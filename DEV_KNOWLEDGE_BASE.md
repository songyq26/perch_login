# Perch 内嵌开发者知识库（15 篇 concept 文档全解）

> 来源：`dist/perch.mjs` 内嵌的 codemap 知识库（供 Perch 自己的 AI 助手回答"这个功能怎么改"用）
> 提取方式：纯静态分析，零网络请求
> 日期：2026-10-13

每篇文档的结构：`summary`（一句话）→ `engine`（核心文件+符号）→ `seams`（接缝）→ `invariants`（不变量/铁律）→ `decoys`（陷阱）→ `dead_zones`（死区）→ `proof`（验证脚本）。

---

## 1. `abuse-gate` — 访问闸门（debug）

**summary**：Hosted-model access is gated by a per-turn ticket plus a bearer/User-Agent check. BYOK/BYO turns are exempt.

| 项 | 内容 |
|---|---|
| engine | `runtime/turnTicketClient.ts` → `beginTicketedTurn` |
| seams | `lib/perchTerminal/turnTicket.ts`（ticket claims / surfaces / TURN_TICKET_HEADER）<br>`app/api/perch-terminal/model-call/route.ts`（服务端校验 ticket + bearer/UA）<br>`hooks/useRuntimeTurnController.ts`（每 prompt 铸票） |
| **invariants** | ① 「legit CLI blocked」的根因是 **auth-header env-fallback**（compaction/vision lane 的 UA 头不共享），**不是版本过旧**<br>② **Never allowlist on User-Agent**<br>③ 拒绝文案与错误码必须过 sanitizer<br>④ **BYOK/BYO 轮次豁免此闸门** |
| dead_zones | `docs/archive/**`、`.tmp_abuse_*` |
| proof | `scripts/turn-ticket-tests.ts` |

---

## 2. `model-routing` — 模型路由（debug）

**summary**：默认走 Roost 自动路由，手动 pin 时用精确模型。**手动 pin 由服务端强制**。

| 项 | 内容 |
|---|---|
| engine | `runtime/modelRouter.ts` → `callModelRouter` |
| entry_points | `app/api/perch-terminal/model-call/route.ts`、`runtime/toolLoop/modelIteration.ts` |
| seams | `runtime/modelRegistry.ts`（模型目录+lane+能力档案）<br>`runtime/autoRouter.ts`（每 lane 的自动池 `eligibleAutoModelsForLane`）<br>`app/api/perch-terminal/model-call/route.ts`（服务端 pin 强制，plan/entitlement 门控） |
| **invariants** | ① **验证实际运行的模型要用 `POST /api/perch-terminal/usage` → `summary.modelBreakdown`**，绝不用 `result.contextSnapshot.modelId`<br>② 手动 pin 需要**同时**提供 selection override **和** `manualModelOptionId`，否则服务端重新路由<br>③ **绝不要把路由/能力修复限定在当前 Standard/Pro Roost slot**——slot 是运行时可由管理员分配的 |
| **decoys** | `result.contextSnapshot.modelId` 是经典时间浪费陷阱：**它不是实际运行的模型** |
| proof | `scripts/provider-model-registry-wiring-tests.ts`、`scripts/model-call-auth-gate-tests.ts` |

---

## 3. `usage-billing` — 计量计费（debug）

**summary**：每轮 spend 在 hosted 调用前计量并限流。滚动 spend 分档（Starter/Manual/Roost）门控用量；usage pane 读 breakdown。

| 项 | 内容 |
|---|---|
| engine | `inference/inferenceUsageRecorder.ts` → `assertInferenceSpendAllowed` |
| seams | `inference/roostRollingSpend.ts`（每档滚动窗口）<br>`inference/inferenceCost.ts`（每模型费率行 `FALLBACK_RATES`）<br>`app/api/perch-terminal/model-call/route.ts`（调用前强制 spend allowance） |
| **invariants** | ① 限流档按 **BILLED tokens** 计（非原始 token）；**promo pin 被排除**以避免双重门控<br>② **已知缺陷**：强制路径用未分页的 PostgREST select（可能被 max-rows 截断），显示路径用 SQL 聚合——**两者可能不一致**<br>③ 费率存在**两处必须一致**：`FALLBACK_RATES`（inferenceCost.ts，计费权威）与 `perch_ai_inference_model_rates` 表 |
| proof | `scripts/metering-v2-tests.ts`、`scripts/usage-breakdown-tests.ts` |

---

## 4. `compaction` — 上下文压缩（debug）

**summary**：当一轮接近模型上下文上限时收缩消息历史：**先剪枝 browser/screenshot 载荷 → 再摘要旧轮次 → 最后丢弃最旧的**。

