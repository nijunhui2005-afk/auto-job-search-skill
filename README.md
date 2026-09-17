# job-auto-apply —— 通用求职站自动投递框架

> 第一个站点适配器：**猎聘**（`c.liepin.com` 求职者端）。
> 这是一个**独立可分发**的技能目录：拷到任何机器上、配好 `.env` 和个人配置就能跑。
> 使用前请确认你有权自动化该站点，并遵守其服务条款。

> ⚠️ **本仓库是源码仓库**，不含 `browser/`（自带 Chromium，~425MB）与 `node/`（便携 Node，~87MB）——
> 它们超出 GitHub 的 100MB 单文件限制（`chrome.dll` 单个就 308MB），所以被 `.gitignore` 排除。
>
> - 想要**开箱即用的完整包**（含自带 Chromium + 便携 Node，无需预装任何东西）：
>   到 **[Releases](../../releases)** 下载 `job-auto-apply.zip`。
> - 想**从源码直接跑**：装好 Node ≥ 18；浏览器没装就按 `start-chrome.ps1` 的解析顺序放一个
>   （`-ChromePath` 参数 → `CHROME_PATH` 环境变量 → `browser/chrome.exe` → 系统 Chrome）。

## 先看这个：你拿到的是一个空壳

本目录含**代码 + 模板 + 自带浏览器 + 自带 Node 运行时 + 默认配置**
（`browser/` CloakBrowser Chromium 148 约 425MB；`node/node.exe` 便携 Node 约 87MB），
不含任何人的简历、手机号、cookie。
首次运行会把 `config.defaults/` 铺到工作根目录，之后的个人数据都留在那边（不会被分发）。

**浏览器解析顺序**（`start-chrome.ps1`）：`-ChromePath` 参数 → `CHROME_PATH` 环境变量（可写进 `.env`）→ 本目录 `browser/chrome.exe` → `D:\tools\cloakbrowser\...` → 系统 Google Chrome。

**Node 解析顺序**：`PATH` 里的 `node`（需 >= 18）→ 本目录 `node\node.exe`。
系统 `node` 缺失或太旧时，`src/core/node-guard.mjs` 会自动改用自带的那个。
所以整个文件夹拷给别人就能跑，对方**无需预装 Chrome，也无需预装 Node**。

开工前需要准备 2 样东西（缺哪个 `doctor` 都会告诉你）：

| 缺什么 | 症状 | 怎么补 |
|---|---|---|
| `config/criteria.json` | `search` 说没有搜索条件 | 照 `config.defaults/examples/criteria.example.json` 建 |
| `config/experience.json` | 打招呼语/简历没内容 | 照 `config.defaults/examples/experience.example.json` 建 |

（**不需要 LLM API key**：本 skill 不调外部 LLM，生成能力由调用它的 agent 提供。）

**工作根（HOME）在哪？** 由 `src/core/paths.mjs` 解析：
`JOB_APPLY_HOME` 环境变量 → 从本目录往上找最近的含 `.env`/`state/`/`config/criteria.json` 的目录 → 本目录自己。
`node src/cli.mjs doctor` 的第 0 节会打印实际解析结果。

想看效果但暂时没有自己的数据：设 `JOB_APPLY_HOME` 指向一个空目录，把示例拷进去跑 `doctor`。

## 首次运行

```bash
node src/cli.mjs doctor
```

（没装 Node 或系统 Node < 18？直接用自带的：`node\node.exe src\cli.mjs doctor`）

它会自动把 `config.defaults/` 铺到工作根，并逐项报告环境/生成能力/CDP/登录态/打分要求。

## 调用方式（本 skill 只给 agent 用）

没有 `run.bat`、没有前端面板、没有给人用的入口 —— **直接用 CLI**：

```bash
node src/cli.mjs doctor        # 先自检
node src/cli.mjs search --pages 2
node src/cli.mjs score --max 60
node src/cli.mjs send --max 3
```

浏览器**默认无头**。首次登录/过验证码加 `--headed`；被风控时加 `--background`：

```bash
node src/cli.mjs doctor --headed        # 有头弹窗，手动扫码登录
node src/cli.mjs send --max 3 --background
```

设计要点：入口会检查 Node 版本（`src/core/node-guard.mjs`）。优先用 `PATH` 里的 `node`，
系统没有或太旧时自动改用自带的 `node\node.exe`。整套流水线依赖全局 `fetch` / `WebSocket`（Node 18+），
旧版下会以极难定位的方式失败 —— 所以必须 >= 18。

## 生成能力：由调用本 skill 的 agent 充当

**本 skill 不调用任何外部 LLM 接口，也不需要 LLM API key。**
调用本 skill 的 agent 就是那个模型。

