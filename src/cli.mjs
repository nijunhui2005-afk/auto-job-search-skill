#!/usr/bin/env node
/**
 * liepin-auto CLI
 *
 *   node src/cli.mjs doctor            # 环境体检：配置 / LLM / CDP / 登录态
 *   node src/cli.mjs recon [--url U]   # 侦察：DOM 结构 + XHR 接口 + 截图落证
 *
 * 后续阶段（recon 出结果后再实现）：
 *   search / score / draft / send / run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv, llmConfig, splitMessages } from './core/llm.mjs';
import {
  isAgentMode,
  checkPrompts,
  writeRequests,
  responsesPath,
  queueStatus,
  clearRequests,
  NeedAgentLlm,
  expectFor,
  NEED_AGENT_LLM_EXIT,
} from './core/agent-llm.mjs';
import { loadLimits, preflight, assertUnderCap, nextDelayMs, recordSuccess, recordFailure } from './core/ratelimit.mjs';
import { loadRubric, saveRubric, generateRubric, rubricStale, buildScoreSystem, RUBRIC_PATH, rubricPrompts } from './core/rubric.mjs';
import { ensureBrowser, cdpVersion as cdpProbe } from './core/browser/chrome.mjs';
import { HOME, P as P_, ensureHome, SKILL_ROOT, DEFAULTS_DIR, relHome } from './core/paths.mjs';
import { getSite, listSites } from './sites/index.mjs';

// 当前站点适配器（默认猎聘）。所有站点特有的东西（URL/cookie 名/接口/按钮文案）
// 都从它拿，core 流程不再直接碰。换站点只改 config/site.json 或 SITE 环境变量。
const SITE = getSite();
import { riskControlPage } from './core/risk.mjs';
import { loadDaily, ensureDir, appendJsonl, readJsonl, saveDaily } from './core/store.mjs';
// legacy Playwright 模块改成**惰性加载**。
// 为什么：playwright-core 在 Node < 20 时会在 `import` 阶段直接抛错
//   （"Playwright requires Node.js 20 or higher"）。
// 静态 import 先于任何顶层语句执行 → 版本守卫根本没机会跑。
// 换成惰性后，ensureModernNode() 先切到新 Node 重跑自己，
// 真正 import 时已经在 v24 上了。调用点写法完全不变。
// 注意：这里不能用 `??=`（ES2021，Node 15+），否则 Node 14 在**解析阶段**就报错，
// 比 ensureModernNode() 还早 —— 守卫就永远没机会跑了。
let _legacy = null;
const legacy = async () => {
  if (!_legacy) {
    try {
      _legacy = await import('./core/browser/cdp.mjs');
    } catch (e) {
      // recon 是可选的重型工具（需要 page.evaluate，cdp-lite 设计上不带）。
      // 主流水线（doctor/search/rubric/score/send/resume-pdf）完全不需要它。
      throw new Error(
        `recon 需要可选的 playwright-core，但没装。装入：npm i playwright-core（在技能目录下执行）\n原始错误：${e.message}`,
      );
    }
  }
  return _legacy;
};
const connectCdp = async (...a) => (await legacy()).connectCdp(...a);
const getLiepinPage = async (...a) => (await legacy()).getLiepinPage(...a);
const probeLogin = async (...a) => (await legacy()).probeLogin(...a);
const shot = async (...a) => (await legacy()).shot(...a);
const waitStable = async (...a) => (await legacy()).waitStable(...a);
const cdpVersion = async (...a) => (await legacy()).cdpVersion(...a);
import { CdpLite } from './core/browser/cdp-lite.mjs';
import { ensureModernNode } from './core/node-guard.mjs';
import { LiepinApi } from './sites/liepin/api.mjs';
import { normalizeJob, prefilter, matchesLocation, jobSummaryLine } from './sites/liepin/normalize.mjs';
import { scoreJobs, draftGreeting, draftGreetingChecked, lintGreeting, jobBrief, scorePrompts, greetPrompt } from './core/ai.mjs';
import { fetchResumeRaw, fetchUserInfo, fetchExpect, formatResumeMarkdown, resumeQuality } from './sites/liepin/resume.mjs';
import { fetchJobDetail, extractJd } from './sites/liepin/detail.mjs';
import { locateGreetButton, locateChatInput, sendOne, listTargets, diagnose, sendResumeCard, locateResumeButton } from './sites/liepin/send.mjs';
import {
  buildFixedResume,
  tailorResume,
  renderResumeHtml,
  htmlToPdf,
  htmlToPng,
  detectFabrication,
  enforceSkillPool,
  loadPhotoAsDataUri,
  tailorPrompts,
} from './core/resume-pdf.mjs';
// 路径分层：HOME = 工作根（你的私人数据），SKILL_ROOT = 本技能目录（代码/模板）。
// 详见 src/core/paths.mjs。ROOT 保留为 HOME 的别名，避免大面积改调用点。
const ROOT = HOME;

const P = {
  limits: P_.limits,
  criteria: P_.criteria,
  daily: P_.daily,
  sent: P_.sent,
  seen: P_.seen,
  jobs: P_.jobs,
  scored: P_.scored,
  details: P_.details,
  resumes: P_.resumes,
  template: P_.template,
  drafts: P_.drafts,
  profileGen: path.join(ROOT, 'config', 'profile.generated.md'),
  profileManual: P_.profile,
  experience: P_.experience,
  cookies: path.join(ROOT, 'state', 'cookies.json'),
  evidence: P_.evidence,
  screens: P_.screens,
};

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', d: '\x1b[90m', c: '\x1b[36m', x: '\x1b[0m' };
const ok = (m) => console.log(`${C.g}  ✓${C.x} ${m}`);
const warn = (m) => console.log(`${C.y}  !${C.x} ${m}`);
const bad = (m) => console.log(`${C.r}  ✗${C.x} ${m}`);
const dim = (m) => console.log(`${C.d}    ${m}${C.x}`);
const head = (m) => console.log(`\n${C.c}▌ ${m}${C.x}`);

/**
 * 取一个带值参数。两种写法都支持：
 *   --job 85256053      （空格分隔，命令行手敲）
 *   --job=85256053      （= 分隔，参数是一个整体，不可能被拆开）
 */
function flag(argv, name) {
  const eq = argv.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const ts = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/**
 * 当前持有的 CDP 连接。
 * 实测（src/tools/probe-cdp-close.mjs）：connectOverCDP 得到 browser.close() 只断开
 * 连接、不会关掉操作者的 Chrome。所以收尾走 browser.close()，不用 process.exit()
 * —— 后者会在 Node 24 上抛 libuv 断言 "!(handle->flags & UV_HANDLE_CLOSING)"。
 */
let activeBrowser = null;
let activeCdpLite = null;

/** 连接调试 Chrome 并取得 cdp-lite 会话（不开 Runtime，因此不会被猎聘踢） */
// 无头模式 / 自动拉起浏览器：由 main() 从 argv 里解析后写这两个变量。
// 放模块级是为了不用改 7 个 attachLite/makeApi 调用点。
let HEADLESS = false;
let BACKGROUND = false;
let AUTO_START = true;

async function attachLite(port) {
  if (AUTO_START) {
    // 用站点自己的首页，而不是写死猎聘
    const b = await ensureBrowser({ port, headless: HEADLESS, background: BACKGROUND, root: SKILL_ROOT, profileDir: P_.chromeProfile, startChrome: P_.startChrome });
    if (!b.ok) throw new Error(b.reason);
    if (b.launched) ok(`Chrome 已就绪（${b.background ? '有头 + 后台窗口' : b.headless ? '无头' : '有头'}）`);
    else if (HEADLESS && !b.headless) dim('（沿用已有实例：它是有头跑着的）');
  }
  const cdp = await CdpLite.attach({ port, url: SITE.meta.homeUrl });
  await cdp.navigate(SITE.meta.homeUrl);
  activeCdpLite = cdp;
  return cdp;
}

function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 读一个 json 文件，失败返回 null（不抛） */
const readJsonSafe = (p) => readJson(p, null);

/**
 * 找出配置里还没填的占位符。
 * 收集字段路径而不是简单一句话，是因为判断有没有拿别人的条件去跑很重要。
 * 下划线开头的键是注释，不算占位。
 */
function findPlaceholders(obj, path = '') {
  const out = [];
  if (typeof obj === 'string') {
    if (obj.includes('FILL_ME')) out.push(path || '(根)');
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => out.push(...findPlaceholders(v, `${path}[${i}]`)));
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue;
      out.push(...findPlaceholders(v, path ? `${path}.${k}` : k));
    }
  }
  return out;
}

