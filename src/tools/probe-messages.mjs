/**
 * 验证：dump 聊天窗的消息列表，确认「发简历」卡片是否真的发出去了。
 *
 * 难点：聊天消息不在根文档的可见文本里（前面 pageText 只拿到职位详情），
 * 所以直接按 class 找消息容器，把它的 HTML/文本 dump 出来。
 *
 * 只读。
 *
 * 用法: node src/tools/probe-messages.mjs [jobId]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpLite } from '../core/browser/cdp-lite.mjs';
import { locateGreetButton, locateChatInput } from '../sites/liepin/send.mjs';
import { HOME } from '../core/paths.mjs';

const ROOT = HOME; // 工作根（config/state/artifacts 都在这里）
const port = Number(process.env.CDP_PORT || 9222);

const scored = JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts', 'scored.json'), 'utf8'));
const jobId = process.argv.find((a) => /^\d+$/.test(a)) || '85256053';
const job = scored.jobs.find((j) => String(j.jobId) === String(jobId));
console.log(`岗位: ${job.title} @${job.company}\n`);

const cdp = await CdpLite.attach({ port, url: 'https://c.liepin.com/' });
await cdp.navigate(job.link);
await cdp.waitStable({ quietMs: 2000, maxMs: 25000 });

const btns = await locateGreetButton(cdp);
await cdp.clickNode(btns[0].nodeId, { settleMs: 2500 });
await new Promise((r) => setTimeout(r, 6000));

const inputs = await locateChatInput(cdp);
console.log(`聊天输入框: ${inputs.length} 个\n`);

// 找所有看起来像「消息列表」的容器
const CLASS_PATTERNS = [/im-ui-message/i, /message-list/i, /chat-message/i, /im-ui-chat-list/i, /msg-list/i, /chatwin/i, /im-ui-list/i];
const found = [];
for (const pat of CLASS_PATTERNS) {
  const ids = await cdp.querySelectorAll(`[class*="${pat.source.replace(/\\/g, '')}"]`).catch(() => []);
  for (const id of ids) {
    const a = await cdp.getAttributes(id).catch(() => ({}));
    const box = await cdp.boxCenter(id).catch(() => null);
    found.push({ pat: pat.source, cls: a.class || '', nodeId: id, w: box ? Math.round(box.w) : 0, h: box ? Math.round(box.h) : 0, vis: !!box });
  }
}
console.log(`=== 候选消息容器（去重前 ${found.length}）===`);
const seen = new Set();
for (const f of found) {
  if (seen.has(f.cls)) continue;
  seen.add(f.cls);
  console.log(`  [${f.pat}] cls="${f.cls.slice(0, 80)}" ${f.w}x${f.h} vis=${f.vis}`);
}

// 取面积最大的那个当消息区，dump 它的 HTML
const best = found.filter((f) => f.vis).sort((a, b) => b.w * b.h - a.w * a.h)[0];
if (best) {
  console.log(`\n=== 消息区 cls="${best.cls.slice(0, 70)}" 的文本 ===`);
  const t = await cdp.getText(best.nodeId).catch(() => '');
  console.log(t.slice(0, 1200));

  console.log('\n=== 内部图片 ===');
  const inner = await cdp.querySelectorAll('img');
  for (const id of inner) {
    const a = await cdp.getAttributes(id).catch(() => ({}));
    const box = await cdp.boxCenter(id).catch(() => null);
    if (!box || box.w < 60) continue;
    const src = a.src || '';
    if (/lietou-static|liepin\.com\/(static|favicon)/.test(src)) continue;
    console.log(`  ${Math.round(box.w)}x${Math.round(box.h)} at ${Math.round(box.x)},${Math.round(box.y)}  src=${src.slice(0, 120)}`);
  }
} else {
  console.log('\n没找到消息容器');
}

// 兜底：整个聊天面板的 HTML 片段
console.log('\n=== 聊天面板 HTML 片段（找 im-ui-chat / chatwin）===');
for (const sel of ['[class*="im-ui-chat"]', '[class*="chatwin"]']) {
  const ids = await cdp.querySelectorAll(sel).catch(() => []);
  for (const id of ids.slice(0, 3)) {
    const h = await cdp.getOuterHTML(id).catch(() => '');
    if (h.length > 200) console.log(`  ${sel} -> ${h.length} 字符，前 600:\n${h.slice(0, 600)}\n`);
  }
}

const shot = path.join(ROOT, 'artifacts', 'screenshots', `messages-${jobId}-${Date.now()}.png`);
await cdp.screenshot(shot).catch(() => {});
console.log(`截图: ${shot}`);

await cdp.close();
process.exitCode = 0;
