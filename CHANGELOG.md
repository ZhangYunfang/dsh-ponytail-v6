# Changelog

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
