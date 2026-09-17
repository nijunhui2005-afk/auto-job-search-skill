/**
 * 探针：找职位详情接口，拿到 JD 正文 + 公司简介。
 * 列表接口的 job 对象只有标题/薪资/标签，没有 JD，所以打分和打招呼语都缺关键输入。
 *
 * 策略：A) 直接试几个候选端点；B) 导航到真实职位页，抓页面自己调的接口。
 *
 * 用法: node src/tools/probe-job-detail.mjs [jobId]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpLite } from '../core/browser/cdp-lite.mjs';
import { HOME } from '../core/paths.mjs';

const ROOT = HOME; // 工作根（config/state/artifacts 都在这里）
const port = Number(process.env.CDP_PORT || 9222);

// 从 scored.json 里挑一个分数最高且有链接的职位
let jobId = process.argv[2];
let jobLink = null;
const scoredFile = path.join(ROOT, 'artifacts', 'scored.json');
if (!jobId && fs.existsSync(scoredFile)) {
  const s = JSON.parse(fs.readFileSync(scoredFile, 'utf8'));
  const top = s.jobs.find((j) => j.link && !j.chatted);
  jobId = top?.jobId;
  jobLink = top?.link;
  console.log(`取打分最高的职位: [${top?.ai?.score}] ${top?.title} @${top?.company}`);
}
jobLink = jobLink || `https://www.liepin.com/lptjob/${jobId}`;
console.log(`jobId=${jobId}  link=${jobLink}`);

const cdp = await CdpLite.attach({ port, url: 'https://c.liepin.com/' });

// ---------- A) 试候选端点 ----------
console.log('\n=== A) 直接试端点 ===');
const candidates = [
  ['com.liepin.searchfront4c.pc-job-detail', { data: { jobId: String(jobId) } }],
  ['com.liepin.searchfront4c.pc-job-detail', { data: { jobId: String(jobId), jobKind: '6' } }],
  ['com.liepin.csearch.job-detail', { data: { jobId: String(jobId) } }],
  ['com.liepin.cbp.job.detail', { data: { jobId: String(jobId) } }],
];
for (const [p, body] of candidates) {
  const res = await cdp.fetchInProcess(`https://api-c.liepin.com/api/${p}`, { method: 'POST', body });
  const s = JSON.stringify(res.json);
  console.log(`  ${p}  body=${JSON.stringify(body).slice(0, 80)}`);
  console.log(`    HTTP ${res.status} flag=${res.json?.flag} code=${res.json?.code ?? ''} msg=${res.json?.msg ?? ''} len=${s.length}`);
  if (res.json?.flag === 1) console.log(`    data keys: ${Object.keys(res.json.data || {}).join(', ').slice(0, 400)}`);
}

// ---------- B) 导航到真实职位页 ----------
console.log('\n=== B) 导航到职位页抓接口 ===');
const landed = await cdp.navigate(jobLink);
console.log(`  landed: ${landed}`);
await cdp.waitStable({ quietMs: 2500, maxMs: 30000 });

console.log(`\n  API 请求:`);
for (const r of cdp.dumpRequests(/liepin\.com\/api/)) {
  console.log(`    ${r.method} ${r.url.replace('https://', '').slice(0, 130)}`);
  if (r.postData) console.log(`      body: ${String(r.postData).slice(0, 400)}`);
}

console.log(`\n  大响应（可能是详情）:`);
const seen = new Set();
for (const r of cdp.networkHits.filter((h) => h.kind === 'response' && /liepin\.com\/api/.test(h.url))) {
  const key = r.url.split('?')[0];
  if (seen.has(key)) continue;
  seen.add(key);
  const { json } = await cdp.responseBody(r.requestId);
  if (!json) continue;
  const s = JSON.stringify(json);
  if (s.length < 1500) continue;
  console.log(`\n    [${s.length}] ${key.replace('https://', '')}`);
  const d = json.data ?? {};
  console.log(`      flag=${json.flag} data keys=${Object.keys(d).join(', ').slice(0, 300)}`);
  // 找长文本字段（JD 正文）
  const walk = (node, p = '', depth = 0) => {
    if (depth > 3 || !node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && v.length > 200 && !/^https?:|^data:/.test(v)) {
        console.log(`      TEXT .${p}${k} (${v.length}): ${v.slice(0, 250).replace(/\n/g, ' ⏎ ')}`);
      } else if (v && typeof v === 'object') walk(v, `${p}${k}.`, depth + 1);
    }
  };
  walk(d);
}

// 页面截图留证
const shotFile = path.join(ROOT, 'artifacts', 'screenshots', `jobdetail-${Date.now()}.png`);
await cdp.screenshot(shotFile).catch(() => {});
console.log(`\n  screenshot: ${shotFile}`);

await cdp.close();
process.exitCode = 0;
