/** 对比：无头 vs 有头、多个 URL，看到底是什么触发验证码。 */
import { CdpLite } from '../core/browser/cdp-lite.mjs';

const cdp = await CdpLite.attach({ port: 9222, url: 'about:blank' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UA = await cdp.sendCommand('Runtime.evaluate', {
  expression: 'navigator.userAgent',
  returnByValue: true,
}).then((r) => r.result?.value).catch((e) => `(读不到: ${e.message})`);
console.log('UA =', UA);
const WD = await cdp.sendCommand('Runtime.evaluate', {
  expression: 'String(navigator.webdriver)',
  returnByValue: true,
}).then((r) => r.result?.value).catch(() => '?');
console.log('navigator.webdriver =', WD);

const urls = [
  ['之前无头成功过的岗位', 'https://www.liepin.com/lptjob/84831881'],
  ['刚被拦的岗位', 'https://www.liepin.com/lptjob/84319041'],
  ['C 端首页', 'https://c.liepin.com/'],
  ['职位搜索页', 'https://www.liepin.com/zhaopin/?city=020&key=Java'],
];

for (const [label, url] of urls) {
  await cdp.navigate(url);
  await cdp.waitStable({ quietMs: 1500, maxMs: 25000 });
  await sleep(1200);
  const real = await cdp.currentUrl();
  const text = ((await cdp.pageText().catch(() => '')) || '').replace(/\s+/g, ' ');
  const captcha = /captcha|安全中心|验证码/.test(real) || /安全中心|请完成验证|拖动滑块|验证码/.test(text.slice(0, 600));
  // 不硬编码姓名：登录与否看 cookie，登录名只用作显示
  const cookies = await cdp.getCookies().catch(() => []);
  const logged = cookies.some((c) => c.name === 'lt_auth');
  const m = /你好[，,]\s*([^\s，,]{1,20})/.exec(text);
  console.log(`\n[${label}]`);
  console.log(`  目标 = ${url}`);
  console.log(`  实际 = ${real.slice(0, 100)}`);
  console.log(`  验证码 = ${captcha ? '是 ✗' : '否 ✓'}   已登录 = ${logged ? `是 ✓${m ? `（${m[1]}）` : ''}` : '否'}`);
  console.log(`  正文 = ${text.slice(0, 90)}`);
  await sleep(1500);
}

await cdp.close();
process.exitCode = 0;
