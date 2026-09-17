/**
 * 持久化：职位去重 + 发送记录 + 当日计数。
 *
 * 为什么必须去重：
 *   猎聘的"打招呼"是对 HR 的一条真实消息。重复给同一个 HR 发消息
 *   既无意义又会显著提高被举报/被风控的概率。所以 (公司, 职位, HR)
 *   三元组一旦处理过，永不重发。
 */

import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // 单行损坏不应让整轮 run 崩掉
    }
  }
  return out;
}

export function appendJsonl(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

/**
 * 去重键。优先级：jobId > link > (company|title)。
 * 猎聘列表页的 jobId 最稳；拿不到时退化为链接。
 */
export function jobKey(job) {
  if (job.jobId) return `id:${job.jobId}`;
  if (job.link) return `url:${normalizeUrl(job.link)}`;
  return `ct:${(job.company || '').trim()}|${(job.title || '').trim()}`;
}

export function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return String(u || '').trim();
  }
}

/** 已处理集合：来自 sent.jsonl + seen.jsonl（含已跳过/过低分的） */
export function loadHandled(jobUrl, sentFile, seenFile) {
  const set = new Set();
  for (const r of readJsonl(sentFile)) set.add(jobKey(r));
  for (const r of readJsonl(seenFile)) set.add(jobKey(r));
  return set;
}

// ---------------- 当日计数 ----------------

const todayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function loadDaily(stateFile) {
  let data = { date: todayKey(), sent: 0, failures: 0 };
  if (fs.existsSync(stateFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (parsed.date === todayKey()) data = { ...data, ...parsed };
    } catch {
      /* 损坏则重置当天 */
    }
  }
  return data;
}

export function saveDaily(stateFile, data) {
  ensureDir(path.dirname(stateFile));
  fs.writeFileSync(stateFile, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

export { todayKey };
