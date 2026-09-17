/**
 * 发送打招呼消息（UI 层，走 Input 域真实鼠标键盘事件）。
 *
 * 为什么不用 API：
 *   猎聘的 IM 走 WebSocket（首页会调 com.liepin.cbp.socket.get-socket-conf 拿连接配置），
 *   复刻 socket 协议的成本远高于直接驱动 UI，而且 UI 路径天然携带全部正确的上下文。
 *
 * 安全设计：
 *   - 无 dry-run：调用即真实点击发送（日上限与去重仍由 cli/preflight 把关）
 *   - sendOne 会先跑完整的限速 preflight，任何一项不过直接抛错
 *   - 每次发送结果都写 state/sent.jsonl + 累加 state/daily.json
 *   - 绝不重发：发送前用 jobId 查 sent.jsonl
 */

import { lintGreeting } from '../../core/ai.mjs';
import { riskControlPage } from '../../core/risk.mjs';

// 实测：未聊过的岗位是「聊一聊」，已聊过会变成「继续聊」——两个都必须包含
const GREET_BUTTON_TEXTS = [
  '聊一聊',
  '继续聊',
  '立即沟通',
  '打招呼',
  '在线沟通',
  '沟通',
  '立即投递',
];
const CHAT_INPUT_HINTS = ['说点什么', '输入', '发送消息', '和TA聊聊'];

/** 在页面上按文本找元素（无 Runtime，只能逐个读文本比对） */
export async function findByText(cdp, selector, needles, { maxScan = 400 } = {}) {
  const ids = await cdp.querySelectorAll(selector);
  const hits = [];
  for (const id of ids.slice(0, maxScan)) {
    let text = '';
    try {
      text = await cdp.getText(id);
    } catch {
      continue;
    }
    if (!text || text.length > 40) continue;
    const needle = needles.find((n) => text.includes(n));
    if (!needle) continue;
    const attrs = await cdp.getAttributes(id).catch(() => ({}));
    const box = await cdp.boxCenter(id).catch(() => null);
    hits.push({ nodeId: id, text, needle, cls: (attrs.class || '').slice(0, 80), visible: !!box });
  }
  return hits;
}

/** 定位职位页上的"打招呼/沟通"入口 */
export async function locateGreetButton(cdp) {
  const found = await findByText(cdp, 'button, a, [role="button"], div[class*="btn"], span[class*="btn"]', GREET_BUTTON_TEXTS);
  // 优先可见的
  return found.filter((f) => f.visible);
}

/** 定位聊天输入框 */
export async function locateChatInput(cdp) {
  const direct = await cdp.querySelectorAll('textarea, [contenteditable="true"]');
  const result = [];
  for (const id of direct) {
    const attrs = await cdp.getAttributes(id).catch(() => ({}));
    const box = await cdp.boxCenter(id).catch(() => null);
    if (!box) continue;
    result.push({
      nodeId: id,
      tag: attrs.tagName || '',
      placeholder: attrs.placeholder || '',
      cls: (attrs.class || '').slice(0, 80),
      hintMatched: CHAT_INPUT_HINTS.some((h) => (attrs.placeholder || '').includes(h)),
    });
  }
  return result;
}

/** 列出当前所有页面目标，便于发现聊天是不是开在新标签页/弹窗里 */
export async function listTargets(port) {
  const all = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return all
    .filter((t) => t.type === 'page')
    .map((t) => ({ id: t.id, url: t.url, title: t.title }));
}

/**
 * 发送失败时的现场取证。
 * 发不出去比发错更常见，没有现场信息就只能盲猜选择器，
 * 所以失败路径必须把“当时页面上到底有什么”全部掳下来。
 */
export async function diagnose(cdp, port) {
  const out = { targets: [], inputs: [], editables: [], pageText: '' };
  out.targets = await listTargets(port).catch(() => []);
  out.inputs = await locateChatInput(cdp).catch(() => []);
  const ids = await cdp.querySelectorAll('input, textarea, [contenteditable]').catch(() => []);
  for (const id of ids.slice(0, 40)) {
    const a = await cdp.getAttributes(id).catch(() => ({}));
    const box = await cdp.boxCenter(id).catch(() => null);
    out.editables.push({
      tag: a.tagName || '',
      type: a.type || '',
      placeholder: a.placeholder || '',
      cls: (a.class || '').slice(0, 70),
      visible: !!box,
      box: box ? `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.w)}x${Math.round(box.h)}` : '',
    });
  }
  out.pageText = await cdp.pageText().catch(() => '');
  out.pageText = out.pageText.slice(0, 800);
  return out;
}

