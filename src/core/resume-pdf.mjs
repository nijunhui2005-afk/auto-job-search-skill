/**
 * 针对单个岗位定制简历 PDF。
 *
 * 设计原则（最重要）：
 *   模板是固定的，只有"侧重"是可变的。
 *   同一段真实经历，面向不同 JD 可以换角度、换措辞、换顺序，
 *   但**绝不允许新增任何未在原始简历中出现的事实**（公司、项目、技术、数字、时间）。
 *   提示词里把这条写成铁律，并在写盘后做一次"事实漂移"自检。
 *
 * 流程：
 *   原始简历(API) -> 固定事实 -> LLM 生成定制片段(侧重) -> 渲染 HTML -> Page.printToPDF
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { llmJson, splitMessages } from './llm.mjs';

// ───────────────────────── 固定事实抽取 ─────────────────────────

const s = (v) => (v === undefined || v === null ? '' : String(v).trim());

function fmtRange(start, end, startYear, startMonth, endYear, endMonth) {
  const a = s(start) || `${s(startYear)}.${s(startMonth)}`;
  const b = s(end) || `${s(endYear)}.${s(endMonth)}`;
  const pretty = (x) => (x.length === 6 ? `${x.slice(0, 4)}.${x.slice(4)}` : x);
  return [pretty(a), pretty(b)].filter(Boolean).join(' - ');
}

/** 从 API 返回抽成模板需要的固定结构。override 来自 config/experience.json（操作者确认的事实） */
export function buildFixedResume(resume, userInfo, override = {}) {
  const b = resume.baseInfo || {};
  const edu = (resume.eduExperiences || []).map((e) => ({
    school: s(e.school),
    special: s(e.special),
    degree: s(e.degreeName || e.degree),
    tz: s(e.tzName || (e.tags || [])[0]),
    time: fmtRange(e.start, e.end, e.startYear, e.startMonth, e.endYear, e.endMonth),
  }));

  let works = (resume.workExperiences || []).map((w) => ({
    compName: s(w.compName),
    title: s(w.title || w.jobtitleName),
    workType: s(w.workTypeName),
    industry: s(w.industryName),
    time: fmtRange(w.start, w.end, w.startYear, w.startMonth, w.endYear, w.endMonth),
    duty: s(w.duty),
  }));

  // config/experience.json 里的经历整段接管平台在线简历（平台不允许改的字段靠这个覆盖）
  let worksOverridden = false;
  if (Array.isArray(override.workExperiences) && override.workExperiences.length) {
    works = override.workExperiences.map((w) => ({
      compName: s(w.compName),
      title: s(w.title),
      workType: s(w.workType),
      industry: s(w.industry),
      time: s(w.time),
      duty: s(w.duty),
    }));
    worksOverridden = true;
  }

  let projects = [];
  if (Array.isArray(override.projectExperiences) && override.projectExperiences.length) {
    projects = override.projectExperiences.map((p) => ({
      name: s(p.name),
      role: s(p.role),
      time: s(p.time),
      bullets: (p.bullets || []).map(s).filter(Boolean),
      description: s(p.description),
    }));
  } else if ((resume.projectExperiences || []).length) {
    projects = (resume.projectExperiences || []).map((p) => ({
      name: s(p.projectName || p.name),
      role: s(p.role || p.duty),
      time: '',
      bullets: [s(p.description || p.projectDesc)].filter(Boolean),
      description: '',
    }));
  }

  const skills = (resume.labels || []).map((l) => s(l.label)).filter(Boolean);
  const extraSkills = (override.skillsExtra || []).map((x) => s(x.name)).filter(Boolean);
  const skillPool = [...new Set([...skills, ...extraSkills])];
  const skillEvidence = (override.skillsExtra || []).reduce((m, x) => {
    if (s(x.name)) m[s(x.name)] = s(x.evidence);
    return m;
  }, {});
  const certs = (resume.credential?.names || []).map(s).filter(Boolean);
  const langs = (resume.languages || []).map((l) => s(l.name)).filter(Boolean);
  const jw = (resume.jobWants || [])[0] || {};

  return {
    name: s(b.showName || b.realName || userInfo?.name),
    gender: s(b.sexName || b.sex),
    age: b.age ? `${b.age}岁` : '',
    birth: s(b.birthYearMonth),
    eduLevel: s(b.eduLevel),
    city: s(b.cityName),
    workStatus: s(b.workStatusName),
    // 联系方式：猎聘 API 返回的是打码值（180****0401），必须用操作者提供的原值
    mobile: s(override.contact?.mobile) || s(b.mobile),
    email: s(override.contact?.email) || s(b.email),
    mobileVerified: b.verifyMobile === true,
    edu,
    works,
    worksOverridden,
    projects,
    skills: skillPool,
    skillPool,
    skillEvidence,
    certs,
    langs,
    expect: {
      city: s(jw.dqName),
      title: s(jw.jobtitleName || jw.jobTitleName),
      salaryLow: jw.wantSalaryLow,
      salaryHigh: jw.wantSalaryHigh,
      practiceMonths: jw.practiceMonths,
      workweek: jw.workweek,
    },
    completeness: resume.completeDegree,
  };
}

