# Perch CLI 集成补充调研（5 项技术细节）

> 场景：单用户/内部使用，通过官方 CLI 编排
> 证据：`dist/perch.mjs` 逆向 + 本地 thread 文件实测
> 日期：2026-10-13
> 前置：[INTEGRATION_GUIDE.md](./INTEGRATION_GUIDE.md)

---

## 1. thread 文件 schema（本地实测）

**路径**：`~/.perch/threads/<scopeHash>/<threadId>.json`
- `scopeHash`（登录态）= `user-` + `sha256("app:"+appUrl+"|user:"+userId+"|email:"+email+"|token:"+<sha256(token)[:20]>)[:20]`；未登录 = `anon-` + `sha256("app:"+appUrl+"|anonymous")[:20]`
- **实测修正**（对照 `dist/perch.mjs` 的 `Jkr()`）：原写的 `sha256(appUrl|userId|email|token)` 不准确——真实串带 `app:`/`user:`/`email:`/`token:` 标签，且 token 取的是它的 `sha256[:20]`。关键在 **token 只在 userId 与 email 同时缺失时**才进入串（兜底区分）；正常会话两者都存在，token 每小时轮换**不会**改变 `~/.perch/threads/` 下的目录名。
- 该值再由 `Xkr()` 把非 `[A-Za-z0-9_.-]` 字符替换为 `_` 并截断 96 字符，作为实际目录名（本例全为合法字符，故原样保留）。
- `threadId` = `cli-cwd-<hash(cwd)>`（同目录共享）

**顶层结构**：

```json
{
  "version": 1,
  "threadId": "cli-cwd-b50b283234c574ef",
  "recentMessages": [ ... ],      // 12 项（UI 展示用）
  "contextSnapshot": { ... },     // 42 键（上下文构成）
  "threadSession": { ... },       // 25 键（会话状态）
  "updatedAt": "2026-10-13T09:35:07.212Z"
}
```

### 1.1 `recentMessages`（UI 消息）

```json
{
  "id": "...",
  "kind": "text",
  "role": "user" | "assistant",
  "text": "Reply with exactly: PONG",
  "createdAt": "..."
}
```

### 1.2 `threadSession`（25 键，会话状态）

| 键 | 类型 | 说明 |
|---|---|---|
| `threadId` | string | |
| `personaId` | string | `saffron`/`quill` |
| `lastObjective` | string | 最近目标 |
| `lastWorkflowStatus` | string | `completed` 等 |
| `lastToolSummary` | null/obj | |
| `threadEvidence` | array | 证据块 |
| **`threadLedger`** | array | **完整操作账本（见下）** |
| **`threadWireMessages`** | array | **实际发给服务端的消息** |
| `workflowHints` | null | |
| `updatedAt` | string | |
| `pendingSuitePlan` / `pendingForcedRouting` / `lastSuitePlanId` / `lastSuiteExecutionStatus` | null | suite 状态 |
| `notificationQueue` | array | 通知队列 |
| `pendingActions` / `pendingApproval` | null | **审批状态（集成需关注）** |
| `contextCompaction` | null | 压缩状态 |
| `contextMetrics` | object | 23 键（token 统计） |
| `planModeState` / `pendingGeneralPlan` / `approvedGeneralPlan` | null | 计划模式 |
| `activeGoal` / `activeResearch` / `activeSkillIds` | null | 活动状态 |

### 1.3 `threadWireMessages`（**集成关键**）

这是**实际发给服务端的消息数组**（不含 system prompt）：

```json
[
  {"role": "user", "content": "Reply with exactly: PONG"},
  {"role": "user", "content": "Say PONG"},
  {"role": "user", "content": "Reply with exactly one word: PONG"},
  {"role": "assistant", "content": "PONG"},
  {"role": "user", "content": "Reply with exactly one word: PONG"}
]
```

**集成用途**：读这个文件就能知道**下一轮会发什么历史**，无需解析日志。

### 1.4 `threadLedger`（操作账本）

每项 18 个字段：

```json
{
  "id": "ledger-<runId>-user",
  "kind": "user_message" | "assistant_message" | "tool_call" | ...,
  "ts": "ISO",
  "runId": "tkt-cli-...",
  "toolCallId": null,
  "toolName": null,
  "ok": null,
  "status": null,
  "surface": null,
  "action": null,
  "title": null,
  "url": null,
  "verified": null,
  "summary": null,
  "inputPreview": null,
  "resultPreview": null,
  "error": null,
  "snapshotHead": null
}
```

**集成用途**：审计轨迹（谁在什么时候做了什么）。

### 1.5 `contextMetrics`（23 键，成本监控）

