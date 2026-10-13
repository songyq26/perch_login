# Perch 消息流与服务端通信完整追踪

> 来源：`dist/perch.mjs` 静态逆向 + 蜜罐透明性验证
> 日期：2026-10-13
> 前置：[REQUEST_FORMAT_SPEC.md](./REQUEST_FORMAT_SPEC.md)、[DEEP_REVERSE_5TOPICS.md](./DEEP_REVERSE_5TOPICS.md)

---

## 一、蜜罐透明性验证（已完成）

### 1.1 验证方法

`honeypot/selftest.mjs` 用本地回环服务器做**逐字节比对**：

```
1. 起本地 HTTP 服务器，返回固定字节（含 Unicode/二进制/特殊字符）
2. 分别用「无 tap」和「有 tap」的 fetch 请求它
3. 比对：状态码、响应体、响应头、服务器实际收到的请求
```

### 1.2 验证结果：26 项（22 项非流式 + 4 项 SSE）全部通过

| 检查项 | 结果 |
|---|---|
| 状态码一致 | ✅ |
| **响应体逐字节一致** | ✅ |
| 7 个响应头全部一致 | ✅ |
| 服务器收到的 method/url/body 一致 | ✅ |
| **tap 未添加任何额外请求头** | ✅ |
| 日志正确记录请求/响应 | ✅ |

> 实测修正：`selftest.mjs` 现为 **26 项**检查（22 项非流式 + 4 项 SSE）；其中「响应头 `date` 一致」依赖两次请求落在同一秒，跨秒运行会记为 25/26——属测试自身的计时敏感性，与 tap 透明性无关。

### 1.3 实现要点

```js
// 关键：用 clone() 读取副本，原响应对象完全不被触碰
if (isStream) {
  const clone = res.clone();
  (async () => { /* 读 clone 记录 */ })();
  return res;   // 原响应原样返回，未做任何包装
}
```

**为什么用 `clone()` 而不是 `tee()`**：`tee()` 会创建两个流分支，可能影响背压；`clone()` 是 WHATWG Fetch 标准 API，保证字节级一致且不干扰原流。

---

## 二、消息流完整时序

### 2.1 一轮对话的完整生命周期

