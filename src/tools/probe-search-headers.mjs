/**
 * 探针：抓 pc-search-job 这个请求的**完整 headers**，找出 Node 直连被拒(400)的原因。
 *
 * 对照点：
 *   - 浏览器里这条请求 flag=1 成功
 *   - Node 侧 fetchInProcess 同样 body 却 flag=0 code=-1400
 *   → 差异必定在请求头（签名 / csrf / 风控标识）或 cookie 范围
 *
 * 用法: node src/tools/probe-search-headers.mjs
 */

import { CdpLite } from '../core/browser/cdp-lite.mjs';

const port = Number(process.env.CDP_PORT || 9222);
const TARGET = /searchfront4c\.pc-search-job$/;

const cdp = await CdpLite.attach({ port, url: 'https://c.liepin.com/' });
await cdp.navigate('https://c.liepin.com/');

console.log('导航到搜索页触发真实请求...');
await cdp.navigate('https://www.liepin.com/zhaopin/?key=Agent%20%E5%BC%80%E5%8F%91&city=020&workYearCode=1');
await cdp.waitStable({ quietMs: 2000, maxMs: 25000 });

const req = cdp.dumpRequests(TARGET)[0];
if (!req) {
  console.log('没抓到 pc-search-job 请求。已记录的请求：');
  for (const r of cdp.dumpRequests()) console.log(`  ${r.method} ${r.url.slice(0, 120)}`);
} else {
  console.log(`\n=== 浏览器真实请求 ===`);
  console.log(`${req.method} ${req.url}`);
  console.log('\n--- headers ---');
  const keys = Object.keys(req.headers).sort();
  for (const k of keys) {
    const v = req.headers[k];
    const shown = /cookie|token|auth/i.test(k) ? String(v).slice(0, 80) + '...' : String(v).slice(0, 200);
    console.log(`  ${k}: ${shown}`);
  }
  console.log('\n--- body ---');
  console.log(`  ${String(req.postData).slice(0, 900)}`);

  // 逐项对照：我们 Node 直连时发了什么
  console.log('\n=== Node 直连时会发的 headers ===');
  const cookies = await cdp.getCookies('https://c.liepin.com/');
  console.log(`  cookie: ${cookies.length} 个 -> ${cookies.map((c) => c.name).join(', ')}`);
  const cCookie = await cdp.getCookies('https://api-c.liepin.com/');
  console.log(`  对 api-c.liepin.com 可见 cookie: ${cCookie.length} 个 -> ${cCookie.map((c) => c.name).join(', ')}`);
  console.log('  (其余 header 由 fetchInProcess 固定写死: accept / content-type / user-agent)');
  console.log('\n=== 浏览器独有的 header（Node 侧没发） ===');
  const ours = new Set(['accept', 'content-type', 'user-agent', 'cookie', 'content-length', 'host', 'origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'accept-encoding', 'accept-language', 'priority', 'connection']);
  for (const k of keys) {
    if (ours.has(k.toLowerCase())) continue;
    console.log(`  ${k}: ${String(req.headers[k]).slice(0, 120)}`);
  }
}

await cdp.close();
process.exitCode = 0;
