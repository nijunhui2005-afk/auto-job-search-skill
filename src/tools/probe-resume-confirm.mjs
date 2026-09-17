import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { CdpLite } from "../lib/cdp-lite.mjs"; import { locateGreetButton, locateResumeButton } from "../lib/send.mjs";
import { HOME } from '../core/paths.mjs';
const ROOT = HOME; // 工作根（config/state/artifacts 都在这里）
const scored = JSON.parse(fs.readFileSync(path.join(ROOT,"artifacts","scored.json"),"utf8"));
const jobId = process.argv[2] || "85256053";
const job = scored.jobs.find(j => String(j.jobId)===String(jobId));
const cdp = await CdpLite.attach({ port:9222, url:"https://c.liepin.com/" });
await cdp.navigate(job.link); await cdp.waitStable({quietMs:2000,maxMs:25000});
const btns = await locateGreetButton(cdp); await cdp.clickNode(btns[0].nodeId,{settleMs:2500});
await new Promise(r=>setTimeout(r,6000));

const snapshot = async (label) => {
  const out = { label, modals: [], buttons: [] };
  const mids = await cdp.querySelectorAll('[class*="modal"], [class*="drawer"], [class*="dialog"], [class*="popover"], [class*="confirm"]');
  const seen = new Set();
  for (const id of mids) {
    const a = await cdp.getAttributes(id).catch(()=>({}));
    const box = await cdp.boxCenter(id).catch(()=>null);
    if (!box) continue;
    const key = a.class||"";
    if (seen.has(key)) continue; seen.add(key);
    const t = await cdp.getText(id).catch(()=>"").then(s=>s.replace(/\s+/g," ").trim());
    out.modals.push({ cls:(a.class||"").slice(0,95), w:Math.round(box.w), h:Math.round(box.h), at:`${Math.round(box.x)},${Math.round(box.y)}`, text:t.slice(0,220) });
  }
  const bids = await cdp.querySelectorAll('button, [class*="btn"], a, span');
  const seenB = new Set();
  for (const id of bids.slice(0,700)) {
    const t = await cdp.getText(id).catch(()=>"").then(s=>s.replace(/\s+/g," ").trim());
    if (!t || t.length>10) continue;
    const box = await cdp.boxCenter(id).catch(()=>null); if(!box) continue;
    const a = await cdp.getAttributes(id).catch(()=>({}));
    const key = `${t}|${(a.class||"").slice(0,50)}`;
    if (seenB.has(key)) continue; seenB.add(key);
    out.buttons.push({ t, cls:(a.class||"").slice(0,75), at:`${Math.round(box.x)},${Math.round(box.y)}`, w:Math.round(box.w) });
  }
  return out;
};

const before = await snapshot("before");
const rb = await locateResumeButton(cdp);
await cdp.clickNode(rb.find(b=>b.visible).nodeId, { settleMs: 2000 });
await new Promise(r=>setTimeout(r,4000));
const after = await snapshot("after");

console.log("===== 点击后新增/变化的 modal =====");
const beforeKeys = new Set(before.modals.map(m=>m.cls));
for (const m of after.modals) {
  const isNew = !beforeKeys.has(m.cls);
  console.log(`${isNew?"[新]":"    "} cls="${m.cls}" ${m.w}x${m.h} @${m.at}`);
  console.log(`      text="${m.text}"`);
}
console.log("\n===== 点击后出现的按钮（对比前值）=====");
const bKeys = new Set(before.buttons.map(b=>b.t+"|"+b.cls));
for (const b of after.buttons) {
  const isNew = !bKeys.has(b.t+"|"+b.cls);
  if (isNew) console.log(`  [新] "${b.t}" cls="${b.cls}" @${b.at}`);
}
console.log("\n===== 点击后全部按钮（含旧）=====");
for (const b of after.buttons) console.log(`  "${b.t}" cls="${b.cls}" @${b.at}`);
const shot = path.join(ROOT,"artifacts","screenshots",`resume-confirm-${Date.now()}.png`);
await cdp.screenshot(shot).catch(()=>{});
console.log(`\n截图: ${shot}`);
await cdp.close(); process.exitCode = 0;