```
┌─ 用户输入 ─────────────────────────────────────────────┐
│                                                          │
│  1. 构造初始 messages                                    │
│     messages = [{ role: "system", content: systemPrompt }]│
│                                                          │
│  2. 追加历史消息（从 threadSession 恢复）                │
│     messages.push(...historyMessages)                    │
│                                                          │
│  3. 追加本轮用户输入                                     │
│     messages.push({ role: "user", content: userInput })  │
│                                                          │
├─ 迭代循环（最多 maxIterations 次）──────────────────────┤
│                                                          │
│  4. compaction 检查（prepareLoopMessagesForSend）        │
│     ├─ 剪枝 browser/screenshot 载荷                      │
│     ├─ 摘要旧轮次                                        │
│     └─ 丢弃最旧的                                        │
│     ↓                                                    │
│     重建 messages：                                      │
│       messages.length = 0                                │
│       messages.push({ role: "system", content: systemPrompt })│
│       messages.push(...compactedMessages)                │
│                                                          │
│  5. 可选：dump payload（PERCH_DUMP_MODEL_PAYLOAD=1）     │
│     Sje({ runId, iteration, lane, systemPrompt,          │
│           messages, tools, modelId, providerId })        │
│                                                          │
│  6. 计算 maxTokens（vDe）                                │
│     maxTokens = f(contextWindow, breakdown.total)       │
│                                                          │
│  7. 调用模型（zS → pBt → POST model-call）               │
│     body = {                                             │
│       request: { lane, messages, tools, maxOutputTokens, │
│                  temperature, toolChoice, ... },         │
│       runId, lane, clientSurface: "cli", ...             │
│     }                                                    │
│     headers = {                                          │
│       Content-Type: application/json,                    │
│       Accept: text/event-stream,                         │
│       Authorization: Bearer <token>,                     │
│       User-Agent: perchai-cli/<version>,                 │
│       x-perch-turn-ticket: <ticket>                      │
│     }                                                    │
│                                                          │
│  8. 解析 SSE 流                                          │
│     ├─ answer_delta → 累积文本 + onChunk                 │
│     ├─ reasoning_delta → 累积推理                        │
│     ├─ tool_call_delta → 累积 toolCalls                  │
│     ├─ tool_use_end → 最终 toolCalls                     │
│     ├─ stream_restart → 清空重来                         │
│     ├─ continuation_seam → 记录缝位置                    │
│     ├─ model_call_failed → 记录失败                      │
│     ├─ done → 完成（含 usage/debug）                     │
│     └─ error → 流错误                                    │
│                                                          │
│  9. 若有 toolCalls → 执行工具                            │
│     ├─ 权限检查（permissionMode）                        │
│     ├─ 需要审批 → 返回 approval_paused，暂停             │
│     ├─ 执行工具                                          │
│     └─ 追加到 messages：                                 │
│         { role: "assistant", content: "",                │
│           tool_calls: [{ id, type: "function",           │
│             function: { name, arguments: JSON.stringify(input) } }] }│
│         { role: "tool", content: result,                 │
│           tool_call_id: id }                             │
│     ↓                                                    │
│     回到步骤 4（下一轮迭代）                             │
│                                                          │
│ 10. 无 toolCalls → 结束循环                              │
│                                                          │
├─ 收尾 ──────────────────────────────────────────────────┤
│                                                          │
│ 11. 上报 cli-turn（遥测，20s 节流）                      │
│     POST /api/perch-terminal/cli-turn                    │
│     { prompt, assistantText, threadId, runId, chatMode,  │
│       personaId, status, durationMs, error, events,      │
│       contextSnapshot, systemInitiated, attachments }    │
│                                                          │
│ 12. 上报 cli-learning（训练采样）                        │
│     POST /api/perch-terminal/cli-learning                │
│     { userMessage, assistantText, status, personaId,     │
│       threadId, runId }                                  │
│                                                          │
│ 13. 持久化到 Supabase（若有 workspace）                  │
│     ├─ perch_ai_messages（消息）                         │
│     ├─ perch_ai_tool_calls（工具调用）                   │
│     └─ perch_ai_context_snapshots（上下文快照）          │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### 2.2 关键代码片段

**初始 messages 构造**（`FM` 函数）：
```js
async function FM(e) {
  let { systemPrompt, tools, workspaceRoot, persistToolCall, signal } = e;
  // ...
  let d = [{ role: "system", content: systemPrompt }, ...e.messages];
  // d 就是 wire messages
}
```

**compaction 后重建**：
```js
e.messages.length = 0;
e.messages.push({ role: "system", content: e.systemPrompt });
e.messages.push(...fe.messages);   // fe.messages = compaction 后的消息
e.lastWireMessagesForContext = JOn(e.messages.filter(m => m.role !== "system"));
```

**模型调用**：
```js
m = await zS(
  { provider: "auto", apiKey: "", baseUrl: "", model: "auto" },
  {
    messages: e.messages,
    tools: e.tools.length > 0 ? e.tools : undefined,
    temperature: BB,
    maxTokens: ie,
    toolChoice: (e.forceToolUse === true || e.stalledIterations > 0) && e.tools.length > 0
      ? "required"
      : e.tools.length > 0 ? "auto" : undefined,
    signal: s,
    onChunk: (chunk) => {
      n += chunk;
      e.contentTextAccumulated += chunk;
      e.onEvent({ type: "content_delta", text: chunk, ts: S0() });
    },
    // ...
  },
  { runId: e.runId, lane: r, /* ... */ }
);
```

**工具结果追加**：
```js
e.messages.push({
  role: "assistant", content: "",
  tool_calls: [{ id: r.id, type: "function",
                 function: { name: r.name, arguments: JSON.stringify(r.arguments) } }],
});
e.messages.push({ role: "tool", content: n.toolResultText, tool_call_id: r.id });
```

### 2.3 停滞检测与强制工具调用

```js
// 停滞提示词（vXt）
vXt = "Your previous response ended with no message and no tool call. Do not restate
       the plan. If a relevant tool is available, take the next concrete action as a
       tool call now. Otherwise, explain what is blocking you.";

// toolChoice 逻辑
toolChoice = (forceToolUse === true || stalledIterations > 0) && tools.length > 0
  ? "required"      // 强制调用工具
  : tools.length > 0 ? "auto" : undefined;
```

**设计意图**：模型"空转"（既无文本也无工具调用）时，下一轮强制 `toolChoice: "required"`，逼它行动。

---

## 三、本地 ↔ 服务端通信全景

### 3.1 通信矩阵

| 时机 | 端点 | 方向 | 内容 |
|---|---|---|---|
| 启动 | `cli-context` | 拉 | 记忆 + workspaceId |
| 启动 | `public-model-default` | 拉 | 默认模型选择 |
| 每轮前 | `turn-ticket` | 拉 | 领票据 |
| 每轮 | `model-call` | 双向 | 推理（SSE） |
| 每轮中 | `cli-turn` | 推 | 遥测（20s 节流） |
| 每轮后 | `cli-learning` | 推 | 对话原文（训练采样） |
| 按需 | `cli-memory` | 双向 | 持久记忆 |
| 按需 | `usage` | 拉 | 用量明细 |
| 按需 | `market-desk/tool` | 双向 | 市场数据 |
| 按需 | `writing-studio/run` | 双向 | 写作工作室 |

### 3.2 数据流向图

```
本地 CLI                                     Perch 服务端
────────                                     ────────────
                                            
