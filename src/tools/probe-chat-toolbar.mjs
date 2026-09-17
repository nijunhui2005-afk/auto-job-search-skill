/**
 * 探针：打开 IM 页面 → 点开一个已有会话 → 枚举聊天工具栏里的所有入口。
 * 目标是找到"发简历 / 附件 / 文件"按钮。
 *
 * 安全说明：打开会话不发送任何消息。本脚本全程不点任何发送类按钮。
 *
 * 用法: node src/tools/probe-chat-toolbar.mjs [会话名关键词]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpLite } from '../core/browser/cdp-lite.mjs';
import { HOME } from '../core/paths.mjs';

const ROOT = HOME; // 工作根（config/state/artifacts 都在这里）
const port = Number(process.env.CDP_PORT || 9222);
const nameHint = process.argv[2] || '';

const cdp = await CdpLite.attach({ port, url: 'https://c.liepin.com/' });

// ---------- 1. 进 IM 页面（渲染慢，耐心等） ----------
console.log('打开 IM 页面并等待渲染（最多 25s）...');
await cdp.navigate('https://c.liepin.com/im/');
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 2500));
  const t = await cdp.pageText().catch(() => '');
  process.stdout.write(`  ${(i + 1) * 2.5}s: ${t.length} 字\r`);
  if (t.length > 800) break;
}
const imText = await cdp.pageText().catch(() => '');
console.log(`\n  IM 页面文本 ${imText.length} 字`);
console.log(`  片段: ${imText.replace(/\s+/g, ' ').slice(0, 400)}`);

// ---------- 2. 找会话列表项并点开 ----------
console.log('\n=== 会话列表项 ===');
let clicked = false;
for (const sel of ['li', 'div[class*="conversation"]', 'div[class*="session"]', 'div[class*="chat-item"]', 'div[class*="list-item"]', 'div[class*="contact"]']) {
  const ids = await cdp.querySelectorAll(sel);
  if (!ids.length) continue;
  let n = 0;
  for (const id of ids.slice(0, 60)) {
    const t = (await cdp.getText(id).catch(() => '')).replace(/\s+/g, ' ');
    if (!t || t.length < 2 || t.length > 120) continue;
    const box = await cdp.boxCenter(id).catch(() => null);
    if (!box) continue;
    const a = await cdp.getAttributes(id).catch(() => ({}));
    console.log(`  <${sel}> "${t.slice(0, 40)}" cls="${(a.class || '').slice(0, 50)}"`);
    if (!clicked && (!nameHint || t.includes(nameHint))) {
      console.log(`    >>> 点开这个会话（不发送任何内容）`);
      await cdp.clickNode(id, { settleMs: 2500 });
      clicked = true;
    }
    if (++n >= 12) break;
  }
  if (clicked) break;
}

if (!clicked) {
  console.log('  没有点到任何会话 —— 可能 IM 页面结构不同，下面直接看工具栏');
}
await new Promise((r) => setTimeout(r, 3000));

// ---------- 3. 枚举聊天工具栏 ----------
console.log('\n=== 聊天区域可交互元素 ===');
const seen = new Set();
for (const sel of ['button', '[role="button"]', 'i', 'span[class*="icon"]', 'div[class*="icon"]', 'div[class*="tool"]', 'div[class*="action"]', 'textarea', '[contenteditable]', 'input']) {
  const ids = await cdp.querySelectorAll(sel);
  if (!ids.length) continue;
  const lines = [];
  for (const id of ids.slice(0, 150)) {
    const t = (await cdp.getText(id).catch(() => '')).replace(/\s+/g, ' ');
    const a = await cdp.getAttributes(id).catch(() => ({}));
    const box = await cdp.boxCenter(id).catch(() => null);
    const key = `${sel}|${t}|${a.class}|${a.placeholder}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // 只输出有意义的：有文本、有 placeholder、或有 icon/tool 类名
    const meaningful = t || a.placeholder || /icon|tool|action|btn|resume|file|attach/i.test(a.class || '');
    if (!meaningful) continue;
    lines.push(`    "${t.slice(0, 26)}" ph="${a.placeholder || ''}" cls="${(a.class || '').slice(0, 60)}" vis=${!!box}`);
  }
  if (lines.length) {
    console.log(`  --- ${sel} ---`);
    console.log(lines.slice(0, 25).join('\n'));
  }
}

// ---------- 4. 文本里找关键词 ----------
const t2 = await cdp.pageText().catch(() => '');
console.log('\n=== 关键词命中 ===');
for (const kw of ['发简历', '发送简历', '附件', '文件', '图片', '在线简历', '我的简历']) {
  const idx = t2.indexOf(kw);
  if (idx >= 0) console.log(`  [${kw}] ...${t2.slice(Math.max(0, idx - 50), idx + 70).replace(/\s+/g, ' ')}...`);
}

const shot = path.join(ROOT, 'artifacts', 'screenshots', `chat-toolbar-${Date.now()}.png`);
await cdp.screenshot(shot).catch(() => {});
console.log(`\n截图: ${shot}`);

await cdp.close();
process.exitCode = 0;
