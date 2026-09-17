/**
 * Node 版本守卫。
 *
 * 为什么需要这个文件：
 *   本机用 nvm4w，`node` 只是个符号链接，被切到旧版本是常事。
 *   实测符号链接被切到了 v14.21.0 —— 而整套流水线依赖全局 fetch / WebSocket（Node 18+）。
 *   症状极其难定位：
 *     - `fetch is not defined`
 *     - `AbortSignal.timeout` 在 Node 14 是 undefined → 抛 ReferenceError
 *       → 被 cdpAlive() 的 catch 吞掉 → 表现为「Chrome 端口连不上，死等 20 秒」
 *   （后者真的一次性骗过了我，因为 start-chrome.ps1 明明打印了 [OK] CDP ready）
 *
 * 策略：入口处检查；不够新就自动在 nvm 版本库里找一个够新的 Node 重新执行自己。
 * 找不到就报明确错误，而不是让它以奇怪的方式失败。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const MIN_MAJOR = 18;

/** 随技能分发的便携运行时：<skill>/node/node.exe（_gitignore_，随文件夹拷贝） */
export const BUNDLED_NODE = path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
  'node',
  'node.exe',
);

/** 当前 node 的大版本号 */
export function currentMajor() {
  return Number(String(process.versions.node).split('.')[0]) || 0;
}

/** 可能存放 node.exe 的位置候选（系统优先，自带运行时时最靠后兜底） */
function candidates() {
  const out = [];
  const roots = [
    process.env.NVM_HOME,
    process.env.NVM_SYMLINK ? path.dirname(process.env.NVM_SYMLINK) : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'nvm') : '',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'nvm') : '',
    'D:\\nvm4w',
    'C:\\nvm4w',
  ].filter(Boolean);

  for (const r of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(r);
    } catch {
      continue;
    }
    for (const d of entries) {
      if (!/^v\d+\.\d+\.\d+$/.test(d)) continue;
      out.push(path.join(r, d, 'node.exe'));
    }
  }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (base) out.push(path.join(base, 'nodejs', 'node.exe'));
  }
  // 自带的放最后：系统有可用 Node 时不会用到它
  out.push(BUNDLED_NODE);
  return [...new Set(out)].filter((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/** 找一个 major >= MIN_MAJOR 的 node.exe：系统优先，其次自带的；同类取版本最高 */
export function findModernNode() {
  const found = [];
  for (const exe of candidates()) {
    const r = spawnSync(exe, ['-v'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(r.stdout || '').trim());
    if (!m) continue;
    const major = Number(m[1]);
    if (major >= MIN_MAJOR) found.push({ exe, major, minor: Number(m[2]), patch: Number(m[3]), raw: m[0] });
  }
  found.sort((a, b) => {
    const ab = a.exe === BUNDLED_NODE ? 1 : 0;
    const bb = b.exe === BUNDLED_NODE ? 1 : 0;
    if (ab !== bb) return ab - bb; // 系统 Node 优先于自带运行时
    return b.major - a.major || b.minor - a.minor || b.patch - a.patch;
  });
  return found[0] || null;
}

/**
 * 若当前 Node 太旧，就自动换一个重跑自己，然后退出当前进程。
 * 当前 Node 够新时返回 false（调用方继续正常执行）。
 *
 * @param {string} entryFile 入口文件的绝对路径（用来重新执行）
 * @param {string[]} argv    传给入口的参数（默认取 process.argv.slice(2)）
 * @returns {false}
 */
export function ensureModernNode(entryFile, argv = process.argv.slice(2)) {
  if (currentMajor() >= MIN_MAJOR) return false;

  const better = findModernNode();
  const self = process.execPath;
  if (!better) {
    console.error('');
    console.error(`[X] 当前 Node 是 v${process.versions.node}（${self}），本项目需要 >= v${MIN_MAJOR}。`);
    console.error(`    原因：依赖全局 fetch / WebSocket，Node < ${MIN_MAJOR} 没有。`);
    console.error('    没找到更新的 Node。用 nvm 切一下，例如：');
    console.error('      nvm use 24.14.0');
    console.error(`    或者把便携运行时放到：${BUNDLED_NODE}`);
    console.error('');
    process.exit(1);
  }

  console.error(`[i] 当前 Node v${process.versions.node} 太旧，自动改用 v${better.raw}（${better.exe}）`);
  const r = spawnSync(better.exe, [entryFile, ...argv], { stdio: 'inherit', env: process.env, windowsHide: true });
  process.exit(r.status === null ? 1 : r.status);
}
