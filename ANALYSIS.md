# Perch CLI (perchai-cli v2.4.107) 逆向分析报告

> 分析对象：`dist/perch.mjs`（8.5MB 打包产物，React + Ink 终端 UI）
> 方法：符号反混淆 + 静态数据提取 + 在线端点验证（2026-10-13）

## 0. 总体架构

```
bin/perch                启动器：设 PERCH_CLI_VERSION → 重执行 node --max-old-space-size=4096
dist/perch.mjs           单文件 ESM bundle（esbuild 打包，含 React/Ink/highlight.js/supabase-js）
~/.perch/                用户状态目录（会话、设置、历史、线程缓存、后台任务、BYO 密钥）
```

技术栈：TypeScript → esbuild bundle、React 19 + Ink 6（终端 UI）、highlight.js（代码高亮）、
@napi-rs/canvas（图表渲染）、jsdom + @mozilla/readability（网页正文提取）、supabase-js（认证/数据库）。

## 1. 命令面（`Okr` 分发器）

| 子命令 | 用途 |
|---|---|
| `perch` / `perch --cwd --mode --persona --permission --thread --desktop-tools --local-tools --splash` | 交互模式 |
| `perch run "<prompt>"` | 单次非交互执行（支持 `--json`） |
| `perch login [google\|github]` / `logout` / `status` | 认证（见 perch_login.py 复刻） |
| `perch skills list/show/new/eject/disable/enable [--personal]` | 技能管理 |
| `perch byok list/status/use/off/set/remove/test` | 自带模型密钥 |
| `perch byolm set/status/clear/test` | 本地/自定义模型端点 |
| `perch sub` | 订阅选择（subscription-selection.json） |
| `perch test ap <dir>` | AP 财务审计测试（见 §8） |

## 2. 认证（已完整复刻，见 ../perch_login.py）

- OAuth2 + PKCE (S256)，Supabase Auth（Google/GitHub）
- 配置端点：`GET {app}/api/perch-terminal/cli-auth/config` → `{supabaseUrl, supabaseAnonKey, providers, redirectHost}`
- 会话 v1 存 macOS Keychain（`app.perchai.cli-auth`/`default`）或 `~/.perch/cli-auth-session.json`
- 90 秒过期余量；刷新带 30s 退避 + 失效 token SHA-256 缓存（24h TTL）
- `signup_source:"cli"` 一次性写入 user_metadata（渠道归因）

## 3. 模型层

### 3.1 路由：Roost（`perch.roostUserSelection.v1`）

档位选择 `standard`/`pro`/`standard_max`/`pro_max`（`jnn()` 归一化），服务端按档位路由到具体模型。
`/model <name>` 钉住具体 optionId（`manualModelOptionId`），`/model auto` 回到 roost。

### 3.2 模型注册表（68 个 `hi(provider, modelId)` 定义）

Pro 榜单（`Jle`，按序）：claude-opus-5.5(snowflake)、gpt-6.1-sol / gpt-6-luna(azure_foundry)、
claude-sonnet-5.5 / claude-haiku-5.5(snowflake)、kimi-3(azure)、grok-4.7 / grok-4.6、
glm-5.3 系、deepseek-v4 系、qwen-3.8 系、minimax-m3、nemotron 系、kimi-2.7、glm-5.2、
gpt-6-sol、gpt-5.6 三兄弟…另有隐藏模型（`gBe`）：grok-4.5、muse-spark-1.x、opus-4.8、gpt-5.5。

Starter（`Yle`）：laguna-s(poolside)、qwen-3.8-27b、deepseek-flash-starter、glm-5.3-flash-starter。
促销期（至 2026-10-13 18:30 UTC）Qwen Flash/Max + GPT-6.1 Sol 显示 `(Promo)`。

### 3.3 Provider 矩阵（27 个 providerId）

hosted 通道：snowflake、azure_foundry、openrouter、dashscope、nvidia_nim、poolside、fireworks、wandb、bedrock_mantle、z_ai、meta、ai_gateway。
BYOK 通道（`ML` 注册表 13 家）：openai、groq、cerebras、openrouter、cohere、nvidia_nim、fireworks、huggingface、wandb、ai_gateway、github_models、bedrock_mantle、custom。
OAuth 转借通道：codex_oauth（ChatGPT 计划，client `app_EMoamEEZ73f0CkXaXp7hrann`）、claude_code_oauth、grok_oauth。