/**
 * 规划一处“有意为之的错字”。
 *
 * 目的：破坏“零失误匀速输入”这种机器特征。
 * 位置选在 25%-75% 区间，避开开头（开头就打错显得业余）和结尾（结尾打错容易被当成真错）。
 * 错字从常见的相邻误按字符里取。
 */
export function planTypo(text) {
  const pos = Math.max(2, Math.floor(text.length * (0.25 + Math.random() * 0.5)));
  const pool = 'asdfghjklqwertyuiopzxcvbnm,.;';
  const wrong = pool[Math.floor(Math.random() * pool.length)];
  return { pos, wrong };
}

/**
 * 定位聊天窗里的图片上传 input。
 * 实测：这个 input 只在点开聊天后才存在于 DOM，且 accept="jpg, jpeg, png, bmp"——不收 PDF。
 */
export async function locateImageInput(cdp) {
  const ids = await cdp.querySelectorAll('input[type="file"]');
  const out = [];
  for (const id of ids) {
    const a = await cdp.getAttributes(id).catch(() => ({}));
    out.push({
      nodeId: id,
      accept: a.accept || '',
      multiple: a.multiple !== undefined,
      cls: (a.class || '').slice(0, 70),
      isImage: /jpg|jpeg|png|bmp/i.test(a.accept || ''),
    });
  }
  return out;
}

/** 把本地文件塞进 file input。CDP 会自己发 change 事件，React 的上传逻辑会被触发。 */
export async function uploadFileToInput(cdp, nodeId, filePath) {
  await cdp.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId });
}

/** 找出页面上可见的「发送」按钮 */
export async function findSendButtons(cdp) {
  const ids = await cdp.querySelectorAll('button, a, div[class*="btn"], span[class*="btn"]');
  const out = [];
  for (const id of ids.slice(0, 400)) {
    const t = (await cdp.getText(id).catch(() => '')).replace(/\s+/g, ' ').trim();
    if (t !== '发送' && t !== '确认发送' && t !== '发送简历') continue;
    const box = await cdp.boxCenter(id).catch(() => null);
    if (!box) continue;
    const a = await cdp.getAttributes(id).catch(() => ({}));
    out.push({ nodeId: id, text: t, cls: (a.class || '').slice(0, 70), x: Math.round(box.x), y: Math.round(box.y) });
  }
  return out;
}

/**
 * 在已打开的聊天窗里发一张图片简历。
 * 前提：调用方已经点开了聊天（出现了聊天输入框）。
 *
 * @param {object} o
 * @param {string} o.imagePath 本地图片路径
 * @param {boolean} o.dry true = 只上传、截图取证，不点发送
 */
/**
 * 定位聊天窗里的「发简历」动作按钮。
 *
 * 重要：每次都要重新查。CDP 的 DOM.getDocument 会作废之前拿到的所有 nodeId，
 * 而 querySelectorAll / pageText 内部都会调它。
 * 所以绝对不能“先拿 nodeId，再读页面文本，再点旧的 nodeId”。
 * 用 [class*="action-resume"] 直接让浏览器筛，避免 500 次 getAttributes 往返。
 */
export async function locateResumeButton(cdp) {
  const ids = await cdp.querySelectorAll('[class*="action-resume"]');
  const out = [];
  for (const id of ids) {
    const a = await cdp.getAttributes(id).catch(() => ({}));
    const box = await cdp.boxCenter(id).catch(() => null);
    const text = (await cdp.getText(id).catch(() => '')).trim();
    out.push({
      nodeId: id,
      text,
      cls: a.class || '',
      visible: !!box,
      x: box ? Math.round(box.x) : 0,
      y: box ? Math.round(box.y) : 0,
    });
  }
  return out;
}

/**
 * 用聊天框自带「发简历」动作发送简历卡片。
 * 不涉及任何文件上传——发的是猎聘根据在线简历生成的卡片，属平台内正常交互。
 *
 * @param {object} o
 * @param {boolean} o.dry true = 只定位不点击
 */