| 项 | 内容 |
|---|---|
| engine | `services/contextLoopCompaction.ts` → `prepareLoopMessagesForSend`（**821 行编排器**，顺序即上述三步） |
| entry_points | `toolLoop/modelIteration.ts`、`toolLoop.ts`、`liveAgentsLoop.ts` |
| seams | `contextLoopCompaction.ts`（引擎+摘要器：`summarizeMessagesForCompaction`、`pruneBrowserArtifactsInMessages`、`microcompactStaleToolResults`）<br>`services/manualContextCompaction.ts`（`/compact` 手动路径）<br>`hooks/useRuntimeContextCompaction.ts`（GUI 接缝）<br>`runtime/contextMeter.ts`（测量+高水位）<br>`runtime/contextThresholds.ts`（何时触发）<br>`runtime/contextTokenAccounting.ts`（token 数学）<br>`runtime/threadSession.ts`（持久化 `ThreadSessionSnapshot.contextCompaction`） |
| **invariants** | ① **contextMeter 是刻意的高水位（`Math.max`），不要"修"低它**<br>② 2 个 meter-accounting 测试失败是**既有的**，不是你的改动导致<br>③ `POST_COMPACT_TARGET_TOKENS` 预算在 `contextLoopCompaction.ts`，手动+自动要保持一致 |
| **decoys** | `services/autoCompact.ts` 导出 `shouldAutoCompact`/`autoCompactIfNeeded`，但**只被测试脚本 import**——改它生产环境无效。真正的决策在 `prepareLoopMessagesForSend` 里 |
| proof | `context-loop-compaction-tests.ts`、`context-meter-accounting-tests.ts`、`context-window-accounting-tests.ts` |

---

## 5. `goal-loop` — /goal 长时程自主循环（debug）

**summary**：`/goal` 把交互式 tool loop 包进自动续跑循环，实现长时程自主：反复跑 `runOperatorTurn` 直到目标达成，带循环打断和预算。

| 项 | 内容 |
|---|---|
| engine | `goal/runGoalTurn.ts` → `runGoalTurn` |
| seams | `continuation/continuationLoop.ts`（共享续跑循环，plan 执行也用）<br>`goal/goalStore.ts`（持久化 `activeGoal`，支持退出后恢复）<br>`goal/goalCommand.ts`（`parseGoalCommand`）<br>`goal/goalPrompts.ts`（续跑+哨兵提示词）<br>`threadSession.ts`（`threadSession.activeGoal`） |
| **invariants** | ① 循环靠 **suppression + budget** 打断，**移除它们会无限运行**<br>② 退出后恢复读 `threadSession.activeGoal`，清 session 状态时注意 preserve-list<br>③ 它包裹的是**交互式 toolLoop（loop #1）**，不是确定性 suite executor（loop #2） |
| proof | `scripts/goal-slash-command-tests.ts` |

---

## 6. `memory` — 三层记忆（debug）

**summary**：Perch 的三层记忆：**Supabase 持久 sidecar、`.perch` 项目文件、`PERCH.md`**。部分层自动注入上下文，部分靠工具读取。

| 项 | 内容 |
|---|---|
| engine | `memory/projectMemorySections.ts` → `buildProjectMemorySections`（组装自动注入的记忆上下文段） |
| seams | `tools/projectMemory/saveToMemory.ts`（写→Supabase 持久记忆）<br>`tools/projectMemory/writePerchManual.ts`（写→PERCH.md）<br>`tools/projectMemory/readProjectMemory.ts`（读工具）<br>`tools/projectMemory/index.ts`（注册）<br>`runtime/perchMemoryGuidance.ts`（`PERCH_MEMORY_GUIDANCE` 提示词）<br>`electron/bridge/projectMemory.ts`（桌面桥） |
| **invariants** | ① 记忆是**项目/workspace 作用域**的。声称有缺口前先确认**是哪一层**（自动注入 vs 工具读取不同）<br>② 自动注入内容来自 `buildProjectMemorySections`，**不要假设 agent 是通过工具读的** |
| **decoys** | `desktop/bridge.ts` 的 `readProjectMemory` 是桌面传输层，**不是模型调用的工具**（那个在 `toolSystem/tools/projectMemory/readProjectMemory.ts`） |
| proof | `scripts/permanent-memory-retrieval-tests.ts` |

---

## 7. `retrieval` — 检索/RAG（debug）

**summary**：为一轮组装 source/evidence 上下文段（选中的 sources、检索到的 evidence、thread evidence）——可选的云/本地检索 lane。

