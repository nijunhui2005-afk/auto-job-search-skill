/**
 * 探针：搞清猎聘聊天窗里"发附件"的真实机制。
 *
 * 关键未知：file input 是一直在 DOM 里（隐藏），还是点附件图标后才创建？
 * 这决定了实现方式：
 *   - 若一直在  -> 直接 DOM.setFileInputFiles
 *   - 若点后才出 -> 必须先点图标，但点图标可能弹原生文件选择框，需要 Page 域拦截
 *
 * 全程**不上传、不发送**任何东西。
 *
 * 用法: node src/tools/probe-file-input.mjs [jobId]
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
const jobId = process.argv[2] || '85256053';
const job = scored.jobs.find((j) => String(j.jobId) === String(jobId));
if (!job) {
  console.log(`scored.json 里没有 ${jobId}`);
  process.exit(1);
}
console.log(`目标岗位: [${job.ai?.score}] ${job.title} @${job.company}`);
console.log(`链接: ${job.link}\n`);

const cdp = await CdpLite.attach({ port, url: 'https://c.liepin.com/' });

// ---------- 1. 打开职位页 ----------
await cdp.navigate(job.link);
await cdp.waitStable({ quietMs: 2000, maxMs: 25000 });
console.log('1) 已打开职位页');

// ---------- 2. 先看页面原本有没有 file input ----------
async function dumpFileInputs(label) {
  const ids = await cdp.querySelectorAll('input[type="file"]');
  console.log(`   ${label}: input[type=file] = ${ids.length} 个`);
  const out = [];
  for (const id of ids) {
    const a = await cdp.getAttributes(id).catch(() => ({}));
    const box = await cdp.boxCenter(id).catch(() => null);
    out.push({ nodeId: id, accept: a.accept || '', multiple: a.multiple !== undefined, cls: (a.class || '').slice(0, 80), id: a.id || '' });
    console.log(`      <input type=file> accept="${a.accept || ''}" multiple=${a.multiple !== undefined} cls="${(a.class || '').slice(0, 70)}" vis=${!!box}`);
  }
  return out;
}
const beforeClick = await dumpFileInputs('点击聊天前');

// ---------- 3. 打开聊天（点「聊一聊」） ----------
console.log('\n2) 定位并点击「聊一聊」打开会话');
const btns = await locateGreetButton(cdp);
for (const b of btns) console.log(`   "${b.text}" cls="${b.cls}" vis=${b.visible}`);
if (btns.length) {
  await cdp.clickNode(btns[0].nodeId, { settleMs: 2500 });
  console.log('   已点击');
}
await new Promise((r) => setTimeout(r, 3500));

const inputs = await locateChatInput(cdp);
console.log(`   聊天输入框: ${inputs.length} 个 ${inputs.map((i) => `ph="${i.placeholder}"`).join(', ')}`);

// ---------- 4. 再看 file input ----------
const afterOpen = await dumpFileInputs('打开聊天后');

// ---------- 5. 找附件图标 ----------
console.log('\n3) 附件/工具条图标');
const iconNodes = [];
for (const sel of ['i', 'span', 'div', 'button']) {
  const ids = await cdp.querySelectorAll(sel);
  for (const id of ids.slice(0, 300)) {
    const a = await cdp.getAttributes(id).catch(() => ({}));
    const cls = a.class || '';
    if (!/attach|file|upload|resume|jianli|tool|action/i.test(cls)) continue;
    const box = await cdp.boxCenter(id).catch(() => null);
    if (!box) continue;
    const key = `${sel}|${cls}`;
    if (iconNodes.some((n) => n.key === key)) continue;
    iconNodes.push({ key, sel, cls, nodeId: id, box: `${Math.round(box.x)},${Math.round(box.y)}` });
  }
}
for (const n of iconNodes.slice(0, 20)) console.log(`   <${n.sel}> cls="${n.cls.slice(0, 70)}" at ${n.box}`);

// ---------- 6. 页面文本里的工具条文字 ----------
const t = await cdp.pageText().catch(() => '');
console.log('\n4) 页面文本里与发送有关的关键词');
for (const kw of ['发送', '简历', '附件', '文件', '图片', '表情', '按Enter']) {
  const i = t.indexOf(kw);
  if (i >= 0) console.log(`   [${kw}] ...${t.slice(Math.max(0, i - 40), i + 50).replace(/\s+/g, ' ')}...`);
}

const shot = path.join(ROOT, 'artifacts', 'screenshots', `file-input-${Date.now()}.png`);
await cdp.screenshot(shot).catch(() => {});
console.log(`\n截图: ${shot}`);

console.log('\n=== 结论 ===');
console.log(`点击聊天前 file input: ${beforeClick.length} 个`);
console.log(`打开聊天后 file input: ${afterOpen.length} 个`);
if (afterOpen.length) {
  console.log('→ file input 已在 DOM 中，可以直接 DOM.setFileInputFiles 上传（无需点图标）');
} else if (beforeClick.length) {
  console.log('→ 页面有 file input 但不在聊天区，可能属于其他组件');
} else {
  console.log('→ 聊天区没有 file input，需要点附件图标后才会创建（可能要拦截原生文件选择框）');
}

await cdp.close();
process.exitCode = 0;