代码不会自己降级或罢工，而是把需要的内容写成**待办文件**，以退出码 3 结束：

```text
$ node src/cli.mjs score --max 8
▌ 需要 agent 充当 LLM
  本次需要 2 项（另有 0 项已缓存），已写入：
    state/agent-llm/requests.json
  下一步：
    1. 读上面那个文件，按每一项的 system + user 产出结果
    2. 写进 state/agent-llm/responses.json（合并进已有 responses，别覆盖）
    3. 重跑：node src/cli.mjs score --max 8
$ echo $?
3
```

agent 读 `requests.json`（每项含 `id` / `kind` / `system` / `user` / `expect`），
自己产出结果写成 `expect` 描述的 JSON，写入：

```json
{ "responses": { "<id>": { "text": "<产出的 JSON 文本>" } } }
```

然后原样重跑同一条命令即可。

**为什么不让 agent 直接把结果写进产物文件**：那样会绕过代码里所有校验
（打招呼语的 20+ 条 lint、技能池强制、JSON 解析）。所以 agent 只提供**原始模型输出**，
解析/校验/落盘仍由代码负责。

**为什么不怕草稿变味**：每项待办的 `id = sha1(kind + system + user)`，内容寻址。
岗位 / 打分要求 / 求职条件任一变化 → id 变 → 自动重新生成；同一个岗位已生成过的不重复要。

## 做什么

```
职位检索(API) → JD/公司简介(SSR页面) → 生成打分要求 → 匹配度打分 → 达标才生成打招呼语 → 限速发送
```

## 打分要求由 AI 自动生成

**不再硬编码任何岗位口径。** 打分标准由 agent 依据「你设置的目标岗位 + 求职条件 +
你的真实背景 + 最多 15 条真实岗位样本」现场生成，存在 `config/rubric.json`。

```bash
node src/cli.mjs rubric            # 生成并保存（换岗位后跑这个）
node src/cli.mjs rubric --print    # 只看不写
```

- **自动触发**：`score` / `send` 发现打分要求缺失、或目标岗位/城市已变，会现场重新生成
  （`--no-auto-rubric` 关掉；生成失败只降级，不会罢工）
- 手改也行：直接编辑 `config/rubric.json`（`_note` 里有字段说明）
- 优先级：`config/prompts.json` 的 `scoreSystem`（你手写的，最大）> `config/rubric.json`（AI）> 内置兜底
- `node src/cli.mjs doctor` 会报告打分要求是否存在/过期，以及权重分布

> 为什么必须这样：原来 `SCORE_SYSTEM` 里写死了「岗位方向是否真做 AI Agent / 大模型应用工程」
> 和「临港最优」。换任何别的岗位都会被这套口径打歪分，而只改 `niceToHave` 是没用的。

## 打招呼语的写作口径
业主定稿的口径（改口径就改 `src/core/ai.mjs` 的 `GREET_SYSTEM` 与 `lintGreeting`）：

| 要求 | 说明 |
|---|---|
| **只讲自己** | 不描述、不评价公司/职位/业务/团队。禁止「这个岗位要…」「难点在于…」「你们团队…」 |
| **纯陈述句** | 禁止任何疑问句，不得出现 `？`。禁止「请问/是否/能不能/能否/方不方便」 |
| **展示能力** | 主体是自己的经历与技术栈，要具体（有技术名、有动作、有场景），不要「熟悉/精通」空话 |
| **向 JD 对齐** | 对齐体现在**挑什么讲**，不是评论对方要什么。素材由打分环节的 JD 分析提供 |
| 收尾 | 一句陈述句交代可到岗时间 / 可实习时长 |
| 长度 | 目标 100-150 字，两到三句话 |

不允许编造：背景里没有的能力只能用「正在系统学习 / 工程能力可迁移」这类诚实口径。

**两级保障**：

```text
提示词约束  →  lintGreeting() 代码硬校验  →  不合格带反馈重试（最多 3 次）
```

`send` 只发 `lint.ok` 的草稿，所以重试机制是必需的 —— 否则模型偶尔超字数就会
导致草稿被静默丢弃、当天发不出去。

## 没有前端面板

本 skill 的界面就是 **CLI + agent**。想改配置直接改文件（或让 agent 改）：

| 改什么 | 文件 |
|---|---|
| 找什么岗位 / 在哪 / 实习还是校招 | `config/criteria.json` |
| 个人经历 / 联系方式 / 证件照 / 技能池 | `config/experience.json` |
| 打分口径 | `config/rubric.json`（由 `node src/cli.mjs rubric` 生成，可手改） |
| 提示词 | `config/prompts.json`（留空 = 用内置默认） |
| 日上限 / 发送间隔 / 匹配阈值 | `config/limits.json` |
| 搜索结果筛选器 | `config/criteria.json` 的 `searchForm`（取值见 `config/search-options.json`） |