export function basicMetaLine(f) {
  return [
    f.gender,
    f.age,
    f.eduLevel,
    f.city,
    f.workStatus,
    f.mobile ? `电话 ${f.mobile}` : '',
    f.email ? `邮箱 ${f.email}` : '',
  ]
    .filter(Boolean)
    .map((x) => `<span>${x}</span>`)
    .join('');
}

// ───────────────────────── LLM 定制 ─────────────────────────

const TAILOR_SYSTEM = `你在为一位求职者生成"针对特定岗位定制"的简历片段。

【铁律 · 违反即失败】
只能使用"原始事实"里出现过的信息。**严禁新增任何公司、项目、技术名词、数字、时间、职位**。
你不是在写简历，你是在**重新组织已有的真实经历**去贴合这个岗位。

【另一个重要约束】
**绝对不能在 targetTitle 里出现目标公司的名字**。
这份简历要看起来像一份正常投递的简历，而不是“为某家定制”的痕述。
不要写“与贵司岗位匹配”这类话 —— 你只负责调整**侧重与顺序**，让对方的 JD 要求恰好被简历里已经存在的事实接住。

允许的操作只有三种：
1. 调整表述角度（同一件事，面向不同岗位强调不同侧面）
2. 调整顺序 / 突出重点
3. 把原文里隐含、但可从原文推出的能力显式点出来

禁止的操作：
- 添加原始事实里没有的技术栈（例如原文只提 AngularJS，不许写成 React）
- **在 skillOrder 里放技能池之外的技能**（池子会明确给出，代码会强制校验并剔除）
- 添加没有的项目经历
- 夸大数字或时长
- 编造"负责过 XX 系统"这类原文没有的职责

只输出 JSON：
{
  "targetTitle": "<照抄岗位标题，不要改写；不要带公司名>",
  "matchPoints": ["<仅用于人工核对，不会写进 PDF；2-4 条，从原始事实出发说明为何能接上该岗位>"],
  "skillOrder": ["<把原始技能按与该 JD 的相关性从高到低重排；必须原样使用原技能名，不得新增或翻译>"],
  "workEmphasis": [{"compName":"<原公司名>","bullets":["<按该 JD 侧重重写的要点，2-3 条；允许改写措辞，不许新增事实>"]}],
  "projectEmphasis": [{"name":"<原项目名>","bullets":["<按该 JD 侧重重写的要点；允许改写措辞，不许新增事实>"]}]
}`;

/**
 * 构造简历定制 prompt（纯函数、无副作用）。agent 模式预检靠它算 id。
 */
