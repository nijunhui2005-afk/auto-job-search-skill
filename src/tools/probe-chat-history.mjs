/**
 * 验证：打开已有会话，把聊天记录里的消息（文本 + 图片）dump 出来。
 * 用于确认"文字 + 简历图片"是否真的送达。
 *
 * 只读。打开会话不发送任何内容。
 *
 * 用法: node src/tools/probe-chat-history.mjs [jobId]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpLite } from '../core/browser/cdp-lite.mjs';
import { locateGreetButton } from '../sites/liepin/send.mjs';
import { HOME } from '../core/paths.mjs';

const ROOT = HOME; // 工作根（config/state/artifacts 都在这里）
const port = Number(process.env.CDP_PORT || 9222);

const scored = JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts', 'scored.json'), 'utf8'));
const jobId = process.argv[2] || '85256053';
const job = scored.jobs.find((j) => String(j.jobId) === String(jobId));
console.log(`岗位: ${job.title} @${job.company}\n`);

const cdp = await CdpLite.attach({ port, url: 'https://c.liepin.com/' });
await cdp.navigate(job.link);
await cdp.waitStable({ quietMs: 2000, maxMs: 25000 });

const btns = await locateGreetButton(cdp);
if (!btns.length) {
  console.log('找不到聊天入口');
  process.exit(1);
}
await cdp.clickNode(btns[0].nodeId, { settleMs: 2500 });
await new Promise((r) => setTimeout(r, 5000));

// 1. 聊天区里的图片
console.log('=== 聊天区图片元素 ===');
const imgs = await cdp.querySelectorAll('img');
let n = 0;
for (const id of imgs.slice(0, 120)) {
  const a = await cdp.getAttributes(id).catch(() => ({}));
  const box = await cdp.boxCenter(id).catch(() => null);
  if (!box) continue;
  const src = a.src || '';
  // 只看大尺寸的（简历图会明显比头像大）
  if (box.w < 100 || box.h < 100) continue;
  n++;
  console.log(`  ${Math.round(box.w)}x${Math.round(box.h)} at ${Math.round(box.x)},${Math.round(box.y)}`);
  console.log(`    src = ${src.slice(0, 130)}`);
}
console.log(`  大尺寸图片共 ${n} 个`);

// 2. 聊天记录文本
const text = await cdp.pageText().catch(() => '');
console.log('\n=== 聊天记录区域文本（截取「我的沟通」之后）===');
const i = text.indexOf('我的沟通');
if (i >= 0) {
  console.log(text.slice(i, i + 900).replace(/\n{2,}/g, '\n'));
} else {
  console.log(text.slice(0, 900));
}

const shot = path.join(ROOT, 'artifacts', 'screenshots', `chat-history-${jobId}-${Date.now()}.png`);
await cdp.screenshot(shot).catch(() => {});
console.log(`\n截图: ${shot}`);

await cdp.close();
process.exitCode = 0;
