/**
 * 把猎聘简历的完整原始结构 dump 下来，用于设计 PDF 模板的字段映射。
 * 输出到 evidence/resume-raw.json（含联系方式，属于隐私文件，已在 .gitignore 覆盖范围内的目录）。
 *
 * 用法: node src/tools/dump-resume-raw.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpLite } from '../core/browser/cdp-lite.mjs';
import { LiepinApi } from '../sites/liepin/api.mjs';
import { HOME } from '../core/paths.mjs';

const ROOT = HOME; // 工作根（config/state/artifacts 都在这里）
const port = Number(process.env.CDP_PORT || 9222);

const cdp = await CdpLite.attach({ port, url: 'https://c.liepin.com/' });
const api = new LiepinApi((url, opts) => cdp.fetchInProcess(url, opts));

const [detail, userInfo, expect] = await Promise.all([
  api.call('com.liepin.cresume.web-resume-detail', { body: { data: {} } }).then((r) => r.json.data),
  api.call('com.liepin.cresume.get-current-userinfo', { body: { imId: '', imApp: '1' } }).then((r) => r.json.data).catch(() => null),
  api.call('com.liepin.csearch.pc.get-valid-expect-info', { body: { data: {} } }).then((r) => r.json.data).catch(() => null),
]);

const out = path.join(ROOT, 'evidence', 'resume-raw.json');
fs.writeFileSync(out, JSON.stringify({ detail, userInfo, expect }, null, 2), 'utf8');
console.log(`已保存 ${out}  (${JSON.stringify(detail).length} 字节)\n`);

// 递归列出所有"叶子路径 -> 值类型/样例"，方便设计模板字段映射
const rows = [];
const mask = (k, v) => {
  const s = String(v);
  if (/phone|mobile|tel|email|mail|wechat|weixin|qq/i.test(k)) {
    return s.length > 4 ? s.slice(0, 3) + '***' + s.slice(-2) : s;
  }
  return s;
};
const walk = (node, k = '', depth = 0) => {
  if (depth > 5 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    rows.push({ path: k, type: `array[${node.length}]`, sample: node.length ? '' : '' });
    if (node.length) walk(node[0], `${k}[0]`, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    for (const [kk, vv] of Object.entries(node)) walk(vv, k ? `${k}.${kk}` : kk, depth + 1);
    return;
  }
  rows.push({ path: k, type: typeof node, sample: mask(k, node).slice(0, 70) });
};

walk(detail, 'detail');
if (userInfo) walk(userInfo, 'userInfo');

console.log('=== 非空字段清单 ===');
for (const r of rows) {
  if (r.sample === '' && r.type !== 'array[0]') continue;
  console.log(`  ${r.path.padEnd(52)} ${String(r.type).padEnd(10)} ${r.sample}`);
}

console.log('\n=== 空数组字段（模板里要留兜底）===');
for (const r of rows) {
  if (String(r.type) === 'array[0]') console.log(`  ${r.path}`);
}

await cdp.close();
process.exitCode = 0;