export function tailorPrompt(fixed, job, criteria, jobBriefText) {
  const user = [
    '## 原始事实（唯一可用的素材）',
    '### 基本信息',
    `${fixed.name} / ${fixed.gender} / ${fixed.age} / ${fixed.eduLevel} / ${fixed.city} / ${fixed.workStatus}`,
    '### 教育',
    fixed.edu.map((e) => `- ${e.school} ${e.special} ${e.degree} ${e.time} ${e.tz}`).join('\n') || '(无)',
    '### 实习/工作经历',
    fixed.works
      .map((w) => `- ${w.compName} | ${w.title} | ${w.workType} | ${w.industry} | ${w.time}\n  职责原文: ${w.duty}`)
      .join('\n') || '(无)',
    '### 技能',
    `**可选用技能池（skillOrder 只能从这里面选，必须原样使用名称）**：${fixed.skillPool.join('、') || '(空)'}`,
    fixed.skillEvidence && Object.keys(fixed.skillEvidence).length
      ? `部分技能的证据：\n${Object.entries(fixed.skillEvidence).map(([k, v]) => `  - ${k}: ${v}`).join('\n')}`
      : '',
    '### 证书',
    fixed.certs.join('、') || '(无)',
    '### 项目经历',
    fixed.projects.length
      ? fixed.projects.map((p) => `- ${p.name} | ${p.role} | ${p.time}\n  要点: ${(p.bullets || []).join(' / ')}`).join('\n')
      : '**无**（模板里不会出现项目章节，不要虚构）',
    '',
    '## 目标岗位',
    jobBriefText,
    '',
    '## 求职者本人的偏好',
    `期望城市 ${fixed.expect.city}；期望岗位 ${fixed.expect.title}；实习时长 ${fixed.expect.practiceMonths} 个月；每周 ${fixed.expect.workweek} 天`,
    criteria.extra ? `补充：${criteria.extra}` : '',
    '',
    '现在生成定制片段。记住：只重组，不新增。',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    kind: 'resume',
    messages: [
      { role: 'system', content: TAILOR_SYSTEM },
      { role: 'user', content: user },
    ],
    meta: { jobId: String(job.jobId || ''), title: job.title || '' },
  };
}

/** 预检用的扁平形式 */
export function tailorPrompts(fixed, jobs, criteria, jobBriefOf) {
  return jobs.map((j) => {
    const p = tailorPrompt(fixed, j, criteria, jobBriefOf(j));
    const { system, user } = splitMessages(p.messages);
    return { kind: 'resume', system, user, meta: { jobId: String(j.jobId || ''), title: j.title || '' } };
  });
}

export async function tailorResume(cfg, fixed, job, criteria, jobBriefText) {
  const p = tailorPrompt(fixed, job, criteria, jobBriefText);
  const r = await llmJson(cfg, { temperature: 0.3, messages: p.messages }, 'resume');
  return r.data;
}

/**
 * 事实漂移自检：把定制后的文本里出现的"技术名词"与原始事实比对，
 * 抓出明显是凭空冒出来的词。不能做到 100% 准确，但能拦住最离谱的情况。
 */