```json
{
  "threadContextTokens": 27392,
  "latestSendTokens": 27392,
  "lastApiContextTokens": 26593,
  "jobTotalTokens": 27388,
  "conversationLedgerTokens": 27335,
  "workersOffThreadTokens": 0,
  "workerUsage": [],
  "peakPackOverheadTokens": 27047,
  "messageTokens": 41,
  "laneTotals": [{"lane": "system", "tokens": 8310, "sentRaw": 1, ...}],
  "contextLimitTokens": 980000,
  "rawContextWindowTokens": 1000000
}
```

> 此样例取自 pin DeepSeek 的 1M 窗口轮次（`980000 / 1000000`）；200k 窗口默认模型为 `180000 / 200000`，两者是不同模型的预算，不是矛盾，见 [INTEGRATION_GUIDE.md](./INTEGRATION_GUIDE.md) §四。

---

## 2. `segments` 数组结构（34 种 kind）

`--json` 输出的 `segments` 是**渲染分段**（`hDe` 从 events 转换），比 `events` 更适合直接渲染 UI。

| kind | 字段 | 用途 |
|---|---|---|
| `reasoning` | text, seq, timestamp | 推理过程 |
| `final_answer` | text, seq, timestamp | **最终答案** |
| `assistant_preamble` | id, text, toolCallIds | 工具调用前的说明 |
| `tool_call` | toolName, toolUseId, input, done | 工具调用 |
| `tool_result` | toolName, toolUseId, text | 工具结果 |
| `worker_tool_call` | workerId, toolName, toolCallId, status | 子 agent 工具 |
| `sandbox_run` | toolUseId, runId, language, label, code, codeSealed | 沙箱执行 |
| `terminal_output` | run, id, command, args, cwd, executionHost, startedAt, stdout, stderr, exitCode | **终端输出** |
| `artifact` | artifact | 产物 |
| `user_question` | questionId, sessionId, header, question, options, multiSelect, surface, answered | **需用户回答** |
| `capability_required` | capabilityId, sessionId, failureKind, surface, message, accounts, path, resolved | 能力缺失 |
| `live_card_start` / `live_step` / `live_card_end` | cardId, surface, title, subtitle, status, ... | 实时卡片 |
| `workflow_card_start` / `workflow_step` / `workflow_narration` / `workflow_card_end` | cardId, runId, personaName, workflowLabel, ... | 工作流卡片 |
| `progress_item` | item, deltas, status | 进度项 |
| `context` | summary, text, estimatedInputTokens, threadContextTokens, latestSendTokens, workersOffThreadTokens | 上下文摘要 |
| `context_compacted` | tokensBefore, tokensAfter, summary | **压缩事件** |
| `activity` | text | 活动 |
| `turn_steered` | runId, mode, text, clientMessageId | 转向 |
| `diagnostic` | message | 诊断 |
| `executor_event` | label, detail, status | 执行器事件 |
| `error` | — | 错误 |
| `status` | — | 状态 |
| `brief` | — | 简报 |
| `mode_gate` | — | 模式门 |
| `plan_card` | — | 计划卡片 |
| `delegated_run` | — | 委派运行 |
| `flock_run` | — | flock 运行 |
| `file_change` | — | 文件变更 |

**集成建议**：优先渲染 `final_answer`（正文）、`tool_call`/`tool_result`（进度）、`terminal_output`（命令输出）、`user_question`（交互）、`context_compacted`（压缩提示）。

---

## 3. `--json` 下的 stdout 行为（关键）

**逆向结论**（`Kco` 函数第一行）：

```js
function Kco(e, t = {}) {
  if (t.json) return;        // ← --json 时直接返回，抑制所有进度输出
  let r = mot();
  if (!r) return;
  let n = `${r}\n`;
  t.stream === "stderr" ? e.stderr(n) : e.stdout(n);
}
```

**行为**：

| 模式 | stdout | stderr |
|---|---|---|
| `--json` | **仅最终 JSON**（`JSON.stringify(obj, null, 2)`） | 错误信息 |
| 无 `--json` | 流式进度 + 最终文本 | 错误信息 |

**集成含义**：
- `--json` 是**一次性输出**——必须等整轮结束才能拿到结果
- 要**流式**，用非 `--json` 模式读 stdout（但输出是渲染后的文本，非结构化）
- **折中方案**：`--json` 拿结构化结果 + 轮询 thread 文件的 `threadWireMessages` 看进度

---

## 4. 错误码 → `status` 映射（状态机）

`_gr` 的 `status` 来自 `turnRunner` 的返回（`NAe` 函数）：

| turnRunner 内部状态 | `status` 字段 | `ok` | 附加字段 |
|---|---|---|---|
| `complete` | `"completed"` | `true` | assistantText, messageId, runId, durationMs, toolCalls |
| `failed` | `"failed"` | `false` | error, runId, toolCalls |
| `cancelled` | `"cancelled"` | `false` | error, runId, toolCalls |
| `blocked` + approval_required | `"approval_required"` | `false` | **approvalContext**, recovery, toolCalls |
| 其他 | `"incomplete"` | `false` | reason, recovery, toolCalls |
| 异常抛出 | `"failed"` | `false` | error（异常消息） |