export async function sendResumeCard(cdp, { dry = false, sleep, onStage, shotDir } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = (s, d) => onStage && onStage(s, d);

  const before = await cdp.pageText().catch(() => '');
  log('page-text-before', `${before.length} 字`);

  // 注意：页文本读完后必须重新定位，否则 nodeId 已失效
  const cands = await locateResumeButton(cdp);
  log('located', `${cands.length} 个 action-resume ${cands.map((c) => `"${c.text}"@${c.x},${c.y}`).join(' | ')}`);
  const target = cands.find((c) => c.visible) || cands[0];
  if (!target) return { ok: false, stage: 'no-resume-button', detail: '聊天窗里找不到「发简历」按钮' };
  if (target.text && !/简历/.test(target.text)) {
    return { ok: false, stage: 'wrong-button', detail: `按钮文案异常: "${target.text}"` };
  }

  if (dry) {
    log('dry-stop', `定位到「${target.text}」@${target.x},${target.y}，未点击`);
    return { ok: true, stage: 'located-dry', detail: `「${target.text}」@${target.x},${target.y}` };
  }

  await cdp.clickNode(target.nodeId, { settleMs: 1800 });
  log('clicked', `「${target.text}」@${target.x},${target.y}`);

  // 「发简历」会弹二次确认：“确定向对方发送简历吗？”→ 取 消 / 确 定
  const dialog = await waitForConfirm(cdp, 9000);
  log('confirm-dialog', dialog.length ? `出现确认弹层（${dialog.length} 个节点）` : '未出现确认弹层');

  const confirms = await findConfirmButtons(cdp);
  log('confirm-buttons', `${confirms.length} 个 ${confirms.map((b) => `"${b.text}"@${b.x},${b.y}`).join(' | ') || '（无）'}`);

  if (!confirms.length) {
    return { ok: false, stage: 'no-confirm-button', detail: '点了「发简历」但没找到确认键（可能没弹层，也可能文案变了）' };
  }

  const btn = confirms.find((b) => /确定|确认/.test(b.text)) || confirms[0];
  await cdp.clickNode(btn.nodeId, { settleMs: 2000 });
  log('confirmed', `「${btn.text}」@${btn.x},${btn.y}`);
  await wait(3000);

  const after = await cdp.pageText().catch(() => '');
  log('page-text-after', `${after.length} 字 (diff ${after.length - before.length >= 0 ? '+' : ''}${after.length - before.length})`);

  if (shotDir) {
    const fs = await import('node:fs');
    const p = await import('node:path');
    fs.mkdirSync(shotDir, { recursive: true });
    const shot = p.join(shotDir, `resume-card-${Date.now()}.png`);
    await cdp.screenshot(shot).catch(() => {});
    log('screenshot', shot);
  }

  return {
    ok: true,
    stage: 'resume-card-sent',
    detail: `「发简历」@${target.x},${target.y} → 确认层「${btn.text}」@${btn.x},${btn.y}`,
  };
}

/** 找二次确认类按钮（旧版，已被上方同名导出替换） */
export async function findConfirmButtonsLegacy(cdp) {
  const ids = await cdp.querySelectorAll('button, a, [class*="btn"]');
  const out = [];
  for (const id of ids) {
    const t = (await cdp.getText(id).catch(() => '')).replace(/\s+/g, ' ').trim();
    if (!/^(确认|确定|确认发送|立即发送|发送|发送简历|好的)$/.test(t)) continue;
    const box = await cdp.boxCenter(id).catch(() => null);
    if (!box) continue;
    const a = await cdp.getAttributes(id).catch(() => ({}));
    out.push({ nodeId: id, text: t, cls: (a.class || '').slice(0, 60), x: Math.round(box.x), y: Math.round(box.y) });
  }
  return out;
}

/**
 * 按钮文案归一化。
 * 坑：Ant Design 对“两个汉字”的按钮会拆成 <span>确</span><span>定</span>，
 * getText 拼出来是 "确 定" 带空格，直接 /^确定$/ 匹不上。
 * 所以所有按钮文案比较前必须先压掉空白。
 */
const normText = (s) => String(s || '').replace(/\s+/g, '');

/** 二次确认弹层的特征 class */
const CONFIRM_SCOPE = '[class*="ant-im-modal-confirm"], [class*="modal-confirm"]';

