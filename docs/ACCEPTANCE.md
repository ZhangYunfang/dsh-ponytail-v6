# 验收说明

四层验收，全部可复跑。任何一层失败都不算通过。

| 层 | 命令 | 覆盖 |
|---|---|---|
| 单元测试 | `npm test` | 18 个纯函数/模块级用例 |
| 静态验收 | `node scripts/verify.mjs` | 68 项断言（技能完整性、档位语义、命令解析、状态解析链） |
| 宿主契约探针 | `node scripts/probe-host.mjs` | 37 项断言（真实 cordis + 真实 SystemPrompt + 真实 WebServer + 5 种 scope） |
| 客户端探针 | `node scripts/probe-client.mjs` | 22 项断言（真实 React 18 渲染 + 面板 HTTP 函数对真实宿主） |

一次跑完：`npm run verify`（后三层）。

> 两个探针都会在挂载插件前把 `DSH_HOME` 指向临时目录，**跑验证不会写真实 `~/.dsh`**，也不启动 dsh-web。

---

## 1. 静态验收（63 项）

`scripts/verify.mjs` 覆盖：

1. **技能逐字节**：6 个 `SKILL.md` 的 sha256 与 `upstream.lock.json` 全等。
2. **名字合法**：kebab-case 且与目录同名（DSH `SKILL_NAME` 规则）。
3. **描述预算**：展平后非空且 ≤ 500 字符（DSH 目录上限）。
4. **provider 可用**：`list()` 返回 6 条且字段齐全，`get()` 每条都能取到非空正文。
5. **四档文本**：`off` 为空串；`lite`/`full`/`ultra` 两两互异。
6. **full 保留四大条款**：`Before you write`、`shortcut:`、`Never cut`、六阶阶梯。
7. **ultra 语义防回归**：包含"质疑需求"，且**不包含** HB123X 的反转句。
8. **档位解析链**：env > config > 默认；文件损坏时 salvage；`setMode` 跨进程持久；非法入参被拒。
9. **反误触发**：`stop ponytail` / `normal mode.` 为真；`add a normal mode toggle` /
   `stop ponytail and also fix the bug` 为假。
10. **命令解析**：空参 = status；四档各自正确；非法参数返回 error 且**不改变状态**。
11. **工作区条款不被过滤**：`lite`/`full`/`ultra` 三档都带该条款，`off` 不带。

## 2. 宿主契约探针（37 项）

`scripts/probe-host.mjs` 用**真实包**搭一个 cordis Context：

- `@deepseek-ai/cordis` 的 `Context`（来自 `~/.dsh/profiles/web/node_modules`）
- `packages/core/system-prompt` 的真 `SystemPrompt`
- `@deepseek-ai/dsh-host-webserver` 的真 `WebServer`（绑 `127.0.0.1:0`，用系统分配端口）

然后挂载本插件，验证七组：

1. 真实服务能起来、WebServer 在监听。
2. `apply()` 不抛、技能提供者与命令各注册一次。
3. provider 满足真实注册表：`list()` 6 条、候选字段齐全、`get()` 有正文。
4. 命令行为：裸命令回 success 并报档位；切档 success；非法档报 error。
5. **prompt section 真进了组装结果**：`ctx.systemPrompt.assemble({})` 的输出里含
   `PONYTAIL MODE ACTIVE`、切档后变成 `level: ultra`、含工作区条款。
6. **HTTP API 端到端**：`/ponytail/state` 200、`/ponytail/mode` 200 且生效、
   非法档 400、坏 JSON 400、错方法 405、未知路径 404、关总开关后 section 真的消失。
7. **子代理继承**：用 5 种 scope 形状（无 scope / 空对象 / 字符串键 / Symbol / 嵌套对象）
   逐个 `assemble({ scope })`，全部都能拿到规则集。