/** 读 JSON，缺失/坏格式都给可操作的错误，而不是裸 ENOENT */
function readConfigOrExplain(file, exampleName) {
  if (!fs.existsSync(file)) {
    throw new Error(
      `找不到 ${relHome(file)}\n` +
        `  第一次用？模板已铺好，直接改：${relHome(path.join(DEFAULTS_DIR, exampleName || path.basename(file)))}\n` +
        `  也可以跑：node src/cli.mjs setup   （告诉 agent 该问用户什么）`,
    );
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${relHome(file)} 不是合法 JSON：${e.message}`);
  }
}

function loadCriteria() {
  const c = readConfigOrExplain(P.criteria, 'criteria.json');
  const ph = findPlaceholders(c);
  if (ph.length) {
    throw new Error(
      `${relHome(P.criteria)} 里还有 ${ph.length} 处没填（FILL_ME）：\n` +
        ph.map((p) => `    - ${p}`).join('\n') +
        `\n  这些都是「你的求职条件」，不能沿用模板。字段含义看 config.defaults/criteria.json 的 _README。`,
    );
  }
  return c;
}

/** 候选人背景 = 自动抓的简历 + 用户手写的补充 */
function loadProfile() {
  const parts = [];
  if (fs.existsSync(P.profileGen)) parts.push(fs.readFileSync(P.profileGen, 'utf8'));
  if (fs.existsSync(P.profileManual)) parts.push(fs.readFileSync(P.profileManual, 'utf8'));
  if (!parts.length) {
    throw new Error(
      '缺少候选人背景。先运行 `node src/cli.mjs resume` 自动抓取，或手写 config/profile.md',
    );
  }
  return parts.join('\n\n');
}

async function makeApi(port) {
  const cdp = await attachLite(port);
  const api = SITE.createApi(cdp);
  return { cdp, api };
}

// ─────────────────────────────── doctor ───────────────────────────────

async function cmdDoctor(argv) {
  console.log(`${C.c}job-auto doctor${C.x}   root=${ROOT}`);
  let hardFail = 0;
  const env = loadEnv(ROOT);

  // 0. 站点 + 路径分层
  head('0. 站点与路径');
  ok(`站点 ${SITE.id} —— ${SITE.label}`);
  dim(`技能目录 SKILL_ROOT = ${SKILL_ROOT}`);
  dim(`工作根   HOME       = ${HOME}   （config/state/artifacts/.env 都在这里）`);
  if (SKILL_ROOT !== HOME) dim('（代码与私人数据分离：换 JOB_APPLY_HOME 就能把数据搬到别处）');
  const created = ensureHome();
  if (created.length) ok(`首次运行：已初始化 ${created.length} 项（${created.slice(0, 4).join(', ')}${created.length > 4 ? '…' : ''}）`);

  // 1. .env
  head('1. 环境文件');
  if (env.loaded) ok(`.env 已加载 (${path.relative(ROOT, env.file)})`);
  else warn('.env 不存在 —— 将只用进程环境变量。可执行: Copy-Item .env.example .env');

  const cfg = llmConfig();
  // 本 skill 不调外部 LLM：生成能力永远由调用它的 agent 提供。
  ok('生成能力：由调用本 skill 的 agent 充当模型（不调用任何外部 LLM 接口）');
  dim('  需要产出的内容会写成待办文件（state/agent-llm/requests.json），由 agent 填后重跑。');

  // 2. limits
  head('2. 限速硬门 config/limits.json');
  let limits = null;
  try {
    limits = loadLimits(P.limits);
    ok(`日上限 ${limits.dailyCap} 条 | 间隔 ${limits.minDelayMs / 1000}-${limits.maxDelayMs / 1000}s（时间窗与熔断已移除）`);
    ok(`匹配度阈值 ${limits.matchThreshold} | 单轮上限 ${limits.maxJobsPerRun}`);
  } catch (e) {
    bad(`limits 无效: ${e.message}`);
    hardFail++;
  }

  const daily = loadDaily(P.daily);
  if (limits) {
    const pf = preflight(limits, daily);
    for (const c of pf.checks) (c.ok ? ok : warn)(`${c.name}: ${c.detail}`);
    if (!pf.ok) warn('当前 preflight 不通过 —— 现在不能发送（额度原因）');
  }

  // 2.5 打分要求（rubric）—— 换岗位后如果没重生成，打分口径就是错的
  head('2.5 打分要求 config/rubric.json');
  try {
    const cur = loadRubric();
    if (!cur) {
      warn('还没有打分要求 —— 打分会用内置通用口径（不够针对具体岗位，建议跑 rubric）');
      dim('生成: node src/cli.mjs rubric');
    } else {
      const criteria = readJsonSafe(P.criteria, {});
      const st = rubricStale(cur, criteria);
      if (st.stale) {
        bad(`打分要求已过期: ${st.why}`);
        dim('score / send 会自动重新生成（不想自动加 --no-auto-rubric）');
      } else {
        ok(`打分要求适用「${(cur.forKeywords || []).join('、')}」（${cur.generatedAt}${cur.editedBy ? `，${cur.editedBy === 'panel' ? '手工编辑过' : '编辑过'}` : ''}）`);
        const w = (cur.weights || []).map((x) => `${x.weight} ${x.name}`).join(' | ');
        dim(`权重: ${w}`);
      }
    }
  } catch (e) {
    warn(`读打分要求失败: ${e.message}`);
  }

  // 3. criteria
  head('3. 求职条件 config/criteria.json');
  try {
    const raw = readConfigOrExplain(P.criteria, 'criteria.json');
    const ph = findPlaceholders(raw);
    if (ph.length) {
      warn(`还有 ${ph.length} 处占位符没填 —— search/score/send 会拒绝运行`);
      ph.slice(0, 8).forEach((p) => dim(`- ${p}`));
      if (ph.length > 8) dim(`…还有 ${ph.length - 8} 处`);
      dim('填法看 config.defaults/criteria.json 的 _README，或跑 node src/cli.mjs setup 看该问用户什么');
      hardFail++;
    } else {
      ok(`keywords=${JSON.stringify(raw.keywords)}  cities=${JSON.stringify(raw.cities)}`);
      ok(`匹配阈值 ${limits?.matchThreshold}，排除词 ${(raw.excludeKeywords || []).length} 个`);
    }
  } catch (e) {
    bad(`criteria.json 读取失败: ${e.message}`);
    hardFail++;
  }

  // 4. 生成能力：永远由 agent 充当
  head('4. 生成能力（打分 / 打招呼语 / 打分要求 / 简历定制）');
  ok('模式：agent 充当 LLM（本 skill 不调用任何外部 LLM 接口）');
  dim('  需要产出的内容会写成待办文件，由调用本 skill 的 agent 填。');
  {
    const q = queueStatus();
    if (q.pendingCount) {
      warn(`有 ${q.pendingCount} 项待 agent 产出（来自 ${q.pendingCommand || '上一条命令'}）`);
      dim(`  待办：${relHome(q.pendingFile)}`);
      dim(`  填完写进：${relHome(responsesPath())}，然后重跑那条命令`);
    } else {
      dim(`  当前无待办；已有 ${q.cached} 项生成结果缓存`);
    }
  }

  // 5. CDP
  head('5. CDP 调试端口');
  const port = Number(flag(argv, '--port') || process.env.CDP_PORT || 9222);
  // 无头模式下 doctor 也把浏览器准备好（agent 不应先手动跑 start-chrome.ps1）
  let cdpInfo = null;
  try {
    if (AUTO_START) {
      const b = await ensureBrowser({ port, headless: HEADLESS, background: BACKGROUND, root: SKILL_ROOT, profileDir: P_.chromeProfile, startChrome: P_.startChrome });
      if (!b.ok) throw new Error(b.reason);
      cdpInfo = b.version;
      ok(`CDP ${b.launched ? '已拉起' : '已在线'}  ${cdpInfo?.Browser || ''}`);
      dim(`模式: ${b.background ? '有头 + 后台窗口 (window off-screen)' : b.headless ? '无头 (--headless=new)' : '有头'}${HEADLESS && !b.headless ? '  ← 你传了 --headless，但沿用的实例是有头的（无法就地切换）' : ''}`);
    } else {
      cdpInfo = await cdpProbe(port);
      if (!cdpInfo) throw new Error(`127.0.0.1:${port} 无 CDP 响应`);
      ok(`CDP 在线  ${cdpInfo.Browser}`);
    }
    dim('profile 必须是 .chrome-debug（Chrome>=136 不允许默认 profile 开调试）');
  } catch (e) {
    bad(`CDP 不可用: ${e.message}`);
    hardFail++;
  }

  if (cdpInfo) {
    // 6. 登录态
    // 改用 cdp-lite 探（原来是 Playwright）—— 让主流程零 playwright 依赖，技能目录才能单独拷走。
    head(`6. ${SITE.label} 登录态`);
    let probe = null;
    try {
      const cdp = await CdpLite.attach({ port, url: SITE.meta.homeUrl });
      const cookies = await cdp.getCookies().catch(() => []);
      const names = [...new Set(cookies.map((c) => c.name))];
      const html = await cdp.pageHtml().catch(() => '');
      const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
      const danger = await riskControlPage(cdp);
      probe = {
        url: await cdp.currentUrl().catch(() => ''),
        title: tm ? tm[1].replace(/\s+/g, ' ').trim() : '',
        cookieNames: names,
        hasAuthCookie: names.includes(SITE.meta.cookieName),
        blocked: danger.blocked,
      };
      await cdp.close().catch(() => {});

      dim(`url=${probe.url}`);
      dim(`title=${probe.title}`);
      if (probe.blocked) {
        bad('被风控拦住（验证码页）—— 需要你本人在普通 Chrome 里人工过验证码');
        console.log(danger.hint.split('\n').map((l) => `  ${l}`).join('\n'));
        hardFail++;
      } else if (probe.hasAuthCookie) ok(`${SITE.meta.cookieName} cookie 存在 → 登录态已建立`);
      else bad(`未找到 ${SITE.meta.cookieName} cookie → 需要在该 Chrome 里手动登录`);
      if (!probe.hasAuthCookie && !probe.blocked) hardFail++;
      dim(`cookies: ${probe.cookieNames.join(', ') || '(none)'}`);
    } catch (e) {
      bad(`登录态探测失败: ${e.message}`);
      hardFail++;
    }
  }

  head('结论');
  if (hardFail === 0) {
    console.log(`${C.g}环境就绪：可以进入 search / rubric / score 阶段。${C.x}`);
  } else {
    console.log(`${C.r}有 ${hardFail} 项硬性阻塞，先解决上面的 ✗ 再继续。${C.x}`);
  }
  return hardFail === 0 ? 0 : 2;
}

// ─────────────────────────────── recon ───────────────────────────────

const DOM_INTEL = () => {
  const txt = (el) => (el?.innerText || '').replace(/\s+/g, ' ').trim();
  const cls = (el) => String(el?.className || '').slice(0, 160);

  const inputs = [...document.querySelectorAll('input,textarea,[contenteditable="true"]')]
    .slice(0, 40)
    .map((el) => ({
      tag: el.tagName,
      type: el.getAttribute('type') || '',
      placeholder: el.getAttribute('placeholder') || '',
      id: el.id || '',
      name: el.getAttribute('name') || '',
      cls: cls(el),
    }));

  const buttons = [...document.querySelectorAll('button,[role="button"],a')]
    .slice(0, 400)
    .map((el) => ({ tag: el.tagName, text: txt(el).slice(0, 40), cls: cls(el), href: el.getAttribute('href') || '' }))
    .filter((b) => b.text && b.text.length <= 40)
    .slice(0, 120);

  // 启发式：反复出现的、类名里带 job/card/item/list 的容器 = 列表卡片
  const counts = new Map();
  for (const el of document.querySelectorAll('div,li,article,section')) {
    const c = String(el.className || '').trim();
    if (!c || c.length > 120) continue;
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  const repeated = [...counts.entries()]
    .filter(([c, n]) => n >= 4 && /job|position|card|item|list|result|search/i.test(c))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([c, n]) => ({ cls: c, count: n }));

  const jobLinks = [...document.querySelectorAll('a[href]')]
    .map((a) => a.getAttribute('href'))
    .filter((h) => /job|position|zhaopin/i.test(h || ''));
  const uniqJobLinks = [...new Set(jobLinks)].slice(0, 20);

  return {
    url: location.href,
    title: document.title,
    viewport: { w: innerWidth, h: innerHeight },
    inputs,
    buttons,
    repeated,
    jobLinkSamples: uniqJobLinks,
    jobLinkCount: jobLinks.length,
    bodyStart: (document.body?.innerText || '').slice(0, 1200),
    localStorageKeys: Object.keys(localStorage).slice(0, 40),
  };
};

async function cmdRecon(argv) {
  const port = Number(flag(argv, '--port') || process.env.CDP_PORT || 9222);
  const targetUrl = flag(argv, '--url') || 'https://c.liepin.com/';
  const stamp = ts();
  console.log(`${C.c}job-auto recon${C.x}  port=${port}  url=${targetUrl}`);

  const { browser, version } = await connectCdp(port);
  activeBrowser = browser;
  console.log(`  browser: ${version.Browser}`);

  const page = await getLiepinPage(browser, { create: true, url: targetUrl });
  if (!page) throw new Error('无法取得猎聘页面');

  // ── 网络侦察：监听 JSON 响应，再导航一次以捕获首次加载的接口 ──
  const apiHits = [];
  const onResponse = async (res) => {
    try {
      const url = res.url();
      if (!/liepin\.com/.test(url)) return;
      const ct = res.headers()['content-type'] || '';
      if (!/json|javascript/.test(ct)) return;
      const entry = { url, status: res.status(), ct: ct.split(';')[0] };
      if (/json/.test(ct)) {
        try {
          const body = await res.json();
          entry.shape = Array.isArray(body) ? `array[${body.length}]` : `object{${Object.keys(body).slice(0, 12).join(',')}}`;
        } catch {
          entry.shape = '(unparsable)';
        }
      }
      apiHits.push(entry);
    } catch {
      /* 响应体已被丢弃等 */
    }
  };
  page.on('response', onResponse);

  console.log('  导航并采集 XHR...');
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const settleMs = await waitStable(page, { quietMs: 1500, maxMs: 25000 });
  console.log(`  页面稳定耗时 ${settleMs}ms`);
  await new Promise((r) => setTimeout(r, 1500));
  page.off('response', onResponse);

  const urlNow = page.url();
  console.log(`  采集前 URL: ${urlNow}`);
  if (!/^https?:/.test(urlNow)) {
    throw new Error(
      `采集前页面已不在真实网页上（url=${urlNow}）。通常是标签页被外部关闭/登录弹窗顶替。\n` +
        `重试时显式指定网址：node src/cli.mjs recon --url "https://c.liepin.com/"`,
    );
  }

  const intel = await page.evaluate(DOM_INTEL);
  const login = await probeLogin(page);
  console.log(`  采集后 URL: ${intel.url}`);

  const shotFile = path.join(P.screens, `recon-${stamp}.png`);
  const shotResult = await shot(page, shotFile);

  const report = {
    stamp,
    port,
    browser: version.Browser,
    login: { hasLtAuthCookie: login.hasLtAuthCookie, domLoginPrompt: login.domLoginPrompt, cookieNames: login.cookieNames },
    intel,
    api: apiHits,
    screenshot: shotResult,
  };

  ensureDir(P.evidence);
  const jsonFile = path.join(P.evidence, `recon-${stamp}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2), 'utf8');

  const lines = [];
  lines.push(`# recon ${stamp}`);
  lines.push(`browser   : ${version.Browser}`);
  lines.push(`url       : ${intel.url}`);
  lines.push(`title     : ${intel.title}`);
  lines.push(`viewport  : ${intel.viewport.w}x${intel.viewport.h}`);
  lines.push(`login     : lt_auth=${login.hasLtAuthCookie}  loginPrompt=${JSON.stringify(login.domLoginPrompt)}`);
  lines.push(`screenshot: ${shotResult}`);
  lines.push('');
  lines.push(`## 输入控件 (${intel.inputs.length})`);
  for (const i of intel.inputs) lines.push(`  <${i.tag} type=${i.type}> ph="${i.placeholder}" id="${i.id}" cls="${i.cls}"`);
  lines.push('');
  lines.push(`## 重复出现的候选卡片容器 (${intel.repeated.length})`);
  for (const r of intel.repeated) lines.push(`  x${String(r.count).padStart(3)}  .${r.cls}`);
  lines.push('');
  lines.push(`## 职位链接样本 (共 ${intel.jobLinkCount})`);
  for (const h of intel.jobLinkSamples) lines.push(`  ${h}`);
  lines.push('');
  lines.push(`## 按钮/链接文本 (${intel.buttons.length})`);
  for (const b of intel.buttons.slice(0, 60)) lines.push(`  [${b.tag}] ${b.text}   cls="${b.cls}"`);
  lines.push('');
  lines.push(`## JSON 接口 (${apiHits.length})`);
  for (const a of apiHits) lines.push(`  ${a.status}  ${a.url}\n        ${a.ct} ${a.shape || ''}`);
  lines.push('');
  lines.push('## 页面文本开头');
  lines.push(intel.bodyStart);
  lines.push('');
  lines.push('## localStorage keys');
  lines.push('  ' + intel.localStorageKeys.join(', '));

  const txtFile = path.join(P.evidence, `recon-${stamp}.txt`);
  fs.writeFileSync(txtFile, lines.join('\n'), 'utf8');

  // 控制台只打最关键的结论
  head('登录态');
  (login.hasLtAuthCookie ? ok : bad)(`lt_auth cookie = ${login.hasLtAuthCookie}`);
  head('重复卡片候选（这些就是职位卡片的可能选择器）');
  for (const r of intel.repeated.slice(0, 12)) dim(`x${String(r.count).padStart(3)}  .${r.cls}`);
  head('JSON 接口');
  for (const a of apiHits.slice(0, 25)) dim(`${a.status}  ${a.url.slice(0, 150)}`);
  head('输入控件');
  for (const i of intel.inputs.slice(0, 12)) dim(`<${i.tag}> ph="${i.placeholder}" cls="${i.cls.slice(0, 60)}"`);
  head('产物');
  ok(jsonFile);
  ok(txtFile);
  ok(shotResult);

  return 0;
}

