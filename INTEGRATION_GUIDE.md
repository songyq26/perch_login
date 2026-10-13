# Perch CLI 集成指南（`perch run --json` 契约）

> 场景：把 Perch 能力嵌入自己的应用（**单用户/内部使用**，通过官方 CLI 编排）
> 证据：`dist/perch.mjs` 逆向（`Dco`/`qte`/`_gr`/`Axr`）+ 蜜罐实测
> 日期：2026-10-13

---

## ⚠️ 合规前提（先读）

| 场景 | 合规性 |
|---|---|
| 你的应用 **spawn 官方 CLI** 进程 | ✅ 合规——服务端流量与人类使用完全一致 |
| 你的应用 **直接发 HTTP 给 Perch 服务器** | ❌ 违反条款（封号邮件原文禁止），再犯永久封禁 |
| **多用户** SaaS（用户各自 Perch 账号） | ⚠️ 灰色，需走企业协议 |

**本文只覆盖第一种**：编排官方 CLI。

---

## 一、调用方式

```bash
perch run "<prompt>" --json [flags...]
```

### 1.1 完整 flag 集（逆向自 `Dco`）

| Flag | 取值 | 默认 | 说明 |
|---|---|---|---|
| `--json` | — | off | 输出 JSON（`JSON.stringify(obj, null, 2)`） |
| `--cwd <dir>` | 路径 | 当前目录 | 工作目录（决定 threadId 与文件工具根） |
| `--thread <id>` | 字符串 | 由 cwd 派生 `cli-cwd-<sha256(realpath(cwd))[:16]>` | 续接已有线程；不指定时同目录共享 |
| `--mode <m>` | `ask`/`agents`/`plan` | `agents` | 聊天模式 |
| `--persona <p>` | `saffron`/`quill` | `saffron` | 人格 |
| `--permission <p>` | `default`/`auto_review`/`take_the_wheel`/`plan` | `default` | 权限模式 |
| `--model <m>` | tier 或具名模型 | — | `standard`/`standard max`/`pro`/`pro max`/`auto`/`"DeepSeek V4.1 Flash"` |
| `--thinking <on\|off>` | — | — | 推理开关 |
| `--effort <level>` | `off`/`low`/`medium`/`high`/`xhigh`/`max`/`ultra` | — | 推理强度 |
| `--skill <id>` | 可重复 | — | 强制加载技能 |
| `--attach <path>` | 可重复（`-a`） | — | 附加文件 |
| `--desktop-tools` | — | off | 启用 Desktop 工具面 |
| `--no-local-tools` | — | off | 禁用本地工具 |
| `--app-url <url>` | — | 默认 | 覆盖服务端地址 |

**prompt 是位置参数**（所有非 `--` 开头的参数拼接）。

---

## 二、`--json` 输出契约（`_gr` 逆向）

```json
{
  "ok": true,                    // status === "completed"
  "status": "completed",         // completed | failed | cancelled | approval_required | incomplete
  "prompt": "<原始输入>",
  "cwd": "<绝对路径>",
  "threadId": "cli-cwd-<hash>",
  "runId": "tkt-cli-<ts>-<rand>",
  "durationMs": 5388,            // 或 null
  "assistantText": "PONG",       // 助手回复全文
  "events": [ ... ],             // 完整事件流（见 §三）
  "segments": [ ... ],           // 渲染分段（hDe 生成）
  "contextSnapshot": { ... },    // 上下文构成（见 §四）
  "error": "..."                 // 仅失败时存在
}
```

> 实测修正：`--json` 的 `status` 枚举来自 `_gr`/`NAe`（`completed`/`failed`/`cancelled`/`approval_required`/`incomplete`）。`cli-turn` *遥测* 管道另有一套映射（`completed`/`failed`/`cancelled`/`partial`/`blocked`，见 [DEEP_REVERSE_5TOPICS.md](./DEEP_REVERSE_5TOPICS.md):328-334）——两者是不同管道，勿混用。

**字段来源**（`_gr` 函数）：
```js
{
  ok: status === "completed",
  status, prompt, cwd, threadId,
  runId: result.runId,
  durationMs: result.durationMs ?? null,
  assistantText: result.assistantText ?? "",
  events, segments, contextSnapshot,
  ...(error ? { error } : {}),
}
```

---

## 三、`events` 数组（集成时最有用的部分）

实测 14 种事件类型（`cli-turn` 遥测同源）：

| 事件 | 关键字段 | 用途 |
|---|---|---|
| `turn_started` | `runId`, `ts` | 轮次开始 |
| `context_summary` | `text` | 上下文摘要（mode/messages/skills/sent） |
| `progress_item_started` | `item{id,turnId,...}` | 进度项开始 |
| `progress_item_delta` | `delta{itemId,deltaType,...}` | 进度增量 |
| `progress_item_completed` | `itemId`, `status` | 进度项完成 |
| `model_call_started` | `provider`, `lane`, `ts` | 模型调用开始 |
| `content_delta` | `text`, `ts` | **正文增量（流式）** |
| `model_call_completed` | `provider`, `lane`, `durationMs` | 模型调用完成 |
| `assistant_response` | `text`, `messageId` | 助手完整回复 |
| `turn_completed` | `runId`, `durationMs`, `status` | 轮次完成 |
| `tool_call_requested` | `toolName`, `toolCallId`, `input` | 工具调用请求 |
| `tool_call_started` / `_completed` / `_failed` | — | 工具执行状态 |
| `tool_result` | `toolName`, `toolUseId`, `text` | 工具结果 |
| `user_question_asked` | — | 需要用户回答（集成时需处理） |

**集成建议**：解析 `content_delta` 做流式 UI；`tool_call_*` 做进度展示；`turn_completed` 判定结束。