每家 provider 的 baseUrl 默认值与 API key 环境变量都硬编码在 `HPt` 表（如 `ANTHROPIC_API_KEY`、`OPENROUTER_API_KEY`、`SNOWFLAKE_PAT` 等 27 个 envKey，可用 `*_BASE_URL` 覆盖）。

### 3.4 推理调用

- **hosted 轮次走服务端代理**：`POST {app}/api/perch-terminal/model-call`，CLI 不直连模型厂商
- **BYO/BYOK 轮次直连厂商**：`TB()`（BYO 激活，AsyncLocalStorage 标记）为真时，`zS()` 完全不走 `UMe()`→`pBt()`（即不发 `model-call`），改走 `sPt()`→`UDt()` 直接 `fetch` 厂商端点（OpenRouter / W&B / 本地 Ollama 等），Perch 服务器不参与推理；`byo/credentials` 仅做凭证管理，不承载推理
  > 实测修正：BYO 直连调用链见 BYO_EXEMPTION_PATH.md（`zS()` 三分支 → `TB()` → `UDt()`）；DEEP_REVERSE_5TOPICS.md:267 记载 BYOK 直连用 OpenAI Responses API 事件流。
- 请求体：`{request:{messages,tools,...}, runId, lane:"chat"|"writer", preferredModelId, avoidModelIds, raceMode, promoOverflowAccepted, reasoningRecovery,...}`
- 头：`Authorization: Bearer <token>`、`User-Agent: perchai-cli/<ver>`、`x-perch-turn-ticket: <ticket>`
- SSE 流事件（共 9 种）：`answer_delta`、`reasoning_delta`、`tool_call_delta`、`tool_use_end`、`stream_restart`（工具调用中途故障转移）、`continuation_seam`、`model_call_failed`、`done`、`error`
- **turn-ticket 准入**（`Aun`）：每轮对话前 `POST /api/perch-terminal/turn-ticket {surface, profile}` 换票据（带 renewal 续期、30s 提前刷新），429 → `turn_rate_limited`（计划限额）
- 错误分类：429→`usage_limit_reached`；403 "Upgrade to Pro"→`starter_model_blocked`；promo 溢出弹「Continue on Manual」选择

## 4. 工具系统（`N` 枚举，134 个工具名全集；单次会话按 surface 裁剪，实测仅暴露 57 个，见 MODEL_CALL_DECODED.md §九）

按类别（权限分级 `read`/`write`/`command`）：

| 类别 | 工具 |
|---|---|
| 文件 | bash、glob、grep、readLocalFile、writeLocalFile、editLocalFile、moveLocalFile、copyLocalFile、deleteLocalFile、createDirectory、printFile、statPath、apply_patch |
| 后台任务 | run_in_background、check/list/kill/wait_for_background_task |
| 记忆 | readProjectMemory、saveToMemory、addProjectRule、getProjectRules、writePerchManual |
| AP 审计 | generateAPAuditPacket、prepare_ap_evidence、query_ap_cases、render_ap_control_graph |
| 编排 | runManagedPlaybook、run_suite、list_suite_catalog、propose/execute_suite_plan、propose_work、execute_work、spawn_worker(_batch)、dispatch_agent、send_worker_message、task_stop |
| 委派 | delegate_task、check_delegate、list_delegates、stop_delegate |
| 沙箱 | runSandboxCode、runSandboxAnalysis、prepareSandboxInputs |
| 浏览器 | browser_navigate/click/type/read/…（16 个）、browser_search_web、browser_read_page |
| 桌面自动化 | computer_list_apps/windows/observe/click/type/scroll/launch_app/execute_actions |
| Google | gmail_send(_draft)、google_docs_create/append、calendar、sheets（及 *_verified 变体） |
| 金融数据 | get_market_signal、run_market_backtest、get_market_track_record 等 6 个 |
| 检索 | searchKnowledge、search_thread_messages、listSources、semanticSearch、retrieveContext、inspectDocument、visionInspect 等 20+ |
| 元工具 | ctxInspect、toolSearch、configInspect、todoWrite、loadSkill、askUserQuestion、propose_plan、enter/exitPlanMode、listMcpServers、loadMcpTools、webSearch、webFetch、scholarSearch |

权限模式（`sBe`）：
- `default`：一切 write/command 需审批
- `auto_review`：低/中危自动放行，高危由「安全审查者」小模型把关
- `take_the_wheel`：全自主（首次需 consent 文件 `~/.perch/take-the-wheel-consent`；legacy 值 `full_access` 归一化）
- `plan`：只读，计划批准前写工具全锁

