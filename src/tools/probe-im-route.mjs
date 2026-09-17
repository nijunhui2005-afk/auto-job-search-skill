/**
 * 探针：定位"发送简历"入口。分两步，都不发任何消息。
 *   A) 从页面链接里找出 IM 的真实路由（/im/ 只返回空壳，说明路由不对）
 *   B) 用更长的等待重试 IM 路由，并**全量**导出可交互元素（不做关键词过滤）
 *
 * 用法: node src/tools/probe-im-route.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpLite } from '../core/browser/cdp-lite.mjs';
import { HOME } from '../core/paths.mjs';

const ROOT = HOME; // 工作根（config/state/artifacts 都在这里）
const port = Number(process.env.CDP_PORT || 9222);

const cdp = await CdpLite.attach({ port, url: 'https://c.liepin.com/' });
await cdp.navigate('https://c.liepin.com/');
await cdp.waitStable({ quietMs: 2000, maxMs: 20000 });

// ---------- A) 找 IM 路由 ----------
console.log('=== A) 页面里的 IM / 消息相关链接 ===');
const links = await cdp.querySelectorAll('a[href]');
const found = new Set();
for (const id of links) {
  const a = await cdp.getAttributes(id).catch(() => ({}));
  const href = a.href || '';
  if (!/im|chat|message|xinxi|msg/i.test(href)) continue;
  if (found.has(href)) continue;
  found.add(href);
  const t = await cdp.getText(id).catch(() => '');
  console.log(`  "${t.slice(0, 20)}"  ->  ${href}`);
}

// 首页整页文本里"有新消息"附近的内容
const homeText = await cdp.pageText();
const i = homeText.indexOf('有新消息');
if (i >= 0) console.log(`\n  页头片段: ...${homeText.slice(Math.max(0, i - 60), i + 40).replace(/\s+/g, ' ')}...`);

// ---------- B) IM 路由长等待重试 + 全量元素导出 ----------
const ROUTES = [
  'https://c.liepin.com/im/',
  'https://c.liepin.com/im/index',
  'https://c.liepin.com/chat',
  'https://c.liepin.com/message',
  'https://c.liepin.com/chatlist',
];
console.log('\n=== B) 重试 IM 路由（每个等 9s）===');
let best = null;
for (const r of ROUTES) {
  const landed = await cdp.navigate(r);
  await new Promise((res) => setTimeout(res, 9000));
  const text = await cdp.pageText().catch(() => '');
  const uniq = new Set(text.replace(/\s+/g, ' ').match(/[\u4e00-\u9fa5]{2,6}/g) || []);
  console.log(`  ${r}\n    -> ${landed}  文本 ${text.length} 字  词例: ${[...uniq].slice(0, 12).join('/')}`);
  if (text.length > 300) {
    best = { url: landed, text };
    break;
  }
}

if (best) {
  console.log(`\n=== 全量可交互元素（页面 ${best.url}）===`);
  const seen = new Set();
  let n = 0;
  for (const sel of ['button', '[role="button"]', 'a', 'input', 'textarea', '[contenteditable]', 'li', 'div[class*="btn"]', 'div[class*="tool"]', 'i']) {
    const ids = await cdp.querySelectorAll(sel);
    if (!ids.length) continue;
    console.log(`\n  --- ${sel} (${ids.length}) ---`);
    for (const id of ids.slice(0, 120)) {
      const t = await cdp.getText(id).catch(() => '');
      const a = await cdp.getAttributes(id).catch(() => ({}));
      const box = await cdp.boxCenter(id).catch(() => null);
      const key = `${sel}|${t}|${a.class}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`    "${t.slice(0, 26)}"  ph="${a.placeholder || ''}"  cls="${(a.class || '').slice(0, 60)}"  vis=${!!box}`);
      if (++n >= 90) break;
    }
  }
  const shot = path.join(ROOT, 'artifacts', 'screenshots', `im-route-${Date.now()}.png`);
  await cdp.screenshot(shot).catch(() => {});
  console.log(`\n截图: ${shot}`);
} else {
  console.log('\n所有路由都是空壳 —— IM 可能是独立 SPA 或在弹窗里，需要从聊天面板入手');
}

await cdp.close();
process.exitCode = 0;
