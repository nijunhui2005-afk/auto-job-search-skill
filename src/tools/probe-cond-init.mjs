import fs from 'node:fs';
import { CdpLite } from '../core/browser/cdp-lite.mjs';
import { LiepinApi } from '../sites/liepin/api.mjs';
const cdp = await CdpLite.attach({ port: 9222, url: 'https://c.liepin.com/' });
const api = new LiepinApi((url, opts) => cdp.fetchInProcess(url, opts));
const res = await api.condInit('020');
const data = res?.data ?? res;

// 到搜索表单字段的映射：cond-init 的键名 -> 请求体字段名
const MAP = {
  salaries: 'salaryCode',
  educations: 'eduLevel',
  pubTimes: 'pubTime',
  jobKinds: 'jobKind',
  compScales: 'compScale',
  compNatures: 'compKind',
  financeStages: 'compStage',
  industries: 'industry',
  workExperiences: 'workExperiences',
  yearSalaries: 'yearSalary',
  famousComps: 'compTag',
};

const flat = (arr, out = []) => {
  for (const it of arr || []) {
    if (it && it.code !== undefined && it.name !== undefined) out.push({ code: String(it.code), name: String(it.name) });
    if (it && Array.isArray(it.children)) flat(it.children, out);
  }
  return out;
};

const out = { generatedAt: new Date().toISOString(), source: 'com.liepin.searchfront4c.pc-search-job-cond-init', groups: {} };
for (const [k, field] of Object.entries(MAP)) {
  const opts = flat(data[k]);
  if (opts.length) out.groups[field] = { raw: k, label: k, options: opts };
}
fs.writeFileSync('config/search-options.json', JSON.stringify(out, null, 2) + '\n', 'utf8');

for (const [field, g] of Object.entries(out.groups)) {
  console.log(`\n${field}  (来自 ${g.raw}, ${g.options.length} 项)`);
  console.log('  ' + g.options.map((o) => `${o.code || '(空)'}=${o.name}`).join(' | '));
}
await cdp.close(); process.exitCode = 0;
