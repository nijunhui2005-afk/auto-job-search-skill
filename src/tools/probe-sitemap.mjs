/**
 * 探针：用 cdp-lite（无 Runtime）读取 c.liepin.com 的真实 DOM 结构。
 * 目标：找到职位搜索入口 URL，并确认页面能长时间存活。
 *
 * 用法: node src/tools/probe-sitemap.mjs [url]
 */

import { CdpLite } from '../core/browser/cdp-lite.mjs';

const url = process.argv[2] || 'https://c.liepin.com/';
const port = Number(process.env.CDP_PORT || 9222);

const t0 = Date.now();
const stamp = () => `+${String(Date.now() - t0).padStart(6)}ms`;

const cdp = await CdpLite.attach({ port, url });
console.log(`${stamp()} attached, ${cdp.browserVersion}, url=${url}`);

const finalUrl = await cdp.navigate(url);
console.log(`${stamp()} navigated -> ${finalUrl}`);

// 存活观测：每 1s 采样一次 URL，共 15s
console.log(`${stamp()} 开始 15s 存活观测...`);
let aliveCount = 0;
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const u = await cdp.currentUrl();
  const blank = !u || /^about:/.test(u);
  if (blank) {
    console.log(`${stamp()} [BLANKED] url=${u}`);
    break;
  }
  aliveCount++;
}
console.log(`${stamp()} 存活 ${aliveCount}/15 秒，最终 url=${await cdp.currentUrl()}`);

// ---- DOM 侦察 ----
console.log(`\n=== 输入控件 ===`);
for (const sel of ['input', 'textarea', '[contenteditable="true"]']) {
  const ids = await cdp.querySelectorAll(sel);
  console.log(`  ${sel}: ${ids.length} 个`);
  for (const id of ids.slice(0, 12)) {
    const a = await cdp.getAttributes(id).catch(() => ({}));
    console.log(`    ph="${a.placeholder || ''}" id="${a.id || ''}" name="${a.name || ''}" cls="${(a.class || '').slice(0, 70)}"`);
  }
}

console.log(`\n=== 含 job/search/position 的链接 ===`);
const links = await cdp.querySelectorAll('a[href]');
console.log(`  a[href] 总数: ${links.length}`);
const seen = new Set();
for (const id of links.slice(0, 400)) {
  let a;
  try {
    a = await cdp.getAttributes(id);
  } catch {
    continue;
  }
  const href = a.href || '';
  if (!/job|search|position|zhaopin|list/i.test(href)) continue;
  if (seen.has(href)) continue;
  seen.add(href);
  const txt = await cdp.getText(id).catch(() => '');
  console.log(`    ${txt.slice(0, 24).padEnd(26)} ${href.slice(0, 120)}`);
  if (seen.size >= 25) break;
}

console.log(`\n=== 「搜索」相关文本节点所在的交互元素 ===`);
for (const sel of ['button', '[role="button"]', '.search-btn', '[class*="search"]']) {
  const ids = await cdp.querySelectorAll(sel);
  if (!ids.length) continue;
  console.log(`  ${sel}: ${ids.length} 个`);
  for (const id of ids.slice(0, 10)) {
    const txt = await cdp.getText(id).catch(() => '');
    const a = await cdp.getAttributes(id).catch(() => ({}));
    if (txt) console.log(`    "${txt.slice(0, 30)}"  cls="${(a.class || '').slice(0, 70)}"`);
  }
}

console.log(`\n=== 导航事件 ===`);
for (const n of cdp.navigations) console.log(`  +${n.t - t0}ms  ${n.url}`);

console.log(`\n=== 搜索/职位相关接口 ===`);
for (const h of cdp.networkHits) {
  if (h.isRequest) console.log(`  REQ ${h.method} ${h.url.slice(0, 150)}${h.postData ? `\n        body=${String(h.postData).slice(0, 200)}` : ''}`);
  else console.log(`  RES ${h.status} ${h.url.slice(0, 150)}`);
}

await cdp.close();
process.exitCode = 0;