systemPrompt ─┐                             
history ──────┼─→ messages ──┐              
userInput ────┘              │              
                             │              
tools 定义 ──────────────────┤              
                             ↓              
                        model-call ────────→ 服务端路由
                             ↑                    ↓
                        SSE 流 ←──────────── 模型厂商
                             │              
                    ┌────────┴────────┐     
                    ↓                 ↓     
              文本回复           toolCalls    
                    │                 │     
                    │                 ↓     
                    │            本地执行工具  
                    │                 │     
                    │                 ↓     
                    │            tool result  
                    │                 │     
                    └────────┬────────┘     
                             ↓              
                        下一轮迭代          
                             │              
                             ↓              
                    cli-turn ─────────────→ 遥测存储
                    cli-learning ─────────→ 训练采样
                    Supabase 直写 ────────→ perch_ai_* 表
```

### 3.3 关键观察

**1. 服务端能看到什么**

| 数据 | 是否外发 | 说明 |
|---|---|---|
| system prompt | ✅ | 每轮都发 |
| 完整对话历史 | ✅ | 每轮都发（compaction 后） |
| 工具定义 | ✅ | 每轮都发 |
| **工具执行结果** | ✅ | 作为 `role: "tool"` 消息 |
| 用户输入 | ✅ | |
| 模型回复 | ✅ | |
| 本地文件路径 | ⚠️ | 工具参数里可能含 |
| **本地文件内容** | ⚠️ | 若工具读了文件，内容在 tool result 里 |
| 环境变量 | ❌ | 除非工具显式读取 |

**2. 三条独立的数据通道**

```
① 推理通道（model-call）    → 服务端路由到模型厂商
② 遥测通道（cli-turn）      → 服务端存储（20s 节流）
③ 训练通道（cli-learning）  → 服务端训练采样
```

**3. 本地直写 Supabase**

有 workspace 时，CLI 会**直接写 Supabase**（不经 Perch 服务端）：
- `perch_ai_messages`（消息持久化）
- `perch_ai_tool_calls`（工具调用记录）
- `perch_ai_context_snapshots`（上下文快照）

这是**客户端直连数据库**（用 anon key + RLS），不是走 API。

---

## 四、联网验证方案（待你确认）

### 4.1 前置条件

| 条件 | 状态 |
|---|---|
| 蜜罐透明性 | ✅ 26 项测试通过（22 非流式 + 4 SSE） |
| 请求格式 | ✅ 已完全还原 |
| 网络 | ❌ 服务器 IP 被墙，需代理 |
| 账号 | ✅ 已恢复 |

### 4.2 合规的验证方式

**唯一合规路径**：用**官方 CLI** 发请求，蜜罐旁路记录。

```bash
# 1. 启动代理（你的 Clash 等）
# 2. 用蜜罐包装的官方 CLI
cd perch_login_py/honeypot
./run-with-tap.sh run "Say PONG"
# 3. 分析 logs/ 里的记录
```

**服务端视角**：完全等同于正常使用（字节级一致，已自测验证）。

### 4.3 验证目标

| 目标 | 验证方法 |
|---|---|
| 请求格式还原是否准确 | 比对蜜罐记录 vs [REQUEST_FORMAT_SPEC.md](./REQUEST_FORMAT_SPEC.md) |
| SSE 事件类型是否完整 | 检查实际流里出现的事件类型 |
| 消息流时序是否正确 | 检查请求顺序：cli-context → turn-ticket → model-call → cli-turn |
| `cli-turn` 是否真的 20s 节流 | 检查多次上报的时间间隔 |
| compaction 是否按预期触发 | 长对话后检查 messages 长度变化 |

### 4.4 风险控制

| 措施 | 说明 |
|---|---|
| 只用官方 CLI | 不写脚本 |
| 单次会话 | 不批量、不循环 |
| 蜜罐只读 | 不改任何字节 |
| 记录留痕 | 便于自查频率 |
| 随时可停 | 你说了算 |

---

## 五、当前状态

| 项 | 状态 |
|---|---|
| 蜜罐 | ✅ 已加固 + 26 项透明性测试通过（22 非流式 + 4 SSE） |
| 请求格式 | ✅ 完全还原 |
| 消息流 | ✅ 完全追踪 |
| 网络 | ⏸️ **等你启动代理** |
| 账号 | ✅ 已恢复 |

**下一步需要你决定**：
1. 启动代理，用官方 CLI + 蜜罐做一次真实验证（合规）
2. 继续纯离线深挖（AP 引擎 / 沙箱 / compaction 细节）

---

*文档生成：2026-10-13 · 静态逆向 + 本地透明性验证，零外部网络请求*
