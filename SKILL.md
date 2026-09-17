---
name: job-auto-apply
description: |
  通用求职站自动投递框架（AI 匹配打分 + AI 生成打招呼语 + 限速发送 + 简历投递）。
  首个站点适配器：猎聘 c.liepin.com 求职者端。
  不调用任何外部 LLM 接口 —— 生成能力（打分/打招呼语/打分要求/简历定制）由调用本 skill 的 agent 提供。
  适用于：批量投递实习/校招岗位、按岗位定制简历、AI 生成打招呼语、职位匹配度打分、
  招聘站点前端接口（无签名 C 端 API）采集、CDP 免 Runtime 浏览器自动化。
  触发关键词：自动投递、批量投递、打招呼、求职自动化、招聘网站爬取、猎聘、BOSS 直聘、
  智联招聘、简历投递、job apply、auto apply、job scraper、AI 打分、岗位匹配度。
---

# 求职站自动投递（job-auto-apply）

## ACTION REQUIRED（读完后立刻执行）

1. `NOW`：`node src/cli.mjs doctor` —— 一次自检（会告诉你环境缺什么）
2. `NOW`：缺配置就跑 `node src/cli.mjs setup` —— 它会列出**你该去问用户哪些问题**；
   问完把答案写进 `config/criteria.json` 与 `config/experience.json`（模板在 `config.defaults/`）
3. `NEXT`：`node src/cli.mjs rubric` 生成打分要求（会给你待办，见下）
4. `ACT`：`node src/cli.mjs send --max N` —— 已无演练/确认，直接真实发送。发前自己核对候选与招呼语

## 生成能力：由你（agent）充当模型

本 skill **不调用任何外部 LLM 接口，不需要 API key**。打分/招呼语/打分要求/简历定制
这些需要模型产出的东西，**你（agent）就是那个模型**。

代码（打分/招呼语/打分要求/简历定制）不会自己降级或罢工，而是把需要的内容写成**待办文件**：

```
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

### 你要做的事（三步，一轮往返）

1. 读 `state/agent-llm/requests.json`。里面 `requests[]` 每项有：
   `id` / `kind`（`score`\|`greet`\|`rubric`\|`resume`）/ `system` / `user` / `expect`
2. 对每项，按 `system` + `user` 的要求**自己产出结果**，写成 `expect` 描述的 JSON，然后写入
   `state/agent-llm/responses.json`：
   ```json
   { "responses": { "<该项目的 id>": { "text": "<你产出的 JSON 文本>", "at": 1737000000000 } } }
   ```
   **已有 responses 要合并进去，不要覆盖别的项。** `text` 里放原始文本即可（带不带 ```json 围栏都行，代码会抠出来）。
3. 原样重跑同一条命令。全部命中缓存后就会正常跑完。

### 规则（别绕过）

| 规则 | 原因 |
|---|---|
| **只写 `state/agent-llm/` 下的文件** | 解析、校验、落盘都由代码负责 |
| **不要自己往 `artifacts/scored.json` 之类写结果** | 那会绕过所有校验 |
| **退出码 3 = 待办，不是失败** | 不要重试、不要尝试别的命令，按上面三步走 |
| **招呼语仍要过代码的 lint** | 代码会检查陈述句、只讲自己、长度、套话，`send` 只发 `lint.ok` 的 |
| **简历定制仍要过技能池强制** | 你从技能池外挑的技能会被代码剔除 |

### 内容寻址：为什么不用怕草稿变味

每项待办的 `id` = `sha1(kind + system + user)`。所以：
- 岗位、打分要求、求职条件任一变化 → prompt 变 → id 变 → **自动重新生成**
- 同一个岗位已生成过的不重复要
- 这正是「不要提前预设草稿」的实现：招呼语永远对着**当时的**岗位与口径生成

### 处理量很大时

一次要处理的很多（比如 `score --max 200` ⇒ 25 批）时，你得分批自己算完。
没有别的方式 —— 本 skill 永远不会自己去调外部模型。

## 绝对不要做的事（硬边界）

| 禁令 | 原因 |
|---|---|
| **不要绕过风控** | 不改 UA、不伪造指纹、不用代理池、不自动过验证码。见下方「风控」 |
| **不要编造简历内容** | 打招呼语只能用「真实能力池」里的东西；`lintGreeting` + `enforceSkillPool` 会在代码层拦 |
| **不要在用户未要求时跑 `send`** | `send` 一跑就直接联系 HR。只想看内容就跑只读命令（`search`/`score`/`detail`/`draft`） |
| **不要把个人数据写进技能目录** | 简历/手机号/证件照/cookie 都在工作根 HOME |
| **不要跳过每日上限** | `config/limits.json` 的 `dailyCap` 是代码层硬门，没有绕过开关 |
| **不要替用户答 `setup` 的问题** | 求职条件与个人经历是用户的事实，猜错了会误导投递 |

