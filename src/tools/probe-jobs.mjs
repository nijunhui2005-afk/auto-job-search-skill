/**
 * 探针：
 *   1. 解析地区码表（get-all-dq），定位"临港"/"浦东"的 dq code
 *   2. 调真实搜索接口，展开 data.data 的字段结构（职位条目字段名）
 *   3. 同时验证"仅凭登录 cookie 从 Node 直连 API"是否可行（无签名）
 *
 * 用法: node src/tools/probe-jobs.mjs ["关键词"]
 */

import { CdpLite } from '../core/browser/cdp-lite.mjs';

const keyword = process.argv[2] || 'Agent 开发';
const port = Number(process.env.CDP_PORT || 9222);
const API = 'https://api-c.liepin.com/api';

const cdp = await CdpLite.attach({ port, url: 'https://c.liepin.com/' });
const lat = await cdp.navigate('https://c.liepin.com/');
console.log(`attached on ${lat}`);

// ---------- 1. 地区码 ----------
console.log('\n=== 地区码解析 ===');
const dq = await cdp.fetchInProcess(
  'https://api-dok.liepin.com/api/com.liepin.bd.p.v4.get-all-dq?part=part_1,country,province&sc=0&from=component',
);
if (dq.json?.data) {
  const hits = [];
  const walk = (node, path = []) => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, path));
    if (!node || typeof node !== 'object') return;
    const name = node.name || node.dqName || '';
    if (/临港|浦东|南汇|洋山/.test(name)) {
      hits.push({ name, code: node.code || node.dqCode || node.id, path: path.join('>') });
    }
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object') walk(v, [...path, k]);
    }
  };
  walk(dq.json.data);
  for (const h of hits.slice(0, 40)) console.log(`  ${String(h.code).padEnd(14)} ${h.name}   (${h.path})`);
  if (!hits.length) console.log('  未匹配到临港/浦东相关地区码');
} else {
  console.log(`  get-all-dq 失败: status=${dq.status} ${dq.text.slice(0, 200)}`);
}

// ---------- 2. 真实搜索 ----------
console.log('\n=== 搜索接口直连测试 ===');
const body = {
  data: {
    mainSearchPcConditionForm: {
      city: '020',
      dq: '410',
      pubTime: '',
      currentPage: '0',
      pageSize: 40,
      key: keyword,
      suggestTag: '',
      workYearCode: '1',
      compId: '',
      compName: '',
      compTag: '',
      industry: '',
      salaryCode: '',
      jobKind: '',
      compScale: '',
      compKind: '',
      compStage: '',
      eduLevel: '',
      salaryLow: '',
      salaryHigh: '',
    },
    passThroughForm: {
      scene: 'init',
      skId: '',
      fkId: '',
      ckId: 'l3nfj98ba825ubve31a5nq67vbwnaoma',
      suggest: null,
    },
  },
};
const res = await cdp.fetchInProcess(`${API}/com.liepin.searchfront4c.pc-search-job`, {
  method: 'POST',
  body,
});
console.log(`  HTTP ${res.status}  flag=${res.json?.flag}  msg=${res.json?.msg ?? ''}`);
if (!res.json || res.json.flag !== 1) {
  console.log(`  原始响应: ${res.text.slice(0, 600)}`);
} else {
  const d = res.json.data;
  console.log(`  data keys      : ${Object.keys(d).join(', ')}`);
  console.log(`  pagination     : ${JSON.stringify(d.pagination)}`);
  console.log(`  passThroughData: ${JSON.stringify(d.passThroughData).slice(0, 200)}`);
  console.log(`  data.data keys : ${Object.keys(d.data || {}).join(', ')}`);

  // 递归展开，找职位数组
  const found = [];
  const walk = (node, path = '', depth = 0) => {
    if (depth > 4 || !node) return;
    if (Array.isArray(node)) {
      if (node.length && typeof node[0] === 'object' && node[0] !== null) {
        found.push({ path, len: node.length, keys: Object.keys(node[0]) });
      }
      return;
    }
    if (typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(d.data, 'data');

  console.log('\n  找到的对象数组：');
  for (const f of found) console.log(`    data.${f.path}  len=${f.len}\n      keys: ${f.keys.join(', ')}`);

  const jobList = found.find((f) => /job|card|list/i.test(f.path));
  if (jobList) {
    const arr = jobList.path.split('.').reduce((o, k) => o?.[k], d.data);
    console.log(`\n  === 职位条目样例 (data.${jobList.path}[0]) ===`);
    console.log(JSON.stringify(arr[0], null, 2).slice(0, 2500));
  }
}

await cdp.close();
process.exitCode = 0;
