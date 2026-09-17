/**
 * 风控页识别。
 *
 * 为什么必须有这个：猎聘在判定「账号行为异常」后会把请求重定向到
 *   https://safe.liepin.com/page/liepin/captchaPage_PC?euuid=...&backurl=...
 * 页面是一张图形验证码。此时**页面结构完全不同**，所有按钮定位必然失败。
 *
 * 没有这个检测的话，症状是「未找到打招呼入口，请调整 GREET_BUTTON_TEXTS」——
 * 会把人引去改选择器，而真正的原因是风控，改选择器永远改不好。
 * 实测踩过（2026-09-17）。
 *
 * 边界：只**识别**并停下，绝不尝试绕过（不改 UA、不伪造指纹、不自动过验证码）。
 * 解验证码属于操作者本人的事。
 */

const CAPTCHA_URL_RE = /safe\.liepin\.com\/page\/liepin\/captchaPage/i;
const CAPTCHA_TEXT_RE = /账号行为异常|安全中心发现|请完成.{0,6}验证|拖动滑块|图形验证码/;

/**
 * 当前页面是不是风控/验证码页。
 * @returns {Promise<{blocked:boolean, url:string, kind:string, hint:string}>}
 */
export async function riskControlPage(cdp) {
  let url = '';
  try {
    url = (await cdp.currentUrl()) || '';
  } catch {
    /* 读不到就当没拦 */
  }
  let text = '';
  try {
    text = ((await cdp.pageText()) || '').slice(0, 2000);
  } catch {
    /* ignore */
  }

  const byUrl = CAPTCHA_URL_RE.test(url);
  const byText = CAPTCHA_TEXT_RE.test(text);

  if (!byUrl && !byText) {
    return { blocked: false, url, kind: '', hint: '' };
  }
  return {
    blocked: true,
    url,
    kind: 'captcha',
    hint: [
      '被猎聘风控拦住（账号行为异常 → 图形验证码）。',
      '这不是选择器问题，改 send.mjs 的按钮文本没有用。',
      '处理办法：在没有调试端口的普通 Chrome 里人工打开下面这个链接，过掉验证码，然后重跑。',
      url ? `  ${url}` : '',
      '想更快：直接开 https://c.liepin.com/ 点任意岗位详情，弹验证码时点一下即可。',
      '本工具不会自动过验证码，也不会改 UA / 伪造指纹去骗过风控。',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

/** 无头模式在猎聘上的实测结论（写进 --headless 的警告里） */
export const HEADLESS_WARNING = [
  '⚠ 实测（2026-09-17）：无头 Chrome 的 UA 里带 "HeadlessChrome/137.0.0.0"，',
  '  猎聘会据此判定「账号行为异常」，把职位详情页重定向到图形验证码页；该标记落在 session 上，',
  '  之后即使切回有头、首页和搜索页正常，详情页仍持续被拦。',
  '  需要无人值守请改用 --background（有头，窗口挪到屏幕外）。',
  '  不要试图偽造 UA / 指纹去掩盖无头 —— 那是绕过平台风控，不是本工具该做的事。',
].join('\n');

/**
 * 后台模式的说明（正向提示，与 HEADLESS_WARNING 相对）。
 * 这个模式不需要偽装任何东西，所以不叫“绕过风控”，叫“不去触发它”。
 */
export const BACKGROUND_NOTE = [
  '浏览器模式：有头 + 窗口挪到屏幕外（--window-position=-32000,-32000）。',
  '  UA / 指纹 / 渲染 / outerHeight-innerHeight 全是真实 Chrome，不做任何偽装，',
  '  因此不会触发招聘平台对「无头浏览器」的判定。需要人工登录时：',
  '  powershell -File start-chrome.ps1 -Kill 后不加 -Background 启动一次即可。',
].join('\n');
