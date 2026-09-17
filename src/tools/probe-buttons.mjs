/**
 * 探针：把职位页上所有"短文本可点元素"全量列出来。
 * 用途：已聊过的岗位，打招呼按钮文案会变（聊一聊 -> ?），需要看真实文案。
 *
 * 只读，不点击。
 *
 * 用法: node src/tools/probe-buttons.mjs [jobId]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpLite } from '../core/browser/cdp-lite.mjs';
import { HOME } from '../core/paths.mjs';

const ROOT = HOME; // 工作根（config/state/artifacts 都在这里）
const port = Number(process.env.CDP_PORT || 9222);

const scored = JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts', 'scored.json'), 'utf8'));
const jobId = process.argv[2] || '85256053';
const job = scored.jobs.find((j) => String(j.jobId) === String(jobId));
console.log(`目标: [${job?.ai?.score}] ${job?.title} @${job?.company}  chatted=${job?.chatted}`);
console.log(`链接: ${job?.link}\n`);

const cdp = await CdpLite.attach({ port, url: 'https://c.liepin.com/' });
const landed = await cdp.navigate(job.link);
await cdp.waitStable({ quietMs: 2200, maxMs: 25000 });
console.log(`已打开: ${landed}`);
console.log(`当前 URL: ${await cdp.currentUrl()}`);

const text = await cdp.pageText().catch(() => '');
console.log(`整页文本 ${text.length} 字`);
console.log(`前 300 字: ${text.replace(/\s+/g, ' ').slice(0, 300)}\n`);

// 全量短文本元素
const seen = new Set();
const rows = [];
for (const sel of ['button', 'a', '[role="button"]', 'div[class*="btn"]', 'span[class*="btn"]', 'div[class*="action"]', 'span', 'div']) {
  const ids = await cdp.querySelectorAll(sel).catch(() => []);
  if (!ids.length) continue;
  for (const id of ids.slice(0, 400)) {
    const t = (await cdp.getText(id).catch(() => '')).replace(/\s+/g, ' ');
    if (!t || t.length > 18) continue;
    const a = await cdp.getAttributes(id).catch(() => ({}));
    const box = await cdp.boxCenter(id).catch(() => null);
    if (!box) continue;
    const key = `${t}|${a.class || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ t, sel, cls: (a.class || '').slice(0, 60), at: `${Math.round(box.x)},${Math.round(box.y)}`, w: Math.round(box.w) });
  }
}

// 按 y 坐标排序，更接近视觉顺序
rows.sort((a, b) => Number(a.at.split(',')[1]) - Number(b.at.split(',')[1]));
console.log(`=== 短文本可点元素（${rows.length}，按页面纵向顺序）===`);
for (const r of rows.slice(0, 70)) {
  console.log(`  y=${String(r.at.split(',')[1]).padStart(4)} x=${String(r.at.split(',')[0]).padStart(4)} w=${String(r.w).padStart(4)}  "${r.t}"  <${r.sel}> cls="${r.cls}"`);
}

const shot = path.join(ROOT, 'artifacts', 'screenshots', `buttons-${Date.now()}.png`);
await cdp.screenshot(shot).catch(() => {});
console.log(`\n截图: ${shot}`);

await cdp.close();
process.exitCode = 0;
