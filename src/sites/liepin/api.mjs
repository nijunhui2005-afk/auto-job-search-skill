/**
 * 猎聘 C 端 API 客户端。
 *
 * 关键事实（由 src/tools/probe-search-headers.mjs 实证）：
 *   猎聘 C 端接口 **没有加密签名**。需要的只是
 *     - 登录 cookie（从已登录的 Chrome profile 里经 CDP Storage.getCookies 取出）
 *     - 一组固定的 X-Fscp-* 风控头
 *     - X-XSRF-TOKEN = XSRF-TOKEN cookie 的值
 *   因此数据获取可以完全脱离页面，直接从 Node 走 HTTP —— 快、稳、不需要 Runtime。
 *
 * 浏览器只用于两件事：提供 cookie；以及在必要时的 UI 兜底（发消息）。
 */

import fs from 'node:fs';
import path from 'node:path';

export const API_C = 'https://api-c.liepin.com/api';
export const API_DOK = 'https://api-dok.liepin.com/api';

export class LiepinApiError extends Error {
  constructor(message, payload) {
    super(message);
    this.name = 'LiepinApiError';
    this.payload = payload;
  }
}

export class LiepinApi {
  /** @param {(url:string, opts:object)=>Promise<{status:number,json:any,text:string}>} fetchFn */
  constructor(fetchFn, { log = console.log } = {}) {
    this.fetchFn = fetchFn;
    this.log = log;
    this.ckId = null;
    this.callCount = 0;
  }

  /** 统一调用；自动判定 flag/code 并把失败抛成结构化错误 */
  async call(apiPath, { method = 'POST', body, headers, allowFail = false } = {}) {
    const url = apiPath.startsWith('http') ? apiPath : `${API_C}/${apiPath}`;
    this.callCount++;
    const res = await this.fetchFn(url, { method, body, headers });
    const j = res.json;
    if (!j) {
      if (allowFail) return res;
      throw new LiepinApiError(`非 JSON 响应 HTTP ${res.status}: ${res.text.slice(0, 200)}`, res);
    }
    if (j.flag !== 1) {
      if (allowFail) return res;
      throw new LiepinApiError(
        `接口失败 ${apiPath} -> flag=${j.flag} code=${j.code} msg=${j.msg}`,
        j,
      );
    }
    return res;
  }

  // ---------------- 搜索 ----------------

  /** 搜索筛选项初始化（拿地区码、薪资档、学历档等编码表） */
  async condInit(dqCode = '410') {
    const res = await this.call('com.liepin.searchfront4c.pc-search-job-cond-init', {
      body: { selectedDqCode: dqCode },
    });
    return res.json.data;
  }

  /**
   * 职位搜索。
   * @param {object} o
   * @param {string} o.keyword    关键词
   * @param {string} o.city       省级/城市码，上海=020
   * @param {string} o.dq         地区码，全国=410
   * @param {number} o.page       从 0 开始
   * @param {number} o.pageSize   实测 40 正常
   * @param {string} o.workYearCode  工作年限码，应届生=1
   */
  async search({
    keyword,
    city = '020',
    dq = '410',
    page = 0,
    pageSize = 40,
    workYearCode = '1',
    extraForm = {},
  } = {}) {
    const body = {
      data: {
        mainSearchPcConditionForm: {
          city,
          dq,
          pubTime: '',
          currentPage: String(page),
          pageSize,
          key: keyword,
          suggestTag: '',
          workYearCode,
          compId: '',
          compName: '',
          compTag: '',
          industry: '',
          salaryCode: '',
          jobKind: '',
          compScale: '',
          compKind: '',
          compStage: '',
          eduLevel: '',
          salaryLow: '',
          salaryHigh: '',
          ...extraForm,
        },
        passThroughForm: {
          scene: 'init',
          skId: '',
          fkId: '',
          ckId: this.ckId || '',
          suggest: null,
        },
      },
    };
    const res = await this.call('com.liepin.searchfront4c.pc-search-job', { body });
    const d = res.json.data;
    // 服务端会回传本轮 ckId，后续翻页必须带上
    const pt = d.passThroughData || {};
    if (pt.ckId) this.ckId = pt.ckId;
    return {
      jobs: d?.data?.jobCardList || [],
      compList: d?.data?.compList || [],
      pagination: d?.pagination || {},
      passThroughData: pt,
    };
  }