第 7 组的依据：`ScopedLayers.merge(scope, pick)` 先铺 **global 层**再用 scope 链覆盖
（`packages/core/scope/lib/index.js:177-181`），而本插件注册在 profile 根的全局上下文，
所以任何 agent scope 都包含它 —— 探针把这句论断变成了 5 条断言。

探针不启动 dsh-web、`DSH_HOME` 重定向到临时目录、结束时 `process.exit`。

## 2b. 客户端探针（22 项）

`scripts/probe-client.mjs` 不靠浏览器也不靠"跟别的插件写法一样"这种说法：

1. 用桩替换 `window.__ModuleLoader__`，按 DSH 加载器**真实信封**加载 `lib/client.js`；
   断言 `id` 正确、导出 `apply`、`inject` 含 `slots`。
2. 在假 `ctx`（只实现 `slots.inject` / `slots.register`）上执行 `apply()`，
   断言注册了且仅注册一个 `settings.section`，`id=ponytail-v6`、`order` 有限、
   `label()` 返回 `Ponytail`。
3. 用**真实 React 18.3.1 + react-dom/server** 的 `renderToStaticMarkup` 渲染面板：
   断言不抛错，输出含插件名、Off/Lite/Full/Ultra 四个按钮、档位徽标、默认值来源行。
4. 把面板**自己的** `readState()` / `post()` 打到宿主半的**真实 WebServer**：
   断言读状态、切档生效、400 错误透传成 Error、总开关可切换。

第 4 组是这层的价值所在：它证明浏览器半与宿主半的 HTTP 契约真的对得上，而不是各写各的。

## 3. 安装后的真机验收（需要重启 DSH）

探针只能证明契约匹配，不能证明真的挂进了正在跑的 dsh-web。装完按这四步确认：

```bash
# ① 进 bundles 层（不是 pnpm 退出码 0）
dsh --profile web --dump-config | grep -A2 ponytail
# 期望看到一层 `# == dsh-ponytail-v6`

# ② 重启后插件在进程里
# 新开会话，输入 /ponytail  → 应回 "ponytail: level full (default source: ...)"

# ③ 档位真的生效（切档后问一个编码问题，看回复结尾是否有"跳过了什么"）
# /ponytail ultra

# ④ 技能真的注册了
# 输入 /ponytail-review  → 应注入评审技能正文
```

## 4. 效果 A/B（可选，用来判断值不值得常开）

DSH 会话日志已记录完整 usage，可直接复算，无需埋点：

```bash
/usr/bin/python3 - <<'PY'
import glob,json,zstandard,os
p=sorted(glob.glob(os.path.expanduser("~/.dsh/sessions/*/*/session.jsonl.zstd")))[-1]
raw=zstandard.ZstdDecompressor().stream_reader(open(p,'rb')).read().decode('utf8','replace')
i=o=cr=r=steps=0
for l in raw.splitlines():
    if '"usage"' not in l: continue
    u=json.loads(l).get('data',{}).get('chunk',{}).get('usage')
    if not u: continue
    steps+=1
    i+=u.get('inputTokens',0); o+=u.get('outputTokens',0)
    cr+=u.get('cacheReadTokens',0); r+=u.get('reasoningTokens',0)
print(f"steps={steps} input={i:,} cacheRead={cr:,} output={o:,} reasoning={r:,}")
PY
```

> 本机只有 `/usr/bin/python3` 带 `zstandard`。

**A/B 协议**：选 5 个真实小任务（10~50 行改动的量级），各跑 `off` 与 `full` 两遍、
**各自新开会话**，记录 步数 / output token / 新增行数 / 是否漏改调用方。

- **通过**：≥4/5 任务新增行数降 ≥20%，且漏改调用方 0 次、测试全绿。
- **放弃**：出现 ≥2 次漏改调用方，或**步数不降反升**（说明"先查已有"反而多花轮次，
  而每多一轮就多读一遍长上下文，可能把省下的输出全吃掉还倒亏）。

判定阈值与成本结构的实测数据见 `docs/CAPABILITIES.md` §8。