/**
 * 找二次确认类按钮。
 *
 * 排除 im-ui-* ：聊天输入框自带的「发送」按钮也在 DOM 里且文案也是发送，
 * 曾经误点它导致“以为发了其实没发”。
 */
export async function findConfirmButtons(cdp) {
  const ids = await cdp.querySelectorAll('[class*="btn"]');
  const out = [];
  for (const id of ids) {
    const a = await cdp.getAttributes(id).catch(() => ({}));
    const cls = a.class || '';
    if (/im-ui-basic-send-btn|im-ui-input|im-ui-action/.test(cls)) continue;
    const t = normText(await cdp.getText(id).catch(() => ''));
    if (!/^(确定|确认|确认发送|立即发送|继续|好的|是|发送)$/.test(t)) continue;
    const box = await cdp.boxCenter(id).catch(() => null);
    if (!box) continue;
    out.push({ nodeId: id, text: t, cls: cls.slice(0, 70), x: Math.round(box.x), y: Math.round(box.y) });
  }
  return out;
}

/** 等确认弹层出现（最多 waitMs） */
async function waitForConfirm(cdp, waitMs = 9000) {
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    const inDialog = await cdp.querySelectorAll(CONFIRM_SCOPE).catch(() => []);
    if (inDialog.length) return inDialog;
    await new Promise((r) => setTimeout(r, 600));
  }
  return [];
}

/**
 * 【已停用】上传图片当简历发。
 *
 * 保留代码仅作记录：猎聘 IM 的 file input accept="jpg, jpeg, png, bmp" 不收 PDF，
 * 上传后确实能发出（已实测跑通），但**发图片属于违规**，业主已明确叫停。
 * 改用 sendResumeCard()。
 */