会话级许可缓存在 `~/.perch/permission-grants.json`。

### 4.1 沙箱（`run_sandbox_code`）

- 工作区 `.perch/venv` 建 Python 虚拟环境，自动装 pandas、openpyxl、matplotlib、plotly、rapidfuzz、networkx、scikit-learn
- 每次运行建 `perch-code-<hash>-{input,output}` 暂存目录，写入 `perch_helpers.py`（含 `input_files/load_tabular/extract_pdf_text/extract_invoice_fields/find_duplicates/write_report` 等 stdlib 辅助函数）
- **静态令牌黑名单**（非真隔离）：Node 禁 `child_process/exec(/spawn(/process.env/eval(/Function(/fetch(`；Python 禁 `subprocess/os.system(/os.popen(/shutil.rmtree/__import__(/importlib/ctypes/requests.get/urllib.request/socket.` 等
- networkPolicy 可配置（disabled 时 pip 安装也禁）

## 5. 会话与状态（`~/.perch/` 文件全景）

| 文件 | 内容 |
|---|---|
| `cli-auth-session.json` | 登录会话（非 macOS） |
| `cli-auth-refresh.lock` / `cli-auth-refresh.invalid.json` | 刷新互斥锁 / 失效缓存 |
| `cli-settings.json` | v1：chatMode、personaId、permissionMode、roostChoice、manualModelOptionId、subagentModelOptionId、effort、cliLocalTools |
| `cli-history.json` | 提示历史 v1（≤500 条，>8000 字符不入档，`PERCH_CLI_HISTORY=0` 关闭） |
| `threads/<scopeHash>/<threadId>.json` | 线程本地缓存；scopeHash = `user-`/`anon-` 前缀 + sha256(`app:appUrl\|user:userId\|email:email\|token:sha256(token)[:20]`)[:20]（token 仅在已认证但 userId/email 均缺失时纳入，故日常登录态目录名稳定） |
| `background-tasks.json` + `background-output/*.log` | 后台任务记录 |
| `byo-local.json` | BYOLM 本地凭据（**明文 apiKey**，mode 0600） |
| `byok-selection.json` / `subscription-selection.json` | 当前 BYOK/订阅选择 |
| `machine-id` | 遥测 distinct_id（randomUUID） |
| `cli-first-run` / `cli-first-prompt` | 漏斗哨兵文件 |
| `take-the-wheel-consent` | 全自主模式首启同意 |
| `permission-grants.json` | 工具许可缓存 |
| `splash-seen` | 首启画面哨兵 |
| `mcp.json` | MCP 服务器配置（全局 or 项目级） |
| `flock-trace.log` | flock 模式轨迹 |

项目级 `.perch/`（在 workspace 根）：`venv/`、`memory/{project,preferences,decisions,permanent}.md`、`rules/`、`skills/`、`plugins/*/plugin.json`、`mcp.json`、`mcp-oauth/`、`playwright-session/`、`debug/model-payloads/`。入口文件 `PERCH.md`。

### 5.1 记忆系统

双层：**server memory**（登录工作区，`perch_ai_permanent_memories` 等表）+ **local project memory**（`.perch/memory/*.md`，固定四文件）。上下文预算 64KB/文件（`nnr`），规则条数上限 40。`/clear` 只清当前终端会话的 recentMessages/usageRunIds/contextSnapshot。

### 5.2 上下文管理

- 有效窗口：`PERCH_CONTEXT_LIMIT_TOKENS` > 模型 effectiveLimit > contextWindow > 默认 128k（`ztn()` 在模型未携带窗口时的兜底值）
- 单次请求 maxTokens 由 `vDe()` 动态计算：`min(模型 maxOutputTokens（缺省 32000）, contextWindow − 已用 tokens − 1000)`；蜜罐实测请求体为 32000（也出现过 393216）
- `uTt = 20000` / `Qtn = 13000` 是本地上下文估算常量（`Wtn` 给输出预留封顶 20k；`dTt = ix − Qtn` 作压缩阈值），**不是**请求体的 maxTokens
- 使用率 ≥90% critical、≥75% warn（`ukr`）
- `/context` 显示明细，`/compact` 手动压缩

## 6. Persona（`nIt`）

| | Saffron（默认） | Quill |
|---|---|---|
| 定位 | "workspace operator"，直接、干燥、结论先行 | "writing companion"，温暖、文人气质 |
| 身份提示词 | `tIt`（~3KB：先给发现、不表演热情、严肃时收起俏皮话…） | `ple`（先读后写、尊重作者声音…） |
| 引用风格 | null | bluebook（法律引用） |
| 偏好工作流 | ap_operator_suite、gl_reconcile、statement_audit、meeting_prep | — |