export function detectFabrication(fixed, tailored) {
  const pool = new Set(
    [
      ...fixed.skills,
      ...fixed.works.flatMap((w) => [w.compName, w.title, w.duty]),
      ...fixed.edu.flatMap((e) => [e.school, e.special]),
      ...fixed.certs,
    ]
      .join(' ')
      .toLowerCase()
      .match(/[a-z][a-z0-9+#.\-]{1,20}/g) || [],
  );
  const checkText = [
    ...(tailored.matchPoints || []),
    ...(tailored.workEmphasis || []).flatMap((w) => w.bullets || []),
  ].join(' ');
  const mentioned = new Set(checkText.toLowerCase().match(/[a-z][a-z0-9+#.\-]{1,20}/g) || []);
  // 这些词属于通用连接词/岗位要求词，出现在定制文本里不算编造
  const allow = new Set([
    'ai', 'agent', 'llm', 'rag', 'api', 'http', 'json', 'sql', 'ui', 'vue', 'java', 'python',
    'langchain', 'mcp', 'po', 'poc', 'etl', 'web', 'app', 'ops', 'ci', 'cd', 'gpu', 'prompt',
  ]);
  const suspicious = [...mentioned].filter((w) => !pool.has(w) && !allow.has(w) && w.length >= 3);
  return { suspicious, ok: suspicious.length === 0 };
}

// ───────────────────────── 渲染 ─────────────────────────

/**
 * 代码层面的强制门：skillOrder 只能包含技能池已有的技能。
 * 不依赖提示词自觉 —— 提示词会被模型“合理化”掉，代码不会。
 * 返回剔除名单，便于人工发现模型在尝试编造什么。
 */
export function enforceSkillPool(tailored, fixed) {
  const poolMap = new Map(fixed.skillPool.map((x) => [x.toLowerCase(), x]));
  const kept = [];
  const dropped = [];
  for (const raw of tailored.skillOrder || []) {
    const key = String(raw ?? '').trim().toLowerCase();
    if (!key) continue;
    if (poolMap.has(key)) {
      const canonical = poolMap.get(key);
      if (!kept.includes(canonical)) kept.push(canonical);
    } else {
      dropped.push(String(raw).trim());
    }
  }
  // 池子里但模型没提的接在后面：不丢技能，只是优先级更低
  const rest = fixed.skillPool.filter((x) => !kept.includes(x));
  return { skillOrder: [...kept, ...rest], dropped };
}

/**
 * 把证件照读成 data URI 内嵌进 HTML。
 * 为什么不用 file:// 引用：Chrome 对 file:// 页面加载 file:// 资源有限制，
 * 而我们把 HTML 写到临时目录、图片在 case 目录，跨目录引用容易踩坑。
 * 内嵌 base64 永远能渲染。
 */
export function loadPhotoAsDataUri(photoPath) {
  if (!photoPath || !fs.existsSync(photoPath)) return null;
  const ext = path.extname(photoPath).toLowerCase();
  const mime =
    ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.bmp' ? 'image/bmp' : 'image/jpeg';
  const b64 = fs.readFileSync(photoPath).toString('base64');
  return { dataUri: `data:${mime};base64,${b64}`, bytes: b64.length, file: photoPath };
}

/** 极简模板渲染：支持 {{key}} 与 {{#section}}...{{/section}} */
export function renderTemplate(tpl, vars) {
  let out = tpl.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, body) =>
    vars[key] ? body : '',
  );
  out = out.replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] === undefined ? '' : String(vars[key])));
  return out;
}

export function renderResumeHtml(template, fixed, tailored, job, photo) {
  const eduList = fixed.edu
    .map(
      (e) => `<div class="item">
      <div class="item-head">
        <div><span class="item-title">${e.school}</span> <span class="item-sub">${[e.special, e.degree, e.tz].filter(Boolean).join(' · ')}</span></div>
        <div class="item-time">${e.time}</div>
      </div>
    </div>`,
    )
    .join('\n');

  const skillsArr = (tailored.skillOrder?.length ? tailored.skillOrder : fixed.skills).filter(Boolean);
  const skillList =
    `<li><b>专业技能：</b>${skillsArr.join('、')}</li>` +
    (fixed.certs.length ? `\n<li><b>证书：</b>${fixed.certs.join('、')}</li>` : '') +
    (fixed.langs.length ? `\n<li><b>语言：</b>${fixed.langs.join('、')}</li>` : '');

  const emphasize = new Map((tailored.workEmphasis || []).map((w) => [w.compName, w.bullets || []]));
  const workList = fixed.works
    .map((w) => {
      const bullets = emphasize.get(w.compName) || (w.duty ? [w.duty] : []);
      return `<div class="item">
      <div class="item-head">
        <div><span class="item-title">${w.compName}</span> <span class="item-sub">${[w.title, w.workType, w.industry].filter(Boolean).join(' · ')}</span></div>
        <div class="item-time">${w.time}</div>
      </div>
      ${bullets.length ? `<ul>${bullets.map((b) => `<li>${b}</li>`).join('')}</ul>` : ''}
    </div>`;
    })
    .join('\n');

  const matchList = (tailored.matchPoints || []).map((p) => `<li>${p}</li>`).join('\n');
  // matchPoints 仅供人工核对与 CLI 展示，**不渲染进 PDF**
  // （操作者要求：不体现与特定公司的关联，只靠侧重与顺序隐式地接住 JD）
  void matchList;

  const projEmph = new Map((tailored.projectEmphasis || []).map((p) => [p.name, p.bullets || []]));
  const projectList = fixed.projects
    .map((p) => {
      const bullets = projEmph.get(p.name) || p.bullets || (p.description ? [p.description] : []);
      return `<div class="item">
      <div class="item-head">
        <div><span class="item-title">${p.name}</span> <span class="item-sub">${p.role || ''}</span></div>
        <div class="item-time">${p.time || ''}</div>
      </div>
      ${bullets.length ? `<ul>${bullets.map((b) => `<li>${b}</li>`).join('')}</ul>` : ''}
    </div>`;
    })
    .join('\n');

  return renderTemplate(template, {
    name: fixed.name,
    basicMeta: basicMetaLine(fixed),
    targetTitle: tailored.targetTitle || job.title || fixed.expect.title,
    hasPhoto: photo?.dataUri ? '1' : '',
    photoUrl: photo?.dataUri || '',
    expectCity: fixed.expect.city,
    expectSalary:
      fixed.expect.salaryLow && fixed.expect.salaryHigh
        ? `${fixed.expect.salaryLow}-${fixed.expect.salaryHigh}K`
        : '',
    hasProjects: projectList ? '1' : '',
    projectList,
    eduList,
    skillList,
    hasWork: workList ? '1' : '',
    workList,
    generatedAt: new Date().toISOString().slice(0, 10),
  });
}

