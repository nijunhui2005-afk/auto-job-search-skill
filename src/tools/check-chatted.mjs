import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { CdpLite } from '../core/browser/cdp-lite.mjs';
import { HOME } from '../core/paths.mjs';
const ROOT = HOME; // 工作根（config/state/artifacts 都在这里）
const jobId = process.argv[2];
const cdp = await CdpLite.attach({ port: 9222, url: 'https://c.liepin.com/' });
const url = `https://www.liepin.com/lptjob/${jobId}`;
await cdp.navigate(url);
await cdp.waitStable({ quietMs: 2000, maxMs: 25000 });
async function grab() {
  const ids = await cdp.querySelectorAll('a[class*="btn-"]');
  const out = [];
  for (const id of ids) {
    const a = await cdp.getAttributes(id).catch(()=>({}));
    const box = await cdp.boxCenter(id).catch(()=>null);
    if (!box) continue;
    const t = (await cdp.getText(id).catch(()=>'')).replace(/\s+/g,' ').trim();
    if (t) out.push(`"${t}" cls="${(a.class||'').slice(0,40)}"`);
  }
  return out;
}
console.log(`jobId ${jobId}`);
console.log('  按钮:', (await grab()).join('  |  '));
const t = await cdp.pageText().catch(()=> '');
console.log('  页面文本里含默认招呼语 =', /我对您在招的.+职位很感兴趣/.test(t));
const m = t.match(/我对您在招的[^。]{0,40}。/);
if (m) console.log('  文本中出现:', m[0]);
await cdp.close(); process.exitCode = 0;
