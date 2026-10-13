# Perch 深度逆向：5 项核心机制

> 来源：`dist/perch.mjs` 静态逆向，零网络请求
> 日期：2026-10-13
> 前置：本文档是 [REQUEST_FORMAT_SPEC.md](./REQUEST_FORMAT_SPEC.md) 的补充

---

## 1. System Prompt 组装链

### 1.1 组装函数（`gRt`）

```js
function gRt(env) {   // env = "web" | "terminal"
  let surfaceBlock = env === "web"
    ? `### What this web chat can do\n\n${Knn()}`
    : `### What Perch Terminal can do\n\n${Ynn()}`;

  let skillHint = env === "terminal"
    ? `\nFor deep detail on Perch (per-tier specifics, full workflow matrix, FAQ),
       consult the "about-perch" skill when a question goes beyond the facts above.`
    : "";

  return [
    Jnn,        // 产品事实权威参考（830 字符）
    "",
    oon(env),   // 验证契约（~1.5KB）
    "",
    Xnn,        // Perch 是什么（1127 字符）
    "",
    Znn,        // 访问与定价（1707 字符）
    "",
    eon(env),   // 环境相关段
    "",
    ton,        // API 与集成（1346 字符）
    "",
    ron,        // Cloud agents（1488 字符）
    "",
    non(),      // 手机端说明
    "",
    surfaceBlock,
    skillHint,
  ].join("\n").trim();
}
```

### 1.2 各段落内容

| 变量 | 标题 | 长度 | 核心内容 |
|---|---|---|---|
| `Jnn` | Perch product facts | 830 | 「只从以下事实回答；不确定就说不确定；绝不编造能力/URL/端点/模型名」 |
| `oon(env)` | **Verification contract** | ~1.5K | 5 条铁律（见 §1.3） |
| `Xnn` | What Perch is | 1127 | 三个 surface 介绍（Web / Desktop / CLI） |
| `Znn` | Access and pricing | 1707 | Starter 20,000 PT / Pro $10 75,000 PT / BYO / Enterprise |
| `eon(env)` | （环境相关） | — | 按 web/terminal 分支 |
| `ton` | **API and integrations** | 1346 | **明确禁止脚本调用**（见 §1.4） |
| `ron` | Cloud agents (beta) | 1488 | 云 agent 与远程控制说明 |
| `non()` | Perch on a phone | — | 手机浏览器用法（无 App Store 应用） |
| `Knn()` | Web chat 能力 | — | 数组形式，逐条列出 |
| `Ynn()` | Terminal 能力 | — | 数组形式，逐条列出 |

### 1.3 验证契约（`oon`）—— 5 条铁律

```
1. Source–claim match. 每个引用必须直接支持它所附着的论断。
   NEVER attach a source to a claim it does not actually state.
   "source laundering" 是这里最严重的失败，比不给引用更糟。

