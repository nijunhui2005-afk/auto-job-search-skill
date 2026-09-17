/**
 * Agent 充当 LLM —— 本 skill 唯一的「生成能力」来源。
 *
 * 本 skill 是给 agent 用的，不再调用任何外部 LLM 接口；需要模型产出的东西
 * （打分 / 招呼语 / 打分要求 / 简历定制）全部交给调用本 skill 的 agent。
 *
 * 为什么要这么设计：
 *   要求每个使用者都去申请一个 LLM key 是多余的门槛，而 agent 本身就是一个足够强的模型
 *   —— 让它直接产出这些结果即可。同时也避免了把数据发到外部服务。
 *
 * 为什么不是“agent 自己算完写进产物文件”：
 *   那样 agent 就绕过了代码里所有的校验（打招呼语的 20+ 条 lint、技能池强制、JSON 解析）。
 *   所以这里让 agent 只提供**原始模型输出**，解析/校验/落盘仍然全部由代码负责。
 *
 * 协议（一轮往返）：
 *   1. CLI 用 `checkPrompts()` 预检：把所有会需要的 prompt 都列出来（纯函数构造，无副作用）
 *   2. 有缺的 → 写 state/agent-llm/requests.json，命令以退出码 3 结束（不是错误，是"待办"）
 *   3. agent 读 requests.json，对每条产出结果，写入 responses.json 的 responses[id]
 *   4. agent 原样重跑同一条命令 → 这次全部命中缓存 → 正常完成
 *
 * 为什么 id 是内容寻址（sha1(kind+system+user)）：
 *   - 天然去重：score 每批一个 prompt，重跑不会重复要求
 *   - 天然失效：岗位、rubric、求职条件任一变化 → prompt 变 → id 变 → 自动重新生成
 *     这正好满足"不要提前预设草稿，在发送时生成"的要求：招呼语永远对着当时的岗位和口径生成
 *   - 天然缓存：同一个岗位已生成过的招呼语不会再来要一遍
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { P, relHome } from './paths.mjs';

const DIR = path.join(P.state, 'agent-llm');

export const requestsPath = () => path.join(DIR, 'requests.json');
export const responsesPath = () => path.join(DIR, 'responses.json');

/** 保留天数：超过这个天数的缓存结果会被清掉，避免文件无限增长 */
const KEEP_DAYS = 30;

/** 退出码 3 = 等 agent 产出结果，不是失败 */
export const NEED_AGENT_LLM_EXIT = 3;

export class NeedAgentLlm extends Error {
  constructor(id, kind) {
    super(`agent 模式下缺少 kind=${kind} 的生成结果（id=${id}）—— 应先跑预检`);
    this.name = 'NeedAgentLlm';
    this.id = id;
    this.kind = kind;
  }
}

/** 每个 kind 期望的输出形状，写进 requests.json 让 agent 知道该产出什么 */
const EXPECT = {
  score: '{"results":[{"jobId":"<原样返回>","score":<0-100整数>,"verdict":"<强烈推荐|可投|勉强|不投>","reason":"<40字内，指出具体依据>","highlights":["<对得上的点>"],"gaps":["<明显缺口>"]}]}',
  greet: '{"greeting":"<消息正文，100-150字，纯陈述句>"}',
  rubric: '{"roles":["<岗位方向，3-6条>"],"targetProfile":"<一句话画像>","weights":[{"name":"<维度>","weight":<整数>,"desc":"<怎么算>"}],"mustHave":[],"niceToHave":[],"disqualifiers":[],"bands":[],"rules":[],"notes":[]}',
  resume: '{"summary":"<一句话概述>","skills":["<从给定技能池里挑>"],"highlights":["<对得上该岗位的经历要点>"],"order":["<工作经历标题，按相关性排序>"]}',
};

export const expectFor = (kind) => EXPECT[kind] || '<JSON>';

/** 内容寻址 id —— 同样的 kind+system+user 永远得到同一个 id */
export function promptId(kind, system, user) {
  return crypto.createHash('sha1').update(`${kind}\u0000${system}\u0000${user}`).digest('hex').slice(0, 16);
}

/** 没有外部 LLM 了：永远由 agent 充当模型（保留函数名以兼容调用方） */
export const isAgentMode = () => true;

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * responses.json 的正式结构是 { "responses": { "<id>": { text, at } } }（协议里就是这么写的）。
 * 这里兼容裸 map 写法，免得 agent 少写一层就直接变成“缓存永远不命中”。
 */
