/**
 * 独立验证：确认打招呼真的送达了。
 *
 * 不靠"输入框被清空"这种间接信号，而是回到搜索接口查
 * `recruiter.chatted` —— 这是平台自己记录的"是否已沟通过"，最权威。
 *
 * 用法: node src/tools/verify-sent.mjs [jobId]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpLite } from '../core/browser/cdp-lite.mjs';
import { LiepinApi } from '../sites/liepin/api.mjs';
import { HOME } from '../core/paths.mjs';

const ROOT = HOME; // 工作根（config/state/artifacts 都在这里）
const port = Number(process.env.CDP_PORT || 9222);

const sentFile = path.join(ROOT, 'state', 'sent.jsonl');
if (!fs.existsSync(sentFile)) {
  console.log('没有发送记录 state/sent.jsonl');
  process.exit(0);
}
const sent = fs.readFileSync(sentFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const target = process.argv[2] || sent[sent.length - 1].jobId;
const rec = sent.find((r) => String(r.jobId) === String(target));
console.log(`验证职位 jobId=${target}`);
if (rec) console.log(`  已发送: [${rec.score}] ${rec.title} @${rec.company}  ->  ${rec.recruiterName}`);
console.log(`  发送时间: ${rec?.sentAt}`);

const cdp = await CdpLite.attach({ port, url: 'https://c.liepin.com/' });
const api = new LiepinApi((url, opts) => cdp.fetchInProcess(url, opts));

// 用多个候选关键词回查（长标题直接搜会一颗不中，短词命中率高得多）
const title = rec?.title || '';
const candidates = [
  title.replace(/[（(【\[].*?[)）】\]]/g, '').trim().slice(0, 6),
  (rec?.company || '').replace(/(上海|有限公司|\(.*?\))/g, '').trim().slice(0, 6),
  'AI 编程',
].filter((k) => k && k.length >= 2);
console.log(`\n回查关键词候选: ${JSON.stringify(candidates)}`);

let found = null;
for (const keyword of [...new Set(candidates)]) {
  if (found) break;
  console.log(`  \u8bd5 "${keyword}" ...`);
  for (const page of [0, 1]) {
    let r;
    try {
      r = await api.search({ keyword, dq: '020', page, pageSize: 40, workYearCode: '2' });
    } catch (e) {
      console.log(`    搜索失败: ${e.message}`);
      break;
    }
    const hit = r.jobs.find((j) => String(j.job?.jobId) === String(target));
    if (hit) {
      found = hit;
      break;
    }
    if (!r.pagination?.hasNext && page >= 1) break;
    await new Promise((res) => setTimeout(res, 900));
  }
}

if (!found) {
  console.log('  在搜索结果里没找到该职位，改用会话计数接口验证');
} else {
  const rc = found.recruiter || {};
  console.log(`\n=== 平台侧记录 ===`);
  console.log(`  chatted      : ${rc.chatted}`);
  console.log(`  imShowText   : ${rc.imShowText ?? ''}`);
  console.log(`  imStatus     : ${rc.imStatus}`);
  console.log(`  recruiterName: ${rc.recruiterName}`);
  if (rc.chatted === true) {
    console.log('\n✓ 验证通过：平台已把该 HR 标记为“已沟通”，打招呼确实送达');
  } else {
    console.log('\n✗ chatted 仍为 false：消息未送达或平台标记有延迟');
  }
}

// ---------- 补充验证：会话/沟通相关计数接口 ----------
console.log('\n=== 沟通计数类接口（辅助证据）===');
for (const [p, body] of [
  ['com.liepin.cresume.connection.category-count', { data: { types: ['attachmentConfirmResumeInfoPC'] } }],
  ['com.liepin.im.c.chat.unread-count', { imUserType: 0, imId: '', imApp: '1', userId: '' }],
]) {
  const r = await api.call(p, { body, allowFail: true });
  console.log(`  ${p}\n    flag=${r.json?.flag} data=${JSON.stringify(r.json?.data).slice(0, 300)}`);
}

// 截图留证
const shot = path.join(ROOT, 'artifacts', 'screenshots', `verify-${target}-${Date.now()}.png`);
await cdp.screenshot(shot).catch(() => {});
console.log(`\n截图: ${shot}`);

await cdp.close();
process.exitCode = 0;
