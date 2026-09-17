/**
 * 站点适配器契约 + 注册表。
 *
 * 这个包的目标是「通用求职站框架」：核心流程（搜索 → 抓 JD → AI 打分 → 生成打招呼语 →
 * 限速发送 → 简历投递）是站点无关的，写在 src/core/ 里；
 * 每个招聘站点的差异（接口地址、字段名、页面选择器、筛选器取值）由一个 adapter 封装。
 *
 * 猎聘是第一个 adapter（src/sites/liepin/）。
 *
 * ─────────────────────────── adapter 契约 ───────────────────────────
 * 一个 adapter 是一个对象：
 *
 * {
 *   id: string                    // 'liepin'
 *   label: string                 // 给人看的名字
 *   meta: {
 *     homeUrl, loginUrl,          // 首页 / 登录页
 *     jobUrlTemplate,             // (jobId) => 详情页 URL
 *     cookieName,                 // 判断登录态的 cookie 名，如 'lt_auth'
 *     cityCodes,                  // 常用城市码表
 *   }
 *   createApi(cdp)                // 造一个「带登录态的 HTTP 客户端」：内部用 CDP 在页面
 *                                 // 上下文里发请求，自动带 cookie / 反爬头
 *   search(api, { keywords, criteria, pages })
 *                                 // → 规范化职位数组（字段见 core 的 NormalizedJob）
 *   fetchDetail(cdp, job)         // → { jd, companyIntro, ... }（SSR 页面正文）
 *   isChatted(cdp, job)           // → boolean（有没有聊过）
 *   send(ctx)                     // → { ok, stage?, detail?, resumeCard? }
 *                                 //   ctx = { cdp, job, greeting, withResume, ... }
 *   searchForm()                  // → 站点筛选器定义（面板用来渲染下拉）
 * }
 *
 * ─────────────────────── 新增一个站点要做什么 ───────────────────────
 * 1. 建 src/sites/<id>/，实现上面这些字段
 * 2. 在下面的 REGISTRY 里注册
 * 3. 在 config/site.json 里把 "site" 改成新 id（或设 SITE 环境变量）
 * 4. 泛化性验证：换站点后 core 里的代码一行都不用改
 */
import fs from 'node:fs';
import { LiepinSite } from './liepin/index.mjs';
import { P } from '../core/paths.mjs';

export const REGISTRY = {
  [LiepinSite.id]: LiepinSite,
};

export const DEFAULT_SITE = 'liepin';

/**
 * 取当前要用的站点 adapter。
 * 解析顺序：显式参数 > SITE 环境变量 > config/site.json 的 site > DEFAULT_SITE
 */
export function getSite(id) {
  let want = id || process.env.SITE || '';
  if (!want) {
    try {
      want = JSON.parse(fs.readFileSync(P.config + '/site.json', 'utf8').replace(/^\uFEFF/, '')).site || '';
    } catch {
      want = '';
    }
  }
  const siteId = want || DEFAULT_SITE;
  const site = REGISTRY[siteId];
  if (!site) {
    throw new Error(`未知站点 "${siteId}"，可用: ${Object.keys(REGISTRY).join(', ')}`);
  }
  return site;
}

export function listSites() {
  return Object.values(REGISTRY).map((s) => ({ id: s.id, label: s.label }));
}
