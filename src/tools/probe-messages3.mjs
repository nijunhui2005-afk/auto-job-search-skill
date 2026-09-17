import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { CdpLite } from "../lib/cdp-lite.mjs"; import { locateGreetButton, locateChatInput } from "../lib/send.mjs";
import { HOME } from '../core/paths.mjs';
const ROOT = HOME; // 工作根（config/state/artifacts 都在这里）
const scored = JSON.parse(fs.readFileSync(path.join(ROOT,"artifacts","scored.json"),"utf8"));
const jobId = process.argv[2] || "85256053";
const job = scored.jobs.find(j => String(j.jobId)===String(jobId));
const cdp = await CdpLite.attach({ port:9222, url:"https://c.liepin.com/" });
await cdp.navigate(job.link); await cdp.waitStable({quietMs:2000,maxMs:25000});
const btns = await locateGreetButton(cdp);
console.log(`聊天入口: ${btns.map(b=>`"${b.text}"`).join(", ")}`);
await cdp.clickNode(btns[0].nodeId,{settleMs:2500});
// 轮询等消息条目出现
let items = [];
for (let i=0;i<15;i++) {
  await new Promise(r=>setTimeout(r,1500));
  items = await cdp.querySelectorAll('[class*="im-ui-message-item-wrapper"]');
  if (items.length) break;
  const inp = await locateChatInput(cdp);
  if (!inp.length && i===4) { // 会话没开，重试点一次
    const b2 = await locateGreetButton(cdp);
    if (b2.length) await cdp.clickNode(b2[0].nodeId,{settleMs:2000});
  }
}
console.log(`消息条目: ${items.length}\n`);
let i=0;
for (const id of items) {
  const html = await cdp.getOuterHTML(id).catch(()=>"");
  const txt = html.replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
  const kind = /-send\b/.test(html) ? "我发" : /-receive\b/.test(html) ? "对方" : /system-tip/.test(html) ? "系统" : "?";
  const feats=[];
  if (/简历/.test(html)) feats.push("含「简历」");
  if (/message-card|im-ui-card|resume-card/i.test(html)) feats.push("卡片结构");
  if (/已发送/.test(txt)) feats.push("含「已发送」");
  console.log(`--- #${++i} [${kind}] ${feats.length?"★"+feats.join(","):""}`);
  console.log(`    ${txt.slice(0,260)||"(无文本)"}`);
}
await cdp.close(); process.exitCode = 0;