配置的字段含义都写在 `config.defaults/` 同名文件的 `_README` / `_note` 注释里。
缺什么跑 `node src/cli.mjs setup` —— 它会列出该问用户哪些问题。

## 架构：为什么是"裸 CDP + 直连 API"而不是 Playwright

这是本项目最重要的发现，踩了两个大坑才走到这里：

### 坑 1：猎聘会检测 JS 调试器并清空页面

用 Playwright `connectOverCDP` 附着后，页面在 **~2.8 秒** 时被导航到 `about:blank`：

```
+  166ms [navigate] -> https://c.liepin.com/
+ 2824ms [frameDetached] reason=remove
+ 2825ms [navigate] -> about:blank
```

对照实验证明这不是 CDP 本身的问题（`example.com` 挂 30 秒无事），而是猎聘针对
**`Runtime` 域（JS 调试器附着）** 的主动检测。Playwright 必然启用 Runtime，因此必然被踢。

**解法**：自己写 `src/lib/cdp-lite.mjs`，只启用 `Page` / `DOM` / `Input` / `Network`，
**不启用 `Runtime`**。实测页面稳定存活 15/15 秒、20/20 秒。

代价：不能执行页面 JS。所有读取走 DOM 域，所有交互走 Input 域的真实鼠标键盘事件。

### 坑 2：数据不应该从 DOM 抠

绝大多数数据直接从 XHR 响应里拿，结构化且不受页面改版影响：

| 用途 | 接口 |
|---|---|
| 职位搜索 | `POST api-c.liepin.com/api/com.liepin.searchfront4c.pc-search-job` |
| 搜索筛选项/编码表 | `POST …/com.liepin.searchfront4c.pc-search-job-cond-init` |
| 自己的简历 | `POST …/com.liepin.cresume.web-resume-detail`（body `{"data":{}}`） |
| 平台默认打招呼语 | `POST …/com.liepin.cresume.get-current-userinfo` → `chatSetting.sayHiText` |

**没有加密签名**。只需要登录 cookie + 一组固定风控头：

```
X-Client-Type: web
X-Fscp-Version: 1.1
X-Fscp-Fe-Version: (空)
X-Fscp-Std-Info: {"client_id": "40108"}
X-Fscp-Trace-Id: <uuid>
X-Fscp-Bi-Stat: {"location": "<当前页>"}
X-Requested-With: XMLHttpRequest
X-XSRF-TOKEN: <XSRF-TOKEN cookie 的值>
```

所以数据获取完全脱离页面，直接从 Node 走 HTTP。

### 唯一必须走 UI 的：发送

猎聘 IM 走 WebSocket，复刻 socket 协议成本过高。发送走 UI：
导航到职位页 → 定位 `聊一聊` / `继续聊` 按钮（`cls=btn-main`）→ 点击
→ 在聊天框输入 → 回车 → 再点聊天条里的「发简历」→ 确认层「确 定」。

发给 HR 的消息共三条：

```text
1. 平台默认招呼语      ← 点「聊一聊」时就自动发了，我们控制不了（可在猎聘设置里改 sayHiText）
2. 我们生成的定制招呼语 ← 这才是真正写给对方看的那句
3. 简历卡片            ← 「发简历」按钮，平台自己生成，不需要上传任何文件
```

**为什么不用附件发 PDF**：聊天窗的 `<input type=file>` 是
`accept="jpg, jpeg, png, bmp"` —— **不收 PDF**；改成发图片虽然技术上可行，
但发图片属违规，已放弃。走平台自带的「发简历」动作既合规又免上传。

## 命令

