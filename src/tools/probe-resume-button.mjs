/**
 * 探针：聊天窗里的「发简历」按钮（action-resume）点下去会发生什么。
 *
 * 背景：猎聘 IM 的 file input 只收图片不收 PDF，且发图片有违规风险，因此放弃上传路线，
 *       改用平台自带的「发简历」动作（发的是猎聘在线简历卡片，不涉及文件上传）。
 *
 * 本探针会**真的点击**「发简历」——这正是用户要求的行为。
 *
 * 用法: node src/tools/probe-resume-button.mjs [jobId] [--no-click]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpLite } from '../core/browser/cdp-lite.mjs';
import { locateGreetButton, locateChatInput } from '../sites/liepin/send.mjs';
import { HOME } from '../core/paths.mjs';

const ROOT = HOME; // 工作根（config/state/artifacts 都在这里）
const port = Number(process.env.CDP_PORT || 9222);
const noClick = process.argv.includes('--no-click');

const scored = JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts', 'scored.json'), 'utf8'));
const jobId = process.argv.find((a) => /^\d+$/.test(a)) || '85256053';
const job = scored.jobs.find((j) => String(j.jobId) === String(jobId));
console.log(`岗位: [${job?.ai?.score}] ${job?.title} @${job?.company}\n`);

const cdp = await CdpLite.attach({ port, url: 'https://c.liepin.com/' });
await cdp.navigate(job.link);
await cdp.waitStable({ quietMs: 2000, maxMs: 25000 });

// 打开会话
const btns = await locateGreetButton(cdp);
if (!btns.length) {
  console.log('找不到聊天入口');
  process.exit(1);
}
await cdp.clickNode(btns[0].nodeId, { settleMs: 2500 });
await new Promise((r) => setTimeout(r, 4000));
const inputs = await locateChatInput(cdp);
console.log(`会话已打开: ${inputs.length} 个输入框\n`);

// ── 1. 枚举聊天动作条 ──
console.log('=== 聊天动作条按钮（class 含 im-ui-action-button）===');
const actions = [];
for (const sel of ['span', 'div', 'button', 'i']) {
  const ids = await cdp.querySelectorAll(sel);
  for (const id of ids.slice(0, 400)) {
    const a = await cdp.getAttributes(id).catch(() => ({}));
    const cls = a.class || '';
    if (!/im-ui-action-button/.test(cls)) continue;
    const t = (await cdp.getText(id).catch(() => '')).replace(/\s+/g, ' ').trim();
    const box = await cdp.boxCenter(id).catch(() => null);
    if (!box) continue;
    const key = `${sel}|${cls}`;
    if (actions.some((x) => x.key === key)) continue;
    actions.push({ key, sel, cls, text: t, nodeId: id, x: Math.round(box.x), y: Math.round(box.y) });
  }
}
for (const a of actions) console.log(`  <${a.sel}> cls="${a.cls.slice(0, 60)}" text="${a.text}" at ${a.x},${a.y}`);

// ── 2. 精确定位 action-resume ──
const resumeCandidates = [];
for (const sel of ['span', 'div', 'button', 'i']) {
  const ids = await cdp.querySelectorAll(sel);
  for (const id of ids.slice(0, 400)) {
    const a = await cdp.getAttributes(id).catch(() => ({}));
    if (!/action-resume/.test(a.class || '')) continue;
    const t = (await cdp.getText(id).catch(() => '')).replace(/\s+/g, ' ').trim();
    const box = await cdp.boxCenter(id).catch(() => null);
    resumeCandidates.push({ sel, cls: a.class, text: t, nodeId: id, visible: !!box, at: box ? `${Math.round(box.x)},${Math.round(box.y)}` : '-' });
  }
}
console.log(`\n=== action-resume 候选（${resumeCandidates.length}）===`);
for (const c of resumeCandidates) console.log(`  <${c.sel}> cls="${c.cls}" text="${c.text}" visible=${c.visible} at ${c.at}`);

const before = await cdp.pageText().catch(() => '');
console.log(`\n点击前页面文本 ${before.length} 字`);

const target = resumeCandidates.find((c) => c.visible) || resumeCandidates[0];
if (!target) {
  console.log('\n没有找到 action-resume 元素');
  await cdp.close();
  process.exit(1);
}

if (noClick) {
  console.log('\n--no-click：只定位，不点击。');
  await cdp.close();
  process.exit(0);
}

// ── 3. 点击 ──
console.log(`\n=== 点击 <${target.sel}> cls="${target.cls}" ===`);
await cdp.clickNode(target.nodeId, { settleMs: 1500 });
for (const wait of [1500, 2500, 3500]) {
  await new Promise((r) => setTimeout(r, wait));
  const t = await cdp.pageText().catch(() => '');
  const diff = t.length - before.length;
  console.log(`  t+${wait}ms 文本 ${t.length} 字 (diff ${diff >= 0 ? '+' : ''}${diff})`);
}

// ── 4. 看有没有弹层/二次确认 ──
console.log('\n=== 点击后新出现的关键词 ===');
const after = await cdp.pageText().catch(() => '');
for (const kw of ['确定', '确认', '取消', '发送', '简历', '已发送', '交换', '次数', '失败', '提示']) {
  const ib = before.indexOf(kw);
  const ia = after.indexOf(kw);
  if (ia >= 0 && ia !== ib) {
    const near = after.slice(Math.max(0, ia - 50), ia + 60).replace(/\s+/g, ' ');
    console.log(`  [${kw}] ...${near}...`);
  }
}
console.log('\n=== 点击后「发送/确定/确认」按钮 ===');
for (const sel of ['button', 'a', 'div[class*="btn"]', 'span[class*="btn"]']) {
  const ids = await cdp.querySelectorAll(sel);
  for (const id of ids.slice(0, 400)) {
    const t = (await cdp.getText(id).catch(() => '')).replace(/\s+/g, ' ').trim();
    if (!/^(发送|确定|确认|确认发送|立即发送)$/.test(t)) continue;
    const box = await cdp.boxCenter(id).catch(() => null);
    if (!box) continue;
    const a = await cdp.getAttributes(id).catch(() => ({}));
    console.log(`  "${t}" cls="${(a.class || '').slice(0, 60)}" at ${Math.round(box.x)},${Math.round(box.y)}`);
  }
}

// ── 5. action-resume 自身状态有没有变 ──
console.log('\n=== 点击后 action-resume 状态 ===');
for (const sel of ['span', 'div']) {
  const ids = await cdp.querySelectorAll(sel);
  for (const id of ids.slice(0, 400)) {
    const a = await cdp.getAttributes(id).catch(() => ({}));
    if (!/action-resume/.test(a.class || '')) continue;
    const t = (await cdp.getText(id).catch(() => '')).replace(/\s+/g, ' ').trim();
    console.log(`  <${sel}> cls="${a.class}" text="${t}"`);
  }
}

const shot = path.join(ROOT, 'artifacts', 'screenshots', `resume-btn-${jobId}-${Date.now()}.png`);
await cdp.screenshot(shot).catch(() => {});
console.log(`\n截图: ${shot}`);

await cdp.close();
process.exitCode = 0;
