/**
 * 打分要求（rubric）—— 由 AI 依据「业主设置的目标岗位」自动生成。
 *
 * 为什么需要这个：
 *   原来打分口径硬编码在 ai.mjs 的 SCORE_SYSTEM 里，写死了「AI Agent / 大模型应用工程」
 *   和「临港最优」。结果是换任何别的岗位（前端/测试/数据…）都会被这套口径打歪分：
 *   不是那个方向的一律给低分，用户还得手动去改 niceToHave 才有救 —— 而且改了也没用，
 *   system prompt 里的方向判断还是 Agent。
 *
 * 现在：
 *   `node src/cli.mjs rubric` 让 LLM 读「目标岗位 + 候选人背景 + 真实岗位样本」，
 *   生成一份岗位专属的打分要求存到 config/rubric.json，打分时注入 system prompt。
 *
 * 优先级（高 → 低）：
 *   1. config/prompts.json 的 scoreSystem 非空（业主手写覆盖，最大）
 *   2. config/rubric.json（AI 生成）
 *   3. 内置 SCORE_SYSTEM 兜底
 * 任何一层坏了都往下退，绝不因为配置写坏就罢工。
 */
import fs from 'node:fs';
import path from 'node:path';
import { llmJson, splitMessages } from './llm.mjs';
import { P } from './paths.mjs';

const RUBRIC_FILE = P.rubric;

export const RUBRIC_PATH = RUBRIC_FILE;

/** 读 rubric。缺失 / JSON 坏 / 没有 roles → 返回 null（调用方退回内置口径） */
export function loadRubric() {
  try {
    const r = JSON.parse(fs.readFileSync(RUBRIC_FILE, 'utf8'));
    if (!r || typeof r !== 'object') return null;
    if (!String(r.roles || '').trim()) return null;
    return r;
  } catch {
    return null;
  }
}

export function saveRubric(rubric) {
  fs.mkdirSync(path.dirname(RUBRIC_FILE), { recursive: true });
  if (fs.existsSync(RUBRIC_FILE)) {
    fs.copyFileSync(RUBRIC_FILE, `${RUBRIC_FILE}.bak-${Date.now()}`);
  }
  fs.writeFileSync(RUBRIC_FILE, JSON.stringify(rubric, null, 2) + '\n', 'utf8');
  // 只留最近 3 个备份，避免反复生成堆一堆
  try {
    const dir = path.dirname(RUBRIC_FILE);
    const baks = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('rubric.json.bak-'))
      .sort()
      .reverse();
    for (const f of baks.slice(3)) fs.unlinkSync(path.join(dir, f));
  } catch {
    /* 清理失败不影响主流程 */
  }
  return rubric;
}

/**
 * rubric 是否已经和当前求职条件脱节。
 * 只比关键词和城市 —— 这两个变了，岗位方向就变了，旧 rubric 就不该继续用。
 */
export function rubricStale(rubric, criteria) {
  if (!rubric) return { stale: true, why: '还没有打分要求' };
  const norm = (a) => [...(a || [])].map((s) => String(s).trim()).filter(Boolean).sort().join('\u0000');
  if (norm(rubric.forKeywords) !== norm(criteria?.keywords)) {
    return { stale: true, why: `目标岗位已变（打分要求是为「${(rubric.forKeywords || []).join('、')}」生成的）` };
  }
  if (norm(rubric.forCities) !== norm(criteria?.cities)) {
    return { stale: true, why: `目标城市已变（打分要求是为「${(rubric.forCities || []).join('、')}」生成的）` };
  }
  return { stale: false, why: '' };
}

/**
 * 把 rubric 渲染成 system prompt。
 * 结构固定（评分器好遵守），内容全部来自 rubric —— 没有任何岗位专属的硬编码。
 */