// ─────────────────────────────── search ───────────────────────────────

async function cmdSearch(argv) {
  const port = Number(flag(argv, '--port') || process.env.CDP_PORT || 9222);
  const criteria = loadCriteria();
  const limits = loadLimits(P.limits);
  // --key 只搜单个关键词；不传则把 criteria.keywords 里的全部搜一遍再合并去重
  // （以前只取 keywords[0]，配了 5 个关键词实际只搜了第一个）
  const onlyKey = flag(argv, '--key');
  const keys = (onlyKey ? [onlyKey] : criteria.keywords || []).filter(Boolean);
  const dq = flag(argv, '--dq') || String(criteria.districtDqCode || criteria.dqCode || '020');
  const city = flag(argv, '--city') || String(criteria.cityCode || '020');
  const workYearCode = flag(argv, '--workYear') || String(criteria.workYearCode ?? '2');
  const maxPages = Number(flag(argv, '--pages') || criteria.searchPages || 2);
  // 搜索筛选器（地区/薪资/学历/发布时间/公司规模…）。空值一律不送，避免空串被当成条件。
  const searchForm = Object.fromEntries(
    Object.entries(criteria.searchForm || {}).filter(([k, v]) => !k.startsWith('_') && v !== '' && v != null),
  );
  const stamp = ts();

  console.log(
    `${C.c}job-auto search${C.x}  ${keys.length} 个关键词 city=${city} dq=${dq} 每词 pages<=${maxPages}`,
  );
  for (const k of keys) dim(`  keyword: ${k}`);
  dim(
    Object.keys(searchForm).length
      ? `  筛选器: ${Object.entries(searchForm).map(([k, v]) => `${k}=${v}`).join('  ')}`
      : '  筛选器: 无（全部不限）',
  );

  const cdp = await attachLite(port);
  console.log(`  cdp-lite 已连接 ${cdp.browserVersion}（无 Runtime 域）`);

  const cookies = await cdp.getCookies();
  SITE.saveCookies(P.cookies, cookies.map((c) => ({ ...c })));
  console.log(`  已缓存 ${cookies.length} 个 cookie -> ${path.relative(ROOT, P.cookies)}`);

  const api = SITE.createApi(cdp);

  const rawJobs = [];
  const seenIds = new Set();
  let lastPagination = null;
  for (const [ki, keyword] of keys.entries()) {
    if (keys.length > 1) console.log(`  [${ki + 1}/${keys.length}] keyword="${keyword}"`);
    const { jobs, pagination } = await api.searchAll(
      { keyword, city, dq, pageSize: 40, workYearCode, extraForm: searchForm },
      {
        maxPages,
        onPage: ({ page, got, total, pagination: pg }) =>
          console.log(
            `  page ${page}: +${got} 条（本词累计 ${total}）  totalCounts=${pg.totalCounts ?? '?'} hasNext=${pg.hasNext}`,
          ),
      },
    );
    lastPagination = pagination || lastPagination;
    let added = 0;
    for (const r of jobs) {
      const id = String(r?.job?.jobId ?? '');
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      rawJobs.push(r);
      added++;
    }
    if (keys.length > 1) console.log(`    拿到 ${jobs.length} 条，去重后新增 ${added}，累计 ${rawJobs.length}`);
  }
  const pagination = lastPagination;

  console.log(`\n  共抓到 ${rawJobs.length} 条（已按 jobId 去重），开始归一化与预过滤...`);

  const kept = [];
  const dropped = [];
  const locMiss = [];
  for (const r of rawJobs) {
    const job = normalizeJob(r);
    const pf = prefilter(job, criteria);
    if (!pf.keep) {
      dropped.push({ job, reason: pf.reason });
      continue;
    }
    const loc = matchesLocation(job, criteria);
    job.locationMatched = loc.matched;
    if (!loc.ok) locMiss.push(job);
    kept.push(job);
  }

  head('搜索结果');
  ok(`原始 ${rawJobs.length} 条 -> 排除词丢 ${dropped.length} -> 保留 ${kept.length}`);
  if (criteria.locationKeywords?.length) {
    const inLoc = kept.filter((j) => j.locationMatched.length).length;
    (inLoc ? ok : warn)(`命中地区关键词 ${JSON.stringify(criteria.locationKeywords)}: ${inLoc} 条`);
    if (!inLoc) dim('地区关键词一条未命中 —— 可能是列表页没有把区名放进 area 字段，需看详情页');
  }
  dim(`pagination: ${JSON.stringify(pagination)}`);

  head('前 15 条');
  for (const j of kept.slice(0, 15)) console.log(`  ${jobSummaryLine(j)}`);

  // 落盘
  ensureDir(path.join(ROOT, 'artifacts'));
  const seen = new Set();
  for (const j of kept) {
    const k = j.jobId || j.link;
    if (seen.has(k)) continue;
    seen.add(k);
    appendJsonl(P.jobs, { ...j, raw: undefined, searchedAt: stamp, keyword });
  }
  ok(`职位写入 ${path.relative(ROOT, P.jobs)}（去重后 ${seen.size} 条）`);

  ensureDir(P.evidence);
  const sampleFile = path.join(P.evidence, 'raw-job-sample.json');
  fs.writeFileSync(sampleFile, JSON.stringify(rawJobs[0] ?? null, null, 2), 'utf8');
  const reportFile = path.join(P.evidence, `search-${stamp}.json`);
  fs.writeFileSync(
    reportFile,
    JSON.stringify(
      {
        stamp,
        keyword,
        city,
        dq,
        workYearCode,
        pagination,
        rawCount: rawJobs.length,
        dropped: dropped.slice(0, 30).map((d) => ({ title: d.job.title, company: d.job.company, reason: d.reason })),
        kept: kept.map((j) => ({ ...j, raw: undefined })),
      },
      null,
      2,
    ),
    'utf8',
  );

  head('产物');
  ok(sampleFile);
  ok(reportFile);
  dim('样例文件用于核对真实字段名，下一步据它校准 normalize.mjs');

  return 0;
}

// ─────────────────────────────── dq ───────────────────────────────

/**
 * 解析地区码。猎聘的 dq 码决定了实际的地域过滤：
 * dq=410 是「全国」，会覆盖 city 参数 —— 这就是之前搜「上海」却出了南京/威海/北京的原因。
 */
async function cmdDq(argv) {
  const port = Number(flag(argv, '--port') || process.env.CDP_PORT || 9222);
  const find = flag(argv, '--find') || '上海|浦东|临港|南汇';
  const re = new RegExp(find);

  console.log(`${C.c}job-auto dq${C.x}  find=/${find}/`);
  const cdp = await attachLite(port);
  const api = SITE.createApi(cdp);

  const init = await api.condInit('410');
  head('搜索筛选项初始化 (cond-init)');

  const showCodes = (label, arr) => {
    if (!Array.isArray(arr) || !arr.length) return;
    const hits = arr.filter((x) => re.test(String(x.name ?? x.dqName ?? '')));
    (hits.length ? ok : dim)(
      `${label}: ${arr.length} 项` + (hits.length ? ` -> 命中 ${JSON.stringify(hits)}` : ''),
    );
  };
  showCodes('hotCities', init.hotCities);
  showCodes('dqs', init.dqs);
  showCodes('salaries', init.salaries);
  showCodes('workExperiences', init.workExperiences);
  showCodes('educations', init.educations);

  head('hotCities 全量');
  for (const c of init.hotCities || []) console.log(`  ${String(c.code).padEnd(8)} ${c.name}`);

  head('workExperiences 全量（用于择定 workYearCode）');
  for (const c of init.workExperiences || []) console.log(`  ${String(c.code).padEnd(8)} ${c.name}`);

  head('全量地区码表 get-all-dq');
  try {
    const all = await api.allDq();
    const hits = SITE.findDq(all, re);
    if (hits.length) {
      for (const h of hits.slice(0, 60)) console.log(`  ${h.code.padEnd(14)} ${h.name}   (${h.path})`);
    } else {
      dim('未命中。抽样看字段名：');
      console.log(`    ${JSON.stringify(all).slice(0, 1200)}`);
    }
  } catch (e) {
    bad(`get-all-dq 失败: ${e.message}`);
  }

  return 0;
}

// ─────────────────────────────── resume ───────────────────────────────