```powershell
# 0) 一次性：起带 CDP 的浏览器。默认无头；首次登录/过验证码用 -Headed
powershell -File start-chrome.ps1 -Headed
# 无头（默认，不弹窗）
powershell -File start-chrome.ps1
# 有头但窗口挪到屏幕外（无头被风控时）
powershell -File start-chrome.ps1 -Kill -Background

node src/cli.mjs doctor                       # 环境体检
node src/cli.mjs dq --find "上海|浦东"         # 解析地区码（dq 决定地域过滤！）
node src/cli.mjs resume                       # 从自己简历抓取候选人背景
node src/cli.mjs search --pages 3             # 搜索职位（直连 API）
node src/cli.mjs score --max 24               # AI 匹配度打分
node src/cli.mjs detail --max 18 --min 0      # 抓 JD + 公司简介（SSR 页面）
node src/cli.mjs score --max 24               # 有 JD 后重打分（质量差别很大）
node src/cli.mjs draft --max 6                # （可选）预生成招呼语，仅用于预览
node src/cli.mjs resume-pdf --max 3           # 按岗位定制简历 PDF（+PNG）
node src/cli.mjs send --locate                # 只定位发送按钮，不发送
node src/cli.mjs attach --job 85256053        # 点「发简历」按钮（真实发送）
node src/cli.mjs send --max 3                 # 发送：目标**成功** 3 条，失败自动补位
node src/cli.mjs send --max 3 --max-attempts 6  # 限制最多尝试 6 次（默认 = 目标数 x 2）
node src/cli.mjs send --max 3 --from-drafts    # 改用预生成的草稿（不推荐，除非要人工核过再发）
node src/cli.mjs send --max 3 --no-resume     # 只发招呼语
node src/cli.mjs send --max 3                 # 发送（真实发送，无演练）
node src/cli.mjs setup                        # 缺什么配置 / 该问用户哪些问题
node src/cli.mjs setup --json                 # 同上，给 agent 机器读
```

> `--flag 值` 与 `--flag=值` 两种写法都支持。

## 关键编码（踩过的坑）

| 编码 | 含义 | 坑 |
|---|---|---|
| `dq=020` | 上海 | **`dq=410` 是"全国"，会覆盖 `city` 参数** —— 一开始搜上海却出南京/威海就是这个原因 |
| `workYearCode=2` | **实习生** | `1` 是"应届生"，找实习必须用 2 |
| `com.liepin.cbd.*` | 猎头职位 | `jobKind` 区分招聘方类型 |

## 安全边界（硬约束）

1. 只操作操作者本人账号；`scope.md` 明确排除他人账号
2. **不做对抗性风控绕过**：无打码农场、无设备指纹伪造、无代理池轮换
3. `config/limits.json` + `src/lib/ratelimit.mjs` 硬拒超额，**不提供 `--force` / 环境变量绕过**
4. **无 DRY-RUN**：`send`/`attach` 一跑就真实发送，没有演练模式、没有二次确认；
   硬门只剩 `config/limits.json` 的 `dailyCap`（日上限）与 `sent.jsonl` 去重
5. 去重强制：`state/sent.jsonl` + API 自带的 `recruiter.chatted` 双重保障，同一 HR 永不重发
6. 产物不入库：`state/`、`artifacts/`、`.env`、`.chrome-debug/` 全在 `.gitignore`

## 已知技术坑

| 坑 | 表现 | 处置 |
|---|---|---|
| Chrome ≥136 禁默认 profile 开调试 | `--remote-debugging-port` 被静默忽略 | 强制独立 `--user-data-dir` |
| PowerShell 5.1 读无 BOM 的 UTF-8 `.ps1` | 中文按 GBK 解码 → 字符串截断 → 引号失配 → 脚本行为错乱 | `.ps1` 必须存 **UTF-8 with BOM** |
| 本 shell 里 `Set-Location` 不影响 .NET 当前目录 | `[IO.File]::ReadAllText("相对路径")` 找错目录，甚至误建空文件 | .NET API 一律用**绝对路径** |
| Node 24 + `process.exit()` | `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` | 用 `browser.close()` / `cdp.close()` + `process.exitCode` 自然退出 |
| cookie 域过滤 | `.liepin.com`（带前导点）的 cookie 全被漏掉 | 用 `host === domain \|\| host.endsWith('.'+domain)`，不能反着判断 |
| `pagination.hasNext` 不可信 | `totalPage=21` 但 `hasNext=false` | 用 `totalPage` 判定翻页 |
| PowerShell 读证据文件 | 无 BOM 的 UTF-8 被按 GBK 读成乱码 | `Get-Content -Encoding UTF8` |

## 探针脚本（`src/tools/`）

| 脚本 | 用途 |
|---|---|
| `probe-cdp-close.mjs` | 验证 `connectOverCDP().close()` 的语义（只断开，不关浏览器） |
| `probe-page-blank.mjs` | 带时间线定位页面被清空的成因 |
| `probe-cdp-network-only.mjs` | 裸 CDP 只开 Network/Page，验证不会被踢 |
| `probe-search-headers.mjs` | 抓真实请求的完整 headers，找出自己直连被拒的原因 |
| `probe-jobs.mjs` | 搜索接口直连测试 + 响应结构展开 |
| `probe-sitemap.mjs` | DOM 结构侦察（输入框、链接、候选卡片容器） |
| `probe-job-detail.mjs` | 找职位详情接口 / 确认详情页是 SSR |
| `probe-resume.mjs` | 找简历接口并取出简历正文 |