2. Never state a current fact from memory. 对时效性内容
   （事件状态、案件、裁决、交易、价格、职位、已发布内容、
   "latest/current/as of now/this week"）不得凭记忆断言。
   [web] 唯一有效来源是本轮的 [W#] 和 [R#] 证据块
   [terminal] 唯一有效来源是本轮实际检索到的证据

3. No invented specifics. 绝不编造日期、金额、案号、姓名、
   统计数字、引文或引用。不在证据里的就省略或标 [unverified]。

4. Keep related-but-distinct things distinct. 两个可能混淆的
   事物（两个案件、两个版本、两个人、两个裁决）不得焊接事实。

5. Separate verified from unverified. 区分可引用事实 / 合理推断
   （要标注）/ 未知。不要用自信的叙述抹平缺口。
```

### 1.4 API 政策段（`ton`）—— 封号依据

```
Perch does not currently offer a public REST API or an OpenAI-compatible API
endpoint, and there is no api.perchai.app. Never tell a user they can call Perch
from their own code, point an OpenAI client at Perch, or integrate Perch as an API.

Perch's internal application endpoints are not a public API, and direct API
access is not included unless a plan or written agreement expressly says otherwise.

Perch credits cannot be transferred into or spent through Claude Code, ChatGPT,
or any other third-party client; users who want a terminal-only experience use
the Perch CLI itself.
```

**MCP 部分**：
```
Perch DOES support MCP. Perch Terminal acts as an MCP client — you connect MCP
servers and their tools become available to the operator (as mcp__<server>__<tool>).
两个限制：
- web chat 本身不用 MCP（MCP 只在 Perch Terminal）
- Perch 不作为 MCP server，不暴露 MCP 端点给其他客户端消费
```

---

## 2. 工具调用完整协议

### 2.1 消息序列（OpenAI 兼容格式）

```js
// 1) assistant 发起工具调用
{
  role: "assistant",
  content: "",
  tool_calls: [{
    id: toolCallId,
    type: "function",
    function: {
      name: toolName,
      arguments: JSON.stringify(input)   // 注意：字符串化的 JSON
    }
  }]
}

// 2) tool 返回结果
{
  role: "tool",
  content: result,          // 成功时原样，失败时经 KTt() 格式化
  tool_call_id: toolCallId
}

// 3) 可选：assistant 的后续文本
{ role: "assistant", content: text }
```

**构造代码**（`z9t`）：
```js
function z9t(messages, toolCalls, finalText) {
  let out = [...messages];
  for (let tc of toolCalls) {
    out.push({
      role: "assistant", content: "",
      tool_calls: [{ id: tc.toolCallId, type: "function",
                     function: { name: tc.toolName, arguments: JSON.stringify(tc.input) } }],
    });
    out.push({ role: "tool", content: tc.result, tool_call_id: tc.toolCallId });
  }
  if (finalText.trim().length > 0) out.push({ role: "assistant", content: finalText });
  return out;
}
```

### 2.2 工具结果大小限制

| 常量 | 值 | 含义 |
|---|---|---|
| `SZr` | 2000 | `maxToolResultChars` 默认 |
| `EZr` | 6000 | `maxToolArgumentChars` 默认 |
| `CZr` | 1000 | `maxToolArgumentPreviewChars` 默认 |
| `PCt` | 48 | `maxTotalTextChars` 乘数 |
| `NDe` | 6000 | 总文本上限基数 |
| `BCt` | 4 | — |
| `IZr` | 0.65 | 压缩比例 |

**范围限定**：`maxToolResultChars: 2000`（`SZr`）属于 **worker 通道**的限制；主对话（model-call）实测未见该截断（见 MODEL_CALL_DECODED.md §九）。

**截断函数**：
```js
function yw(s, limit) {
  let r = (s ?? "").toString();
  return r.length <= limit ? r : `${r.slice(0, Math.max(0, limit - 16))} [truncated]`;
}
function H7(s, limit = NDe) {
  return s.length > limit ? `${s.slice(0, limit)}...[truncated]` : s;
}
```

### 2.3 审批暂停机制

```js
// 工具需要审批时，返回 approval_paused 状态
{
  status: "approval_paused",
  pendingCalls: [call],
  text: contentTextAccumulated || resultText,
  provider: lastProvider,
  pendingApproval: {
    toolCallId: call.id,
    toolName: call.toolName,
    input: call.input,
    reason: reason
  }
}
```

### 2.4 工具调用事件（本地事件流）

```js
{ type: "tool_call_requested", toolName, toolCallId, input, ts }
{ type: "tool_call_started", ... }
{ type: "tool_call_completed", ... }
{ type: "tool_call_failed", ... }
{ type: "tool_result", toolName, toolUseId, text, seq, timestamp }
{ type: "tool_output_delta", text, toolCallId }
```

### 2.5 自动路由失败处理

```js
// 连续参数失败 2 次 → 加入 avoidModelIds
if (consecutiveArgFailureCount >= 2) { ... }

// 自动路由跳转失败 → 把该模型加入 avoid 列表
function cje(e) {
  return !e.autoRouterActive || !e.lastAutoHopModelId
    || (e.executionOk && e.consecutiveArgFailureCount < 2)
    ? false
    : (e.avoidModelIds.add(e.lastAutoHopModelId), !qce(e.lane, e.avoidModelIds));
}
```

---

## 3. SSE 流事件类型

### 3.1 `model-call` 的 9 种事件（Perch 自有协议）

| 事件 | 字段 | 含义 |
|---|---|---|
| `answer_delta` | `text` | 正文增量 |
| `reasoning_delta` | `text` | 推理增量 |
| `tool_call_delta` | `toolCalls[]` | 工具调用增量 |
| `tool_use_end` | `toolCalls[]` | 工具调用结束 |
| `stream_restart` | `reason` | 流重启（`mid_tool_call_failover`） |
| `continuation_seam` | `at` | 续接缝（数字位置） |
| `model_call_failed` | `provider`, `modelId`, `lane`, `error`, `errorCategory` | 模型调用失败 |
| `done` | `ok`, `text`, `toolCalls`, `provider`, `model`, `durationMs`, `usage`, `debug` | 完成 |
| `error` | `message` | 流错误 |

**解析代码**：
```js
let lines = buffer.split("\n");
buffer = lines.pop() ?? "";
for (let line of lines) {
  if (!line.startsWith("data:")) continue;
  let evt = Lun(line.slice(5).trim());   // JSON.parse
  if (!evt) continue;
  switch (evt.type) {
    case "answer_delta": ...
    case "reasoning_delta": ...
    case "stream_restart": ...
    case "continuation_seam": ...
    case "tool_call_delta":
    case "tool_use_end": ...
    case "model_call_failed": ...
    case "done": ...
    case "error": ...
  }
}
```

### 3.2 第三方 provider 的流格式（OpenAI Responses API）

当直连 provider（BYOK）时，用 OpenAI Responses API 事件：

| 事件 | 含义 |
|---|---|
| `response.output_text.delta` | 正文增量（`delta` 字段） |
| `response.reasoning_summary_text.delta` | 推理摘要增量 |
| `response.reasoning_text.delta` | 推理正文增量 |
| `response.output_text.done` | 正文完成（`text` 字段） |
| `response.output_item.added` | 输出项添加（工具调用开始） |
| `response.output_item.done` | 输出项完成（工具调用结束） |
| `response.failed` | 响应失败 |
| `response.completed` | 响应完成 |
| `response.incomplete` | 响应不完整 |

**注意**：第三方流用 `event:` + `data:` 双行格式，且有 `[DONE]` 终止标记；Perch 自有协议只用 `data:` 单行。

### 3.3 其他流式端点

| 端点 | 格式 |
|---|---|
| `model-call` | Perch 自有（9 种事件） |
| BYOK 直连 | OpenAI Responses API |
| `flock-plan` | 非流式（JSON） |
| `cli-turn` | 非流式（遥测） |

---

## 4. `cli-turn` 端点（遥测）

### 4.1 性质

**这是轮次遥测端点**，不是推理端点。日志前缀 `[cli-turn-telemetry]`。

### 4.2 请求规范

```js
POST {appUrl}/api/perch-terminal/cli-turn
Headers: {
  "content-type": "application/json",
  authorization: `Bearer ${accessToken}`
}
Timeout: 12 秒
Body: {
  prompt,              // 用户输入
  assistantText,       // 助手回复
  threadId,
  runId,               // 或 null
  chatMode,
  personaId,           // 或 null
  status,              // "completed" | "failed" | "cancelled" | "partial" | "blocked"
  durationMs,          // 或 null
  error,               // 或 null
  events,              // 事件数组
  contextSnapshot,
  systemInitiated,     // boolean
  attachments          // 附件数组
}
```

### 4.3 状态映射

```js
status = t.status === "failed"            ? "failed"
       : t.status === "cancelled"         ? "cancelled"
       : t.status === "incomplete"        ? "partial"
       : t.status === "approval_required" ? "blocked"
       : "completed";
```

### 4.4 节流机制

```js
// Mmr() —— 20 秒节流
function Mmr(getPayload) {
  let stopped = false, pending = Promise.resolve(), lastAt = Date.now();
  return {
    notify: () => {
      if (stopped) return;
      let now = Date.now();
      if (now - lastAt < 20000) return;   // ceo = 2e4
      let payload = getPayload();
      if (payload) { lastAt = now; pending = Pet({ ...payload, status: "streaming" }); }
    },
    stop: async () => { stopped = true; await pending.catch(() => {}); },
  };
}
```

**关键**：流式过程中每 20 秒上报一次 `status: "streaming"`，结束时上报最终状态。

### 4.5 前置条件

```js
if (!e.userId || !e.workspaceId) return;   // 必须有 workspace
```

**这解释了为什么之前 `cli-turn` 返回 `workspace_required`**。

---

## 5. `perch_ai_*` 表 Schema（34 张）

### 5.1 核心业务表

| 表 | 字段（从代码推断） |
|---|---|
| `perch_ai_workspaces` | `id`, `name`, `learning_consent`, `created_at` |
| `perch_ai_threads` | `id`, `workspace_id`, `title` |
| `perch_ai_messages` | `thread_id`, `role`, `content`, `content_json`, `created_at` |
| `perch_ai_chat_threads` | （chat 专用线程） |
| `perch_ai_chat_messages` | `workspace_id`, `thread_id`, `role`, `mode`, `content`, `content_json`, `source_ids`, `artifact_ids`, `workflow_run_id` |

### 5.2 源与检索

| 表 | 字段 |
|---|---|
| `perch_ai_sources` | `id`, `file_name`, `file_type`, `mime_type`, `size_bytes`, `storage_path`, `source_kind`, `content_hash`, `metadata`, `created_at`, `updated_at` |
| `perch_ai_source_chunks` | `id`, `source_id`, `chunk_index`, `chunk_kind`, `title`, `content`, `token_estimate` |
| `perch_ai_retrieval_chunks` | `*`（含 `contextual_chunk_text`） |
| `perch_ai_source_memory` | `id`, `source_id`, `memory_kind`, `status`, `title`, `body`, `payload`, `confidence`, `updated_at` |
| `perch_ai_extraction_runs` | `id`, `source_id`, `file_name`, `file_type`, `document_type`, `status`, `confidence`, `summary`, `payload`, `warnings`, `created_at`, `completed_at` |
| `perch_ai_extraction_chunks` | `id`, `extraction_run_id`, `source_id`, `chunk_kind`, `title`, `content`, `metadata`, `token_estimate`, `created_at` |
| `perch_ai_workbook_profiles` | `id`, `source_id`, `workbook_id`, `profile`, `created_at` |

### 5.3 记忆

| 表 | 字段 |
|---|---|
| `perch_ai_permanent_memories` | `id`, `user_id`, `workspace_id`, `scope`, `type`, `title`, `body`, `source_kind`, `confidence` |

### 5.4 计费与用量

| 表 | 字段 |
|---|---|
| `perch_ai_inference_usage` | `user_id`, `workspace_id`, `run_id`, `created_at`, ... |
| `perch_ai_inference_model_rates` | `model_option_id`, `provider_id`, `model_id`, `label`, `input_usd_per_1k`, `output_usd_per_1k`, `cached_input_usd_per_1k` |
| `perch_ai_token_calculations` | `*` |
| `perch_ai_token_rate_cards` | `*` |
| `perch_ai_usage_raw_events` | `*` |

### 5.5 执行与产物

| 表 | 字段 |
|---|---|
| `perch_ai_tool_calls` | `workspace_id`, `thread_id`, `workflow_run_id`, `tool_name`, `tool_kind`, `status`, `input`, `output`, `output_summary`, `evidence` |
| `perch_ai_sandbox_executions` | `workspace_id`, `thread_id`, `user_id`, `tool_call_id`, `run_id`, `language`, `code`, `stdout`, `stderr`, `exit_code`, `status`, `duration_ms`, `produced_files`, `report_json`, `finding_ids` |
| `perch_ai_artifacts` | `workspace_id`, `created_by`, `workflow_run_id`, `kind`, `title`, `status`, `source_file_name`, `payload` |
| `perch_ai_reports` | `workspace_id`, `created_by`, `artifact_id`, `thread_id`, `report_kind`, `title`, `storage_path`, `source_ids`, `metadata` |
| `perch_ai_workflow_runs` | `workspace_id`, `created_by`, `kind`, `status`, `title` |
| `perch_ai_context_snapshots` | （上下文快照） |
| `perch_ai_correction_events` | `workspace_id`, `user_id`, `vertical`, `task_ref`, `surface`, `input_ref`, `input_snapshot`, ... |
| `perch_ai_product_audit_events` | `workspace_id`, `user_id`, `event_type`, `entity_type`, `entity_id`, `details` |
| `perch_ai_runtime_settings` | `value_json`, `updated_at`, `updated_by` |
| `perch_ai_provider_oauth_tokens` | `token_json` |
| `perch_delegated_runs` | `delegate_id`, `parent_thread_id`, `child_thread_id`, `run_id`, `task`, `status`, `review_status`, `result_summary`, `artifacts`, `proposed_changes`, `error`, `created_at`, `completed_at`, `duration_ms`, `user_id`, `workspace_id`, `tool_trace` |

### 5.6 市场数据

| 表 | 字段 |
|---|---|
| `perch_ai_market_instruments` | `ticker`, `name`, `sector`, `currency`, `active`, `delisted_at` |
| `perch_ai_market_bars` | `bar_date`, `open`, `high`, `low`, `close`, `adj_close`, `volume`, `known_at`, `source` |
| `perch_ai_market_fundamentals` | `ticker`, `metric`, `value`, `as_of`, `known_at`, `source` |
| `perch_ai_market_signals` | `id`, `strategy_id`, `strategy_version`, `config_hash`, `engine_version`, `ticker`, `action`, `strength`, `score`, `horizon_days`, `as_of`, `provenance`, `signal_hash` |
| `perch_ai_market_backtest_runs` | （回测运行） |

### 5.7 关键设计观察

1. **`known_at` 字段**（`market_bars`/`market_fundamentals`）：**时点正确性**设计——防止用未来数据回测（look-ahead bias）
2. **`content_hash`**（`sources`）：去重
3. **`token_estimate`**（chunks）：避免每次重新计算 token
4. **`learning_consent`**（`workspaces`）：训练数据同意开关
5. **`signal_hash`**（`market_signals`）：信号去重/幂等
6. **`config_hash` + `engine_version`**（`market_signals`）：可复现性

---

## 附：本轮逆向的完整符号表

| 混淆名 | 语义 |
|---|---|
| `gRt` | system prompt 组装 |
| `oon` | 验证契约 |
| `Jnn`/`Xnn`/`Znn`/`ton`/`ron`/`non` | prompt 段落 |
| `Knn`/`Ynn` | surface 能力列表 |
| `z9t` | 工具调用消息构造 |
| `yw`/`H7` | 截断函数 |
| `SZr`/`EZr`/`CZr`/`PCt`/`NDe` | 大小限制常量 |
| `Lun` | SSE 事件解析 |
| `Pet` | cli-turn 上报 |
| `kgr` | cli-turn payload 构造 |
| `Mmr` | 20 秒节流器 |
| `cje` | 自动路由失败处理 |
| `Dun` | 重试包装 |
| `Tun`/`Run` | 401 session 同步 |
| `$Me` | 指数退避 |
| `Pun`/`Mun` | 可重试判定 |
| `_ot` | 通用 POST 助手 |
| `sBt`/`OL` | Authorization / User-Agent 构造 |
| `aue` | ticket header 构造 |
| `vun`/`bun`/`wun`/`kun` | 条件字段构造 |

---

*文档生成：2026-10-13 · 纯静态逆向，零网络请求*
