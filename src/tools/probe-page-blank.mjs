/**
 * 探针：定位 "导航到 c.liepin.com 后页面变成 about:blank" 的成因。
 *
 * 观测点：
 *   - 每 250ms 采样 page.url()
 *   - 监听 CDP Page.frameNavigated，记录每次主框架导航及其时间
 *   - 区分「新建标签页」与「复用已有标签页」两种情况
 *
 * 用法: node src/tools/probe-page-blank.mjs [url] [--reuse]
 */

import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const reuse = args.includes('--reuse');
const url = args.find((a) => a.startsWith('http')) || 'https://c.liepin.com/';
const port = Number(process.env.CDP_PORT || 9222);
const endpoint = `http://127.0.0.1:${port}`;

const listPages = async () => {
  try {
    const all = await (await fetch(`${endpoint}/json/list`)).json();
    return all.filter((t) => t.type === 'page').map((t) => t.url);
  } catch {
    return null;
  }
};

const t0 = Date.now();
const stamp = () => `+${String(Date.now() - t0).padStart(6)}ms`;

console.log(`mode = ${reuse ? 'REUSE 已有标签页' : 'NEW 新建标签页'}`);
console.log(`url  = ${url}`);
console.log(`${stamp()} pages before = ${JSON.stringify(await listPages())}`);

const browser = await chromium.connectOverCDP(endpoint);
const ctx = browser.contexts()[0];

let page;
if (reuse) {
  page = ctx.pages().find((p) => /liepin\.com/.test(p.url())) || ctx.pages()[0];
  if (!page) throw new Error('没有可复用的标签页（--reuse 模式下需要你先手动打开一个猎聘标签页）');
  console.log(`${stamp()} reusing page, url=${page.url()}`);
} else {
  page = await ctx.newPage();
  console.log(`${stamp()} new page created, url=${page.url()}`);
}

// CDP: 记录主框架导航事件，看导航是否由渲染进程发起
const client = await ctx.newCDPSession(page);
await client.send('Page.enable').catch(() => {});
client.on('Page.frameNavigated', (e) => {
  if (!e.frame.parentId) console.log(`${stamp()} [navigate] -> ${e.frame.url}`);
});
client.on('Page.frameDetached', (e) => {
  console.log(`${stamp()} [frameDetached] reason=${e.reason} frame=${e.frameId?.slice(0, 12)}`);
});

page.on('close', () => console.log(`${stamp()} [page CLOSED]`));
page.on('crash', () => console.log(`${stamp()} [page CRASH]`));

console.log(`${stamp()} goto ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log(`goto err: ${e.message}`));

// 采样 25 秒
for (let i = 0; i < 100; i++) {
  await new Promise((r) => setTimeout(r, 250));
  let u;
  try {
    u = page.url();
  } catch (e) {
    console.log(`${stamp()} page.url() threw: ${e.message}`);
    break;
  }
  if (i === 0 || u !== globalThis.__lastU) {
    console.log(`${stamp()} url = ${u}`);
    globalThis.__lastU = u;
  }
}

console.log(`${stamp()} pages after = ${JSON.stringify(await listPages())}`);
console.log(`${stamp()} final url = ${page.url()}`);

await browser.close();
process.exitCode = 0;
