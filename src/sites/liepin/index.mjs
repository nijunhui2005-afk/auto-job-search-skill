/**
 * 猎聘（c.liepin.com 求职者端）适配器 —— 第一个站点实现。
 *
 * 这里集中放**猎聘特有的知识**：接口地址、cookie 名、城市码、详情页 URL、按钮文案、
 * 筛选器取值。core/ 里的流程代码不直接碰这些。
 *
 * 契约见 ../index.mjs。
 */
import { LiepinApi } from './api.mjs';
import { normalizeJob, prefilter, matchesLocation, jobSummaryLine } from './normalize.mjs';
import { fetchJobDetail, extractJd, extractCompanyIntro } from './detail.mjs';
import { locateGreetButton, locateChatInput, sendOne, sendResumeCard, locateResumeButton } from './send.mjs';
import { fetchResumeRaw, fetchUserInfo, fetchExpect, formatResumeMarkdown, resumeQuality } from './resume.mjs';

/** 地区码表（实测；410 是全国码，会覆盖 city，不能用于地域过滤） */
const CITY_CODES = {
  全国: '410',
  北京: '010',
  上海: '020',
  天津: '030',
  重庆: '040',
  广州: '050020',
  深圳: '050090',
  苏州: '060080',
  南京: '060020',
  杭州: '070020',
  大连: '210040',
  成都: '280020',
  武汉: '170020',
  西安: '270020',
};

export const LiepinSite = {
  id: 'liepin',
  label: '猎聘（c.liepin.com 求职者端）',

  meta: {
    homeUrl: 'https://c.liepin.com/',
    loginUrl: 'https://c.liepin.com/',
    jobUrlTemplate: (jobId) => `https://www.liepin.com/lptjob/${jobId}`,
    cookieName: 'lt_auth',
    cityCodes: CITY_CODES,
    /** 打招呼入口按钮文案（未聊过 / 已聊过） */
    greetButtonTexts: ['聊一聊', '继续聊', '沟通', '打招呼'],
    chatInputPlaceholder: '请输入文字，按Enter键发送',
    /** 平台自带的「发简历」动作按钮 */
    resumeActionText: '发简历',
  },

  /** 造一个带登录态的 HTTP 客户端：在页面上下文里发请求，自动带 cookie 与反爬头 */
  createApi(cdp) {
    return new LiepinApi((url, opts) => cdp.fetchInProcess(url, opts));
  },

  /** cookie 缓存（缓存一份后，部分接口调用不需要 CDP） */
  saveCookies: (file, cookies) => LiepinApi.saveCookies(file, cookies),
  loadCookies: (file) => LiepinApi.loadCookies(file),

  /** 在地区树里找 dq 码 */
  findDq: (all, re) => LiepinApi.findDq(all, re),

  /**
   * 搜索职位。多次关键词搜索由调用方合并；这里只负责单次「一个关键词 + 翻页」。
   * @returns {Promise<{jobs:object[], pagination:object|null}>}
   */
  async search(api, { keyword, city, dq, pages = 2, pageSize = 40, workYearCode = '2', extraForm = {}, onPage } = {}) {
    const { jobs, pagination } = await api.searchAll(
      { keyword, city, dq, pageSize, workYearCode, extraForm },
      { maxPages: pages, onPage },
    );
    return { jobs: (jobs || []).map(normalizeJob), pagination };
  },

  /** 站点筛选器取值表（cond-init 探测） */
  async searchForm(api, dqCode = '410') {
    return api.condInit(dqCode);
  },

  /** 抓职位详情页正文（SSR 页面） */
  fetchDetail(cdp, url) {
    return fetchJobDetail(cdp, url);
  },

  /** 候选池预筛（排除词 / 地点 / 是否已沟通） */
  prefilter,
  matchesLocation,
  summaryLine: jobSummaryLine,

  /** 有没有聊过：按钮文案是「继续聊」即已聊过 */
  async isChatted(cdp) {
    const btns = await locateGreetButton(cdp);
    if (!btns.length) return null; // 判断不了（页面没加载好 / 被风控）
    return btns.some((b) => /继续聊/.test(b.text));
  },

  locateGreetButton,
  locateChatInput,
  locateResumeButton,

  /** 发一条打招呼（含可选的简历卡片），站点 UI 细节全在 send.mjs 里 */
  sendOne,
  sendResumeCard,

  /** 在线简历 */
  resume: {
    fetchRaw: fetchResumeRaw,
    fetchUserInfo,
    fetchExpect,
    formatMarkdown: formatResumeMarkdown,
    quality: resumeQuality,
  },

  // 供 core / cli 复用的纯函数
  extractJd,
  extractCompanyIntro,
  normalizeJob,
};

export default LiepinSite;