  /** 连续翻页直到达到上限或没有下一页 */
  async searchAll(opts = {}, { maxPages = 3, onPage } = {}) {
    const out = [];
    let page = opts.page ?? 0;
    let pagination = {};
    for (let i = 0; i < maxPages; i++) {
      const r = await this.search({ ...opts, page });
      out.push(...r.jobs);
      pagination = r.pagination;
      if (onPage) onPage({ page, got: r.jobs.length, total: out.length, pagination });
      // 不要依赖 hasNext（实测 totalPage=21 但 hasNext=false），用 totalPage 判定
      const cur = Number(pagination?.currentPage ?? page);
      const total = Number(pagination?.totalPage ?? 1);
      if (cur + 1 >= total) break;
      page = cur + 1;
      await new Promise((res) => setTimeout(res, 800 + Math.random() * 700));
    }
    return { jobs: out, pagination };
  }

  // ---------------- 地区码 ----------------

  /** 拉取全量地区码表（较大，建议缓存到磁盘） */
  async allDq() {
    const res = await this.call(
      `${API_DOK}/com.liepin.bd.p.v4.get-all-dq?part=part_1,country,province&sc=0&from=component`,
      { method: 'GET' },
    );
    return res.json.data;
  }

  /**
   * 从地区码表里按名称找 code。
   * 注意 get-all-dq 用的是压缩字段名：n=名称, c=code, p=父级, l=层级,
   * 结构与 cond-init 的 {code,name} 完全不同，两者都要兼容。
   */
  static findDq(data, re) {
    const hits = [];
    const walk = (node, trail = []) => {
      if (Array.isArray(node)) return node.forEach((n) => walk(n, trail));
      if (!node || typeof node !== 'object') return;
      const name = node.name ?? node.dqName ?? node.shortName ?? node.n ?? '';
      const code = node.code ?? node.dqCode ?? node.dq ?? node.id ?? node.c;
      if (name && code !== undefined) {
        if (re.test(String(name))) {
          hits.push({ name: String(name), code: String(code), parent: node.p, level: node.l, path: trail.join('>') });
        }
      }
      for (const [k, v] of Object.entries(node)) {
        if (v && typeof v === 'object') walk(v, [...trail, k]);
      }
    };
    walk(data);
    return hits;
  }

  /** 按 code 反查完整条目（用于核对 020010110 这类层级码到底是什么地区） */
  static findDqByCode(data, code) {
    let found = null;
    const walk = (node) => {
      if (found || !node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      const c = node.code ?? node.c ?? node.id;
      if (c !== undefined && String(c) === String(code)) {
        found = { name: node.name ?? node.n, code: String(c), parent: node.p, level: node.l };
        return;
      }
      for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v);
    };
    walk(data);
    return found;
  }

  // ---------------- 职位详情 ----------------

  /**
   * 职位详情。走公开的 job 页面 API（无需登录态签名的只读接口）。
   * 若某个端点不可用会在 detailWithFallback 里逐个尝试。
   */
  async jobDetailRaw(jobId) {
    // 猎聘 C 端详情接口；不同版本路径不同，调用方用 detailWithFallback 容错
    return this.call('com.liepin.searchfront4c.pc-job-detail', {
      body: { data: { jobId: String(jobId) } },
      allowFail: true,
    });
  }

  // ---------------- 持久化 cookie ----------------

  static saveCookies(file, cookies) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rec = {
      savedAt: new Date().toISOString(),
      cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path })),
    };
    fs.writeFileSync(file, JSON.stringify(rec, null, 2), 'utf8');
    return rec;
  }

  static loadCookies(file) {
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }
}