| 项 | 内容 |
|---|---|
| engine | `sourceContext/index.ts` → `buildContextSourceSections` |
| seams | `retrievedEvidenceSections.ts`（检索到的 evidence 块）<br>`selectedSourceSections.ts`（用户选中的 source 块）<br>`threadEvidenceSections.ts`（从近期 assistant 轮次水合的 evidence） |
| **invariants** | 检索喂给上下文段，**与三层记忆系统是分开的** |
| proof | `local-source-index-retrieval-tests.ts`、`permanent-memory-retrieval-tests.ts` |

---

## 8. `suite-executor` — 确定性 suite 执行器（debug）

**summary**：确定性 suite 路径：`multiStepExecutor`（maxSteps 10）+ `autonomousHost` work graph，跑结构化金融 playbook，带 Supabase 持久检查点。**这是 loop #2，不是交互式 tool loop**。

| 项 | 内容 |
|---|---|
| engine | `executor/multiStepExecutor.ts` → `runMultiStepExecutor` |
| seams | `autonomousHost/index.ts`（自主 host 入口）<br>`autonomousHost/workGraph.ts`（playbook 步骤的 work graph） |
| **invariants** | ① 这是确定性 suite 路径（maxSteps 10，持久检查点），**与交互式 toolLoop（loop #1，约 64 迭代，人在环）不同，不要混淆**<br>② **Suite 启动是 NL-first**：模型自己选 `propose_suite_plan`/`execute_suite_plan`。**不要加服务端短语门控去拦截消息** |
| proof | `autonomous-host-tests.ts`、`background-suite-execution-tests.ts` |

---

## 9. `personas` — 人格（debug）

**summary**：Quill 和 Saffron **只是声音**；它们共享**同一套工具/能力面**。人格改风格，**绝不改能力**。

| 项 | 内容 |
|---|---|
| engine | `personas/personaRegistry.ts` → `getPersona` |
| seams | `context/lanes/personaLane.ts`（把人格身份注入核心提示词）<br>`context/coreSystemSection.ts`（把 `persona.styleContract` **最后**追加——对回复观感的最终决定权） |
| **invariants** | ① 人格是声音不是能力。**保持 Quill/Saffron 对等——绝不用人格门控工具或能力**<br>② style contract 刻意晚/最后追加；能力/路由在其之上 |
| **decoys** | **人格导致的行为差异是 bug 不是 feature**。要在共享面修，不要按人格分叉 |
| proof | `scripts/persona-parity-tests.ts` |

---

## 10. `slash-commands` — 斜杠命令（write）

**summary**：斜杠命令是 `parse*Command` + `run*Turn` 配对，接进**共享** slash 引擎，所以 CLI 和 desktop/web 都能用。**在这里建，不要在 CLI host 里建**。

| 步骤 | 文件 | 做什么 |
|---|---|---|
| 1 | `runtime/verify/verifyCommand.ts` | `parse*Command`（输入→类型化命令）。放 `runtime/<feature>/<feature>Command.ts` |
| 2 | `runtime/verify/runVerifyTurn.ts` | `run*Turn`（把命令当一轮执行）。放 `runtime/<feature>/run<Feature>Turn.ts` |
| 3 | `runtime/commands/sharedSlashCommands.ts` | 路由它（`resolveTurnRunnerForPrompt`）——CLI+GUI 共享接缝 |
| 4 | `runtime/commands/slashCommandCatalog.ts` | 注册可见性/help/CLI picker（**parity 被强制**） |
| 5 | `scripts/perch-cli.ts` | **只**做 surface-local 接线；真正的 surface-local 命令（`/login` `/cwd` `/thread`）留这里，共享的不要 |
| 6 | `app/api/perch-terminal/verify/route.ts` | 命令需要服务端工作时才加 API 路由 |

**invariants**：① **两个接缝**：`sharedSlashCommands.ts` 负责**路由**；`slashCommandCatalog.ts` 决定**可见性**。`test:slash-menu` 强制 picker↔parser↔/help 三方一致<br>② 共享斜杠功能建在共享引擎里，**在两个 surface 都验证**；不要把行为分叉进 CLI host

---

## 11. `add-a-tool` — 加工具（write）

**summary**：加一个新 agent 工具（尤其是改文件的）。它会**扇出**到工具实现、catalog、名字枚举、schema/定义、权限策略。