两者共享 `XCt` 能力声明段（shell/文件/沙箱/浏览器/邮件/日历等能力自述）。

## 7. Agent 编排

- **主循环**：`toolLoop` —— 迭代调 `model-call`，SSE 增量渲染，tool_use → 本地执行 → 结果回传 → 循环；`PERCH_DUMP_MODEL_PAYLOAD=1` 可 dump 每轮 payload 到 `.perch/debug/model-payloads/<runId>-iter-<n>.json`
- **多 agent**：`spawn_worker/batch`（fan-out，受 `PERCH_MAX_AGENTS_PER_TURN`、agent pool 并发限制）、`dispatch_agent`（按 roleId 派发）、`flock`（实验性多 agent 模式，计划端点 `/api/perch-terminal/flock-plan`，轨迹写 flock-trace.log）
- **delegate**：后台委派任务，状态落 Supabase `perch_delegated_runs` 表（delegate_id 主键，含 parent/child thread、proposed_changes、tool_trace），CLI 用 `check_delegate` 轮询
- **managed playbook**：结构化子代理（受限 allowedTools + maxIterations 3~20 + outputSchema JSON 校验），如发票抽取、异常聚类、图表生成
- **中断**：Esc/Ctrl-C → AbortController 链；`run_in_background` 任务可跨 turn 用 mailbox/wake 恢复（`drainReconciledWakes`：「finished while you were gone」）

## 8. AP 审计子系统（`perch test ap`）

纯本地财务审计流水线（不经模型）：

1. **扫描**（`h2e`）：遍历目录，按文件名正则分类角色（`OYr`）：invoice/po/payment_log/bank_ledger/vendor_master/ap_aging/supplier_catalog/receipt_ocr/shipping_inventory；敏感文件（.env/.pem/credential 等）标记 `secret_sensitive` 跳过
2. **解析**（`v2e`）：CSV/JSON/txt → 记录（vendorKey/invoiceKey/amount/recordType 归一化键）
3. **规则引擎**（`c=k2e`→`S2e/P2e/O2e`）：重复付款（`T2e`：recordType|vendor|invoice|amount 分组，recoverableExposure = 总额−单笔最大）、三单匹配（PO-收据-发票）、金额差异、审批超标、多跳网络风险（networkx 风格图分析）等
4. **案例生成**（`SEt`）：按 `xEt` 评分排序 = severity(400/300/200/100) + log10(敞口)×42(≤250) + confidence×60
5. **产物**（`YEe/u2e`）：@napi-rs/canvas 画 aging_buckets.png、duplicate_candidates.png、network_risk.png；生成 HTML 报告与 JSON packet 到 `<dir>/perch-artifacts/audit-packets/<timestamp>/`
6. `--expect key=value` 断言（`Kuo` 支持 true/false/null/数字/字符串）；`--profile financial-lab-v2` 切换测试基准；指标含 invoicesParsed/Total、duplicateRecoverableExposure、noGrExposure 等

## 9. 网络端点全景（`/api/perch-terminal/*`，25 个）

cli-auth/config、cli-context、cli-learning（对话原文回传，训练采样）、cli-turn、model-call(/route)、turn-ticket、usage(-meter)、public-model-default、byo/credentials(/test)、action-review、deep-research、document-extract、embeddings、flock-plan、knowledge/search、market-desk/tool、message-attachments、verify(/route)、web-research、writing-studio/run。

Supabase 表（34 张，RLS 下用户自己的行）：perch_ai_{threads,messages,chat_*,tool_calls,inference_usage,inference_model_rates,token_calculations,token_rate_cards,usage_raw_events,permanent_memories,source_*,retrieval_chunks,extraction_*,artifacts,reports,market_*,sandbox_executions,workflow_runs,runtime_settings,provider_oauth_tokens,workspaces,product_audit_events,correction_events,workbook_profiles} + perch_delegated_runs。

`/usage`：优先查 `perch_ai_inference_usage` 表（按 runIds），CLI 走 `/usage` 端点；成本单价来自 `inference_model_rates`/`token_rate_cards`，本地只做展示格式化（`b3()` = `$x.xx`）。

## 10. TUI 细节

