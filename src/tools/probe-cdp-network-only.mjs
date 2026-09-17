/**
 * 探针：用「裸 CDP」驱动猎聘，只启用 Network / Page 域，不启用 Runtime / Debugger。
 *
 * 目的：
 *   1. 定位 about:blank 清空动作的触发条件（是 Runtime/Debugger 附着，还是别的）
 *   2. 顺带抓取职位搜索相关接口（如果页面能存活够久）
 *
 * 用法: node src/tools/probe-cdp-network-only.mjs [url] [seconds]
 */

const url = process.argv[2] || 'https://c.liepin.com/';
const seconds = Number(process.argv[3] || 20);
const port = Number(process.env.CDP_PORT || 9222);

const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
console.log(`browser: ${version.Browser}`);
console.log(`mode   : 裸 CDP，仅 Network + Page（无 Runtime / 无 Debugger）`);

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error('websocket 连接失败'));
});

let seq = 0;
const pending = new Map();
const apiHits = [];
const navigations = [];

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  const m = msg.method;
  if (m === 'Network.responseReceived') {
    const r = msg.params.response;
    if (/api-[a-z]+\.liepin\.com/.test(r.url) && /json/.test(r.mimeType || '')) {
      apiHits.push({ url: r.url, status: r.status });
    }
  } else if (m === 'Page.frameNavigated' && !msg.params.frame.parentId) {
    navigations.push({ t: Date.now(), url: msg.params.frame.url });
  }
};

function send(method, params = {}, sessionId) {
  const id = ++seq;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const t0 = Date.now();
const stamp = () => `+${String(Date.now() - t0).padStart(6)}ms`;

// 1. 新建目标
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
console.log(`${stamp()} target created ${targetId}`);

// 2. 只启用 Network + Page，不碰 Runtime / Debugger
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Network.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
console.log(`${stamp()} attached (Network + Page enabled, Runtime NOT enabled)`);

// 3. 导航
await send('Page.navigate', { url }, sessionId);
console.log(`${stamp()} navigating to ${url}`);

// 4. 轮询该 target 的当前 URL
const prevUrl = new Set();
const deadline = Date.now() + seconds * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  let list;
  try {
    list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(
      (t) => t.id === targetId,
    );
  } catch {
    continue;
  }
  const cur = list[0]?.url ?? '(target gone)';
  if (!prevUrl.has(cur)) {
    console.log(`${stamp()} url = ${cur}`);
    prevUrl.add(cur);
  }
}

console.log(`\n=== 导航事件 ===`);
for (const n of navigations) console.log(`  +${n.t - t0}ms  ${n.url}`);

console.log(`\n=== 捕获到的 JSON 接口 (${apiHits.length}) ===`);
const seen = new Set();
for (const a of apiHits) {
  const k = a.url.split('?')[0];
  if (seen.has(k)) continue;
  seen.add(k);
  console.log(`  ${a.status}  ${a.url.slice(0, 160)}`);
}

ws.close();
process.exitCode = 0;
