/**
 * 无头模式可行性探针。
 *
 * 要回答的问题（按重要性）：
 *   1. 无头 Chrome 能开 CDP 调试端口并被 CdpLite 附着吗？
 *   2. 猎聘页面在无头下会不会白屏？（有头模式下 Runtime.enable 会让它 frameDetached）
 *   3. 登录态能用吗？（用同一个 profile）
 *   4. 关键 UI（聊一聊 / 发简历）在无头下能定位到吗？—— 这一步**不点击**，避免真实打扰 HR
 *
 * 用法：
 *   node src/tools/probe-headless.mjs                 # 临时 profile，只验渲染
 *   node src/tools/probe-headless.mjs --profile=<dir>  # 指定 profile（会用登录态）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CdpLite } from '../core/browser/cdp-lite.mjs';

const flag = (n, d) => {
  const a = process.argv.find((x) => x === `--${n}` || x.startsWith(`--${n}=`));
  if (!a) return d;
  if (a.includes('=')) return a.split('=').slice(1).join('=');
  return process.argv[process.argv.indexOf(a) + 1] ?? d;
};

const PORT = Number(flag('port', 9333));
const CHROME = [
  flag('chrome', ''),
  process.env.CHROME_PATH,
  'D:\\tools\\cloakbrowser\\148.0.7778.215\\browser\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean).find((p) => fs.existsSync(p));
const USE_TEMP = !process.argv.some((a) => a.startsWith('--profile='));
const PROFILE = path.resolve(USE_TEMP ? path.join(os.tmpdir(), `liepin-headless-probe-${Date.now()}`) : flag('profile'));
const HEADLESS = flag('headless', 'new');

const say = (s) => console.log(s);
const step = (s) => console.log(`\n=== ${s} ===`);

say(`chrome   : ${CHROME}`);
say(`profile  : ${PROFILE}${USE_TEMP ? '  (临时，用完删)' : '  (复用，含登录态)'}`);
say(`port     : ${PORT}`);
say(`headless : --headless=${HEADLESS}`);

fs.mkdirSync(PROFILE, { recursive: true });

const args = [
  `--headless=${HEADLESS}`,
  '--disable-gpu',
  '--no-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--window-size=1440,900',
  'about:blank',
];
const child = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
// 把 chrome 自己的话收集起来 —— 它起不来时只在 stderr 里说原因（profile 被占用等），
// stdio:'ignore' 会让这种失败完全无声
let chromeOut = '';
child.stdout.on('data', (d) => (chromeOut += d.toString()));
child.stderr.on('data', (d) => (chromeOut += d.toString()));
say(`chrome pid = ${child.pid}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等 CDP 端点起来 */
let version = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      version = await r.json();
      break;
    }
  } catch {
    /* 还没起来 */
  }
}

step('1. 无头 Chrome 的 CDP 端口');
if (!version) {
  say('  ✗ 40 次轮询（20 秒）内没起来 —— 无头模式不可行');
  say(`  chrome 退出码 = ${child.exitCode}`);
  const tail = chromeOut.trim().split('\n').slice(-12).join('\n    ');
  say(tail ? `  chrome 输出:\n    ${tail}` : '  chrome 没有任何输出');
  child.kill();
  process.exitCode = 1;
  process.exit();
}
say(`  ✓ ${version.Browser}`);
say(`  ✓ ${version.webSocketDebuggerUrl}`);

const cleanup = async () => {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  await sleep(800);
  if (USE_TEMP) {
    try {
      fs.rmSync(PROFILE, { recursive: true, force: true });
    } catch {
      /* 目录可能被占，留着也无所谓 */
    }
  }
};

let cdp;
try {
  cdp = await CdpLite.attach({ port: PORT, url: 'about:blank' });
  say('  ✓ CdpLite 附着成功');

  step('2. 猎聘页面在无头下是否渲染（会不会白屏）');
  const TARGET = flag('url', 'https://www.liepin.com/zhaopin/?city=020&key=Java');
  await cdp.navigate(TARGET);
  await cdp.waitStable({ quietMs: 1500, maxMs: 25000 });
  await sleep(1500);
  const url = await cdp.currentUrl();
  const text = (await cdp.pageText().catch(() => '')) || '';
  const html = (await cdp.pageHtml().catch(() => '')) || '';
  say(`  url    : ${url}`);
  say(`  正文长度: ${text.length} 字符`);
  say(`  HTML    : ${html.length} 字符`);
  say(`  白屏?   : ${text.length < 40 ? '是 ✗（页面是空的）' : '否 ✓'}`);
  const looksLogin = /登录|注册|扫码/.test(text);
  say(`  登录页? : ${looksLogin ? '是（临时 profile 没登录，属预期）' : '否'}`);
  say(`  片段    : ${text.replace(/\s+/g, ' ').slice(0, 160)}`);

  step('3. 截图能力（证据归档要用）');
  const shot = path.resolve('artifacts', `headless-probe-${Date.now()}.png`);
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  try {
    await cdp.screenshot(shot);
    const sz = fs.statSync(shot).size;
    say(`  ✓ 截图成功 ${path.basename(shot)} (${(sz / 1024).toFixed(0)} KB)`);
    if (sz < 3000) say('  ! 文件很小，可能是纯白页');
  } catch (e) {
    say(`  ✗ 截图失败: ${e.message}`);
  }

  step('4. 关键 UI 元素能否定位（不点击，零副作用）');
  for (const sel of ['[class*="job-card"]', '[class*="job-detail"]', '[class*="btn-main"]', 'a[href*="/job/"]']) {
    const ids = await cdp.querySelectorAll(sel).catch(() => []);
    say(`  ${sel.padEnd(26)} → ${ids.length} 个`);
  }

  step('5. 按钮文案扫描（找 聊一聊 / 继续聊 / 发简历，只读不点）');
  const norm = (s) => String(s || '').replace(/\s+/g, '').trim();
  const btnIds = await cdp.querySelectorAll('button, a[class*="btn"], [class*="action-"]').catch(() => []);
  const found = {};
  for (const id of btnIds.slice(0, 120)) {
    const t = norm(await cdp.getText(id).catch(() => ''));
    if (!t || t.length > 24) continue;
    if (/聊一聊|继续聊|发简历|确定|取消/.test(t)) found[t] = (found[t] || 0) + 1;
  }
  say(`  扫描了 ${Math.min(btnIds.length, 120)} 个候选元素`);
  const keys = Object.keys(found);
  say(keys.length ? keys.map((k) => `  ✓ 「${k}」 × ${found[k]}`).join('\n') : '  （没找到目标按钮）');

  step('6. 登录态');
  try {
    const ck = await cdp.getCookies(TARGET);
    const names = ck.map((c) => c.name);
    say(`  cookie 数 = ${names.length}`);
    say(`  lt_auth  = ${names.includes('lt_auth') ? '存在 ✓（已登录）' : '缺失 ✗（未登录）'}`);
  } catch (e) {
    say(`  读 cookie 失败: ${e.message}`);
  }
} catch (e) {
  say(`  ✗ 失败: ${e.message}`);
  if (e.stack) say(e.stack.split('\n').slice(1, 4).join('\n'));
} finally {
  try {
    if (cdp) await cdp.close();
  } catch {
    /* ignore */
  }
  await cleanup();
  say('\n[*] 已清理无头 Chrome 进程');
  process.exitCode = 0;
}