- **粘贴折叠**：≥800 字符或 ≥6 行（`xSr/kSr`）折成 `[Pasted text #N · X lines]`，发送时展开
- **历史**：500 条上限、8000 字符截断、原子写（tmp+rename）、Ctrl-R 搜索
- **OSC 8 超链接**（`qft`）：白名单 TERM_PROGRAM ∈ {iTerm.app, WezTerm, vscode, ghostty, WarpTerminal} ∪ KITTY_WINDOW_ID/xterm-kitty ∪ WT_SESSION ∪ VTE≥5000；tmux/STY/CI/dumb 一律关
- **配色**（`Wr`）：patina 绿 #2F5E43、bronze #9A5228、brick #CF6A52、graphite #0F0D0B、cream #FFF8F0；语法高亮主题 `iMr`（注释 #7A6F66、关键字 #D98A55、字符串 #B7C989）
- **光标**：`PERCH_CLI_NATIVE_CURSOR=0` 回退块光标；kitty keyboard protocol 可关
- Git 归因（`woe`）：默认给 commit/PR 加 `Co-authored-by: Perch <agent@perchai.app>`（可 `PERCH_GIT_ATTRIBUTION=off` 关）与 `Made-with: Perch`

## 11. 遥测

PostHog（us.i.posthog.com/i/v0/e/），事件仅 4 个：cli_first_run、cli_session_started、message_sent、first_message。distinct_id = machine-id（与账号无关联）。**本构建 api_key 为空串，上报实际停用**。退出：CI/PERCH_NO_TELEMETRY/DO_NOT_TRACK。
对话内容回传走 `cli-learning`（登录态 API，非匿名遥测）。

## 12. 值得注意的设计点

1. **hosted 代理 vs BYO 直连**：只有 hosted 轮次经服务端代理（`model-call`）；BYO/BYOK 轮次由客户端直连厂商（`zS()`→`TB()`→`sPt()`→`UDt()`），Perch 不参与推理——本地 `byo-local.json` 明文存 BYOLM 本地端点 key
   > 实测修正：原「即使 BYOK 也由服务端代调」的说法与代码/实测不符，BYO 轮次根本不发 `model-call`。
2. **turn-ticket 是核心计费闸门**：每轮推理前必须领票，服务端可精确限流/计量
3. **沙箱是黑名单制**：静态 token 扫描（Python 禁 importlib/__import__ 等），非系统级隔离；networkPolicy 可配
4. **AP 审计完全离线**：规则引擎在本地，不调模型，产物含图表/HTML/JSON
5. **能力分层的工具面**：同一 CLI 面向个人（文件/bash）和企业（AP 审计、GL 对账、Google Workspace、市场回测）场景

## 13. Token 能力边界（实测，2026-10-13）

用真实会话 token 对 25 个端点做了完整探测，脚本见 [probe_capabilities.py](./probe_capabilities.py)。

### 13.1 端点认证矩阵（实测结果）

| 端点 | 结果 | 含义 |
|---|---|---|
| `GET public-model-default` | **200** | 公开，无需 token；返回服务端默认模型选择 |
| `POST embeddings` | **200** | 需 token，**直接可用**（返回 1536 维向量） |
| `POST cli-context` | 403 `workspace_required` | token 有效，缺 workspace |
| `POST cli-learning` | 403 `workspace_required` | 同上 |
| `POST usage` | 403 `workspace_required` | 同上 |
| `POST verify` | 403 `no_workspace` | 同上 |
| `POST turn-ticket` | 401 `not_authenticated` | **额外闸门**（见 13.3） |
| `GET usage-meter` | 401 `not_authenticated` | 该 HTTP 端点仅 Web 应用使用；CLI 不走它（见下注） |
| `POST model-call` | 403 `not_authorized` | abuse gate 拒绝 |
| `POST action-review` | 401 `not_authenticated` | 同上 |
| `POST byo/credentials` | 403 `not_entitled` | 账号未开通 BYOK |
| `POST flock-plan` | 400 `Missing task or flockId` | 参数校验先于鉴权 |
| `POST market-desk/tool` | 400 `unknown_market_tool` | 同上 |

> 实测修正：CLI（Node）获取用量仪表走的是 **Supabase RPC `perch_ai_my_inference_usage_meter`**，并不调用 `GET /api/perch-terminal/usage-meter`；该 HTTP 路径只在浏览器（Web 应用）里以 cookie 会话调用，用裸 Bearer 探测返回 401 属预期，不代表 CLI 的认证失败。

### 13.2 根因：账号无 workspace

Supabase 直查（RLS 下）确认：`perch_ai_workspaces`、`perch_ai_threads`、`perch_ai_messages`、
`perch_ai_sources`、`perch_ai_artifacts`、`perch_ai_inference_usage` 等**全部返回 0 行**。