async function cmdResume(argv) {
  const port = Number(flag(argv, '--port') || process.env.CDP_PORT || 9222);
  console.log(`${C.c}job-auto resume${C.x}  从你自己的猎聘简历自动抓取候选人背景`);

  const { api } = await makeApi(port);
  const [resume, userInfo, expect] = await Promise.all([
    fetchResumeRaw(api),
    fetchUserInfo(api).catch(() => null),
    fetchExpect(api).catch(() => null),
  ]);

  const md = formatResumeMarkdown(resume, userInfo, expect);
  const q = resumeQuality(md);

  head('简历抓取结果');
  ok(`原始 ${JSON.stringify(resume).length} 字节 -> 格式化 ${md.length} 字符`);
  (q.hasWork ? ok : warn)(`工作经历: ${q.hasWork ? '有' : '无'}`);
  (q.hasProject ? ok : warn)(`项目经历: ${q.hasProject ? '有' : '无'}`);
  if (!q.usable) warn('简历内容偏少，建议再手写 config/profile.md 补充亮点');

  fs.writeFileSync(P.profileGen, md, 'utf8');
  ok(`已写入 ${path.relative(ROOT, P.profileGen)}`);

  if (userInfo?.chatSetting?.sayHiText) {
    head('平台自带的模板打招呼语（我们要替换掉的）');
    warn(`"${userInfo.chatSetting.sayHiText}"`);
  }

  // 附件简历：发回简历时要靠它，先确认到底有没有传过
  head('附件简历（发简历功能依赖它）');
  const atts = resume.attachmentResumeList || resume.attachmentResume || [];
  if (Array.isArray(atts) && atts.length) {
    ok(`已上传 ${atts.length} 个附件简历`);
    for (const a of atts) {
      console.log(
        `  ${a.fileName || a.name || '(无文件名)'}  ${a.fileSize ? Math.round(a.fileSize / 1024) + 'KB' : ''}  ${a.updateTime || a.createTime || ''}`,
      );
    }
  } else {
    bad('未检测到附件简历 —— 聊天窗里的“发附件简历”将无东西可发');
    dim(`原始 attachmentResumeList = ${JSON.stringify(atts)}`);
    dim('需要你先在猎聘网页版上传一份 PDF 简历（我的简历 → 附件简历）');
  }
  if (resume.resName) dim(`简历名称: ${resume.resName}`);
  if (resume.completeDegree !== undefined) dim(`简历完整度: ${resume.completeDegree}%`);

  head('简历 Markdown 预览');
  console.log(md.slice(0, 2200));
  return 0;
}

// ─────────────────────────────── detail ───────────────────────────────

async function cmdDetail(argv) {
  const limits = loadLimits(P.limits);
  const cap = Number(flag(argv, '--max') || 12);
  // --min 允许忽略阈值先批量补 JD（打分前需要 JD，但详情抓取又按分数筛选，会形成鸡生蛋问题）
  const minScore = flag(argv, '--min') !== undefined ? Number(flag(argv, '--min')) : limits.matchThreshold;

  if (!fs.existsSync(P.scored)) throw new Error('先跑：node src/cli.mjs score');
  const scored = JSON.parse(fs.readFileSync(P.scored, 'utf8'));

  // 只抓达阀且未沟通的，避免无谓请求
  const targets = scored.jobs
    .filter((j) => (j.ai?.score ?? -1) >= minScore)
    .filter((j) => !j.chatted)
    .slice(0, cap);

  console.log(`${C.c}job-auto detail${C.x}  抓 ${targets.length} 个职位的 JD（minScore=${minScore}, SSR 页面，串行 + 拟人延时）`);
  ensureDir(P.details);
  const { cdp } = await makeApi(Number(flag(argv, '--port') || process.env.CDP_PORT || 9222));

  let okCount = 0;
  for (const [i, job] of targets.entries()) {
    process.stdout.write(`  [${i + 1}/${targets.length}] ${String(job.title).slice(0, 28)} ... `);
    try {
      const d = await fetchJobDetail(cdp, job.link);
      const rec = { jobId: job.jobId, title: job.title, company: job.company, ...d, pageText: undefined };
      fs.writeFileSync(path.join(P.details, `${job.jobId}.json`), JSON.stringify(rec, null, 2), 'utf8');
      // 同时把整页文本存到 evidence，便于事后校准标记
      fs.writeFileSync(
        path.join(P.evidence, `detail-${job.jobId}.txt`),
        `URL: ${job.link}\nJD MARKER: ${d.jdMarker}\n\n${d.jd || '(未切出 JD)'}\n\n--- 公司简介 ---\n${d.companyIntro || '(无)'}\n\n--- 原始整页文本 ---\n${d.pageText}`,
        'utf8',
      );
      if (d.jd) {
        okCount++;
        console.log(`JD ${d.jd.length}字  公司简介 ${d.companyIntro ? d.companyIntro.length + '字' : '无'}`);
      } else {
        console.log(`${C.y}未切出 JD${C.x} (整页 ${d.pageTextLength} 字)`);
      }
    } catch (e) {
      console.log(`${C.r}失败${C.x} ${e.message}`);
    }
    if (i < targets.length - 1) await new Promise((r) => setTimeout(r, 2500 + Math.random() * 2500));
  }

  head('详情抓取结果');
  ok(`${okCount}/${targets.length} 个职位成功切出 JD`);
  dim(`缓存目录 ${path.relative(ROOT, P.details)}`);
  if (okCount === 0) warn('一个都没切出 —— 看 evidence/detail-*.txt 的整页文本，需要校准 extractJd 的标记词');
  warn('详情已变，建议重跑 score 让打分用上 JD 正文');
  return 0;
}

// ─────────────────────────────── score ───────────────────────────────

/** 已缓存的职位详情（artifacts/details/<jobId>.json），按 jobId 索引 */
function loadDetailCache() {
  const map = new Map();
  if (!fs.existsSync(P.details)) return map;
  for (const f of fs.readdirSync(P.details)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(P.details, f), 'utf8'));
      if (d.jobId) map.set(String(d.jobId), d);
    } catch {
      /* 损坏单项跳过 */
    }
  }
  return map;
}

function loadJobs() {
  const jobs = readJsonl(P.jobs);
  if (!jobs.length) throw new Error(`没有职位数据，先跑：node src/cli.mjs search`);
  const uniq = new Map();
  const details = loadDetailCache();
  for (const j of jobs) {
    const k = j.jobId || j.link;
    const d = details.get(String(j.jobId));
    uniq.set(k, d ? { ...j, jd: d.jd, companyIntro: d.companyIntro } : j);
  }
  return [...uniq.values()];
}

// ──────────────────────── 打分要求（rubric）────────────────────────
// 原来打分口径写死在 ai.mjs 的 SCORE_SYSTEM 里（「AI Agent」+「临港最优」），
// 换岗位就被打歪分。现在让 AI 依据「目标岗位 + 候选人背景 + 真实岗位样本」
// 生成岗位专属的打分要求，存 config/rubric.json。

/** 生成一份打分要求（并在需要时落盘） */
async function makeRubric(cfg, criteria, profile, { save = true } = {}) {
  const jobs = loadJobs().filter((j) => j.title && j.company);
  // 样本要能代表市场写法：抽最多 15 条，标题去重
  const seen = new Set();
  const sample = [];
  for (const j of jobs) {
    const k = String(j.title).trim();
    if (seen.has(k)) continue;
    seen.add(k);
    sample.push(j);
    if (sample.length >= 15) break;
  }
  console.log(`  依据: 目标岗位 ${(criteria.keywords || []).join('、')}`);
  console.log(`       候选人背景 ${profile.length} 字，真实岗位样本 ${sample.length} 条`);
  const t0 = Date.now();
  const r = await generateRubric(cfg, criteria, profile, sample);
  console.log(`  生成完毕 ${((Date.now() - t0) / 1000).toFixed(1)}s  权重合计 ${r.weights.reduce((a, b) => a + b.weight, 0)}`);
  if (save) {
    saveRubric(r);
    ok(`已写入 ${path.relative(ROOT, RUBRIC_PATH)}（备份保留最近 3 份）`);
  }
  return r;
}

function printRubric(r) {
  console.log(`\n${C.c}岗位方向${C.x}  ${r.roles}`);
  if (r.targetProfile) console.log(`${C.c}目标画像${C.x}  ${r.targetProfile}`);
  if (r.weights?.length) {
    console.log(`\n${C.c}权重${C.x}`);
    for (const w of r.weights) console.log(`  ${String(w.weight).padStart(3)} 分  ${w.name}${w.desc ? ` — ${w.desc}` : ''}`);
  }
  for (const [k, label] of [['mustHave', '硬性要求'], ['niceToHave', '加分项'], ['disqualifiers', '直接低分'], ['rules', '特有规则']]) {
    if (r[k]?.length) {
      console.log(`\n${C.c}${label}${C.x}`);
      for (const x of r[k]) console.log(`  - ${x}`);
    }
  }
  if (r.bands?.length) {
    console.log(`\n${C.c}分数区间${C.x}`);
    for (const b of r.bands) console.log(`  ${b.range}  ${b.meaning}`);
  }
  if (r.notes) console.log(`\n${C.c}补充${C.x}  ${r.notes}`);
}

async function cmdRubric(argv) {
  const criteria = loadCriteria();
  const profile = loadProfile();
  const cfg = llmConfig();
  const printOnly = argv.includes('--print');
  const show = !argv.includes('--quiet');

  console.log(`${C.c}job-auto rubric${C.x}  依据目标岗位生成打分要求  模型 agent（充当 LLM）`);

  // agent 充当 LLM 时先预检：打 zh 分要求本身也要模型产出
  if (agentPreflight(cfg, rubricPrompts(criteria, profile, loadJobs().slice(0, 15)), 'node src/cli.mjs rubric', '一份打分要求')) {
    return NEED_AGENT_LLM_EXIT;
  }

  const old = loadRubric();
  if (old && !printOnly) {
    const st = rubricStale(old, criteria);
    if (st.stale) warn(`现有打分要求已过期：${st.why}`);
    else console.log(`  现有打分要求仍适用（为「${(old.forKeywords || []).join('、')}」生成，${old.generatedAt || '?'}）`);
  }

  try {
    const r = await makeRubric(cfg, criteria, profile, { save: !printOnly });
    if (show || printOnly) printRubric(r);
    if (printOnly) dim('(--print：只显示，没写入文件)');
    return 0;
  } catch (e) {
    bad(`生成失败：${e.message}`);
    return 1;
  }
}

/** score/draft/send 共用：拿一个可用的 rubric；缺失或过期就自动生成 */
async function ensureRubric(cfg, criteria, profile, { noAuto = false } = {}) {
  const cur = loadRubric();
  const st = rubricStale(cur, criteria);
  if (!st.stale) return cur;

  if (noAuto) {
    warn(`打分要求不可用：${st.why}`);
    warn('  （--no-auto-rubric 已关闭自动生成，本次将退回内置口径）');
    return null;
  }

  // agent 充当 LLM：不能再静默“自动生成” —— 那需要一次逐回。
  // 直接把待办交出去，让 agent 跑 `rubric` 补上，而不是在这里降级成内置口径
  // （内置口径是通用版，不针对当前目标岗位，打分偏粗）。
  if (isAgentMode(cfg)) {
    const prompts = rubricPrompts(criteria, profile, loadJobs().slice(0, 15));
    const { missing } = checkPrompts(prompts);
    if (missing.length) {
      const file = writeRequests('node src/cli.mjs rubric', missing);
      warn(`打分要求不可用：${st.why}`);
      warn(`  已把生成任务写入 ${relHome(file)} —— 先跑 rubric 补上，再重跑本命令。`);
      warn('  （不用内置口径兜底：它是通用版，不针对当前目标岗位，打分偏粗）');
      return null;
    }
    return makeRubric(cfg, criteria, profile);
  }

  console.log(`${C.c}打分要求${C.x}  ${st.why} → 自动生成中…`);
  try {
    return await makeRubric(cfg, criteria, profile);
  } catch (e) {
    bad(`自动生成打分要求失败：${e.message}`);
    warn('  本次退回内置口径继续跑（不会因为打分要求生成失败就罢工）');
    return null;
  }
}