export function buildScoreSystem(rubric) {
  const r = rubric || {};
  const list = (a) => (Array.isArray(a) && a.length ? a.map((x) => `- ${x}`).join('\n') : '- （无）');
  const weights = Array.isArray(r.weights) && r.weights.length
    ? r.weights.map((w) => `- ${w.name}（权重 ${w.weight}）：${w.desc || ''}`).join('\n')
    : '';
  const bands = Array.isArray(r.bands) && r.bands.length
    ? r.bands.map((b) => `- ${b.range}：${b.meaning || ''}`).join('\n')
    : '';

  return [
    '你是一个严格但务实的求职匹配度评估器。评估"这份职位是否值得这位候选人投递"。',
    '',
    '## 本轮的岗位方向（打分必须严格按这个方向，不要套用其他方向的标准）',
    String(r.roles || '').trim(),
    r.targetProfile ? `\n目标候选人画像: ${r.targetProfile}` : '',
    '',
    weights ? '## 评分权重（按权重分配 0-100 分）\n' + weights : '',
    '',
    '## 硬性要求（不满足 → 显著扣分，通常不超过 50 分）',
    list(r.mustHave),
    '',
    '## 加分项（对得上就往上加分）',
    list(r.niceToHave),
    '',
    '## 直接低分 / 否决（命中任意一条 → 30 分以下）',
    list(r.disqualifiers),
    '',
    bands ? '## 分数区间含义\n' + bands : '',
    '',
    ...(Array.isArray(r.rules) && r.rules.length ? ['## 本岗位特有的判断规则', list(r.rules), ''] : []),
    r.notes ? `## 补充说明\n${r.notes}\n` : '',
    '## 通用纪律',
    '- 不要因为"公司名气大"就给高分，只看 JD 与候选人条件的实际匹配',
    '- 标题与上述方向不符、或 JD 实际在招别的岗位 → 打到 30 分以下',
    '- reason 必须具体指出匹配或不匹配的**依据**，不许写"整体匹配"这类空话',
    '- 严格按上面的权重打分，不要自己另立标准',
    '',
    '只输出 JSON：',
    '{"results":[{"jobId":"<原样返回>","score":<0-100整数>,"verdict":"<强烈推荐|可投|勉强|不投>","reason":"<40字内，指出具体依据>","highlights":["<对得上的点>"],"gaps":["<明显缺口>"]}]}',
  ]
    .filter((x) => x !== '')
    .join('\n');
}

/** 生成 rubric 时给 LLM 的指令 */
const RUBRIC_SYSTEM = `你是求职策略分析师。任务：为一位候选人**当前的**目标岗位，写出一份可执行的岗位匹配打分要求（rubric）。

要求：
1. 必须紧扣"目标岗位"这个方向。不要套用其他岗位的标准（例如目标岗位是"前端开发"，就不要拿"大模型/Agent"当评分主线）。
2. 权重加起来必须正好 100，且方向匹配类权重最高。
3. mustHave 写"不满足就该明显扣分"的硬要求；disqualifiers 写"命中就直接低分"的否决项（如外包/驻场/挂羊头卖狗肉）。
4. 参考给出的真实岗位样本，让要求贴合市场上实际出现的写法，不要空泛。
5. 每条都写成可直接判断的短句，不要写"能力优秀"这种无法验证的话。
6. 结合候选人真实背景，让标准落在"够得着但不白送"的位置。

只输出 JSON，不要任何额外文字：
{
  "roles": "<一句话说明本轮岗位方向，以及要识别什么、排除什么>",
  "targetProfile": "<一句话画像：什么样的候选人算匹配>",
  "weights": [{"name":"<维度名>","weight":<整数>,"desc":"<该维度怎么打分>"}],
  "mustHave": ["<硬性要求>"],
  "niceToHave": ["<加分项>"],
  "disqualifiers": ["<命中即低分的否决项>"],
  "bands": [{"range":"80-100","meaning":"<什么意思>"},{"range":"60-79","meaning":""},{"range":"40-59","meaning":""},{"range":"0-39","meaning":""}],
  "rules": ["<该岗位特有的判断规则，例如标题与JD不符怎么处理>"],
  "notes": "<补充说明>"
}`;

/**
 * 调用 LLM 生成 rubric 的 prompt（纯函数、无副作用）。agent 模式预检靠它算 id。
 */
