# Changelog

## [1.1.1] — 2026-10-31

**修一个 P0：装上之后每一次对话都会失败。** 这个版本之前，插件一旦加载，宿主会在
每一步抛 `TypeError: Cannot read properties of undefined (reading 'kind')`。

### The bug

`agent/pre-step` 是**协作 waterfall**（`packages/core/agent/src/runtime-types.ts:238`，
发出点 `packages/core/agent-loop/src/agent.ts:244`）：每个监听器按 `(payload, next)` 被调用，
**必须** `await next()` 并把拿到的 decision 原样返回。宿主随后执行

```ts
return decision.kind === 'reject' ? decision : { ...decision, assembly }
```

v1.1.0 的 `installDeactivationWatch` 注册的是 `ctx.on('agent/pre-step', payload => {…})` ——
没有 `next`、隐式返回 `undefined`，于是整个 decision 变成 `undefined`，
下一行读 `.kind` 就炸。**影响面是全部**：不是某个功能坏，是整个 agent 循环每步都挂。

### Why the 32-assertion probe missed it

探针只 `provide` 了假的 `skills` 与 `commands`，从没走过 `agent/pre-step` 的真实分发路径；
而 `ctx.on` 在真 cordis 上合法存在，所以「不抛异常」被误当成「契约正确」。
**教训：接缝能注册 ≠ 契约正确，waterfall 类事件必须验返回值。**

### The fix

- 新增 `lib/prestep.js`：监听器改成 `async (payload, next) => { const decision = await next(); …; return decision }`，
  `next()` 无条件调用且在 try/catch 之外；启发式逻辑单独 try/catch，永不外溢。
- **改为默认关闭、需显式开启**（`PONYTAIL_PRE_STEP=1`）。理由：这个功能的收益很小
  （`/ponytail off` 命令已覆盖），但它的爆炸半径是全部 —— 默认关掉才是对的取舍。
- 宿主不传 `next` 时监听器保持惰性（返回 undefined 无人读取），不再参与链条。

### New gate

静态验收新增**第 13 组：waterfall 契约**（10 项断言）——监听器必须调用 `next()` 恰好一次、
必须返回**同一个 decision 对象**、reject 决策必须原样透传、抛异常的状态不得破坏返回值、
默认必须是关闭、`index.js` 必须用 `isPreStepEnabled()` 守卫且不得出现无守卫的
`ctx.on('agent/pre-step', payload => …)`。

单测 18 → 26，静态断言 68 → 78。

## [1.1.0] — 2026-10-31

关闭 1.0.0 遗留的两个「未验证」，全部变成可复跑的断言。

### Verified (previously unverified)

- **设置页面板现在有真渲染证据**。新增 `scripts/probe-client.mjs`（22 项断言）：
  - 用桩替换 `window.__ModuleLoader__`，按 DSH 加载器的真实信封加载 `lib/client.js`；
  - 在假 `ctx` 上执行 `apply()`，断言注册了且仅注册了一个 `settings.section`
    （`id=ponytail-v6`、`order` 有限、`label()` 返回 `Ponytail`）；
  - 用**真实 React 18.3.1 + react-dom/server** 的 `renderToStaticMarkup` 渲染面板，
    断言不抛错且输出含插件名与 Off/Lite/Full/Ultra 四个按钮、档位徽标、默认值来源行；
  - 把面板**自己的** `readState()` / `post()` 直接打到**宿主半的真实 WebServer** 上，
    断言读状态、切档、400 错误透传、总开关四种交互全部与宿主一致。
- **子代理继承已实测，不再靠推断**。`SystemPrompt.merge(scope, …)` 永远以 global 层为基底，
  而本插件注册在 profile 根的全局上下文，所以任何 agent scope 都能看到规则集。
  探针用 5 种 scope 形状（无 scope / 空对象 / 字符串键 / Symbol / 嵌套对象）逐个
  `assemble({ scope })` 验过，全部拿到规则集。

### Fixed

- **探针不再写真实 `~/.dsh`**。此前 `probe-host` 通过 HTTP 改档位会落到
  `~/.dsh/ponytail/config.json`；现在两个探针在挂载插件前把 `DSH_HOME` 指向临时目录，
  结束后删除，跑探针绝不污染用户的 home。
