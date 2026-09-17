/**
 * 路径解析 —— 技能目录 vs 工作根（数据目录）。
 *
 * 为什么要分开：
 *   代码是可以分发/复用的（skills/job-auto-apply/），
 *   而你的简历、手机号、证件照、cookie、发送记录是**私人的**，不该跟着技能走。
 *   所以：
 *     SKILL_ROOT  = 技能目录（代码 + 模板 + 默认配置），可以进版本库、可以拷给别人
 *     HOME        = 工作根（config/ state/ artifacts/ .env），私人数据都在这里
 *
 * HOME 的解析顺序：
 *   1. 环境变量 JOB_APPLY_HOME
 *   2. 从 SKILL_ROOT 往上找最近的、含 .env / state/ / config/criteria.json 的目录
 *   3. 都没有 → 就用 SKILL_ROOT 自己（首次运行会在那里建 config/ state/ artifacts/）
 *
 * 这样同一份代码既能当“你自己的工作实例”（数据在 case 根），
 * 也能被别人拷走直接跑（数据落在技能目录里）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 技能根 = src/ 的上一级（paths.mjs 位于 src/core/，所以是两层） */
export const SKILL_ROOT = path.resolve(HERE, '..', '..');
/** 默认配置模板（首次运行用来初始化 HOME/config） */
export const DEFAULTS_DIR = path.join(SKILL_ROOT, 'config.defaults');

function looksLikeHome(dir) {
  return (
    fs.existsSync(path.join(dir, '.env')) ||
    fs.existsSync(path.join(dir, 'state')) ||
    fs.existsSync(path.join(dir, 'config', 'criteria.json'))
  );
}

function findHome() {
  const env = process.env.JOB_APPLY_HOME;
  if (env && env.trim()) return path.resolve(env.trim());

  let dir = SKILL_ROOT;
  for (let i = 0; i < 4; i++) {
    if (looksLikeHome(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return SKILL_ROOT;
}

export const HOME = findHome();

/** 工作根下的路径表（全部是绝对路径） */
export const P = {
  config: path.join(HOME, 'config'),
  limits: path.join(HOME, 'config', 'limits.json'),
  criteria: path.join(HOME, 'config', 'criteria.json'),
  prompts: path.join(HOME, 'config', 'prompts.json'),
  rubric: path.join(HOME, 'config', 'rubric.json'),
  searchOptions: path.join(HOME, 'config', 'search-options.json'),
  experience: path.join(HOME, 'config', 'experience.json'),
  profile: path.join(HOME, 'config', 'profile.md'),
  state: path.join(HOME, 'state'),
  daily: path.join(HOME, 'state', 'daily.json'),
  sent: path.join(HOME, 'state', 'sent.jsonl'),
  seen: path.join(HOME, 'state', 'seen.jsonl'),
  artifacts: path.join(HOME, 'artifacts'),
  jobs: path.join(HOME, 'artifacts', 'jobs.jsonl'),
  scored: path.join(HOME, 'artifacts', 'scored.json'),
  drafts: path.join(HOME, 'artifacts', 'drafts.json'),
  details: path.join(HOME, 'artifacts', 'details'),
  resumes: path.join(HOME, 'artifacts', 'resumes'),
  screens: path.join(HOME, 'artifacts', 'screenshots'),
  evidence: path.join(HOME, 'evidence'),
  template: path.join(SKILL_ROOT, 'templates', 'resume.html'),
  chromeProfile: path.join(HOME, '.chrome-debug'),
  startChrome: path.join(SKILL_ROOT, 'start-chrome.ps1'),
};

/**
 * 首次运行时把技能自带的默认配置铺到工作根。
 * 只补**缺的**文件，绝不覆盖已有配置。
 * @returns {string[]} 本次新建的文件（相对 HOME）
 */
export function ensureHome() {
  const created = [];
  for (const d of [P.config, P.state, P.artifacts, P.details, P.resumes, P.screens]) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
      created.push(path.relative(HOME, d) + path.sep);
    }
  }
  if (fs.existsSync(DEFAULTS_DIR)) {
    for (const f of fs.readdirSync(DEFAULTS_DIR)) {
      const src = path.join(DEFAULTS_DIR, f);
      const dst = path.join(P.config, f);
      if (!fs.statSync(src).isFile()) continue;
      if (!fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
        created.push(path.relative(HOME, dst));
      }
    }
  }
  return created;
}

export const relHome = (p) => path.relative(HOME, p) || '.';