export function rubricPrompt(criteria, profile, sampleJobs = []) {
  const samples = sampleJobs
    .slice(0, 15)
    .map((j) => `- ${j.title}${j.company ? ` @${j.company}` : ''}${j.salary ? ` ${j.salary}` : ''}${j.labels?.length ? ` [${j.labels.join('/')}]` : ''}`)
    .join('\n');

  const user = [
    '## 目标岗位（业主设置，本 rubric 必须服务这个方向）',
    (criteria.keywords || []).join(' / ') || '(未设置)',
    '',
    '## 求职条件',
    `城市: ${(criteria.cities || []).join('/') || '不限'}${criteria.locationTopPreference ? `（最优: ${criteria.locationTopPreference}）` : ''}`,
    `岗位类型: ${(criteria.jobTypes || []).join('/') || '不限'}`,
    `学历要求: ${criteria.degree || '不限'}`,
    criteria.salaryMinK ? `薪资期望: ${criteria.salaryMinK}-${criteria.salaryMaxK}K` : '',
    `明确排除: ${(criteria.excludeKeywords || []).join('/') || '无'}`,
    criteria.extra ? `补充说明: ${criteria.extra}` : '',
    '',
    '## 候选人真实背景（rubric 要落在够得着的位置）',
    profile || '(无)',
    '',
    samples ? `## 该方向在招的真实岗位样本（${Math.min(sampleJobs.length, 15)} 条，参考市场写法）\n${samples}` : '## 暂无岗位样本（请只依据目标岗位方向生成）',
    '',
    `为「${(criteria.keywords || []).join(' / ')}」这个方向生成打分要求。权重之和必须等于 100。`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    kind: 'rubric',
    messages: [
      { role: 'system', content: RUBRIC_SYSTEM },
      { role: 'user', content: user },
    ],
  };
}

/** 预检用的扁平形式 */
export function rubricPrompts(criteria, profile, sampleJobs = []) {
  const p = rubricPrompt(criteria, profile, sampleJobs);
  const { system, user } = splitMessages(p.messages);
  return [{ kind: 'rubric', system, user, meta: { forKeywords: criteria.keywords || [] } }];
}

/**
 * 调用 LLM 生成 rubric。
 * @param {object} cfg      llm 配置
 * @param {object} criteria 求职条件
 * @param {string} profile  候选人背景
 * @param {Array}  sampleJobs 真实岗位样本（可选，用来让 rubric 贴合市场）
 */
export async function generateRubric(cfg, criteria, profile, sampleJobs = []) {
  const p = rubricPrompt(criteria, profile, sampleJobs);
  const { data } = await llmJson(cfg, { temperature: 0.3, messages: p.messages }, 'rubric');
  if (!data) throw new Error('agent 未产出打分要求结果');

  // 校验 + 归一化：权重必须凑到 100，缺字段补空数组，坏数据不落盘
  const weights = Array.isArray(data.weights)
    ? data.weights
        .map((w) => ({ name: String(w.name || '').trim(), weight: Number(w.weight) || 0, desc: String(w.desc || '').trim() }))
        .filter((w) => w.name && w.weight > 0)
    : [];
  const sum = weights.reduce((a, b) => a + b.weight, 0);
  if (weights.length && sum !== 100) {
    // 按比例归一到 100，并把误差补到最大权重的那个维度上，保证严格等于 100
    for (const w of weights) w.weight = Math.max(1, Math.round((w.weight / sum) * 100));
    const diff = 100 - weights.reduce((a, b) => a + b.weight, 0);
    if (diff !== 0) {
      const idx = weights.reduce((best, w, i, arr) => (w.weight > arr[best].weight ? i : best), 0);
      weights[idx].weight = Math.max(1, weights[idx].weight + diff);
    }
  }

  const arr = (k) => (Array.isArray(data[k]) ? data[k].map((s) => String(s).trim()).filter(Boolean) : []);

  return {
    _note: '由 `node src/cli.mjs rubric` 依据目标岗位自动生成。打分时注入 system prompt；改完立即生效。',
    forKeywords: [...(criteria.keywords || [])],
    forCities: [...(criteria.cities || [])],
    generatedAt: new Date().toISOString(),
    model: cfg?.model || '',
    roles: String(data.roles || '').trim(),
    targetProfile: String(data.targetProfile || '').trim(),
    weights,
    mustHave: arr('mustHave'),
    niceToHave: arr('niceToHave'),
    disqualifiers: arr('disqualifiers'),
    bands: Array.isArray(data.bands)
      ? data.bands.map((b) => ({ range: String(b.range || ''), meaning: String(b.meaning || '') })).filter((b) => b.range)
      : [],
    rules: arr('rules'),
    notes: String(data.notes || '').trim(),
  };
}
