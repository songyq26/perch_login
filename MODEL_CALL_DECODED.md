# model-call 请求体完整解码（蜜罐实测）

> 数据来源：蜜罐真实捕获（官方 CLI 正常对话；`logs-run1/2/3/5` + `logs` 共 5 批、38 条，本文数据主要取自 run2）
> 分析方式：纯离线解析已捕获日志
> 日期：2026-10-13

---

## 一、完整请求结构（实测确认）

```json
POST /api/perch-terminal/model-call
{
  "request": {
    "messages": [ ... ],       // 6 条（见下）
    "tools": [ ... ],          // 57 个工具定义
    "temperature": 0.6,
    "maxTokens": 32000,
    "toolChoice": "auto"
  },
  "runId": "tkt-cli-1791882578713-tl95b098",   // 与 turn-ticket 返回的 runId 相同！
  "lane": "chat",
  "strictManual": false,
  "preferredModelId": "wandb-qwen3-6-35b-a3b",
  "avoidModelIds": [ ...28 个... ],
  "attribution": {
    "userId": "…",
    "workspaceId": "…",
    "runId": "…",
    "lane": "chat",
    "source": "cli",
    "billingMultiplier": null
  },
  "clientSurface": "cli"
}
```

**实测与逆向对照**：

| 逆向预测 | 实测结果 | 一致？ |
|---|---|---|
| 顶层字段 | 完全一致 + attribution 完整结构 | ✅ |
| `runId` 来自 turn-ticket | `runId = tkt-cli-…` 与 ticket 响应相同 | ✅ |
| `clientSurface: "cli"` | 确认 | ✅ |
| `avoidModelIds`（自动路由 avoid 列表） | 28 个模型（历史失败记录） | ✅ |
| `preferredModelId` | 有值（Roost 路由偏好） | ✅ |

---

## 二、messages 实测结构（6 条）

```
[0] system   51629 字符 — Saffron 完整提示词（见 §四）
[1] user     24 字符   — 'Reply with exactly: PONG'      ← 第一次实验的历史
[2] user     8 字符    — 'Say PONG'                       ← 第二次实验的历史
[3] user     33 字符   — 'Reply with exactly one word: PONG'
[4] assistant 4 字符  — 'PONG'
[5] user     33 字符   — 'Reply with exactly one word: PONG'  ← 本轮输入
```

**发现**：
1. **历史消息直接进 messages**（不做服务端 thread 恢复——CLI 本地维护上下文）
2. **连续 user 消息未合并**（[1][2][3] 是三次输入，[4] 是唯一成功的回复）
3. threadId 是 `cli-cwd-b50b283234c574ef`（基于 cwd 的确定性 ID，同一目录共享 thread）

---

## 三、57 个工具（实测清单）

CLI 本地工具模式（`cliLocalTools: true`，未连接 Desktop）下的完整工具面：

| 类别 | 工具 |
|---|---|
| 工作区 | validateWorkspaceRoot |
| Shell | bash, run_in_background, check/kill/wait_for_background_task, list_background_tasks |
| 文件 | glob, grep, readLocalFile, writeLocalFile, moveLocalFile, copyLocalFile, createDirectory, deleteLocalFile, editLocalFile, apply_patch, statPath |
| 记忆 | readProjectMemory, saveToMemory |
| 源 | listLocalSources, readLocalSourceFile |
| AP 审计 | generateAPAuditPacket, prepare_ap_evidence, query_ap_cases, render_ap_control_graph |
| 编排 | runManagedPlaybook, send_worker_message, task_stop, spawn_worker, spawn_worker_batch, dispatch_agent |
| 沙箱 | run_sandbox_code |
| 元工具 | ctxInspect, toolSearch, configInspect, syntheticOutput, todoWrite |
| 产物 | create_artifact, update_artifact |
| 技能 | loadSkill |
| 交互 | askUserQuestion, brief |
| 计划 | propose_plan, enterPlanMode, exitPlanMode |
| MCP | listMcpServers |
| 检索 | searchKnowledge |
| Web | webSearch, webFetch, scholarSearch |
| 市场 | get_market_signal, query_market_signal_log, explain_market_signal, list_market_strategies, run_market_backtest, get_market_track_record |

**注意**：CLI 未连接 Desktop 时**没有**浏览器/电脑控制/Gmail/Google Workspace 工具（它们需要 Desktop bridge）。

---

## 四、System Prompt 组成（contextSnapshot 实测）

```
分节估算合计 27,930 tokens（含 4,000 output reserve；扣除后 23,930）≈ 108,300 字符，组成如下：

section             chars    tokens   占比
─────────────────────────────────────────────
system             33,240    7,485    27%  ← Saffron 身份+验证契约+产品事实+能力声明
selected_skills    15,504    3,666    13%  ← about-perch 技能全文
tools              57,984   12,426    45%  ← 57 个工具的 JSON Schema
output_reserve         -     4,000    15%  ← 输出预留
selected_model          0         0        ← 未选源
project_memory        476       102        ← .perch 项目记忆
permanent_memory        0         0        ← 服务端记忆（空）
desktop                955       210        ← Desktop 上下文段
messages               141        41        ← 对话历史
─────────────────────────────────────────────
合计               108,300   27,930
```

> 实测修正：表中 tokens 是 `sectionBreakdown.estimatedTokens`（估算）。同一轮（run2）usage 实测为 `inputTokens 18,878 + cacheReadInputTokens 7,776 + outputTokens 3 = totalTokens 26,657`（= `contextFillTokens`，也等于 `contextSnapshot.totalContextTokens`）。估算合计 27,930 比实测总额高约 5%；扣除 output_reserve 后的 23,930 与 `latestSendTokens 24,164` 接近。原文的「总输入 26,610」实为 run1 的 usage `inputTokens`（那轮缓存未命中，cacheRead=0），与本文其他 run2 数据不同轮，已按 run2 更正。

