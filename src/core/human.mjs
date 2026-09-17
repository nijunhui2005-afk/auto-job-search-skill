/**
 * 拟人化动作基元。
 *
 * 目的不是"对抗风控"——那是 scope.md 明确的 out_of_scope。
 * 目的只是让机器行为落在正常人类的操作节奏区间内，避免因为
 * "0ms 间隔连续点击" 这种非人类特征触发平台的风控误判。
 */

export const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在 [minMs, maxMs] 内随机等待，返回实际等待毫秒数 */
export async function jitterSleep(minMs, maxMs, label = '') {
  const ms = rand(minMs, maxMs);
  if (label) console.log(`    [wait] ${label}: ${(ms / 1000).toFixed(1)}s`);
  await sleep(ms);
  return ms;
}

/**
 * 逐字符输入，模拟真实键盘节奏。
 * Playwright 的 fill() 会一次性 set 值并触发单个 input 事件，
 * 对带输入监听的前端来说特征过于明显。
 */
export async function humanType(locator, text, { minMs = 60, maxMs = 180 } = {}) {
  await locator.click();
  await sleep(rand(120, 400));
  for (const ch of text) {
    await locator.pressSequentially(ch, { delay: rand(minMs, maxMs) });
  }
}

/**
 * 阅读停顿：模拟"人在看这一屏内容"。
 * 文案越长停顿越久，上限 8s。
 */
export async function readPause(text = '') {
  const base = 1200 + Math.min(text.length * 12, 6000);
  return jitterSleep(base * 0.6, base * 1.4, 'read');
}

/** 正态分布抖动，用于给固定间隔加噪声（避开均匀分布的机器特征） */
export function gaussianJitter(center, spread) {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const n = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return Math.max(0, Math.round(center + n * spread));
}