## 路径分层（先搞清这个）

```
<技能目录> skills/job-auto-apply/     代码 + 模板 + 自带浏览器 + 自带 Node + 默认配置（可分发）
  browser/                             自带 Chromium（CloakBrowser 148，~425MB，不入库，随文件夹分发）
  node/node.exe                        便携 Node 运行时（~87MB，不入库，随文件夹分发；系统 node 缺失/太旧时兜底）
  src/core/                            站点无关：浏览器/CDP、LLM、打分、打招呼语、限速、存储、路径
  src/sites/<id>/                      站点适配器（当前：liepin）
  src/tools/                           开发探针
  config.defaults/                     默认配置 + 个人数据示例（首次运行拷到 HOME/config）

<工作根 HOME>                           私人数据（不进版本库）
  config/ criteria.json experience.json profile.md rubric.json limits.json prompts.json
  state/  daily.json sent.jsonl cookies.json agent-llm/
  artifacts/ jobs.jsonl scored.json details/ resumes/ screenshots/
  .env .chrome-debug/
```

HOME 解析顺序：`JOB_APPLY_HOME` → 从技能目录往上找最近的含 `.env`/`state/`/`config/criteria.json` 的目录 → 技能目录自己。
`doctor` 第 0 节会打印它。

## 核心工作流

```bash
node src/cli.mjs doctor                    # 自检（缺什么会明说）
node src/cli.mjs setup                     # 缺配置时：列出该问用户的问题（--json 给机器读）
node src/cli.mjs rubric                    # 按目标岗位生成打分要求（换岗位后必跑）
node src/cli.mjs search --pages 2          # 按 criteria.keywords 逐词搜索，按 jobId 合并去重
node src/cli.mjs detail --max 30           # 抓 JD 正文（SSR 页面，串行 + 拟人延时）
node src/cli.mjs score --max 60            # 匹配度打分（用 rubric.json 的口径）
node src/cli.mjs resume-pdf --max 5        # 按岗位定制简历 PDF（换侧重，不新增事实）
node src/cli.mjs draft --max 20            # 预生成招呼语，仅用于预览，不发送
node src/cli.mjs send --max 3              # 真实发送（无演练；招呼语发送前即时生成 + 附简历卡片）
```


浏览器模式默认**无头**（`--headless`）。首次登录或过验证码用 `--headed`（有头弹窗）；
被风控时改用 `--background`（有头但窗口挪到屏幕外）。


### `send` 在 agent 模式下的一个差异（必须知道）

招呼语是**发送时生成**的。没有 key 时无法在发送循环里现问现答，所以采取：

**发送前一次性预检全部候选的招呼语** —— 点第一个按钮之前就把语料备齐。

这不是妥协而是必须：`send` 是真实点击，跑到一半才发现缺招呼语时，
「聊一聊」可能已经点过了（那本身就会发出平台默认招呼语）—— HR 已经被打扰了。

如果某个岗位的招呼语被 lint 拦下且重试轮也没缓存，该岗位会**本轮跳过**（不发坏文案），
汇总里会列出来；直接重跑同一条命令即可补上（没写 `sent.jsonl`，不会重复打扰已发过的 HR）。

## 打分要求由 AI 生成（**不要硬编码岗位口径**）

打分口径**不在代码里**。`config/rubric.json` 由模型依据「目标岗位 + 求职条件 + 候选人背景 + 真实岗位样本」生成：

```bash
node src/cli.mjs rubric            # 生成并保存
node src/cli.mjs rubric --print    # 只看不写
```

- `score`/`send` 发现打分要求缺失或过期会**自动重新生成**（`--no-auto-rubric` 关掉）
- 优先级：`config/prompts.json` 的 `scoreSystem`（人手写）> `rubric.json`（生成）> 内置兜底
- **agent 模式下不自动降级**：生成不了就把待办交出去，而不是用内置口径糊弄
  （内置口径是通用版，不针对当前目标岗位，打分偏粗）
- 换岗位流程：改 `criteria.keywords` → `rubric` → `search` → `score`

## 风控（**硬边界，不许绕**）

猎聘判定「账号行为异常」后会把请求重定向到 `safe.liepin.com/page/liepin/captchaPage_PC`（图形验证码）。
此时页面结构完全不同，所有按钮定位必然失败 —— `core/risk.mjs` 的 `riskControlPage()` 会识别它并直接停下，
而不是报「找不到按钮」把人引去改选择器。

