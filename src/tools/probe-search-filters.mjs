import { CdpLite } from '../core/browser/cdp-lite.mjs';
import { LiepinApi } from '../sites/liepin/api.mjs';
const cdp = await CdpLite.attach({ port: 9222, url: 'https://c.liepin.com/' });
const api = new LiepinApi((url, opts) => cdp.fetchInProcess(url, opts));
const base = { keyword: 'Java 开发', city: '020', dq: '020', pageSize: 40, workYearCode: '' };
const ids = async (extraForm) => {
  const r = await api.search({ ...base, extraForm });
  return new Set(r.jobs.map((x) => String(x?.job?.jobId)));
};
const cases = [
  ['基线', {}],
  ['pubTime=1（一天内）', { pubTime: '1' }],
  ['eduLevel=040（本科）', { eduLevel: '040' }],
  ['compScale=080', { compScale: '080' }],
  ['salaryCode=5$10', { salaryCode: '5$10' }],
  ['salaryLow=5,salaryHigh=10', { salaryLow: '5', salaryHigh: '10' }],
  ['pubTime=30（一月内）', { pubTime: '30' }],
];
let b = null;
for (const [name, f] of cases) {
  try {
    const s = await ids(f);
    if (!b) b = s;
    const inter = [...s].filter((x) => b.has(x)).length;
    const same = s.size === b.size && inter === s.size;
    console.log(`  ${name.padEnd(28)} 返回=${String(s.size).padStart(3)}  与基线重合=${String(inter).padStart(3)}  ${same ? '✗ 完全一样（未生效）' : '✓ 有差异（生效）'}`);
    if (!same) {
      const only = [...s].filter((x) => !b.has(x)).slice(0, 5);
      if (only.length) console.log(`     仅筛选结果里出现: ${only.join(', ')}`);
    }
  } catch (e) {
    console.log(`  ${name.padEnd(28)} 失败: ${e.message.slice(0, 60)}`);
  }
  await new Promise((r) => setTimeout(r, 1300));
}
await cdp.close(); process.exitCode = 0;