**关键数字**：
- **工具定义占 45%**（12,426 tokens）——最大头
- **system prompt 本体 7,485 tokens**
- **skills 注入 3,666 tokens**（单个 about-perch 技能）
- **输出预留 4,000 tokens**
- 上下文限制 180,000（本表所在 run2 为窗口 200,000 × 90%）；pin DeepSeek 的 1M 窗口轮次实测 980,000（× 98%），折扣率因模型而异
- `contextPercentage: 15`（15% 使用率）

---

## 五、turn-ticket 票据解码（实测）

```
ticket = base64url(JSON payload) + "." + 32 字节签名
```

**payload**（明文可读）：
```json
{
  "tid": "52d11204-…",          // ticket id
  "uid": "2a9827d3-…",          // user id
  "wid": "aee5feae-…",          // workspace id
  "surface": "cli",
  "plan": "pro",                 // 套餐！票据里带着
  "run": "tkt-cli-1791882578713-tl95b098",  // 绑定 runId（与 §一 的 model-call 同一轮）
  "exp": 1791882878              // 5 分钟有效期
}
```

**签名**：32 字节（HS256 风格 HMAC）

**关键发现**：
1. 票据**不是标准 JWT**（payload 无 header 包裹，签名仅 32 字节）
2. **票据绑定 runId**——一次性使用，换 run 必须重新领票
3. **plan 写进票据**——服务端凭票据就知道你的套餐
4. 有效期实测 **5 分钟**（exp - iat = 300s），比逆向发现的 30s renewal 窗口长（30s 是客户端提前续期的阈值）

---

## 六、cli-turn 遥测解码（实测）

```json
{
  "prompt": "…", "assistantText": "…",
  "threadId": "cli-cwd-b50b283234c574ef",
  "runId": "tkt-cli-…",
  "chatMode": "agents", "personaId": "saffron",
  "status": "completed", "durationMs": 5388,
  "events": [ 14 个事件 ],          // 见下
  "contextSnapshot": { … },         // 金矿，见 §四
  "systemInitiated": false,
  "attachments": []
}
```

**14 个事件类型（实测）**：
```
turn_started → context_summary → progress_item_started(context) →
progress_item_delta → progress_item_completed → model_call_started →
content_delta(×2) → model_call_completed → assistant_response →
progress_item_started(assistant) → progress_item_delta →
progress_item_completed → turn_completed
```

---

## 七、模型路由实测

| 项 | 第 1 次运行 | 第 2 次运行 |
|---|---|---|
| preferredModelId | （未捕获，截断） | `wandb-qwen3-6-35b-a3b` |
| 实际模型（done 事件） | `poolside/laguna-s-2.1` | `poolside/laguna-s-2.1` |
| done.provider | perch | perch |
| contextSnapshot.modelId / provider | （截断未捕获） | `Qwen/Qwen3.6-35B-A3B` / `wandb` |
| modelLabel | Standard | Standard |

> 实测修正：两轮 done 事件的 `provider` 都是 `perch`、`model` 都是 `poolside/laguna-s-2.1`。`wandb/Qwen3.6-35B-A3B` 只出现在 cli-turn 的 `contextSnapshot.modelId`（`provider: "wandb"`），是快照/路由标签而非实际运行的模型——正印证 model-routing 文档「NEVER contextSnapshot.modelId」的告诫。

**avoidModelIds（28 个）实测值**：cerebras/groq/cohere/github-models/openrouter-free 系——
这些是**历史调用失败的模型**（自动路由把它们加入 avoid 列表，符合逆向发现的 `cje` 逻辑）。

**缓存命中**：`cacheReadInputTokens: 7,776`——system prompt 部分被服务端缓存（真实节省）。

---

## 八、流程总结（实测版）

```
1. public-model-default   GET   拉默认模型选择
2. cli-context            POST  {query: 用户输入, limitPerScope: 8}   ← 取相关记忆
3. turn-ticket            POST  {surface:"cli", profile:"standard"}   ← 领票（绑定 runId）
4. cli-context            POST  {query, limitPerScope: 24}            ← 再取一轮记忆
5. model-call             POST  {request:{messages,tools,…}, runId:票里的, …}
    ↓ SSE
    answer_delta × N → done{provider, model, usage, text}
6. cli-turn               POST  完整遥测（14 events + contextSnapshot）
7. cli-learning           POST  {userMessage, assistantText, …}       ← 训练采样
```

**每次对话 7 个请求，全部携带有效票据语义，与官方逆向完全一致。**

---

## 九、与逆向文档的差异修正

| 逆向文档说法 | 实测修正 |
|---|---|
| UA 为 `perchai-cli/<版本>` | 实际 `perchai-cli/unknown`（版本注入在子进程才生效，但服务端**接受**） |
| ticket 有效期 30s | payload exp 显示 **5 分钟**；30s 是客户端续期阈值 |
| ticket 是 JWT | **非标准**：payload+32 字节 HMAC，无 JWT header |
| messages 从服务端 thread 恢复 | **本地维护**，历史直接进 messages |
| `maxToolResultChars: 2000` | 属于 worker 通道；主对话未见截断 |
| 工具数 134 | 单次实际暴露 **57 个**（按 surface 裁剪） |

---

*分析完成：2026-10-13 · 基于蜜罐真实捕获，纯离线解析*