| 步骤 | 文件 | 做什么 |
|---|---|---|
| 1 | `toolSystem/tools/fileSystem/applyPatch.ts` | 在 `toolSystem/tools/<area>/<tool>.ts` 实现（此文件是 apply_patch 参考实现） |
| 2 | `toolSystem/tools/fileSystem/index.ts` | 在所属 area 模块注册 |
| 3 | `toolSystem/catalog.ts` | 加进工具 catalog（**两个能力清单之一**） |
| 4 | `runtime/toolNames.ts` | 加进 `TOOL_NAMES` |
| 5 | `runtime/toolDefinitions.ts` | 加模型可见的 schema/定义（**另一个能力清单**） |
| 6 | `runtime/toolPolicy.ts` | 分类审批要求 |
| 7 | `runtime/permissions/toolPermissionPolicy.ts` | 权限策略条目 |
| 8 | `toolLoop/toolBatchExecutor.ts` | 若参与批处理则接线 |

**invariants**：① **能力清单是"两处陷阱"**：`catalog.ts` **和** `toolDefinitions.ts` 必须一致，否则工具在一个 surface 上不可见<br>② 注意 `CLI_LOCAL`/两处注册：工具可能为一个 bridge 注册了却在另一个上缺失

---

## 12. `add-a-model` — 加模型（write）

**summary**：注册新 hosted 模型为手动 pin（`/model <name>`），覆盖 Terminal/CLI/desktop surface，带定价+路由资格。**加到 WEB CHAT 是单独的 opt-in**。

| 步骤 | 文件 | 做什么 |
|---|---|---|
| 1 | `runtime/modelRegistry.ts` | 加 `OPTION_ID` 常量 → 注册进 options 数组 → 加 `FOUNDER_MODEL_OPTIONS` 条目（providerId, modelId, contextWindow, maxOutputTokens, lanes, capabilityProfile）→ 加 `MANUAL_MODEL_DISPLAY_LABELS` 条目。**这一个文件里三处** |
| 2 | `inference/inferenceCost.ts` | 加每 token 成本行。**免费 promo == $0 行（见 invariants；定时炸弹）** |
| 3 | `runtime/autoRouter.ts` | 路由资格/avoid-list 接线（`roostSlotEligible` 等） |
| 4 | `runtime/commands/modelCommand.ts` | 暴露 `/model <name>` 词汇 |
| 5 | `scripts/perch-cli.ts` | CLI 接线（小） |
| 6 | `supabase/migrations/<new-ts>_..._lineup.sql` | **新** migration 带 lineup/计费费率。**手工应用，不 bootstrap** |
| 7 | `app/.../model-switchboard/probe/route.ts` | probe 路由入口（诊断用；可选） |

**surfaces**：
- **web chat (chat.perchai.app)**：`lib/perchai/webChatManualModels.ts` —— 加名字到 `PERCHAI_WEB_MANUAL_MODEL_NAMES`（Pro 档还要 `PRO_MANUAL_MODEL_OPTION_IDS`）。**不是从 registry 自动派生的**。跳过 == 模型在 web chat 缺席（GLM commit 就跳过了）
- **BYOK/BYO**：`lib/perch-ai/byo/modelCatalog.ts` —— 只给自带密钥模型，不同路径，hosted pin 通常不碰

**invariants**：
① **`OPTION_ID` 是 SLOT 不是 build**。换到更新的 provider build **复用** id（`project_model_build_swaps`；add 不是 swap）
② **`modelRegistry.ts` 里有两个 label**：option 的 `label` **和** `MANUAL_MODEL_DISPLAY_LABELS`（composer 名）。**两个都要设，它们不同**
③ `contextWindow`/`maxOutputTokens` 必须来自 provider 文档；rebuild 会改它们。**不要抄兄弟模型**
④ **免费 promo 的 $0 inferenceCost 行是定时炸弹**。promo 结束时要翻转
⑤ **绝不要把能力标志限定到当前 Roost slot**；roost slot 是运行时可由管理员分配的（`project_model_agnostic`）
⑥ 发布前对照 **no-backend-provider-names 规则**验证用户可见的 `providerLabel`/`groupLabel`（`project_feedback_no_provider_names`）

**decoys**：
- `grep modelRegistry` == 155 文件，`founderModelSelection` == 118。**几乎全是 READER**。写集合约 7 个文件；**用 reference_commit，不要用 grep**
- 改 `webChatManualModels.ts` 期望影响 Terminal/CLI（它是 web-only），或反之

**dead_zones**：`supabase/migrations/*_lineup_*.sql`

---

## 13. `auth` — 跨主机认证（debug）

**summary**：Supabase 跨主机认证。Supabase 把错误/确认链接作为 **URL FRAGMENT** 发到 SITE_URL，服务端中间件看不到；`/auth/hash` 转发它，且 `setSession` 必须在 chat origin 上跑（cookie 是 host-only 的）。

