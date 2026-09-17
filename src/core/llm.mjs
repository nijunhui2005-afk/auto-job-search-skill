/**
 * 「生成能力」入口 —— 本 skill **不调用任何外部 LLM 接口**。
 *
 * 设计定位：本 skill 是给 agent 用的。需要模型产出的东西（打分 / 打招呼语 /
 * 打分要求 / 简历定制）全部交给**调用本 skill 的 agent**去算，协议见 core/agent-llm.mjs。
 *
 * 因此这里没有 HTTP 客户端、没有 apiKey、没有 baseUrl：
 *   - llmJson() 只做一件事：按内容寻址 id 从 agent 填好的 responses.json 里取结果
 *   - 取不到就抛 NeedAgentLlm —— 由命令的预检流程写成待办文件（退出码 3）
 *
 * 保留 loadEnv：.env 仍然承载浏览器相关配置（CDP_PORT / CHROME_PATH / HEADLESS）。
 */

import fs from 'node:fs';
import path from 'node:path';

export function loadEnv(rootDir) {
  const file = path.join(rootDir, '.env');
  if (!fs.existsSync(file)) return { loaded: false, file };
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    // 不覆盖已存在的真实环境变量（环境变量优先级高于 .env）
    if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
  }
  return { loaded: true, file };
}

/**
 * 生成参数。没有远程模型了，只剩采样温度这类本地偏好；
 * 保留这个函数是为了让上层代码形状不变。
 */
export function llmConfig(env = process.env) {
  return {
    tempGreet: Number(env.LLM_TEMP_GREET ?? 0.7),
    tempScore: Number(env.LLM_TEMP_SCORE ?? 0),
  };
}

/** 从可能带 ```json 围栏的回复里抠出 JSON */
export function parseLooseJson(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    /* 继续尝试截取首个 {...} 或 [...] */
  }
  const start = t.search(/[{[]/);
  if (start < 0) throw new Error(`回复里找不到 JSON: ${t.slice(0, 200)}`);
  const open = t[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === open) depth++;
    else if (t[i] === close) {
      depth--;
      if (depth === 0) return JSON.parse(t.slice(start, i + 1));
    }
  }
  throw new Error(`JSON 括号不闭合: ${t.slice(0, 200)}`);
}

/**
 * 统一的「要一段 JSON 结果」入口。
 *
 * 上游（打分/招呼语/打分要求/简历定制）不关心结果从哪来 —— 它们只依赖 JSON 的**形状**。
 * 这里唯一的来源是 agent 写进 state/agent-llm/responses.json 的结果（内容寻址）。
 *
 * @param {object} cfg  llmConfig() 的结果（当前未使用，保留签名兼容）
 * @param {object} opts { messages, temperature }
 * @param {string} kind 'score' | 'greet' | 'rubric' | 'resume'
 */
export async function llmJson(cfg, opts, kind = 'generic') {
  const { takeResponse } = await import('./agent-llm.mjs');
  const { system, user } = splitMessages(opts.messages);

  const { text } = takeResponse(kind, system, user);
  let data = null;
  try {
    data = parseLooseJson(text);
  } catch (e) {
    // greeting 容错：agent 很可能直接给一段正文而不是 {"greeting":"..."}。
    // 给了机会仍然解析不出来才算失败（比如真的塞了段散文）。
    if (kind === 'greet') data = { greeting: String(text).trim() };
    else throw new Error(`agent 产出不是合法 JSON（kind=${kind}）：${e.message}`);
  }
  return { content: text, data, usage: null, model: 'agent', agent: true };
}

/** 把 messages 拍平成 (system, user) —— 预检和取值必须用同一个函数算 prompt，否则 id 对不上 */
export function splitMessages(messages) {
  return {
    system: messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n'),
    user: messages
      .filter((m) => m.role !== 'system')
      .map((m) => m.content)
      .join('\n\n'),
  };
}