**`approval_required` 的 `recovery` 字段**（集成关键）：

```json
{
  "recovery": {
    "hint": "Re-run with an auto-approve permission mode, or approve the pending action.",
    "retryable": true
  }
}
```

**集成处理**：
```js
if (result.status === "approval_required") {
  // 需要审批：要么改 --permission，要么在 TUI 里批准
  console.error("需要审批:", result.approvalContext);
}
```

---

## 5. `--attach` 附件处理链

### 5.1 路径解析（`v3`）

```js
function v3(p) {
  if (p === "~") return process.env.HOME ?? p;
  if (p.startsWith("~/")) return path.join(process.env.HOME ?? "", p.slice(2));
  return path.resolve(p);
}
```

### 5.2 上传流程

```
--attach <path>
  ↓ v3() 解析路径（支持 ~ 展开）
  ↓ T({path}) 上传（yot 返回的函数）
      → POST /api/perchai/upload（12 万 ms 超时）
      → 返回 {ref: {id, ...}}
  ↓ 去重（b.some(q => q.id === ref.id)）
  ↓ 加入 messageAttachments 数组
  ↓ 随 model-call 请求发送
```

**上传端点**：`POST {appUrl}/api/perchai/upload`（注意是 `/api/perchai/` 不是 `/api/perch-terminal/`）

**集成含义**：
- 附件先上传到 Perch 存储，再以 `sourceIds` 引用
- 支持 `~` 展开和相对路径
- 同一文件重复 attach 会去重

---

## 6. 集成完整示例（Node.js）

```js
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 调用官方 perch CLI（合规：spawn 官方进程，不直连服务器）
 */
function perchRun(prompt, opts = {}) {
  const {
    cwd, threadId, model, mode = "agents", persona = "saffron",
    permission = "auto_review",   // 自动化场景必须用 auto_review 或 take_the_wheel
    effort, thinking, skills = [], attach = [], timeoutMs = 600_000,
  } = opts;

  const args = ["run", prompt, "--json", "--mode", mode, "--persona", persona,
                "--permission", permission];
  if (cwd) args.push("--cwd", cwd);
  if (threadId) args.push("--thread", threadId);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (thinking) args.push("--thinking", thinking);
  for (const s of skills) args.push("--skill", s);
  for (const a of attach) args.push("--attach", a);

  return new Promise((resolve, reject) => {
    const child = spawn("perch", args, { cwd });
    let out = "", err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`perch 超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(out);
        resolve({ ...result, exitCode: code, stderr: err });
      } catch {
        reject(new Error(`perch 输出非 JSON (exit ${code}): ${err || out.slice(0, 500)}`));
      }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// ---- 用法 ----

// 1. 基本调用
const r1 = await perchRun("总结这个文件夹", { cwd: "/path/to/project" });
if (r1.ok) {
  console.log("回复:", r1.assistantText);
  console.log("成本:", r1.contextSnapshot.lastApiUsage);
} else if (r1.status === "approval_required") {
  console.error("需要审批:", r1.approvalContext);
} else {
  console.error("失败:", r1.error);
}

// 2. 多轮对话（续接 thread）
const r2 = await perchRun("再画个图", { cwd: "/path/to/project", threadId: r1.threadId });

// 3. 指定模型
const r3 = await perchRun("深度分析", {
  cwd: "/data", model: "DeepSeek V4.1 Flash", effort: "high",
});

// 4. 带附件
const r4 = await perchRun("分析这个 CSV", { cwd: "/data", attach: ["~/data.csv"] });

// 5. 读 thread 文件看历史（无需解析日志）
async function readThread(cwd) {
  // scopeHash 需从登录态推导；简化：遍历目录找匹配的 threadId
  const dir = join(homedir(), ".perch", "threads");
  // ... 实际实现需读 scopeHash 目录
}
```

---

## 7. 集成检查清单

| 项 | 状态 |
|---|---|
| 调用方式（spawn 官方 CLI） | ✅ 已确认 |
| 完整 flag 集 | ✅ 已提取 |
| `--json` 输出契约 | ✅ 已提取（`_gr`） |
| `segments` 34 种类型 | ✅ 已提取 |
| `events` 14 种类型 | ✅ 已提取 |
| `contextSnapshot` 结构 | ✅ 已提取 |
| 退出码语义 | ✅ 已提取 |
| 状态机（5 种 status） | ✅ 已提取 |
| 审批处理（`approval_required`） | ✅ 已提取 |
| thread 文件 schema | ✅ 本地实测 |
| 附件处理链 | ✅ 已提取 |
| `--json` stdout 行为 | ✅ 已确认（抑制进度） |
| 并发注意事项 | ✅ 已提取 |
| 成本模型 | ✅ 已提取 |

**结论：集成所需的技术细节已全部补齐。**

---

*文档生成：2026-10-13 · 逆向 + 本地文件实测，零新增网络请求*
