import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { CdpLite } from '../core/browser/cdp-lite.mjs'; import { locateGreetButton, locateChatInput } from '../sites/liepin/send.mjs';
import { HOME } from '../core/paths.mjs';
const ROOT = HOME; // 工作根（config/state/artifacts 都在这里）
const scored = JSON.parse(fs.readFileSync(path.join(ROOT,'artifacts','scored.json'),'utf8'));
const jobId = process.argv[2] || '85256053';
const job = scored.jobs.find(j => String(j.jobId)===String(jobId));
const cdp = await CdpLite.attach({ port:9222, url:'https://c.liepin.com/' });
await cdp.navigate(job.link); await cdp.waitStable({quietMs:2000,maxMs:25000});
const btns = await locateGreetButton(cdp); await cdp.clickNode(btns[0].nodeId,{settleMs:2500});
await new Promise(r=>setTimeout(r,6000));
const items = await cdp.querySelectorAll('[class*="im-ui-message-item-wrapper"]');
console.log(`消息条目: ${items.length}\n`);
let i=0;
for (const id of items) {
  const a = await cdp.getAttributes(id).catch(()=>({}));
  const html = await cdp.getOuterHTML(id).catch(()=>'');
  const txt = html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  const kind = /-send\b/.test(html) ? '我发' : /-receive\b/.test(html) ? '对方' : /system-tip/.test(html) ? '系统' : '?';
  // 徽标/卡片特征
  const feats = [];
  if (/resume|简历/i.test(html)) feats.push('含「简历」字样');
  if (/im-ui-card|message-card|card-wrap/i.test(html)) feats.push('卡片结构');
  console.log(`--- #${++i} [${kind}] cls="${(a.class||'').slice(0,90)}"`);
  console.log(`    文本: ${txt.slice(0,220) || '(无文本)'}`);
  if (feats.length) console.log(`    特征: ${feats.join(', ')}`);
  const imgs = html.match(/<img[^>]+src="([^"]+)"/g) || [];
  if (imgs.length>0) console.log(`    图片: ${imgs.slice(0,3).map(s=>s.replace(/.*src="/,'').slice(0,80)).join(' | ')}`);
}
await cdp.close(); process.exitCode = 0;
