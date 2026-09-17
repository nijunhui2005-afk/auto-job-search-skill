/**
 * 探针：真实执行一次职位搜索，抓取
 *   1. 搜索接口的完整 request body + headers（判断有没有签名/风控参数）
 *   2. 响应 JSON 的结构（职位列表字段）
 *
 * 两种路径：
 *   A. 直接导航到搜索 URL
 *   B. 走 UI：定位搜索框 -> Input.insertText -> 回车
 *
 * 用法: node src/tools/probe-search.mjs "Agent 开发"
 */

import { CdpLite } from '../core/browser/cdp-lite.mjs';

const keyword = process.argv[2] || 'Agent 开发';
const port = Number(process.env.CDP_PORT || 9222);
const t0 = Date.now();
const stamp = () => `+${String(Date.now() - t0).padStart(6)}ms`;

const JOB_API_RE = /(csearch|searchfront4c|job).*\.(json|do)?/i;

const cdp = await CdpLite.attach({ port, url: 'https://c.liepin.com/' });
console.log(`${stamp()} attached ${cdp.browserVersion}`);

// ---------- 路径 A：直接搜索 URL ----------
const searchUrl = `https://www.liepin.com/zhaopin/?key=${encodeURIComponent(keyword)}&city=020&workYearCode=1&currentPage=0`;
console.log(`${stamp()} A: navigate ${searchUrl}`);
const landed = await cdp.navigate(searchUrl);
console.log(`${stamp()} A: landed on ${landed}`);
await cdp.waitStable({ quietMs: 2000, maxMs: 25000 });
console.log(`${stamp()} A: settled, url=${await cdp.currentUrl()}`);

// ---------- 路径 B：如果 A 没出结果，走 UI ----------
const jobApis = () =>
  cdp.networkHits.filter((h) => h.kind === 'response' && /liepin\.com\/api/.test(h.url));

if (jobApis().length < 5) {
  console.log(`${stamp()} B: 接口太少(${jobApis().length})，改走 UI 路径`);
  const inputs = await cdp.querySelectorAll('input');
  console.log(`${stamp()} B: 找到 ${inputs.length} 个 input`);
  for (const id of inputs) {
    const a = await cdp.getAttributes(id).catch(() => ({}));
    console.log(`       ph="${a.placeholder || ''}" cls="${(a.class || '').slice(0, 60)}"`);
  }
  const box = inputs.find(async () => true);
  if (box) {
    await cdp.clickNode(box);
    await cdp.typeText(keyword);
    await cdp.pressKey('Enter', 'Enter', 13);
    await cdp.waitStable({ quietMs: 2500, maxMs: 25000 });
    console.log(`${stamp()} B: after typing, url=${await cdp.currentUrl()}`);
  }
}

// ---------- 报告：所有 API 请求（含 body / headers） ----------
console.log(`\n=== 全部 API 请求 (含 postData) ===`);
for (const r of cdp.dumpRequests()) {
  const short = r.url.replace('https://', '').slice(0, 110);
  console.log(`\n  ${r.method} ${short}`);
  if (r.postData) console.log(`    body: ${String(r.postData).slice(0, 700)}`);
}

// ---------- 报告：找职位列表响应，dump 结构 ----------
console.log(`\n=== 探测职位列表响应 ===`);
const responses = cdp.networkHits.filter((h) => h.kind === 'response');
const candidates = [];
for (const r of responses) {
  if (!/liepin\.com\/api/.test(r.url)) continue;
  if (r._probed) continue;
  r._probed = true;
  const { json } = await cdp.responseBody(r.requestId);
  if (!json) continue;
  const jsonStr = JSON.stringify(json);
  if (jsonStr.length < 800) continue;
  candidates.push({ r, json, size: jsonStr.length });
}
candidates.sort((a, b) => b.size - a.size);

for (const { r, json, size } of candidates.slice(0, 6)) {
  console.log(`\n  [${size} bytes] ${r.url.slice(0, 130)}`);
  console.log(`    top keys: ${Object.keys(json).join(', ')}`);
  const data = json.data ?? json;
  console.log(`    data keys: ${Object.keys(data || {}).join(', ').slice(0, 400)}`);
  // 找出数组型字段（职位列表通常在这里）
  for (const [k, v] of Object.entries(data || {})) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
      console.log(`    ARRAY .data.${k} len=${v.length}`);
      console.log(`      item[0] keys: ${Object.keys(v[0]).join(', ')}`);
      console.log(`      item[0] sample: ${JSON.stringify(v[0]).slice(0, 900)}`);
    }
  }
  if (json.flag !== undefined) console.log(`    flag=${json.flag} msg=${json.msg || ''}`);
}

console.log(`\n=== 页面存活确认 ===`);
console.log(`  url = ${await cdp.currentUrl()}`);

await cdp.close();
process.exitCode = 0;
