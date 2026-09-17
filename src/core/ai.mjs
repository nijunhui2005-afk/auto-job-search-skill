/**
 * AI 层：职位匹配度打分 + 打招呼语生成。
 *
 * 设计取舍：
 *   - 打分用 temperature=0 + JSON 模式，批量送多职位以摊薄 token
 *   - 文案用 temperature=0.7，逐条生成，因为每条都要引用该职位独有的具体信息
 *   - 打分只送"压缩后的职位摘要"，不送原始 JSON —— 原始结构里有大量埋点字段
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { llmJson, splitMessages } from './llm.mjs';
import { buildScoreSystem } from './rubric.mjs';
import { P } from './paths.mjs';

const PROMPTS_FILE = P.prompts;

/** 把职位压成给 LLM 看的紧凑文本，省 token 且去掉噪声字段 */
export function jobBrief(job) {
  return [
    `jobId: ${job.jobId}`,
    `标题: ${job.title}`,
    `公司: ${job.company}${job.companyIndustry ? ` (${job.companyIndustry}${job.companyScale ? ', ' + job.companyScale : ''})` : ''}`,
    `地点: ${job.area}`,
    `薪资: ${job.salary}`,
    `要求: ${[job.eduLevel, job.campusJobKind || job.jobKind].filter(Boolean).join(' ')}`,
    `标签: ${(job.labels || []).join('/')}`,
    job.description || job.jd ? `JD: ${String(job.jd || job.description).slice(0, 1500)}` : 'JD: (列表页无正文)',
    job.companyIntro ? `公司简介: ${String(job.companyIntro).slice(0, 500)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function criteriaBrief(criteria, rubric = null) {
  // rubric 存在时，打分口径以 rubric 为准（它是针对当前岗位生成的），
  // 否则退回 criteria 里手写的 niceToHave（旧行为）。
  const nice = rubric?.niceToHave?.length ? rubric.niceToHave : criteria.niceToHave || [];
  const must = rubric?.mustHave?.length ? rubric.mustHave : criteria.mustHave || [];
  return [
    `目标岗位: ${(criteria.keywords || []).join(' / ')}`,
    `目标地点: ${(criteria.cities || []).join('/')}${criteria.locationTopPreference ? `，最优: ${criteria.locationTopPreference}` : ''}`,
    `期望: ${criteria.expectedNote || '实习岗'}`,
    criteria.salaryMinK ? `薪资期望: ${criteria.salaryMinK}-${criteria.salaryMaxK}K` : '',
    must.length ? `硬性要求: ${must.join(' / ')}` : '',
    `加分项: ${nice.join(' / ')}`,
    `排除: ${(criteria.excludeKeywords || []).join(' / ')}`,
    criteria.extra ? `补充: ${criteria.extra}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const SCORE_SYSTEM = `你是一个严格但务实的求职匹配度评估器。评估"这份职位是否值得这位候选人投递"。

评分标准（0-100）：
- 岗位方向与候选人的目标岗位是否一致（权重最高）
- 工作地点是否匹配（以候选人期望地点为准）
- 候选人技能与 JD 要求的重合度
- 岗位性质是否匹配（实习/校招/社招；是否有转正机会、是否有导师带）
- 排除项：外包/驻场/人力派遣/猎头岗/销售/地推 等 → 直接给 0-20

严格要求：
- 不要因为"公司名气大"就给高分，只看 JD 与候选人条件的实际匹配
- 标题里带关键词但 JD 实际是无关方向或销售 → 打到 30 以下
- reason 必须具体指出匹配或不匹配的**依据**，不许写"整体匹配"这类空话

只输出 JSON：
{"results":[{"jobId":"<原样返回>","score":<0-100整数>,"verdict":"<强烈推荐|可投|勉强|不投>","reason":"<40字内，指出具体依据>","highlights":["<对得上的点>"],"gaps":["<明显缺口>"]}]}`;

/**
 * 构造「某一批岗位」的打分 prompt（纯函数、无副作用）。
 *
 * 为什么单独抽出来：agent 模式下要先预检——把所有会用的 prompt 一次性列出来
 * 交给 agent 批量产出。预检和实跑必须走同一个函数，否则算出的 id 对不上。
 */
export function scorePrompt(criteria, profile, batch, rubric = null) {
  const P = loadPrompts();
  // system prompt 优先级：业主手写 > AI 生成的 rubric > 内置兜底
  const system = P.scoreSystemCustom || (rubric ? buildScoreSystem(rubric) : P.scoreSystem);
  const user = [
    '## 候选人背景',
    profile,
    '',
    '## 求职条件',
    criteriaBrief(criteria, rubric),
    '',
    '## 待评估职位',
    batch.map((j, i) => `### [${i + 1}]\n${jobBrief(j)}`).join('\n\n'),
    '',
    `对以上 ${batch.length} 个职位逐一打分，results 数组必须包含全部 ${batch.length} 项，jobId 原样返回。`,
    P.scoreUserExtra ? `\n## 业主补充的评分口径（优先遵守）\n${P.scoreUserExtra}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return { kind: 'score', messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
}

/** 把一批岗位拆成 [prompt, batch] 列表，供预检用 */
export function scorePrompts(jobs, criteria, profile, { batchSize = 8, rubric = null } = {}) {
  const out = [];
  for (let i = 0; i < jobs.length; i += batchSize) {
    const batch = jobs.slice(i, i + batchSize);
    const p = scorePrompt(criteria, profile, batch, rubric);
    const { system, user } = splitMessages(p.messages);
    out.push({ kind: 'score', system, user, meta: { jobIds: batch.map((j) => String(j.jobId)), batch: out.length + 1 } });
  }
  return out;
}

/**
 * 批量打分。
 * @returns {Promise<Map<string, {score:number,verdict:string,reason:string,highlights:string[],gaps:string[]}>>}
 */
export async function scoreJobs(cfg, jobs, criteria, profile, { batchSize = 8, onProgress, delayMs = 600, rubric = null } = {}) {
  const out = new Map();
  const batches = [];
  for (let i = 0; i < jobs.length; i += batchSize) batches.push(jobs.slice(i, i + batchSize));

  for (const [bi, batch] of batches.entries()) {
    const p = scorePrompt(criteria, profile, batch, rubric);

    let data;
    try {
      const r = await llmJson(cfg, { temperature: cfg.tempScore, messages: p.messages }, 'score');
      data = r.data;
    } catch (e) {
      // 单批失败不能让整轮 run 崩掉：标记为未评分，后续可选择跳过
      console.log(`    [score] batch ${bi + 1} 失败: ${e.message}`);
      for (const j of batch) out.set(j.jobId, { score: null, error: e.message });
      continue;
    }

    const results = data?.results || [];
    for (const r of results) {
      out.set(String(r.jobId), {
        score: Number(r.score),
        verdict: r.verdict || '',
        reason: r.reason || '',
        highlights: r.highlights || [],
        gaps: r.gaps || [],
      });
    }
    // LLM 漏返回的项补 null，避免下游把"没评分"误当成"高分"
    for (const j of batch) {
      if (!out.has(String(j.jobId))) out.set(String(j.jobId), { score: null, error: 'LLM 未返回该项' });
    }

    if (onProgress) onProgress({ batch: bi + 1, total: batches.length, done: out.size, totalJobs: jobs.length });
    if (bi < batches.length - 1 && delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  return out;
}

const GREET_SYSTEM = `你是求职者本人，正在招聘网站上给 HR 发第一条站内消息。

写作口径（最重要，必须遵守）：
1. 全文必须是陈述句，禁止任何疑问句：不能出现“？”或“?”，
   也不能用“请问 / 想请问 / 想问一下 / 是否 / 能不能 / 能否 / 方不方便 / 怎么样”这类疑问说法
2. **只讲自己，不描述对方**：不得对公司/职位/业务/团队做任何描述或评价。
   禁止出现“这个岗位要…”“该职位需要…”“难点在于…”“你们在做…”“团队目前…”这类句子
3. 内容主体就是**我自己的能力与经历**：做过哪个方向的开发、用什么技术栈、能承接哪些环节。
   表述要具体（有技术名、有动作、有场景），不要“熟悉/精通”这类空话
4. **选材要向岗位要求对齐**：从下面给的岗位要求里挑对得上的能力来讲。
   对齐体现在“我挑什么讲”，而不是“我评论你们要什么”
5. 结尾用一句陈述句收束（可到岗时间 / 可实习时长 / 可随时沟通），不能是问句

硬性要求：
- 长度 100-150 字，两到三句话，不分段、不换行
- 最多一个感叹号；语气像一个有分寸的年轻工程师，不卑不亢
- 严禁出现：“贵公司”、“贵司”、“我对贵司的职位很感兴趣”、“期待您的回复”这类模板话术
- **严禁声称候选人背景里没有的能力**。背景里没有的能力，只能用“正在系统学习 / 工程能力可迁移”这类诚实口径，绝不能编造成做过的项目

只输出 JSON：{"greeting":"<消息正文>"}`;

/**
 * 提示词加载。
 *
 * 为什么放到 config/prompts.json：业主希望能在面板里自己调打分口径和写作口径。
 * 约定：字段为空 / 文件不存在 / JSON 坏了 → 一律回退到内置默认值，
 * 绝不因为配置写坏就罢工（宁可跑默认提示词，也不能整个流程停掉）。
 */
export function loadPrompts() {
  let j = {};
  try {
    j = JSON.parse(fs.readFileSync(PROMPTS_FILE, 'utf8'));
  } catch {
    j = {};
  }
  const s = (k) => String(j[k] ?? '').trim();
  return {
    scoreSystem: s('scoreSystem') || SCORE_SYSTEM,
    // 业主手写的才有值；用它区分“手写覆盖”和“内置默认”——前者优先级高于 AI rubric
    scoreSystemCustom: s('scoreSystem'),
    greetSystem: s('greetSystem') || GREET_SYSTEM,
    scoreUserExtra: s('scoreUserExtra'),
    greetUserExtra: s('greetUserExtra'),
    // 让调用方知道哪些字段用的是内置默认
    usingDefault: {
      scoreSystem: !s('scoreSystem'),
      greetSystem: !s('greetSystem'),
    },
  };
}

/** 内置默认提示词（面板里展示给业主对照） */
export function builtinPrompts() {
  return { scoreSystem: SCORE_SYSTEM, greetSystem: GREET_SYSTEM };
}

/**
 * 构造一条打招呼语的 prompt（纯函数、无副作用）。feedback 非空时是质检没过后的重试轮。
 */
export function greetPrompt(job, criteria, profile, scoreInfo, { feedback = '', rubric = null } = {}) {
  const P = loadPrompts();
  const user = [
    '\n## ① 候选人的真实能力（**正文主体只能是这里面的东西**）',
    profile,
    '\n## ② 我的求职条件（可到岗时间/可实习时长等，用作结尾陈述）',
    criteriaBrief(criteria, rubric),
    '\n## ③ 目标岗位在招什么、硬要求是什么（**仅用于你挑选讲哪些能力，严禁在正文里描述或评论这些内容**）',
    jobBrief(job),
    scoreInfo?.highlights?.length
      ? `\n岗位真正的难点/硬要求（同样仅供选材，不得写入正文）：\n${scoreInfo.highlights.join('\n')}`
      : '',
    // 完整缺口信息只用于"不要让模型编造"，并在提示里明确禁止写进消息
    scoreInfo?.gaps?.length
      ? `\n## ④ 我的缺口（**仅供你避开雷区，绝对不允许写进消息**，也不要试图掩饰）\n${scoreInfo.gaps.join('\n')}`
      : '',
    '',
    '现在写这条消息：全程只讲我自己。用陈述句陈述与③最对得上的能力与经历 → 陈述句收束（可到岗/可沟通）。',
    '**不要出现任何对公司/职位/业务/团队的描述或评价，不要出现任何疑问句。**',
    P.greetUserExtra ? `\n## 业主补充的写作口径（优先遵守）\n${P.greetUserExtra}` : '',
    feedback,
  ]
    .filter(Boolean)
    .join('\n');

  const messages = [
    { role: 'system', content: P.greetSystem },
    { role: 'user', content: user },
  ];
  return { kind: 'greet', messages, meta: { jobId: String(job.jobId), title: job.title || '' } };
}

export async function draftGreeting(cfg, job, criteria, profile, scoreInfo, { feedback = '', rubric = null } = {}) {
  const p = greetPrompt(job, criteria, profile, scoreInfo, { feedback, rubric });
  const r = await llmJson(cfg, { temperature: cfg.tempGreet, messages: p.messages }, 'greet');
  const greeting = String(r.data?.greeting || '').trim();
  return { greeting, usage: r.usage };
}

/**
 * 生成 + 质检 + **带反馈重试**。
 *
 * 为什么需要：提示词里写了“100-150 字”，但模型实测会超（出过 171 字）。
 * 单纯收紧 lint 只会把草稿标记为不合格（而 send 只发 lint.ok 的）→ 等于白跑。
 * 所以把 linter 的不合格项回喂给模型让它自己改。
 *
 * @returns {{greeting:string, lint:object, attempt:number, attempts:number}}
 */
export async function draftGreetingChecked(cfg, job, criteria, profile, scoreInfo, { attempts = 3, rubric = null } = {}) {
  let last = null;
  for (let i = 1; i <= attempts; i++) {
    const feedback = last
      ? [
          '',
          '## 上一次的输出不合格，必须逐条修正（保持原意，不要换风格）',
          ...last.lint.problems.map((p) => `- ${p}`),
          `上一次原文（${last.greeting.length} 字）：${last.greeting}`,
        ].join('\n')
      : '';
    const { greeting } = await draftGreeting(cfg, job, criteria, profile, scoreInfo, { feedback, rubric });
    const lint = lintGreeting(greeting);
    last = { greeting, lint, attempt: i, attempts };
    // 没有 hard 问题就算可用（soft 只是“偏长”这类瑕疵，不值得把岗位丢掉）
    if (lint.ok && !lint.soft.length) return last;
    if (lint.ok && i === attempts) return last;
  }
  return last;
}

/**
 * 文案质检。
 *
 * 分两级：
 *   hard 一票否决（不能发）：空、太短、过长、含换行、套话、疑问句、描述对方
 *   soft 只提醒、不阻止发送：比如“略超目标字数”
 * 为什么要分开：以前“太长”是硬失败，JIT 生成时模型写出 166 字就直接丢掉整个岗位。
 * 长了确实是瑕疵，但不能因为长了就不投。
 */
export function lintGreeting(text) {
  const hard = [];
  const soft = [];
  const t = String(text || '').trim();
  if (!t) hard.push('空文案');
  if (t && t.length < 90) hard.push(`太短 (${t.length} 字)`);
  if (t.length > 150) soft.push(`偏长 (${t.length} 字，目标 100-150)`);
  if (t.length > 220) hard.push(`过长 (${t.length} 字，上限 220)`);
  if (t.includes('\n')) hard.push('含换行');
  for (const bad of ['贵公司', '贵司', '期待您的回复', '方便聊聊', '您好，我是', '很感兴趣']) {
    if (t.includes(bad)) hard.push(`套话「${bad}」`);
  }
  // 体裁：必须纯陈述句，禁止疑问
  if (/[？?]/.test(t)) hard.push('出现问号（要求纯陈述句）');
  for (const q of ['请问', '想问', '想请教', '请教下', '是否', '能不能', '能否', '哪些', '怎么样', '方便吗', '聊聊吗']) {
    if (t.includes(q)) hard.push(`疑问句式「${q}」（要求纯陈述句）`);
  }
  // 只讲自己：不得描述/评价对方（公司、职位、业务、团队）
  for (const bad of [
    '这个岗位', '该岗位', '岗位上', '岗位要', '岗位需要', '岗位要求', '岗位难',
    '这个职位', '该职位', '职位要求',
    '贵公司', '贵司', '你们', '贵方', '公司要', '公司需要', '团队目前', '团队现在',
    '难点在', '难点是', '该业务',
  ]) {
    if (t.includes(bad)) hard.push(`描述了对方「${bad}」（要求只讲自己）`);
  }
  // 开头不能是对方描述（现在开头就该是我自己）
  if (/^\s*(这个|该|贵|你们|岗位|职位)/.test(t)) {
    hard.push('开头在描述对方（要求只讲自己）');
  }
  if ((t.match(/！/g) || []).length > 1) hard.push('感叹号过多');
  return { ok: hard.length === 0, problems: [...hard, ...soft], hard, soft };
}
