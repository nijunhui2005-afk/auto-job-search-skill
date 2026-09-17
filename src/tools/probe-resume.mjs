/**
 * 探针：找出候选人自己的简历接口，把简历正文取出来。
 * 这样打招呼语能引用真实经历，而不是靠用户手填。
 *
 * 用法: node src/tools/probe-resume.mjs
 */

import { CdpLite } from '../core/browser/cdp-lite.mjs';

const port = Number(process.env.CDP_PORT || 9222);
const RE = /cresume|resume|userinfo|usercx\.pc\.user|expect/i;

const cdp = await CdpLite.attach({ port, url: 'https://c.liepin.com/' });
await cdp.navigate('https://c.liepin.com/');
await cdp.waitStable({ quietMs: 2000, maxMs: 25000 });

console.log('=== 简历/用户相关请求（含 postData）===');
for (const r of cdp.dumpRequests(RE)) {
  console.log(`\n  ${r.method} ${r.url.replace('https://', '')}`);
  if (r.postData) console.log(`    body: ${String(r.postData).slice(0, 400)}`);
}

console.log('\n=== 逐个响应看内容 ===');
const responses = cdp.networkHits.filter((h) => h.kind === 'response' && RE.test(h.url));
const seen = new Set();
for (const r of responses) {
  const key = r.url.split('?')[0];
  if (seen.has(key)) continue;
  seen.add(key);
  const { json } = await cdp.responseBody(r.requestId);
  if (!json) continue;
  const s = JSON.stringify(json);
  console.log(`\n  [${s.length} bytes] ${key.replace('https://', '')}`);
  console.log(`    flag=${json.flag} data keys=${Object.keys(json.data || {}).join(', ').slice(0, 300)}`);
  if (s.length < 4000 && json.data) {
    console.log(`    data: ${s.slice(0, 1500)}`);
  }
}

// 主动试几个详情端点
console.log('\n=== 主动尝试简历详情端点 ===');
const tries = [
  ['com.liepin.cresume.web-resume-detail', { data: {} }],
  ['com.liepin.cresume.web-resume-detail', { imId: '', imApp: '1' }],
  ['com.liepin.cresume.get-current-userinfo', { imId: '', imApp: '1' }],
];
for (const [path, body] of tries) {
  const res = await cdp.fetchInProcess(`https://api-c.liepin.com/api/${path}`, { method: 'POST', body });
  const s = JSON.stringify(res.json);
  console.log(`\n  ${path}  body=${JSON.stringify(body)}`);
  console.log(`    HTTP ${res.status} flag=${res.json?.flag} code=${res.json?.code ?? ''} msg=${res.json?.msg ?? ''} len=${s.length}`);
  if (res.json?.flag === 1) console.log(`    data keys: ${Object.keys(res.json.data || {}).join(', ')}`);
}

await cdp.close();
process.exitCode = 0;