- 面板徽标断言改成正则（`level <mode>` 或 `loading`），不再依赖加载中文本的措辞。

### Changed

- `npm run verify` 现在是四层：静态 78 项 + 宿主探针 37 项 + 客户端探针 22 项，
  加上 `npm test` 的 26 个单元测试。
- 静态验收新增**第 12 组：版本一致性**（`package.json` / `dsh.plugin.json` /
  `CHANGELOG.md` 三者必须一致，`engines.dsh` 与兼容矩阵必须存在）。
  加它的直接原因：本次升 1.1.0 时 `dsh.plugin.json` 漏改，靠人眼才发现。

### Known limits (still true)

- 兼容矩阵仍只声明 `0.1.2-alpha.2`。
- 面板的**视觉效果**（配色、间距、暗色主题下的观感）没有截图证据，只验了渲染与交互。
- `stop ponytail` 的自然语言触发依赖 `agent/pre-step` 事件形状；识别不到时静默不生效。

## [1.0.0] — 2026-10-31

首个发布版：把上游 ponytail v5.3.3 完整移植到 DeepSeek Harness，并补上 DSH 独有能力。

### Added

- **6 个技能，逐字节移植**（`skills/*/SKILL.md`）。`upstream.lock.json` 记录上游
  `5.3.3 @ 96608e0` 与每个文件的 sha256；`npm run verify` 会重算比对，漂移即失败。
- **实时档位**：`off` / `lite` / `full` / `ultra`，通过 `systemPrompt.section` 注入，
  `text` 每次组装求值 —— 切档在下一步生效，档位不变时提示前缀完全一致（KV 缓存友好）。
- **`/ponytail` host 命令**：`status` 与四档切换，走 `commands.register`，
  **不发送给模型因此零 token**。
- **设置页面板**（可选）：四档按钮 + 总开关，走 `slots.inject('settings.section')`；
  整段 try/catch，挂载失败不影响 host 侧功能。
- **HTTP API**：`GET /ponytail/state`、`POST /ponytail/mode`、`POST /ponytail/enabled`，
  带 400/405/404 校验。
- **档位持久化**：`~/.dsh/ponytail/config.json`，临时文件 + rename 原子写；文件损坏时
  salvage 到默认值并告警，不抛异常。

### Design decisions worth knowing

- **工作区优先条款**（本移植新增）：基线文本末尾固定声明「工作区指令与本块冲突时以工作区
  为准，本块不得作为跳过门禁的理由」。上游宿主没有硬门禁，DSH 有，缺这条会让「懒惰」
  被当成绕门禁的借口。
- **段位 10**：紧接 `DEPLOYMENT_PERSONA (0)`、`PLAN_POLICY (500)` 之前，而不是随手写个魔数。
- **`ultra` 语义忠实上游**：质疑需求（push back），不是「永不追问、直接给最短」——
  后者是 HB123X 版的反转，验收里有一条断言专门防它回归。
- **`stop ponytail` / `normal mode` 要求整条消息**：复刻上游修过的 bug（子串匹配会把
  「add a normal mode toggle」误判成关闭）。
- **只拷贝 `skills/`**：上游的 hooks、各宿主适配层、benchmark 属于别的宿主，不搬。

### Verification

- `npm run verify` → **63 项静态断言 + 32 项真机契约探针**，全部 PASS。
- `npm test` → **18 个单元测试**，全部通过。
- 真机探针用**真实 cordis + 真实 SystemPrompt + 真实 WebServer** 挂载，验证 prompt 确实
  进入组装结果、切档实时生效、HTTP API 全状态码正确、关闭后 section 真的消失。

### Known limits

- 设置页面板未在真浏览器里跑过（挂载方式与同机跑通的 `dsh-skill-studio` 一致）。
- `stop ponytail` 的自然语言触发依赖 `agent/pre-step` 事件形状，识别不到时静默不生效。
- 子代理是否继承 prompt section 未验证。
- 兼容矩阵只声明 `0.1.2-alpha.2`。
