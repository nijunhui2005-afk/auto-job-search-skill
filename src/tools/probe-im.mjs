/**
 * 探针：摸清 IM 聊天页/聊天面板里"发送简历"的入口。
 * 只定位，不点击（不往真实会话里发任何东西）。
 *
 * 已有会话：和已发送过的那位 HR。打开会话不等于发消息，是安全的。
 *
 * 用法: node src/tools/probe-im.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpLite } from '../core/browser/cdp-lite.mjs';
import { HOME } from '../core/paths.mjs';

const ROOT = HOME; // 工作根（config/state/artifacts 都在这里）
const port = Number(process.env.CDP_PORT || 9222);

const CANDIDATE_URLS = [
  'https://c.liepin.com/im/',
  'https://c.liepin.com/im',
  'https://c.liepin.com/chat/',
  'https://c.liepin.com/message/',
];

const cdp = await CdpLite.attach({ port, url: 'https://c.liepin.com/' });

// ---------- 1. 找 IM 页面 ----------
console.log('=== 探测 IM 页面 URL ===');
let imUrl = null;
for (const u of CANDIDATE_URLS) {
  const landed = await cdp.navigate(u);
  await cdp.waitStable({ quietMs: 1800, maxMs: 15000 });
  const text = await cdp.pageText().catch(() => '');
  const hasChatWord = /聊天|消息|沟通|会话/.test(text);
  const is404 = /404|页面不存在|找不到页面/.test(text);
  console.log(`  ${u}\n    -> ${landed}\n    文本 ${text.length} 字  聊天词=${hasChatWord}  404=${is404}`);
  if (hasChatWord && !is404 && text.length > 500) {
    imUrl = landed;
    console.log(`    ✓ 采用`);
    break;
  }
}

if (!imUrl) {
  console.log('\n未找到可用的 IM 页面，改从职位页的聊天面板探测');
  // 从已发送记录里拿一个职位链接
  const sentFile = path.join(ROOT, 'state', 'sent.jsonl');
  const rec = fs.existsSync(sentFile)
    ? JSON.parse(fs.readFileSync(sentFile, 'utf8').trim().split('\n').pop())
    : null;
  const scored = JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts', 'scored.json'), 'utf8'));
  const job = scored.jobs.find((j) => String(j.jobId) === String(rec?.jobId));
  if (!job) {
    console.log('  拿不到职位链接，退出');
    await cdp.close();
    process.exit(0);
  }
  console.log(`  打开职位页: ${job.link}`);
  await cdp.navigate(job.link);
  await cdp.waitStable({ quietMs: 2200, maxMs: 25000 });
  imUrl = await cdp.currentUrl();
}

console.log(`\n=== 当前页面: ${imUrl} ===`);

// ---------- 2. 枚举可交互元素（按钮/图标/工具条） ----------
console.log('\n=== 可点击元素（文本 + class 线索）===');
const seen = new Set();
for (const sel of ['button', '[role="button"]', 'a', 'div[class*="btn"]', 'span[class*="btn"]', 'i[class*="icon"]', 'div[class*="icon"]', 'li']) {
  const ids = await cdp.querySelectorAll(sel);
  if (!ids.length) continue;
  let printed = 0;
  for (const id of ids.slice(0, 250)) {
    const text = await cdp.getText(id).catch(() => '');
    const a = await cdp.getAttributes(id).catch(() => ({}));
    const cls = a.class || '';
    const key = `${text}|${cls}`;
    if (seen.has(key)) continue;
    // 只关心跟"简历/发送/附件/文件"相关的，或者文本很短的工具条按钮
    const interesting = /简历|发送|附件|文件|图片|表情|快捷|resume|file|attach/i.test(text + cls);
    if (!interesting) continue;
    if (text.length > 30) continue;
    seen.add(key);
    const box = await cdp.boxCenter(id).catch(() => null);
    console.log(`  <${sel}> "${text.slice(0, 24)}"  cls="${cls.slice(0, 70)}"  vis=${!!box}`);
    if (++printed >= 20) break;
  }
}

// ---------- 3. 页面文本里搜关键词 ----------
const text = await cdp.pageText().catch(() => '');
console.log('\n=== 整页文本里命中"简历/附件/发送"的片段 ===');
for (const kw of ['发送简历', '附件简历', '在线简历', '简历', '附件', '发送']) {
  let idx = -1;
  const hits = [];
  while ((idx = text.indexOf(kw, idx + 1)) >= 0 && hits.length < 3) {
    hits.push(text.slice(Math.max(0, idx - 40), idx + 60).replace(/\s+/g, ' '));
  }
  if (hits.length) {
    console.log(`  [${kw}]`);
    for (const h of hits) console.log(`    ...${h}...`);
  }
}

const shot = path.join(ROOT, 'artifacts', 'screenshots', `im-probe-${Date.now()}.png`);
await cdp.screenshot(shot).catch(() => {});
console.log(`\n截图: ${shot}`);

await cdp.close();
process.exitCode = 0;