**正确做法**：停下，让操作者本人在普通 Chrome 里人工过验证码，然后重跑。
`src/tools/probe-captcha-cause.mjs` 可以确认是哪个 URL 被拦。

### 无头模式（默认）

**默认就是无头**（`--headless`，`start-chrome.ps1` 不传模式参数也走无头）。
功能上可用（能开 CDP、能渲染、能复用登录态、能定位按钮、能截图）。

**但实测会触发风控**：无头 Chrome 的 UA 含 `HeadlessChrome/148.0.0.0`，猎聘据此判定账号行为异常，
把职位详情页重定向到验证码页；该标记落在 session 上，即使切回有头，详情页仍会持续被拦一段时间（约 10 分钟后自行过期）。

**遇到风控/验证码时的正确做法**：

```bash
# 有头但窗口挪到屏幕外（不触发无头判定）
powershell -File start-chrome.ps1 -Kill -Background

# 或需要人工过验证码 / 首次扫码登录
powershell -File start-chrome.ps1 -Kill -Headed
```

也**不要去改 UA 掩盖** —— 那是越过约定的边界。

## 新增一个站点

1. 建 `src/sites/<id>/`，实现契约（见 `src/sites/index.mjs` 顶部注释）：
   `id` `label` `meta` `createApi` `search` `fetchDetail` `isChatted` `sendOne` `searchForm`
2. 在 `src/sites/index.mjs` 的 `REGISTRY` 里注册
3. `config/site.json` 的 `site` 改成新 id（或设 `SITE` 环境变量）
4. **泛化性自检**：`src/core/` 一行都不该改。要改就说明抽象漏了，回去补适配器

## 关键陷阱（都是实测踩过的，别再踩）

| 陷阱 | 事实 |
|---|---|
| **`Runtime.enable` 会让猎聘页白屏** | 约 2.8s 后 `frameDetached`。所以浏览器层是 `core/browser/cdp-lite.mjs`，只用 `Page`/`DOM`/`Input`/`Network` 域。只读求值可用一次性 `Runtime.evaluate`，**绝不调 `Runtime.enable`** |
| **CDP nodeId 不能跨查询持有** | 中间的 `querySelectorAll`/`pageText` 会让旧 nodeId 失效（`Could not find node with given id`）。每次重新查 |
| **按钮文案必须过 `normText()`** | Ant Design 两个汉字的按钮会把 span 拆开，DOM 里是 `确 定`/`取 消` |
| **`totalCounts` 不可信** | 猎聘把它截在 ~800。判断筛选器是否生效要**比较返回的 jobId 集合** |
| **`dq=410` 是全国码** | 会覆盖 city，绝不能用于地域过滤。上海是 `020` |
| **`workYearCode=2`** 才是实习 | 1=应届生。找实习必须用 2 |
| **点「聊一聊」会先发平台默认语** | 我们的打招呼语永远是第 2 条消息。所以每次失败也已经在接触 HR → 补位必须有上限（`--max-attempts`，默认目标×2） |
| **cmd.exe 按字节读 bat** | bat 必须纯 ASCII + CRLF，中文一律由 Node 输出；中途改 `chcp` 会让 cmd 丢失文件位置 |
| **PowerShell 5.1 的 `Invoke-RestMethod -Body` 按 ASCII 编码** | 中文会变 `?` **并且落盘**。测本地 HTTP 接口用 Node `fetch` |
| **nvm 会把 `node` 切到旧版** | 本流水线依赖全局 `fetch`/`WebSocket`（Node 18+）。入口有版本守卫会自动换回（`core/node-guard.mjs`） |

## 与仓库其他部分的关系

- 本 skill 是**独立可移植**的：整个 `skills/job-auto-apply/` 拷到任何 agent 的 skills 目录即可用
- 用到的通用能力（浏览器自动化、前端接口逆向）与 `skills/browser-automation`、`skills/js-reverse` 同源
- 无头被识别的现场记录：`skills/field-journal/2026-09-17_headless-detection-and-session-level-risk-flag.md`

## 任务完成自检（声称完成前 MUST 通过）

- [ ] `node src/cli.mjs doctor` 退出码 0？
- [ ] 缺 `criteria.json`/`experience.json` 时，是**问了用户**而不是自己编的？
- [ ] 改过目标岗位吗？改了就重跑 `rubric` 了吗？
- [ ] agent 模式下的退出码 3，是按「读待办 → 写 responses → 重跑」处理的，而不是当失败？
- [ ] 没在未经要求时擅自跑 `send`（已无演练可退，发了就是真联系 HR）？
- [ ] 碰到风控是**停下**而不是想办法绕？
- [ ] 有没有把个人数据写进技能目录（应写进 HOME）？
- [ ] 新增站点的话，`src/core/` 是否一行未改？