function loadResponses() {
  const j = readJsonSafe(responsesPath(), {});
  if (!j || typeof j !== 'object') return {};
  const inner = j.responses && typeof j.responses === 'object' ? j.responses : j;
  return inner && typeof inner === 'object' ? inner : {};
}

function saveResponses(map) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(responsesPath(), JSON.stringify({ responses: map }, null, 2), 'utf8');
}

/** 清掉过期缓存，避免 responses.json 无限增长（每个岗位的招呼语都会进来） */
function pruneResponses(obj) {
  const cutoff = Date.now() - KEEP_DAYS * 86400_000;
  const out = {};
  let dropped = 0;
  for (const [id, v] of Object.entries(obj)) {
    const at = typeof v === 'object' && v ? Number(v.at) || 0 : 0;
    if (at && at < cutoff) {
      dropped++;
      continue;
    }
    out[id] = v;
  }
  return { out, dropped };
}

/**
 * 预检：把这次命令会用到的 prompt 一次性列出来，返回还缺哪些。
 * 纯查询，不写盘。
 *
 * @param {Array<{kind:string, system:string, user:string, meta?:object}>} prompts
 */
export function checkPrompts(prompts = []) {
  const responses = loadResponses();
  const missing = [];
  const dup = new Set();
  for (const p of prompts) {
    const id = promptId(p.kind, p.system, p.user);
    if (dup.has(id)) continue;
    dup.add(id);
    const hit = responses[id];
    if (!(typeof hit === 'string' && hit.trim()) && !(hit && typeof hit.text === 'string' && hit.text.trim())) {
      missing.push({ id, kind: p.kind, system: p.system, user: p.user, expect: expectFor(p.kind), meta: p.meta || {} });
    }
  }
  return { total: dup.size, missing, cached: dup.size - missing.length };
}

/**
 * 把缺的 prompt 写成待办文件，让 agent 去填。
 * @returns {string} requests.json 的绝对路径
 */
export function writeRequests(command, missing) {
  fs.mkdirSync(DIR, { recursive: true });
  const payload = {
    _README: [
      '本文件是「待你生成的 LLM 结果」清单 —— 本 skill 不调用外部 LLM，由你这个 agent 充当模型。',
      '',
      '怎么做：',
      '1. 对 requests 里每一项，按 system + user 的要求产出结果',
      `2. 结果必须是该项 expect 字段描述的 JSON（可以带 markdown 围栏，代码会自动抠出来）`,
      `3. 把结果写进 ${relHome(responsesPath())}，形如：`,
      '   { "responses": { "<这一项的 id>": { "text": "<你产出的原始文本>", "at": 1737000000000 } } }',
      '   （若该文件已存在，请合并进已有的 responses，不要覆盖掉别的项）',
      `4. 原样重跑同一条命令：${command}`,
      '',
      '注意：不要修改 state/ agent-llm/ 之外的任何文件；解析与校验由代码负责，你只需给出模型输出。',
    ],
    command,
    createdAt: new Date().toISOString(),
    count: missing.length,
    requests: missing,
  };
  const file = requestsPath();
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  // 顺手清一次过期缓存
  const { out, dropped } = pruneResponses(loadResponses());
  if (dropped) saveResponses(out);
  return file;
}

/** 取一条已生成的结果；没有就抛（说明调用方漏了预检） */
export function takeResponse(kind, system, user) {
  const id = promptId(kind, system, user);
  const responses = loadResponses();
  const hit = responses[id];
  const text = typeof hit === 'string' ? hit : hit && typeof hit.text === 'string' ? hit.text : '';
  if (!text.trim()) throw new NeedAgentLlm(id, kind);
  return { id, text };
}

/** 汇总给 doctor / 命令收尾用：缓存了多少条、还有多少条待办 */
export function queueStatus() {
  const responses = loadResponses();
  const req = readJsonSafe(requestsPath(), null);
  return {
    dir: DIR,
    cached: Object.keys(responses).length,
    pendingFile: fs.existsSync(requestsPath()) ? requestsPath() : null,
    pendingCount: req?.count || 0,
    pendingCommand: req?.command || null,
    pendingCreatedAt: req?.createdAt || null,
  };
}

/** 全部命中缓存后把待办文件清掉，避免下次误以为还有活没干 */
export function clearRequests() {
  try {
    fs.unlinkSync(requestsPath());
    return true;
  } catch {
    return false;
  }
}
