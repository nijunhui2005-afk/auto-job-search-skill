/**
 * 职位详情提取。
 *
 * 关键实测结论：猎聘的职位详情页（www.liepin.com/lptjob/<id>）是 **SSR** ——
 * JD 正文不在任何 XHR 响应里，而是直接渲染进 HTML。
 * 所以详情必须走"导航 + 读整页文本"，再从噪噪中切出 JD 区段。
 *
 * 页面里既没有稳定的 class 名（都是 search-input--Xzc3N 这种哈希），
 * 也无法执行 JS 定位元素，所以提取策略是**基于文本标记切段**，
 * 比依赖选择器稳。
 */

/** JD 区段的起止标记。命中第一个起点后，遇到任一终点即截断。 */
const JD_START = [
  '职位描述',
  '岗位描述',
  '职位详情',
  '岗位职责',
  '工作职责',
  '职责描述',
  '你将负责',
  '工作内容',
];
const JD_END = [
  '公司信息',
  '工商信息',
  '公司介绍',
  '企业信息',
  '工作地址',
  '举报',
  '相似职位',
  '其他职位',
  '热门职位',
  '猎聘温馨提示',
  '竞争力分析',
];

/**
 * 从整页文本里切出 JD。切不到就返回 null，让调用方决定是否用整页文本兜底。
 */
export function extractJd(pageText) {
  const text = String(pageText || '');
  if (!text) return null;

  let start = -1;
  let usedStart = null;
  for (const m of JD_START) {
    const i = text.indexOf(m);
    if (i >= 0 && (start < 0 || i < start)) {
      // 取最靠前的起点；但如果太靠后（>60% 位置）可能命中的是别处，先记下
      start = i;
      usedStart = m;
    }
  }
  if (start < 0) return null;

  let end = text.length;
  for (const m of JD_END) {
    const i = text.indexOf(m, start + (usedStart?.length ?? 0));
    if (i > start && i < end) end = i;
  }

  let jd = text.slice(start, end).trim();
  // 去掉常见的尾部噪声
  jd = jd.replace(/(竞争力分析|申请职位|收藏|立即沟通|举报)$/g, '').trim();
  if (jd.length < 40) return null;
  return { jd, usedStart, length: jd.length };
}

/** 提取公司简介区段（不少页面没有，拿不到就算了） */
export function extractCompanyIntro(pageText) {
  const text = String(pageText || '');
  const starts = ['公司简介', '企业简介', '公司介绍'];
  const ends = ['工作地址', '相似职位', '热门职位', '工商信息', '猎聘温馨提示', '竞争力分析', '举报'];
  for (const s of starts) {
    const i = text.indexOf(s);
    if (i < 0) continue;
    let end = text.length;
    for (const e of ends) {
      const j = text.indexOf(e, i + s.length);
      if (j > i && j < end) end = j;
    }
    const intro = text.slice(i, end).trim();
    if (intro.length >= 30) return intro;
  }
  return null;
}

/** 从整页文本里提取 HR 在线状态等招聘者信号 */
export function extractRecruiterSignals(pageText) {
  const text = String(pageText || '');
  const m = text.match(/(\d+\s*(?:分钟|小时|天)前(?:在线|活跃))|刚刚在线|今日活跃|本周活跃|离线/);
  return { onlineText: m ? m[0].replace(/\s+/g, '') : '' };
}

/**
 * 抓一个职位的详情。
 * @param {import('../../core/browser/cdp-lite.mjs').CdpLite} cdp 已附着的会话（会被复用，串行调用）
 * @param {string} url 职位页 URL
 */
export async function fetchJobDetail(cdp, url) {
  const landed = await cdp.navigate(url);
  await cdp.waitStable({ quietMs: 2000, maxMs: 25000 });
  const pageText = await cdp.pageText();

  const jd = extractJd(pageText);
  const intro = extractCompanyIntro(pageText);
  const recruiter = extractRecruiterSignals(pageText);

  return {
    url,
    landedUrl: landed,
    pageTextLength: pageText.length,
    jd: jd?.jd || null,
    jdMarker: jd?.usedStart || null,
    companyIntro: intro,
    recruiter,
    // 整页文本留档，便于事后校准 extractJd 的标记
    pageText,
  };
}