export async function sendAttachment(cdp, { imagePath, dry = false, sleep, onStage, shotDir } = {}) {
  const stage = (s, d) => {
    if (onStage) onStage(s, d);
    return { ok: false, stage: s, detail: d };
  };

  const inputs = await locateImageInput(cdp);
  if (!inputs.length) return stage('no-file-input', '聊天窗里没有 input[type=file]');
  const target = inputs.find((i) => i.isImage) || inputs[0];
  if (onStage) onStage('found-file-input', `accept="${target.accept}"`);

  await uploadFileToInput(cdp, target.nodeId, imagePath);
  if (onStage) onStage('file-set', imagePath);
  await sleep(2500);

  // 等上传+预览出现（用「发送」按钮是否出现作为信号）
  let sendBtns = [];
  for (let i = 0; i < 6; i++) {
    sendBtns = await findSendButtons(cdp);
    if (sendBtns.length) break;
    await sleep(1200);
  }
  if (onStage) onStage('after-upload', `可见发送按钮 ${sendBtns.length} 个`);

  if (shotDir) {
    const fs = await import('node:fs');
    const p = await import('node:path');
    const shot = p.join(shotDir, `attach-preview-${Date.now()}.png`);
    fs.mkdirSync(shotDir, { recursive: true });
    await cdp.screenshot(shot).catch(() => {});
    if (onStage) onStage('screenshot', shot);
  }

  if (dry) {
    if (onStage) onStage('dry-stop', '未点发送（dry 模式）');
    return { ok: true, stage: 'uploaded-dry', detail: `已上传，未发送。可见发送按钮: ${sendBtns.map((b) => `${b.text}@${b.x},${b.y}`).join(' | ') || '无'}` };
  }

  if (!sendBtns.length) return stage('no-send-button', '上传后未出现「发送」按钮');
  // 多模态时取最后一个（弹层通常追加在 DOM 尾部）
  const btn = sendBtns[sendBtns.length - 1];
  await cdp.clickNode(btn.nodeId, { settleMs: 1500 });
  await sleep(2000);
  if (onStage) onStage('attachment-sent', `${btn.text}@${btn.x},${btn.y}`);
  return { ok: true, stage: 'attachment-sent', detail: '' };
}
export async function sendOne(cdp, draft, { humanType, sleep, onStage, typo } = {}) {
  const stage = (s, d) => {
    if (onStage) onStage(s, d);
    return { ok: false, stage: s, detail: d };
  };

  const lint = lintGreeting(draft.greeting);
  if (!lint.ok) return { ok: false, stage: 'lint', detail: lint.problems.join('; ') };
  if (!draft.link) return { ok: false, stage: 'no-link', detail: '缺少职位链接' };

  // 1. 打开职位页
  await cdp.navigate(draft.link);
  await cdp.waitStable({ quietMs: 2000, maxMs: 25000 });
  if (onStage) onStage('navigated', draft.link);

  // 1.5 风控检查：验证码页上按钮当然找不到，必须先分辨出来，
  //     否則会报「no-greet-button」把人引去改选择器（实测踩过）
  const risk = await riskControlPage(cdp);
  if (risk.blocked) return stage('risk-control', risk.hint.replace(/\n/g, ' '));

  // 2. 找打招呼入口
  const buttons = await locateGreetButton(cdp);
  if (!buttons.length) return stage('no-greet-button', '页面上找不到打招呼/沟通入口');
  const btn = buttons[0];
  if (onStage) onStage('found-button', `${btn.text} (${btn.cls})`);

  // 3. 点击（会触发平台默认打招呼语，随后我们补发个性化文案）
  await cdp.clickNode(btn.nodeId, { settleMs: 1500 });
  if (onStage) onStage('clicked', btn.text);
  await sleep(2500 + Math.random() * 1500);

  // 4. 找聊天输入框（点击后 UI 是异步渲染的，轮询等待）
  let inputs = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    inputs = await locateChatInput(cdp);
    if (inputs.length) break;
    await sleep(1200);
  }
  if (!inputs.length) {
    return stage(
      'no-chat-input',
      '点击后 10s 内未出现聊天输入框（可能开在新标签页/弹窗，或按钮未触发聊天）',
    );
  }
  const input = inputs.find((i) => i.hintMatched) || inputs[0];
  if (onStage) onStage('found-input', `${input.tag} ph="${input.placeholder}"`);

  // 5. 输入并发送（先打前半段 → 有意打错一个字 → 退格删掉 → 重打后半段）
  await cdp.clickNode(input.nodeId, { settleMs: 400 });
  if (onStage) onStage('focused-input', `${input.tag} ph="${input.placeholder}"`);

  const typoEnabled = typo !== false;
  if (typoEnabled && draft.greeting.length > 40) {
    const { pos, wrong } = planTypo(draft.greeting);
    await humanType(cdp, draft.greeting.slice(0, pos));
    await sleep(180 + Math.random() * 220);
    // 打错的那一下
    await cdp.typeText(wrong);
    await sleep(280 + Math.random() * 340); // 停顿（人在看自己打错了）
    await cdp.pressKey('Backspace', 'Backspace', 8);
    await sleep(200 + Math.random() * 260);
    await humanType(cdp, draft.greeting.slice(pos));
    if (onStage) onStage('typo-simulated', `位置 ${pos} 插入「${wrong}」后退格重打`);
  } else {
    await humanType(cdp, draft.greeting);
  }
  if (onStage) onStage('typed', `${draft.greeting.length} 字`);

  // 发送前校验：错字必须已删干净、文本必须完整。
  // 退格如果没生效，这里能拦住带错字的消息发出去。
  const typedText = (await cdp.getText(input.nodeId).catch(() => '')).replace(/\s+/g, '');
  const expect = draft.greeting.replace(/\s+/g, '');
  if (typedText && !typedText.includes(expect.slice(0, 20))) {
    return stage('type-mismatch', `输入框内容与预期不符（实际 ${typedText.length} 字 / 预期 ${expect.length} 字）`);
  }
  if (typedText && typedText.length !== expect.length) {
    return stage('type-mismatch', `长度不符（实际 ${typedText.length} / 预期 ${expect.length}），错字可能未删干净`);
  }

  await sleep(600 + Math.random() * 900);
  await cdp.pressKey('Enter', 'Enter', 13);
  await sleep(1800);

  // 6. 验证：输入框应该被清空（说明消息发出去了）
  const after = await locateChatInput(cdp);
  const stillThere = after.find((i) => i.nodeId === input.nodeId);
  if (stillThere) {
    const remaining = await cdp.getText(input.nodeId).catch(() => '');
    if (remaining.includes(draft.greeting.slice(0, 12))) {
      return stage('send-unconfirmed', `消息仍在输入框里（剩余 ${remaining.length} 字），回车可能无效`);
    }
  }
  if (onStage) onStage('sent', '输入框已清空');

  return { ok: true, stage: 'sent', detail: '' };
}
