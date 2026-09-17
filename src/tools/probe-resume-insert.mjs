import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { CdpLite } from "../lib/cdp-lite.mjs"; import { locateGreetButton, locateChatInput, locateResumeButton } from "../lib/send.mjs";
import { HOME } from '../core/paths.mjs';
const ROOT = HOME; // 工作根（config/state/artifacts 都在这里）
const scored = JSON.parse(fs.readFileSync(path.join(ROOT,"artifacts","scored.json"),"utf8"));
const jobId = process.argv[2] || "85256053";
const job = scored.jobs.find(j => String(j.jobId)===String(jobId));
const cdp = await CdpLite.attach({ port:9222, url:"https://c.liepin.com/" });
await cdp.navigate(job.link); await cdp.waitStable({quietMs:2000,maxMs:25000});
const btns = await locateGreetButton(cdp); await cdp.clickNode(btns[0].nodeId,{settleMs:2500});
await new Promise(r=>setTimeout(r,6000));

const dumpInput = async (label) => {
  console.log(`\n===== ${label} =====`);
  for (const sel of ['[class*="im-ui-input-actions"]','[class*="chatwin-action"]','[class*="im-ui-input-container"]','[class*="im-ui-message-input"]']) {
    const ids = await cdp.querySelectorAll(sel).catch(()=>[]);
    for (const id of ids.slice(0,2)) {
      const h = await cdp.getOuterHTML(id).catch(()=>"");
      if (!h) continue;
      const t = h.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
      console.log(`  [${sel}] ${h.length}字符  text="${t.slice(0,150)}"`);
    }
  }
  // 输入框里有没有东西
  const editables = await cdp.querySelectorAll('[contenteditable="true"], textarea');
  for (const id of editables.slice(0,3)) {
    const a = await cdp.getAttributes(id).catch(()=>({}));
    const h = await cdp.getOuterHTML(id).catch(()=>"");
    console.log(`  输入框 ph="${a.placeholder||""}" 内容="${h.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim().slice(0,150)}"`);
  }
  // 所有含「发送」的可见按钮
  const all = await cdp.querySelectorAll('button, [class*="btn"], span, div');
  for (const id of all.slice(0,600)) {
    const t = await cdp.getText(id).catch(()=>"").then(s=>s.replace(/\s+/g," ").trim());
    if (!/^(发送|确认|确定)$/.test(t)) continue;
    const box = await cdp.boxCenter(id).catch(()=>null); if(!box) continue;
    const a = await cdp.getAttributes(id).catch(()=>({}));
    console.log(`  「${t}」cls="${(a.class||"").slice(0,70)}" @${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.w)}x${Math.round(box.h)}`);
  }
};

await dumpInput("点击「发简历」之前");
const rb = await locateResumeButton(cdp);
console.log(`\n找到「发简历」: ${rb.map(b=>`"${b.text}"@${b.x},${b.y}`).join(", ")}`);
await cdp.clickNode(rb.find(b=>b.visible).nodeId, { settleMs: 2500 });
await new Promise(r=>setTimeout(r,3500));
await dumpInput("点击「发简历」之后");
await cdp.close(); process.exitCode = 0;
