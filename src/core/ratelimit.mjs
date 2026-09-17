/**
 * 限速硬门。
 *
 * 设计原则：这一层只提供 "assert" 与 "record"，**不提供任何绕过开关**。
 * 命令行没有 --force，环境变量也无法关闭。要改行为只能改 config/limits.json，
 * 也就是必须留下一次显式的、可审计的配置变更。
 *
 * 2026-09-17 按业主决定**彻底移除**了两道门：
 *   - 时间窗（window）：不再限制只能在某个时段发送
 *   - 熔断（abortAfterConsecutiveFailures）：连续失败不再中止当日发送
 * limits.json 里的对应字段也一并删除，代码里不再留死配置。
 * 现在剩下的唯一硬门是**当日发送条数上限** dailyCap。
 *
 * 失败仍会被计数（daily.failures），但只作为可观测性，不再阻断任何行为。
 */

import fs from 'node:fs';

export class RateLimitError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RateLimitError';
    this.code = code;
  }
}

export function loadLimits(file) {
  if (!fs.existsSync(file)) {
    throw new RateLimitError(`limits file not found: ${file}`, 'LIMITS_MISSING');
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const required = ['dailyCap', 'minDelayMs', 'maxDelayMs', 'matchThreshold'];
  for (const k of required) {
    if (raw[k] === undefined) {
      throw new RateLimitError(`limits.${k} is required`, 'LIMITS_INVALID');
    }
  }
  if (raw.minDelayMs > raw.maxDelayMs) {
    throw new RateLimitError('limits.minDelayMs > maxDelayMs', 'LIMITS_INVALID');
  }
  return raw;
}

export function assertUnderCap(limits, daily) {
  if (daily.sent >= limits.dailyCap) {
    throw new RateLimitError(
      `已达当日上限 ${limits.dailyCap} 条（已发 ${daily.sent}），停止。`,
      'DAILY_CAP',
    );
  }
}

/** 下一次发送前应等待的毫秒数 */
export function nextDelayMs(limits) {
  const { minDelayMs, maxDelayMs } = limits;
  return Math.floor(minDelayMs + Math.random() * (maxDelayMs - minDelayMs));
}

export function recordSuccess(daily) {
  daily.sent += 1;
  daily.failures = 0;
  return daily;
}

/** 失败只计数，不阻断（熔断已按业主决定移除） */
export function recordFailure(daily) {
  daily.failures = (daily.failures || 0) + 1;
  return daily;
}

/** 一次性把当前所有前提条件检查完，返回人类可读的结论 */
export function preflight(limits, daily) {
  const checks = [
    { name: '日上限', ok: daily.sent < limits.dailyCap, detail: `${daily.sent}/${limits.dailyCap}` },
    { name: '发送间隔', ok: limits.minDelayMs <= limits.maxDelayMs, detail: `${limits.minDelayMs / 1000}-${limits.maxDelayMs / 1000}s` },
    { name: '匹配阈值', ok: true, detail: `>= ${limits.matchThreshold}` },
  ];
  return { checks, ok: checks.every((c) => c.ok) };
}
