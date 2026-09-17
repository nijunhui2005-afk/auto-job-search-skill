/**
 * 探针：connectOverCDP 得到的 browser，调用 browser.close() 到底是
 *   (a) 只断开 CDP 连接（Chrome 存活）
 *   (b) 连 Chrome 一起关掉
 *
 * 这个语义直接决定 cli.mjs 的收尾方式：能用 browser.close() 就不用 process.exit()，
 * 从而避开 Node 24 上 "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" 的 libuv 报错。
 *
 * 用法: node src/tools/probe-cdp-close.mjs [port]
 */

import { chromium } from 'playwright-core';

const port = Number(process.argv[2] || process.env.CDP_PORT || 9222);
const endpoint = `http://127.0.0.1:${port}`;

const alive = async () => {
  try {
    const r = await fetch(`${endpoint}/json/version`);
    if (!r.ok) return null;
    return (await r.json()).Browser;
  } catch {
    return null;
  }
};

/** 通过 CDP HTTP 端点列出全部 page target（不依赖 Playwright 连接） */
const listPages = async () => {
  try {
    const r = await fetch(`${endpoint}/json/list`);
    const all = await r.json();
    return all.filter((t) => t.type === 'page').map((t) => `${t.url}  [${t.title}]`);
  } catch {
    return null;
  }
};

console.log(`probe target: ${endpoint}`);
console.log(`CDP before     : ${await alive()}`);
console.log(`pages before   : ${JSON.stringify(await listPages())}`);

const browser = await chromium.connectOverCDP(endpoint);
console.log(`contexts       : ${browser.contexts().length}`);
for (const [i, ctx] of browser.contexts().entries()) {
  console.log(`  ctx[${i}] pages=${ctx.pages().length} -> ${ctx.pages().map((p) => p.url().slice(0, 80)).join(' | ')}`);
}

console.log('calling browser.close() ...');
const t0 = Date.now();
await browser.close();
console.log(`browser.close() returned in ${Date.now() - t0}ms`);

await new Promise((r) => setTimeout(r, 1000));
const after = await alive();
const pagesAfter = await listPages();
console.log(`CDP after      : ${after}`);
console.log(`pages after    : ${JSON.stringify(pagesAfter)}`);

if (after) {
  console.log('VERDICT: (a) close() 只断开 CDP 连接，Chrome 存活 —— cli.mjs 可以安全地 await browser.close()');
  if (pagesAfter && pagesAfter.length === 0) {
    console.log('        注意：但目标页被一并关闭（Chrome 会留一个 about:blank）→ 每次调用都必须显式导航，不能依赖已有标签页');
  }
  process.exitCode = 0;
} else {
  console.log('VERDICT: (b) close() 把 Chrome 也关了 —— cli.mjs 必须改用 process.exit() 断开');
  process.exitCode = 3;
}