---

## 四、`contextSnapshot`（成本与状态监控）

```json
{
  "threadId": "...",
  "totalContextTokens": 26657,
  "latestSendTokens": 24164,
  "contextLimitTokens": 180000,
  "rawContextWindowTokens": 200000,
  "effectiveLimitTokens": 180000,
  "contextPercentage": 15,
  "compacted": false,
  "selectedSkills": ["about-perch"],
  "sectionBreakdown": {
    "system": {"chars": 33240, "estimatedTokens": 7485},
    "tools": {"chars": 57984, "estimatedTokens": 12426},
    "output_reserve": {"chars": 0, "estimatedTokens": 4000},
    ...
  },
  "lastApiUsage": {"inputTokens": 18878, "outputTokens": 3,
                   "cacheReadInputTokens": 7776, "totalTokens": 26657},
  "provider": "wandb",
  "modelId": "Qwen/Qwen3.6-35B-A3B",
  "modelLabel": "Standard"
}
```

> 实测修正（口径）：
> - `contextLimitTokens: 180000` / `rawContextWindowTokens: 200000` 是 **200k 窗口默认模型**（run2）的观测；pin DeepSeek 的 1M 窗口轮次实测为 `contextLimitTokens: 980000` / `rawContextWindowTokens: 1000000`（[INTEGRATION_SUPPLEMENT.md](./INTEGRATION_SUPPLEMENT.md) §1.5）。两条并排不是矛盾，而是不同模型的预算。
> - `lastApiUsage.inputTokens` **不含** cacheRead，`totalTokens = inputTokens + cacheReadInputTokens + outputTokens`（18,878 + 7,776 + 3 = 26,657）。缓存命中轮次 inputTokens 会显著偏小（run2 仅 18,878），缓存未命中轮次可达 ~26,600（cacheRead=0，如 run1/run3）——核算成本时需统一口径。

**集成用途**：
- `contextPercentage` → 进度条/告警（≥75% warn、≥90% critical）
- `lastApiUsage` → 成本核算（配合 PT 单价 $0.001）
- `compacted` → 判断是否发生上下文压缩

---

## 五、退出码（逆向 + 实测）

| 码 | 含义 | 来源 |
|---|---|---|
| `0` | 成功 | `gxr` 返回 0 |
| `1` | 参数错误 / 未知 flag | `Dco` 返回 `{ok:false}` |
| `2` | 未登录 / 会话无效 | `gxr` status 分支返回 2 |

**注意**：`--json` 模式下**错误也可能走 stdout**（JSON 里带 `error` 字段），需同时检查退出码和 `ok` 字段。

---

## 六、集成模式建议

### 6.1 基本调用（Node.js 示例）

```js
import { spawn } from "node:child_process";

function perchRun(prompt, { cwd, threadId, model, signal } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["run", prompt, "--json"];
    if (cwd) args.push("--cwd", cwd);
    if (threadId) args.push("--thread", threadId);
    if (model) args.push("--model", model);

    const child = spawn("perch", args, { signal });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      try {
        const result = JSON.parse(out);
        resolve({ ...result, exitCode: code, stderr: err });
      } catch {
        reject(new Error(`perch 输出非 JSON (exit ${code}): ${err || out}`));
      }
    });
  });
}

// 用法
const r = await perchRun("总结这个文件夹", { cwd: "/path/to/project" });
if (r.ok) console.log(r.assistantText);
else console.error(r.error);
```

### 6.2 流式（需要实时输出时）

`--json` 是**一次性输出**（等整轮结束）。要流式，用**不带 `--json`** 的模式读 stdout（README：*"Piped output and `--json` keep the raw text"*），或解析 `events` 数组。

### 6.3 多轮对话

```js
// 第一轮
const r1 = await perchRun("分析这个 CSV", { cwd: "/data" });
// 续接（用返回的 threadId）
const r2 = await perchRun("再画个图", { cwd: "/data", threadId: r1.threadId });
```

**注意**：threadId 由 cwd 哈希决定（`cli-cwd-<hash>`），同目录默认共享线程。

---

## 七、集成时的注意事项

| 项 | 说明 |
|---|---|
| **并发** | 同目录多进程会互踩 thread 历史（无锁）；token 刷新有文件锁保护 |
| **成本** | 每轮约 2.6 万 input tokens（system prompt + 57 工具 Schema 占大头）；缓存命中可省 |
| **超时** | 无内置超时；长任务需自己设 `signal` |
| **权限** | `--permission default` 下 write/command 工具会**暂停等审批**（`--json` 里 `status: "approval_required"`）——自动化场景需用 `auto_review` 或 `take_the_wheel` |
| **用户交互** | `askUserQuestion` 工具会触发 `user_question_asked` 事件，自动化场景需处理或避免 |
| **登录** | 首次需 `perch login`；之后自动刷新（1h token + 长期 refresh） |
| **网络** | 需能访问 `app.perchai.app`（国内需代理） |

---

## 八、仍需调研的（离线可得）

| # | 项 | 方法 |
|---|---|---|
| 1 | `segments` 数组结构（`hDe` 生成） | 离线挖 bundle |
| 2 | thread 文件 schema（`~/.perch/threads/`） | **本地文件直接读** |
| 3 | `--json` 下 stdout 是否仍流式 | 离线挖 `Kco`（stream:"stderr" 参数） |
| 4 | 各错误码 → `status` 字段映射 | 离线挖 `_gr` 调用点 |
| 5 | `--attach` 的附件处理链 | 离线挖 `v3`/`T` |

---

*文档生成：2026-10-13 · 逆向 + 蜜罐数据，零新增网络请求*