| 项 | 内容 |
|---|---|
| engine | `lib/auth/authHashFragment.ts` → `resolveAuthHashTarget` |
| seams | `middleware.ts`（edge 中间件；**读不到 URL fragment——这是根因**）<br>`lib/supabase/middleware.ts`（`updateSession` 服务端 session 刷新）<br>`app/auth/hash/page.tsx`（客户端读 fragment 的落地页）<br>`components/auth/AuthHashForwarder.tsx`（把 fragment 转发到 chat origin）<br>`components/auth/AuthHashLanding.tsx`（渲染落地/错误文案） |
| **invariants** | ① **fragment（#...）按设计对中间件不可见；不要试图服务端读它**<br>② **`setSession` 必须在 chat origin 上跑**，因为 Supabase cookie 是 host-only 的；在别处跑会静默失败 |
| proof | `auth-hash-landing-tests.ts`、`post-auth-redirect-tests.ts` |

---

## 14. `mcp-servers` — MCP 服务器（write）

**summary**：从桌面 Connections pane 加/改/删自定义 MCP 服务器。写路径穿过 Electron bridge 的**五个接缝**。

| 步骤 | 文件 | 做什么 |
|---|---|---|
| 1 | `electron/bridge/mcp/mcpConfigWriter.ts` | 配置写入器（持久化 server 定义） |
| 2 | `electron/bridge/mcp/mcpHandlers.ts` | add/edit/remove 的 IPC handler |
| 3 | `electron/preload.ts` | 通过 contextBridge 暴露 IPC |
| 4 | `features/perchTerminal/desktop/bridge.ts` | renderer 侧 bridge 包装 |
| 5 | `components/account/AccountConnectionsPane.tsx` | Connections pane UI |

**surfaces**：remote sign-in (MCP OAuth) —— http/sse 服务器的浏览器 OAuth（commit 8418f0c8）；passive vs interactive loopback 分离；在 electron mcp bridge 里加 `mcpOAuth`

**invariants**：① **5 接缝写路径**：writer → IPC → preload → renderer bridge → pane。**漏一个功能就半残**<br>② **内置服务器（playwright、courtlistener）是锁定的**；注意内置 re-merge 别让自定义写入覆盖它们

---

## 15. `browser-operator` — 浏览器操作员（debug）

**summary**：浏览器操作员驱动**内嵌的 Electron BrowserView**。Semantic → CUA 升级**已实现**。Console/network 捕获**已发布**。**缺口是生产使用量约等于零，不是正确性**。

| 项 | 内容 |
|---|---|
| engine | `browserOperator/taskRunner.ts` → `runBrowserExecuteTask` |
| seams | `browserOperator/actionPolicy.ts`（允许什么动作）<br>`browserOperator/observation.ts`（DOM/截图观察）<br>`browserOperator/taskVerification.ts`（验证动作落地）<br>`runtime/toolNames.ts`（`BROWSER_OPERATOR_TOOL_NAMES`）<br>`runtime/liveAgentsLoop.ts`（当轮次含浏览器工具时附加操作员截图） |
| **invariants** | ① 后端是**内嵌 Electron BrowserView**；假设后端前先查 `BROWSER_BACKEND`<br>② **Semantic → CUA 升级已实现；不要描述成缺失/有 bug** |
| proof | `browser-operator-action-policy-tests.ts`、`browser-operator-observation-tests.ts` |

---

## 附：知识库的检索机制

这些文档不是随便塞进去的——bundle 里有完整的**检索器**：

```js
// son() 函数：按 concept 名 + aliases 做加权匹配
// 评分：词长优先（score），命中数次之（hits），最后按 concept 名排序
function son(e, t = bBe) {
  // e = 用户查询，t = 知识库条目数组
  // 返回最佳匹配条目
}
```

**匹配规则**：
- 查询与 `concept` 名（连字符转空格）+ `aliases` 做匹配
- 单词长度 < `ion` 阈值的单字忽略
- 评分 = 最长匹配词长；平局看命中数；再平局按名字典序

**渲染**（`uon` 函数）：
- `kind:"write"` → 输出「Edit, in order:」步骤列表 + 「Extra surfaces」
- `kind:"debug"` → 输出「Engine: file → symbol」+ entry_points + seams + invariants + decoys + dead_zones + proof

**这意味着**：Perch 的 AI 助手在回答「怎么加模型/加工具/为什么被限流」这类问题时，会**自动检索这些文档**并注入上下文。所以这些文档是**权威的、维护中的**内部知识。

---

*提取完成：2026-10-13 · 纯静态分析，零网络请求*