async function cmdScore(argv) {
  const limits = loadLimits(P.limits);
  const criteria = loadCriteria();
  const profile = loadProfile();
  const cfg = llmConfig();
  const jobs = loadJobs();

  const onlyUnchatted = !argv.includes('--include-chatted');
  const pool = onlyUnchatted ? jobs.filter((j) => !j.chatted) : jobs;
  const cap = Number(flag(argv, '--max') || limits.maxJobsPerRun);
  const target = pool.slice(0, cap);

  // 打分要求：没有 / 过期就自动生成（--no-auto-rubric 可关）
  const rubric = await ensureRubric(cfg, criteria, profile, { noAuto: argv.includes('--no-auto-rubric') });
  if (rubricBlocked(cfg, rubric)) return NEED_AGENT_LLM_EXIT;

  // agent 充当 LLM 时：预检全部批次的 prompt，缺的一次性交出去（避免逐批来回）
  const cmd = `node src/cli.mjs score --max ${target.length}${argv.includes('--merge') ? ' --merge' : ''}`;
  if (
    agentPreflight(cfg, scorePrompts(target, criteria, profile, { rubric }), cmd, ` ${target.length} 条岗位的匹配度打分`)
  ) {
    return NEED_AGENT_LLM_EXIT;
  }

  // 防误操作：score 是**覆盖写**，--max 取小了会把上次打好的结果截掉
  // （历史上出过：默认 max=3，一次调用把 24 条缩成 3 条）
  const prevScored = readJsonSafe(P.scored);
  const prevCount = prevScored?.jobs?.length ?? 0;
  if (prevCount > target.length) {
    warn(`注意：本次只评 ${target.length} 条，会覆盖上次的 ${prevCount} 条打分结果。`);
    warn(`  想保留请把 --max 调大（当前池子 ${pool.length} 条），或加 --merge 只合并不截断。`);
  }

  console.log(`${C.c}job-auto score${C.x}  待评 ${target.length}/${pool.length} 条（已沟通 ${jobs.length - pool.length} 条已排除）`);
  console.log(`  模型 agent（充当 LLM） | 阈值 ${limits.matchThreshold}`);

  const results = await scoreJobs(cfg, target, criteria, profile, {
    rubric,
    onProgress: ({ batch, total, done }) => console.log(`  batch ${batch}/${total} 累计已评 ${done}`),
  });

  const scored = target.map((j) => ({ ...j, ai: results.get(String(j.jobId)) || { score: null } }));

  // --merge：把上次已打分的、本轮没评到的岗位保留下来（按 jobId 去重，本轮优先）
  if (argv.includes('--merge') && prevScored?.jobs?.length) {
    const freshIds = new Set(scored.map((j) => String(j.jobId)));
    const kept = prevScored.jobs.filter((j) => !freshIds.has(String(j.jobId)));
    if (kept.length) {
      scored.push(...kept);
      ok(`--merge：保留上次 ${kept.length} 条未重评的打分结果`);
    }
  }

  scored.sort((a, b) => (b.ai.score ?? -1) - (a.ai.score ?? -1));

  if (prevCount > 0 && scored.length < prevCount) {
    bad(`scored.json 从 ${prevCount} 条缩到 ${scored.length} 条（覆盖写）。下次可加 --merge 避免。`);
  }

  fs.writeFileSync(
    P.scored,
    JSON.stringify({ scoredAt: ts(), threshold: limits.matchThreshold, count: scored.length, jobs: scored }, null, 2),
    'utf8',
  );

  head('打分结果');
  const above = scored.filter((j) => (j.ai.score ?? -1) >= limits.matchThreshold);
  ok(`达到阈值 ${limits.matchThreshold} 分的：${above.length} / ${scored.length}`);

  head('Top 15');
  for (const j of scored.slice(0, 15)) {
    const s = j.ai.score ?? '--';
    const loc = j.locationMatched?.length ? `  ★${j.locationMatched.join('/')}` : '';
    console.log(`  [${String(s).padStart(3)}] ${jobSummaryLine(j)}${loc}`);
    if (j.ai.reason) dim(j.ai.reason);
  }

  ok(`已写入 ${path.relative(ROOT, P.scored)}`);
  return 0;
}

/**
 * agent 模式下 rubric 拿不到时，不要用内置兜底口径继续跑
 * （内置口径是通用版，不针对当前目标岗位，打分偏粗）。
 * ensureRubric 已经报了原因并写了待办，这里只负责把流程停下。
 */
function rubricBlocked(cfg, rubric) {
  return isAgentMode(cfg) && !rubric;
}

// ─────────────────────────────── draft ───────────────────────────────