- workspace 由 **Web 应用（chat.perchai.app）** 在首次登录引导时创建
- CLI **只读不建**：`perch_ai_workspaces` 只有 `select`，客户端 `insert` 被 RLS 拒绝（`42501`）
- 无 `create_workspace` / `ensure_workspace` 等 RPC（PGRST202）
- 无 `/api/perch-terminal/workspace*` 引导端点（404）

### 13.3 关键对照实验：官方 token 同样被拒

从 macOS Keychain 取出**官方 perch CLI 自己的会话**，刷新后测试：

| 端点 | 官方 token（有效） | 我们的 token（有效） |
|---|---|---|
| `turn-ticket` | 401 `not_authenticated` | 401 `not_authenticated` |
| `cli-context` | 403 `workspace_required` | 403 `workspace_required` |
| `model-call` | 403 `not_authorized` | 403 `not_authorized` |

**结论：这不是复刻实现的问题**——官方 CLI 的 token 表现完全一致。两个 token 的 JWT 声明逐字段相同
（同 `sub`、同 `appUrl`、同 `signup_source:cli`、同长度 1403），唯一差别是 `session_id`。

另用**已过期**的官方 token 做对照：`cli-context` 从 `workspace_required` 变为 `unauthorized`，
证明该端点确实校验 token 有效性——即我们的 token 是**被认可的**，卡点纯粹在 workspace。

### 13.4 内嵌开发文档揭示的机制

bundle 里内嵌了 15 篇开发者知识库（`concept:"..."`），其中三篇直接相关：

**`abuse-gate`**（turn ticket / 访问闸门）
> Hosted-model access is gated by a per-turn ticket plus a bearer/User-Agent check. BYOK/BYO turns are exempt.
> - 服务端 `model-call/route.ts` 校验 ticket + bearer/UA
> - 历史 bug 根因：「auth-header env-fallback the UA header did not share」（compaction/vision lane）
> - 不变量：**Never allowlist on User-Agent**；BYOK/BYO 轮次豁免此闸门

**`model-routing`**（模型路由）
> - 默认走 Roost 自动路由，手动 pin 由**服务端强制**
> - 验证实际运行的模型要用 `POST /api/perch-terminal/usage` → `summary.modelBreakdown`
> - **陷阱**：`result.contextSnapshot.modelId` 不是实际运行的模型（那是 auto-router/上下文预算模型）
> - 手动 pin 需要**同时**提供 selection override 和 `manualModelOptionId`，否则服务端重新路由

**`usage-billing`**（计量计费）
> - 每轮 spend 在 hosted 调用前计量并限流；滚动窗口分 Starter/Manual/Roost 三档
> - 限流按 **BILLED tokens** 计（非原始 token）；promo pin 排除以避免双重计费
> - 费率存在**两处**必须一致：`FALLBACK_RATES`（inferenceCost.ts，计费权威）与 `perch_ai_inference_model_rates` 表
> - 已知缺陷：强制路径用未分页的 PostgREST select（可能被 max-rows 截断），显示路径用 SQL 聚合，两者可能不一致

### 13.5 如何真正解锁 hosted 模型

```sh
# 1. 用同一账号访问 Web 应用完成引导（创建 workspace）
open https://chat.perchai.app

# 2. 回到 CLI 用官方命令验证
perch status
#    （原文建议的 python3 probe_capabilities.py --models 属主动探测，已被
#     RESEARCH_PROTOCOL.md 规则 5 禁止，不得再跑）
#    期望：cli-context 返回 200 且带 workspaceId

# 3. 之后 model-call 才可能通过（仍需 turn-ticket）
```

**注意**：即使有 workspace，`model-call` 仍需 turn-ticket，而 turn-ticket 的 401 在无 workspace 时
先于 workspace 检查触发。因此**必须先有 workspace**，才能判断 turn-ticket 是否还有其他要求。

### 13.6 无需 workspace 即可用的能力

| 能力 | 端点 | 说明 |
|---|---|---|
| 默认模型查询 | `GET public-model-default` | 公开，返回服务端 Roost 默认选择 |
| 文本向量化 | `POST embeddings` | 1536 维，可用于本地检索/相似度 |
| 本地全部功能 | — | 文件、bash、沙箱、AP 审计（`perch test ap`）均离线，不依赖 token |

---
*报告生成：2026-10-13 · 与 perch_login.py 复刻工程同目录*