/** 用浏览器把 HTML 打成 PDF（不需要 Runtime） */
export async function htmlToPdf(cdp, html, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmp = path.join(os.tmpdir(), `liepin-resume-${Date.now()}.html`);
  fs.writeFileSync(tmp, html, 'utf8');
  await cdp.navigate(pathToFileURL(tmp).href);
  await new Promise((r) => setTimeout(r, 1200));

  // Chrome 的 printToPDF 返回 base64，我们自己写盘。
  // 如果目标文件正被 PDF 阅读器占用（很常见，操作者在开着看），
  // 就回落到带时间戳的文件名，而不是让整个流程失败。
  const { data } = await cdp.sendCommand('Page.printToPDF', {
    printBackground: true,
    preferCSSPageSize: true,
    marginTop: 0.55,
    marginBottom: 0.55,
    marginLeft: 0.6,
    marginRight: 0.6,
  });
  const buf = Buffer.from(data, 'base64');

  let target = outFile;
  try {
    fs.writeFileSync(target, buf);
  } catch (e) {
    if (e.code !== 'EBUSY' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
    target = outFile.replace(/\.pdf$/i, `-${Date.now()}.pdf`);
    fs.writeFileSync(target, buf);
    console.log(`    （目标 PDF 被占用，改写到 ${path.basename(target)}）`);
  }

  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  return { file: target, size: buf.length, requested: outFile };
}

/**
 * 把简历渲染成 PNG。
 *
 * 为什么需要：猎聘 IM 的 file input 只接受 jpg/jpeg/png/bmp，**不收 PDF**，
 * 所以想“发定制简历”只能走图片。A4@96dpi = 794x1123 css px。
 * 用 deviceScaleFactor 提高清晰度（HR 放大看也能看清）。
 */
export async function htmlToPng(cdp, html, outFile, { width = 794, height = 1123, scale = 2 } = {}) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmp = path.join(os.tmpdir(), `liepin-resume-${Date.now()}.html`);
  fs.writeFileSync(tmp, html, 'utf8');

  await cdp.sendCommand('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: false,
  });
  try {
    await cdp.navigate(pathToFileURL(tmp).href);
    await new Promise((r) => setTimeout(r, 900));
    const { data } = await cdp.sendCommand('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(data, 'base64');

    let target = outFile;
    try {
      fs.writeFileSync(target, buf);
    } catch (e) {
      if (e.code !== 'EBUSY' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      target = outFile.replace(/\.png$/i, `-${Date.now()}.png`);
      fs.writeFileSync(target, buf);
    }
    return { file: target, size: buf.length, requested: outFile };
  } finally {
    await cdp.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {});
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}