async function cmdDraft(argv) {
  const limits = loadLimits(P.limits);
  const criteria = loadCriteria();
  const profile = loadProfile();
  const cfg = llmConfig();

  const rubric = await ensureRubric(cfg, criteria, profile, { noAuto: argv.includes('--no-auto-rubric') });
  if (rubricBlocked(cfg, rubric)) return NEED_AGENT_LLM_EXIT;

  if (!fs.existsSync(P.scored)) throw new Error('先跑：node src/cli.mjs score');
  const scored = JSON.parse(fs.readFileSync(P.scored, 'utf8'));
  const sentIds = new Set(readJsonl(P.sent).map((r) => String(r.jobId)));
  const cap = Number(flag(argv, '--max') || limits.maxJobsPerRun);
  const eligible = scored.jobs
    .filter((j) => (j.ai?.score ?? -1) >= limits.matchThreshold)
    .filter((j) => !j.chatted)
    .filter((j) => !sentIds.has(String(j.jobId)))
    .slice(0, cap);

  console.log(`${C.c}job-auto draft${C.x}  为 ${eligible.length} 个达标职位生成打招呼语（模型 agent（充当 LLM））`);

  // agent 充当 LLM 时预检：一轮把重试轮的 prompt 也一起要上（通常重试轮用不到，但要多要了也只能多要）
  if (
    agentPreflight(
      cfg,
      eligible.map((job) => greetPrompt(job, criteria, profile, job.ai, { rubric })).map((p) => {
        const { system, user } = splitMessages(p.messages);
        return { kind: 'greet', system, user, meta: p.meta };
      }),
      `node src/cli.mjs draft --max ${eligible.length}`,
      ` ${eligible.length} 条打招呼语`,
    )
  ) {
    return NEED_AGENT_LLM_EXIT;
  }

  const drafts = [];
  for (const [i, job] of eligible.entries()) {
    process.stdout.write(`  [${i + 1}/${eligible.length}] ${job.title?.slice(0, 30)} ... `);
    try {
      const { greeting, lint, attempt, attempts } = await draftGreetingChecked(
        cfg,
        job,
        criteria,
        profile,
        job.ai,
        { attempts: 3, rubric },
      );
      drafts.push({
        jobId: job.jobId,
        title: job.title,
        company: job.company,
        area: job.area,
        salary: job.salary,
        link: job.link,
        recruiterName: job.recruiterName,
        seniorTitle: job.recruiterTitle,
        imId: job.recruiterImId,
        imUserType: job.recruiterImUserType,
        chatted: job.chatted,
        score: job.ai?.score ?? null,
        reason: job.ai?.reason || '',
        greeting,
        lint,
        attempt,
      });
      console.log(
        lint.ok
          ? `${C.g}ok${C.x} (${greeting.length}字${attempt > 1 ? `, 第${attempt}次` : ''})`
          : `${C.y}lint${C.x} 重试${attempts}次仍不合格: ${lint.problems.join(';')}`,
      );
    } catch (e) {
      console.log(`${C.r}失败${C.x} ${e.message}`);
      drafts.push({ jobId: job.jobId, title: job.title, company: job.company, link: job.link, error: e.message });
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const payload = {
    draftedAt: ts(),
    count: drafts.length,
    cleanCount: drafts.filter((d) => d.lint?.ok).length,
    drafts,
  };
  fs.writeFileSync(P.drafts, JSON.stringify(payload, null, 2), 'utf8');

  head('生成的打招呼语');
  for (const d of drafts) {
    if (d.error) {
      bad(`${d.title} @${d.company} -> ${d.error}`);
      continue;
    }
    console.log(`\n  ${C.c}[${d.score}] ${d.title}${C.x}  @${d.company}  [${d.area}] ${d.salary}`);
    console.log(`  → ${d.greeting}`);
    if (!d.lint.ok) dim(`  lint: ${d.lint.problems.join('; ')}`);
  }
  ok(`已写入 ${path.relative(ROOT, P.drafts)}`);
  return 0;
}

// ─────────────────────────────── send ───────────────────────────────

async function cmdSend(argv) {
  const limits = loadLimits(P.limits);
  const criteria = loadCriteria();
  const profile = loadProfile();
  const cfg = llmConfig();
  const port = Number(flag(argv, '--port') || process.env.CDP_PORT || 9222);
  const locateOnly = argv.includes('--locate');
  const cap = Number(flag(argv, '--max') || limits.dailyCap);
  // 默认：发完招呼语后接着发简历卡片（平台自带「发简历」动作，无文件上传）
  const withResume = !argv.includes('--no-resume');
  // 默认**即时生成**（JIT）：不提前批量生成草稿。
  // 理由（业主提出）：批量预生成会一次性产出大量草稿，其中大部分永远发不出去；
  // 而 JIT 下 LLM 调用被发送限速（120-300s）自然拉开，不会形成密集请求。
  const fromDrafts = argv.includes('--from-drafts');
  // 自测钩子：SIMULATE_FAILURES=N → 前 N 次发送强制失败。
  // 用途：验证「失败自动补位」逻辑。日常不设这个变量就完全不生效。
  const simFail = Number(process.env.SIMULATE_FAILURES || 0) || 0;

  // 去重：同一个 HR/职位永不重发
  const sentKeys = new Set(readJsonl(P.sent).map((r) => String(r.jobId)));

  let pool;
  if (fromDrafts) {
    if (!fs.existsSync(P.drafts)) throw new Error('先跑：node src/cli.mjs draft（或者去掉 --from-drafts 改用即时生成）');
    pool = JSON.parse(fs.readFileSync(P.drafts, 'utf8')).drafts
      .filter((d) => !d.error && d.lint?.ok)
      .filter((d) => !sentKeys.has(String(d.jobId)));
  } else {
    if (!fs.existsSync(P.scored)) throw new Error('先跑：node src/cli.mjs score');
    pool = JSON.parse(fs.readFileSync(P.scored, 'utf8')).jobs
      .filter((j) => (j.ai?.score ?? -1) >= limits.matchThreshold)
      .filter((j) => !j.chatted)
      .filter((j) => !sentKeys.has(String(j.jobId)))
      .sort((a, b) => (b.ai?.score ?? -1) - (a.ai?.score ?? -1)); // 高分优先，补位时先吃好的
  }

  // ── 目标：**成功**发送 cap 条；失败的岗位用后面的候选自动补位 ──
  // 为什么补位必须有上限：no-chat-input 这类失败发生在点击「聊一聊」**之后**，
  // 而点「聊一聊」本身就会自动发出平台默认招呼语 ——
  // 也就是说每次失败都可能已经打扰到一个 HR。无上限补位 = 批量骚扰。
  // 所以最多尝试 maxAttempts 次（默认 cap*2，且不超过候选池）。
  const requestedAttempts = Number(flag(argv, '--max-attempts') || 0) || cap * 2;
  const maxAttempts = Math.max(cap, Math.min(pool.length, requestedAttempts));
  const queue = pool.slice(0, maxAttempts);
  const attemptsBumped = requestedAttempts < cap;

  console.log(`${C.c}job-auto send${C.x}  模式=${
    locateOnly ? 'LOCATE（只定位不发送）' : 'REAL SEND'
  }  招呼语=${fromDrafts ? '读预生成草稿' : '发送时即时生成'}`);
  if (!locateOnly) {
    bad('████████ 真实发送模式 ████████');
    bad('  会真的联系 HR。受日上限约束，不会自动重试。');
    bad(`  目标：成功 ${cap} 条（失败自动补位，最多尝试 ${queue.length} 条）。`);
    bad('██████████████████████████████');
  }
  ok(
    fromDrafts
      ? `草稿文件 -> 可用 ${pool.length} 条，本轮最多尝试 ${queue.length} 条（日上限 ${limits.dailyCap}）`
      : `scored.json 中 ≥${limits.matchThreshold} 分、未沟通、未发送 -> 可用 ${pool.length} 条，本轮最多尝试 ${queue.length} 条（日上限 ${limits.dailyCap}）`,
  );
  if (queue.length > cap) {
    warn(`目标成功 ${cap} 条；若中途失败会用后面 ${queue.length - cap} 个候选补位`);
  } else if (pool.length < cap) {
    warn(`候选池只有 ${pool.length} 条，不足目标 ${cap} 条 —— 请先搜索/打分补充岗位`);
  }
  if (attemptsBumped) {
    // 不能静默：业主写了 6，实际跑了 8，必须让他知道
    warn(
      `--max-attempts=${requestedAttempts} 小于目标 ${cap} 条，已自动提升为 ${maxAttempts} —— ` +
        '尝试次数不可能少于目标成功数',
    );
  }

  const daily = loadDaily(P.daily);
  if (!locateOnly) {
    const pf = preflight(limits, daily);
    for (const c of pf.checks) (c.ok ? ok : bad)(`${c.name}: ${c.detail}`);
    assertUnderCap(limits, daily);
  }

  // ── agent 充当 LLM：**在点第一个按钮之前**把招呼语全部备齐 ──
  // 为什么必须提前：send 是真实点击。跑到一半才发现缺招呼语时，
  // “聊一聊”可能已经点过了（那本身就会发出平台默认招呼语）—— HR 已经被打扰了。
  // --from-drafts 用的是草稿文件，不需要 LLM；--locate 不发送，也不需要。
  if (!locateOnly && !fromDrafts && isAgentMode(cfg)) {
    const rubric = await ensureRubric(cfg, criteria, profile, { noAuto: argv.includes('--no-auto-rubric') });
    if (rubricBlocked(cfg, rubric)) return NEED_AGENT_LLM_EXIT;
    const prompts = queue.map((raw) => {
      const p = greetPrompt(raw, criteria, profile, raw.ai, { rubric });
      const { system, user } = splitMessages(p.messages);
      return { kind: 'greet', system, user, meta: p.meta };
    });
    if (
      agentPreflight(
        cfg,
        prompts,
        `node src/cli.mjs send --max ${cap}`,
        ` ${queue.length} 条打招呼语（发送前一次性备齐）`,
      )
    ) {
      return NEED_AGENT_LLM_EXIT;
    }
  }
  const agentRubric = isAgentMode(cfg) && !fromDrafts && !locateOnly
    ? loadRubric()
    : null;

  if (!queue.length) {
    warn('没有待发条目（草稿为空或已全部发过）');
    return 0;
  }

  const { cdp } = await makeApi(port);

  // ---- LOCATE 模式：只做定位校验，绝不点击 ----
  if (locateOnly) {
    const sample = queue[0];
    console.log(`\n  定位样本: [${sample.score}] ${sample.title} @${sample.company}`);
    console.log(`  ${sample.link}`);
    await cdp.navigate(sample.link);
    await cdp.waitStable({ quietMs: 2200, maxMs: 25000 });
    const buttons = await locateGreetButton(cdp);

    // 先判风控：验证码页上按钮当然找不到，別把人引去改选择器
    const risk = await riskControlPage(cdp);
    if (risk.blocked) {
      bad('页面被风控拦截，没进入职位详情');
      console.log(risk.hint.split('\n').map((l) => `  ${l}`).join('\n'));
      return 1;
    }

    head('页面上匹配到的打招呼入口');
    if (!buttons.length) {
      bad('未找到。需要看页面真实按钮文本，调整 send.mjs 的 GREET_BUTTON_TEXTS');
    } else {
      for (const b of buttons.slice(0, 8)) console.log(`  "${b.text}"  命中=「${b.needle}」  cls="${b.cls}"  可见=${b.visible}`);
    }

    head('当前页面目标');
    for (const t of await listTargets(port)) console.log(`  ${t.url.slice(0, 110)}\n      ${t.title.slice(0, 60)}`);

    head('聊天输入框（点击打招呼前通常不存在）');
    const inputs = await locateChatInput(cdp);
    (inputs.length ? ok : dim)(`找到 ${inputs.length} 个 textarea/contenteditable`);
    for (const i of inputs.slice(0, 6)) console.log(`  <${i.tag}> ph="${i.placeholder}" hint=${i.hintMatched}`);

    warn('验证聊天输入框需要真实点一次“打招呼”（会发出平台默认语），所以我没做');
    return 0;
  }

  // ---- 发送 ----
  let sentCount = 0;
  let resumeSentCount = 0;
  let failStreak = 0;
  let stopReason = ''; // 为什么停：达成目标 / 日上限 / 候选用尽
  // agent 充当 LLM 时，质检没过需要再要一轮生成的岗位：本轮跳过，不发坏文案
  const skippedForAgent = [];
  for (const [i, raw] of queue.entries()) {
    // 已达成目标成功数 → 收工。注意判据是**成功数**，不是循环次数。
    if (sentCount >= cap) {
      ok(`已达成目标（成功 ${sentCount}/${cap}），停止（共尝试 ${i} 条）`);
      stopReason = '已达成目标';
      break;
    }
    // 长跑会跨时间窗 / 撞日上限，每条前重校一次（不再只在开头查一次）
    if (daily.sent >= limits.dailyCap) {
      warn(`今日额度已满 ${daily.sent}/${limits.dailyCap}，停止补位`);
      stopReason = `日上限已满（${daily.sent}/${limits.dailyCap}）`;
      break;
    }
    // 时间窗与熔断已按业主决定彻底移除（2026-09-17），这里不再有任何对应检查。
    // 剩下的硬门只有日上限（上面那个），以及在取消/停止时的中断。

    const backfill = i - sentCount;
    const tag = `[${i + 1}/${queue.length}]${backfill > 0 ? ` 补位（已成功 ${sentCount}/${cap}，累计失败 ${backfill}）` : ''}`;
    let d = raw;

    if (!fromDrafts) {
      // 即时生成：**只调 LLM，不请求猎聘页面**。
      process.stdout.write(`\n  ${tag} [${raw.ai?.score}] ${raw.title} @${raw.company}\n    生成招呼语 ... `);
      try {
        const { greeting, lint, attempt } = await draftGreetingChecked(cfg, raw, criteria, profile, raw.ai, {
          attempts: 3,
          rubric: agentRubric,
        });
        if (!lint.ok) throw new Error(`lint 不过: ${lint.problems.join('; ')}`);
        console.log(`${C.g}ok${C.x} (${greeting.length}字${attempt > 1 ? `, 第${attempt}次` : ''})`);
        d = {
          jobId: raw.jobId,
          title: raw.title,
          company: raw.company,
          link: raw.link,
          score: raw.ai?.score ?? null,
          recruiterName: raw.recruiterName,
          seniorTitle: raw.recruiterTitle,
          imId: raw.recruiterImId,
          greeting,
        };
      } catch (e) {
        console.log(`${C.r}失败${C.x} ${e.message}`);
        // agent 模式下质量质检没过、需要再要一轮生成：**跳过这一条，不能带着坏文案发出去**。
        // 该岗位没写 sent.jsonl，重跑会自然补上。
        if (e instanceof NeedAgentLlm || e.name === 'NeedAgentLlm') {
          skippedForAgent.push({ jobId: raw.jobId, title: raw.title, kind: e.kind || 'greet' });
          continue;
        }
        continue;
      }
    } else {
      console.log(
        `\n  ${tag} [${d.score}] ${d.title} @${d.company}  ${d.recruiterName || ''} ${d.seniorTitle || ''}`,
      );
    }
    console.log(`    → ${d.greeting}`);

    try {
      const r = simFail > 0 && i < simFail
        ? { ok: false, stage: 'simulated-failure', detail: `SIMULATE_FAILURES 强制失败 #${i + 1}` }
        : await sendOne(cdp, d, {
            humanType: (c, t) => c.typeText(t),
            sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
            onStage: (s, det) => dim(`    [${s}] ${det ?? ''}`),
          });
      if (!r.ok) throw new Error(`${r.stage}: ${r.detail}`);

      appendJsonl(P.sent, {
        jobId: d.jobId,
        title: d.title,
        company: d.company,
        recruiterName: d.recruiterName,
        imId: d.imId,
        score: d.score,
        greeting: d.greeting,
        sentAt: new Date().toISOString(),
        resumeCard: false, // 下一段补发成功后会重写为 true
      });
      recordSuccess(daily);
      saveDaily(P.daily, daily);
      sentCount++;
      failStreak = 0;
      ok(`    已发送（今日 ${daily.sent}/${limits.dailyCap}）`);

      // 补发简历卡片：点「发简历」→ 确认层「确定」
      // 用平台自己的动作，不传任何文件，避开“发图片违规”的坑。
      if (withResume) {
        const rr = await sendResumeCard(cdp, {
          onStage: (s, det) => dim(`    [resume:${s}] ${det ?? ''}`),
          shotDir: P.screens,
        });
        if (rr.ok) {
          resumeSentCount++;
          ok(`    已发简历卡片（${rr.detail}）`);
          const recs = readJsonl(P.sent);
          if (recs.length) {
            recs[recs.length - 1].resumeCard = true;
            fs.writeFileSync(P.sent, recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
          }
        } else {
          warn(`    简历卡片未发出: ${rr.stage} - ${rr.detail}（招呼语已发，不重试以防重复）`);
        }
      }

    } catch (e) {
      failStreak++;
      recordFailure(daily, limits);
      saveDaily(P.daily, daily);
      bad(`    失败(${failStreak}): ${e.message}`);

      // 现场取证：发不出去时最需要知道“当时页面上有什么”
      try {
        const dg = await diagnose(cdp, port);
        head('发送失败现场');
        dim(`当前 URL: ${await cdp.currentUrl()}`);
        dim(`页面文本: ${dg.pageText.replace(/\s+/g, ' ').slice(0, 400)}`);
        dim(`可编辑元素 (${dg.editables.length}):`);
        for (const el of dg.editables.slice(0, 15)) {
          dim(`  <${el.tag} type=${el.type}> ph="${el.placeholder}" cls="${el.cls}" vis=${el.visible} ${el.box}`);
        }
        dim(`页面标签页 (${dg.targets.length}):`);
        for (const t of dg.targets.slice(0, 10)) dim(`  ${t.url.slice(0, 100)}`);
        const dumpFile = path.join(P.evidence, `send-fail-${d.jobId}-${Date.now()}.json`);
        fs.writeFileSync(dumpFile, JSON.stringify(dg, null, 2), 'utf8');
        dim(`现场已存 ${path.relative(ROOT, dumpFile)}`);
      } catch (de) {
        dim(`现场取证也失败了: ${de.message}`);
      }

      // 熔断已按业主决定移除（2026-09-17）：连续失败不再中止当日发送。
      // 失败仍会计数（daily.failures），只作为可观测性信息。
      if (daily.failures > 0) dim(`本日累计失败 ${daily.failures} 次（不再熔断）`);
    }

    // 统一等待：**成功要继续，失败也要继续（去补位）**。
    // 以前这个等待只写在成功分支里，于是连续失败时会一条接一条猛冲；
    // 而每次失败都可能已经点过「聊一聊」打扰到 HR，更需要拉开间隔。
    if (sentCount < cap && i < queue.length - 1 && daily.sent < limits.dailyCap) {
      const wait = nextDelayMs(limits);
      console.log(`    等待 ${(wait / 1000).toFixed(0)}s 后继续...`);
      await new Promise((res) => setTimeout(res, wait));
    }
  }

  head('发送结果');
  if (!stopReason) stopReason = '候选或尝试次数用尽';
  ok(`实际发送 ${sentCount} 条；今日累计 ${daily.sent}/${limits.dailyCap}`);
  if (withResume) ok(`其中附发简历卡片 ${resumeSentCount} 条${resumeSentCount < sentCount ? `（${sentCount - resumeSentCount} 条未成功，见上方 warn）` : ''}`);
  if (sentCount) ok(`发送记录 ${path.relative(ROOT, P.sent)}`);
  // agent 模式下文案质检没过会跳过该岗位（宁可少发一条，也不带坏文案发出去）
  if (skippedForAgent.length) {
    warn(`${skippedForAgent.length} 条没发：招呼语被质检拦下了。`);
    for (const s of skippedForAgent.slice(0, 5)) dim(`  - ${s.title}`);
    dim('  重跑同一条命令即可补上（未写 sent.jsonl，不会重复打扰已发过的 HR）');
  }
  if (sentCount < cap) {
    warn(`未达成目标：目标 ${cap} 条，实际成功 ${sentCount} 条${stopReason ? `（${stopReason}）` : ''}`);
  }
  return 0;
}

// ─────────────────────────── resume-pdf ───────────────────────────

async function cmdResumePdf(argv) {
  const limits = loadLimits(P.limits);
  const criteria = loadCriteria();
  const cfg = llmConfig();
  const port = Number(flag(argv, '--port') || process.env.CDP_PORT || 9222);
  const cap = Number(flag(argv, '--max') || 3);
  const onlyJob = flag(argv, '--job');

  if (!fs.existsSync(P.template)) throw new Error(`模板不存在: ${P.template}`);
  const tpl = fs.readFileSync(P.template, 'utf8');

  console.log(`${C.c}job-auto resume-pdf${C.x}  按岗位定制简历 PDF（模板 + 换侧重，不新增事实）`);

  const { cdp, api } = await makeApi(port);
  const [resume, userInfo] = await Promise.all([
    fetchResumeRaw(api),
    fetchUserInfo(api).catch(() => null),
  ]);
  // 操作者确认的事实（联系方式原值、替换/新增的经历）优先于在线简历
  const override = fs.existsSync(P.experience)
    ? JSON.parse(fs.readFileSync(P.experience, 'utf8'))
    : {};
  const fixed = buildFixedResume(resume, userInfo, override);

  // 证件照（config/experience.json 的 photo，相对 case 根目录）
  const photoPath = override.photo ? path.resolve(ROOT, override.photo) : null;
  const photo = loadPhotoAsDataUri(photoPath);
  (photo ? ok : warn)(
    photo ? `证件照已内嵌 ${path.relative(ROOT, photo.file)}（${Math.round(photo.bytes / 1024)}KB base64）` : '未配置证件照（config/experience.json 的 photo）',
  );

  head('固定事实（模板里会原样出现）');
  ok(`${fixed.name} / ${fixed.gender} / ${fixed.age} / ${fixed.eduLevel} / ${fixed.city} / ${fixed.workStatus}`);
  ok(`电话 ${fixed.mobile} | 邮箱 ${fixed.email}`);
  (fixed.worksOverridden ? warn : dim)(
    fixed.worksOverridden
      ? '经历已由 config/experience.json 接管（覆盖在线简历）'
      : '经历来自在线简历（未被 config/experience.json 覆盖）',
  );
  ok(`教育 ${fixed.edu.length} 条 | 项目 ${fixed.projects.length} 条 | 实习 ${fixed.works.length} 条 | 证书 ${fixed.certs.length} 个`);
  ok(`技能池 ${fixed.skillPool.length} 个：${fixed.skillPool.join(', ')}`);
  dim('（技能池 = 猎聘标签 + config/experience.json 的 skillsExtra；AI 只能从池子里挑）');
  (fixed.projects.length ? ok : warn)(
    `项目经历 ${fixed.projects.length} 条${fixed.projects.length ? '' : '（模板不会出现项目章节）'}`,
  );

  // 选目标岗位
  if (!fs.existsSync(P.scored)) throw new Error('先跑：node src/cli.mjs score');
  const scored = JSON.parse(fs.readFileSync(P.scored, 'utf8'));
  let jobs = scored.jobs.filter((j) => (j.ai?.score ?? -1) >= limits.matchThreshold).filter((j) => !j.chatted);
  if (onlyJob) jobs = scored.jobs.filter((j) => String(j.jobId) === String(onlyJob));
  jobs = jobs.slice(0, cap);
  if (!jobs.length) {
    warn('没有可定制的岗位');
    return 0;
  }

  // agent 充当 LLM：预检所有岗位的定制 prompt（每个岗位一个）
  if (isAgentMode(cfg)) {
    if (
      agentPreflight(
        cfg,
        tailorPrompts(fixed, jobs, criteria, (j) => jobBrief(j)),
        `node src/cli.mjs resume-pdf --max ${jobs.length}`,
        ` ${jobs.length} 份定制简历片段`,
      )
    ) {
      return NEED_AGENT_LLM_EXIT;
    }
  }

  ensureDir(P.resumes);
  const summary = [];

  for (const [i, job] of jobs.entries()) {
    console.log(`\n  [${i + 1}/${jobs.length}] ${job.title} @${job.company}`);
    try {
      const tailoredRaw = await tailorResume(cfg, fixed, job, criteria, jobBrief(job));
      // 代码强制门：剔除技能池外的技能（防编造），并把剔除名单报出来
      const poolCheck = enforceSkillPool(tailoredRaw, fixed);
      const tailored = { ...tailoredRaw, skillOrder: poolCheck.skillOrder };
      const fab = detectFabrication(fixed, tailored);

      const html = renderResumeHtml(tpl, fixed, tailored, job, photo);
      const pdf = path.join(P.resumes, `${job.jobId}.pdf`);
      const r = await htmlToPdf(cdp, html, pdf);
      // 同时出一份 PNG：猎聘 IM 的 file input 只收图片（jpg/jpeg/png/bmp），不收 PDF，
      // 所以真正能发出去的载体是这张 PNG。
      const pngRes = await htmlToPng(cdp, html, pdf.replace(/\.pdf$/, '.png'));

      // 同时存 HTML 和定制 JSON，便于人工核对“到底改了什么”。
      // 以实际写入的文件名为基准（目标被占用时会给回落到带时间戳的名字）。
      const actual = r.file;
      fs.writeFileSync(actual.replace(/\.pdf$/, '.html'), html, 'utf8');
      fs.writeFileSync(actual.replace(/\.pdf$/, '.tailored.json'), JSON.stringify(tailored, null, 2), 'utf8');

      ok(`PDF ${Math.round(r.size / 1024)}KB -> ${path.relative(ROOT, actual)}`);
      ok(`PNG ${Math.round(pngRes.size / 1024)}KB -> ${path.relative(ROOT, pngRes.file)}（发附件用这个）`);
      dim(`求职意向: ${tailored.targetTitle}`);
      dim(`匹配点 ${tailored.matchPoints?.length || 0} 条（仅核对，不进 PDF）| 技能 ${poolCheck.skillOrder.length} 个 | 经历改写 ${tailored.workEmphasis?.length || 0} 段 | 项目改写 ${tailored.projectEmphasis?.length || 0} 段`);
      if (poolCheck.dropped.length) {
        bad(`技能池拦截：模型试图添加技能池外的 ${poolCheck.dropped.length} 个技能 -> ${poolCheck.dropped.join(', ')}（已剔除非未写入 PDF）`);
      }
      (fab.ok ? ok : bad)(
        fab.ok ? '事实漂移自检通过（未出现原始简历外的技术名词）' : `可疑新增词汇: ${fab.suspicious.join(', ')}`,
      );
      for (const p of tailored.matchPoints || []) dim(`· ${p}`);

      summary.push({ jobId: job.jobId, title: job.title, company: job.company, pdf: actual, fabricated: fab.suspicious });
    } catch (e) {
      bad(`失败: ${e.message}`);
      summary.push({ jobId: job.jobId, title: job.title, error: e.message });
    }
    if (i < jobs.length - 1) await new Promise((res) => setTimeout(res, 700));
  }

  fs.writeFileSync(path.join(P.resumes, 'index.json'), JSON.stringify({ generatedAt: ts(), items: summary }, null, 2), 'utf8');
  head('产物');
  ok(`${path.relative(ROOT, P.resumes)}/  （每个岗位一份 .pdf + .html + .tailored.json）`);
  warn('请先打开 PDF 看一眼排版，再接入发送流程');
  return 0;
}

// ─────────────────────────────── attach ───────────────────────────────

/**
 * 在聊天窗里发简历——走平台自带的「发简历」动作（action-resume）。
 *
 * 曾经实现过“上传定制 PDF/图片当附件”，但猎聘 IM 的 file input 只收图片，
 * 且发图片有违规风险，已废弃。现在发的是猎聘自己的简历卡片，内容取自在线简历。
 *
 * 只做真实发送，没有 dry-run。
 */
async function cmdAttach(argv) {
  const limits = loadLimits(P.limits);
  const port = Number(flag(argv, '--port') || process.env.CDP_PORT || 9222);

  if (!fs.existsSync(P.scored)) throw new Error('先跑：node src/cli.mjs score');
  const scored = JSON.parse(fs.readFileSync(P.scored, 'utf8'));
  const jobId = flag(argv, '--job') || scored.jobs.find((j) => (j.ai?.score ?? -1) >= limits.matchThreshold)?.jobId;
  const job = scored.jobs.find((j) => String(j.jobId) === String(jobId));
  if (!job) throw new Error(`scored.json 里没有 ${jobId}`);

  console.log(`${C.c}job-auto attach${C.x}  REAL：点「发简历」`);
  console.log(`  岗位: [${job.ai?.score}] ${job.title} @${job.company}`);

  const { cdp } = await makeApi(port);
  await cdp.navigate(job.link);
  await cdp.waitStable({ quietMs: 2000, maxMs: 25000 });
  const risk = await riskControlPage(cdp);
  if (risk.blocked) {
    bad('页面被风控拦截');
    console.log(risk.hint.split('\n').map((l) => `  ${l}`).join('\n'));
    return 1;
  }
  dim(`  已打开职位页: ${job.link}`);

  // 打开会话（未聊过=聊一聊，已聊过=继续聊）
  const btns = await locateGreetButton(cdp);
  if (!btns.length) throw new Error('页面上找不到聊天入口（聊一聊 / 继续聊）');
  console.log(`  点击「${btns[0].text}」打开会话`);
  await cdp.clickNode(btns[0].nodeId, { settleMs: 2500 });
  await new Promise((r) => setTimeout(r, 3500));

  const inputs = await locateChatInput(cdp);
  if (!inputs.length) throw new Error('会话未打开（找不到聊天输入框）');
  ok(`会话已打开（输入框 ph="${inputs[0].placeholder}"）`);

  const bar = await locateResumeButton(cdp);
  dim(`  聊天动作条: ${bar.map((b) => `「${b.text}」`).join(' ') || '（空）'}`);

  const r = await sendResumeCard(cdp, {
    onStage: (s, d) => dim(`    [${s}] ${d ?? ''}`),
    shotDir: P.screens,
  });

  head('结果');
  (r.ok ? ok : bad)(`${r.stage}${r.detail ? ' - ' + r.detail : ''}`);
  return r.ok ? 0 : 1;
}

// ────────────────────────── agent 充当 LLM ──────────────────────────

/**
 * 在真正动手之前做 LLM 预检：
 *   没配 API key 时，把本次会需要的 prompt 一次性列出来，缺的写成待办文件给 agent，
 *   然后以退出码 3（待办，不是失败）结束。agent 填完重跑同一条命令即可。
 *
 * 为什么必须预检而不能边跑边要：
 *   send 是真实点击。如果跑到一半才发现缺招呼语，那时已经点过“聊一聊”、
 *   已经打扰了 HR。所以宁可先把语料都备齐。
 *
 * @returns {boolean} true = 已写出待办、调用方应立即 return 退出码 3
 */
function agentPreflight(cfg, prompts, command, what) {
  if (!isAgentMode(cfg)) return false;
  const { total, missing, cached } = checkPrompts(prompts);
  if (!missing.length) {
    if (total) console.log(`    ${C.g}✓${C.x} agent 充当 LLM：${total} 项已有结果（缓存命中，不调外部 API）`);
    return false;
  }
  const file = writeRequests(command, missing);
  head('需要 agent 充当 LLM');
  console.log(`  本 skill 不调用外部 LLM，由调用本 skill 的 agent 来产出${what || '这些结果'}。`);
  console.log(`  本次需要 ${missing.length} 项${cached ? `（另有 ${cached} 项已缓存）` : ''}，已写入：`);
  console.log(`    ${C.c}${relHome(file)}${C.x}`);
  console.log('');
  console.log('  下一步：');
  console.log('    1. 读上面那个文件，按每一项的 system + user 产出结果');
  console.log(`    2. 写进 ${C.c}${relHome(responsesPath())}${C.x}（合并进已有 responses，别覆盖）`);
  console.log(`    3. 重跑：${C.c}${command}${C.x}`);
  console.log('');
  dim('这是待办不是报错。填完重跑同一条命令即可。');
  return true;
}

/** 载入生成配置 + 把模式说清楚 */
function llmCfgForRun() {
  dim(`LLM: agent 充当模型（本 skill 不调外部 LLM）`);
  return llmConfig();
}

// ──────────────────────────────── setup ────────────────────────────────

/**
 * 输出一份「该问用户什么」的清单。
 *
 * 为什么要单独做：skill 要被 agent 使用，那“缺配置”就不应该是一句
 * “criteria.json 不存在”，而应该是 agent 能直接照着去问用户的结构化清单。
 * agent 问完把答案写回文件，doctor 再校验。
 */
async function cmdSetup(argv) {
  const asJson = argv.includes('--json');
  const out = { missing: [], placeholders: [], ask: [] };

  // 求职条件
  let criteria = null;
  try {
    criteria = readConfigOrExplain(P.criteria, 'criteria.json');
  } catch {
    criteria = null;
  }
  const critPh = criteria ? findPlaceholders(criteria) : [];
  if (!criteria || critPh.length) {
    out.missing.push('config/criteria.json');
    out.ask.push({
      file: 'config/criteria.json',
      why: '决定搜什么岗位、在哪个城市、实习还是校招。没它 search/score/send 会拒绝运行',
      questions: [
        { key: 'keywords',    ask: '你想找什么岗位？给 3-6 个招聘网站上真实的岗位叫法（例：后端开发实习生、AI Agent 开发实习生）', type: 'string[]' },
        { key: 'cities',      ask: '在哪个城市找？', type: 'string[]' },
        { key: 'locationKeywords', ask: '有没有更想去的片区/区？（如“临港”、“浦东新区”）；没有就说“不限”', type: 'string[]' },
        { key: 'cityCode',    ask: '城市码。不确定就填 FILL_ME，然后用 `node src/cli.mjs dq --find 城市名` 查', type: 'string' },
        { key: 'dqCode',      ask: '地域过滤码，通常同 cityCode', type: 'string' },
        { key: 'workYearCode', ask: '找实习还是校招？实习填 "2"，应届生填 "1"', type: 'string' },
        { key: 'jobTypes',    ask: '岗位类型？（如 实习 / 校招）', type: 'string[]' },
        { key: 'excludeKeywords', ask: '有哪些你明确不要的？（如 外包、驻场、销售、社招）', type: 'string[]' },
        { key: 'extra',       ask: '还有什么偏好或约束？（通勤时间、要不要转正机会、不想去的团队类型…）', type: 'string' },
      ],
    });
  }
  out.placeholders.push(...critPh.map((p) => `criteria.json → ${p}`));

  // 个人经历
  let exp = null;
  try {
    exp = JSON.parse(fs.readFileSync(P.experience, 'utf8'));
  } catch {
    exp = null;
  }
  const expEmpty = !exp || !(exp.workExperiences || []).length;
  const expPh = exp ? findPlaceholders(exp) : [];
  if (!exp || expEmpty || expPh.length) {
    out.missing.push('config/experience.json');
    out.ask.push({
      file: 'config/experience.json',
      why: '事实来源。打招呼语和定制简历只能引用这里存在的内容；AI 不许编造',
      questions: [
        { key: 'contact.phone', ask: '你的手机号？', type: 'string' },
        { key: 'contact.email', ask: '你的邮箱？', type: 'string' },
        { key: 'photo',         ask: '有没有证件照？有就给路径（相对工作根），没有就不填', type: 'string|null' },
        { key: 'workExperiences', ask: '实习/工作经历：每段要 公司 / 职位 / 起止时间 / 具体做了什么（越具体越好，AI 从这里挑和岗位对得上的点）', type: 'array' },
        { key: 'projectExperiences', ask: '项目经历：项目名 / 你的角色 / 时间 / 2-4 条要点', type: 'array' },
        { key: 'skillsExtra', ask: '除了招聘网站简历上已有的技能标签，你还有哪些技能？每条要说清哪段经历能证明', type: 'array' },
      ],
    });
  }
  out.placeholders.push(...expPh.map((p) => `experience.json → ${p}`));

  // 打分要求
  const rubric = loadRubric();
  if (!rubric) out.missing.push('config/rubric.json');

  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }

  head('配置体检 & 该问用户什么');
  if (!out.missing.length && !out.placeholders.length) {
    ok('没有缺的东西，直接跑 search / rubric / score 即可');
    return 0;
  }
  console.log(`  缺 ${out.missing.length} 项。下面是你要代用户确认的问题：\n`);
  for (const a of out.ask) {
    console.log(`${C.c}${a.file}${C.x}  —— ${a.why}`);
    for (const q of a.questions) console.log(`    [?] ${q.ask}   ${C.d}(${q.key}: ${q.type})${C.x}`);
    console.log('');
  }
  if (out.placeholders.length) {
    head('已有文件但没填完的字段');
    out.placeholders.forEach((p) => dim(`- ${p}`));
    console.log('');
  }
  head('问完之后');
  console.log('  把答案写进上面两个文件（模板都在 config.defaults/ 里，字段含义有 _README 注释）');
  console.log(`  然后校验：${C.c}node src/cli.mjs doctor${C.x}`);
  console.log(`  打分要求不用手写：${C.c}node src/cli.mjs rubric${C.x}（AI/agent 按目标岗位生成）`);
  return 0;
}

// ─────────────────────────────── main ───────────────────────────────

const USAGE = `job-auto

  node src/cli.mjs doctor [--port 9222]              环境体检（配置/限速/LLM/CDP/登录态）
  node src/cli.mjs setup  [--json]                   告诉 agent：缺什么配置、该问用户哪些问题
  node src/cli.mjs recon  [--url URL]                侦察页面结构 + XHR 接口 + 截图落证
  node src/cli.mjs dq     [--find 正则]              解析地区码/筛选项编码表
  node src/cli.mjs resume                            从自己简历自动抓取候选人背景
  node src/cli.mjs search [--key K] [--pages N]      搜索职位（直连 API，无需页面）
                         [--city 020] [--dq 410] [--workYear 1]
  node src/cli.mjs score  [--max N] [--include-chatted]  AI 匹配度打分
  node src/cli.mjs detail [--max N]                  抓取职位详情（JD + 公司简介）
  node src/cli.mjs draft  [--max N]                  为达标职位生成打招呼语
  node src/cli.mjs resume-pdf [--max N] [--job ID]   按岗位定制简历 PDF + PNG
  node src/cli.mjs attach [--job ID]                 在聊天窗点「发简历」（真实发送）
  node src/cli.mjs send   [--locate] [--max N] [--no-resume]   发送打招呼 + 简历卡片（真实发送）
                                                      --locate 只定位按钮不发送

全局开关：
  --headless           无头（**默认**）
  --headed             有头弹窗（首次登录 / 过验证码）
  --background, --bg   有头但窗口挪到屏幕外（无头被风控时改用这个）
  --no-autostart       连不上 Chrome 时报错，不自动拉起
`;
async function main() {
  const argv = process.argv.slice(2);
  // nvm 把 node 切到旧版（实测 v14.21.0）时自动换回新版再跑。
  // 必须在任何 fetch/WebSocket 之前 —— 那些是 Node 18+ 才有的全局对象。
  ensureModernNode(fileURLToPath(import.meta.url), argv);
  const cmd = argv[0];

  // 默认无头（2026-09-18 起）。
  //   --headed         有头正常弹窗（首次登录 / 过验证码）
  //   --background/--bg  有头但窗口挪到屏幕外（避开无头风控）
  //   --headless       显式无头（同默认）
  //   HEADLESS=0       环境变量切有头；BACKGROUND=1 切后台窗口
  BACKGROUND = argv.includes('--background') || argv.includes('--bg') || String(process.env.BACKGROUND || '') === '1';
  HEADLESS = !BACKGROUND && !argv.includes('--headed') && String(process.env.HEADLESS || '') !== '0';
  AUTO_START = !argv.includes('--no-autostart');
  ensureHome(); // 首次运行把默认配置铺到工作根（只补缺失的，不覆盖）
  if (BACKGROUND) {
    // 正向提示，不提风险 —— 这个模式不触发风控。
    dim('浏览器模式：有头 + 窗口挪到屏幕外（避开无头风控）');
  }
  if (HEADLESS) {
    // 默认就是无头，不再每次都报风险；只提示怎么切。
    // 若猎聘因 HeadlessChrome 判「异常行为」/ 弹验证码，改用 --background 或 --headed。
    dim('浏览器模式：无头（默认）。被风控/弹验证码时改用 --background 或 --headed。');
  }
  let code = 0;

  // 必须在这里就加载 .env：之前只有 doctor 调了 loadEnv，
  // 导致 search/score/draft/send 全都没读到 .env。
  loadEnv(ROOT);

  try {
    if (cmd === 'doctor') code = await cmdDoctor(argv);
    else if (cmd === 'setup') code = await cmdSetup(argv);
    else if (cmd === 'recon') code = await cmdRecon(argv);
    else if (cmd === 'dq') code = await cmdDq(argv);
    else if (cmd === 'resume') code = await cmdResume(argv);
    else if (cmd === 'rubric') code = await cmdRubric(argv);
    else if (cmd === 'score') code = await cmdScore(argv);
    else if (cmd === 'detail') code = await cmdDetail(argv);
    else if (cmd === 'draft') code = await cmdDraft(argv);
    else if (cmd === 'resume-pdf') code = await cmdResumePdf(argv);
    else if (cmd === 'attach') code = await cmdAttach(argv);
    else if (cmd === 'send') code = await cmdSend(argv);
    else if (cmd === 'search') code = await cmdSearch(argv);
    else {
      console.log(USAGE);
      code = cmd ? 1 : 0;
    }
  } catch (e) {
    if (e instanceof NeedAgentLlm) {
      // 走到这里说明某处漏了预检。不当成崩溃：把这一条写成待办，让 agent 补上重跑。
      const file = writeRequests(cmd || '(未知命令)', [
        { id: e.id, kind: e.kind, system: '', user: '', expect: expectFor(e.kind), meta: { note: '该条由运行中途的漏检产生，缺少 prompt 原文' } },
      ]);
      console.error(`${C.y}需要 agent 充当 LLM${C.x}：${e.message}`);
      console.error(`  待办已写入 ${relHome(file)}`);
      code = NEED_AGENT_LLM_EXIT;
    } else {
      console.error(`${C.r}FATAL:${C.x} ${e.message}`);
      if (process.env.DEBUG) console.error(e.stack);
      code = 1;
    }
  }

  // 只断开连接，不动操作者的 Chrome，也不用 process.exit()（会触发 libuv 断言）
  if (activeBrowser) {
    try {
      await activeBrowser.close();
    } catch {
      /* 已经断开 */
    }
    activeBrowser = null;
  }
  if (activeCdpLite) {
    try {
      await activeCdpLite.close();
    } catch {
      /* 已经断开 */
    }
    activeCdpLite = null;
  }
  process.exitCode = code;
}

main();
