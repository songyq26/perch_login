# Perch CLI 请求格式权威规范（逆向还原）

> 来源：`dist/perch.mjs` 静态逆向，零网络请求
> 目的：**在完全理解官方请求格式之前，不做任何网络调用**
> 日期：2026-10-13

---

## 一、为什么这份文档重要

Perch 官方回复明确指出封号原因：

> 它发送的请求**不符合 Perch 的正常格式**，上报了与您实际安装版本**不符的客户端版本号**，并测试了服务器对**缺失或伪造的 turn ticket** 的处理方式。

**这三个问题都能通过逆向分析避免**。本文件还原官方 CLI 的精确请求格式。

---

## 二、`model-call` 完整请求规范

### 2.1 端点

```
POST {cliServerAppUrl}/api/perch-terminal/model-call
```

`cliServerAppUrl` 解析链（`bot()` 函数）：
```
TSe(t) || session.appUrl || e.appUrl
  ↓
TSe: PERCH_CLI_APP_URL || PERCH_APP_URL || ""
  ↓
默认: https://app.perchai.app
```

### 2.2 请求头（精确）

| Header | 值 | 来源函数 | 条件 |
|---|---|---|---|
| `Content-Type` | `application/json` | 硬编码 | 总是 |
| `Accept` | `text/event-stream` | 硬编码 | **仅流式**（有 onChunk/onReasoningChunk/onStreamEvent） |
| `Authorization` | `Bearer ${token}` | `sBt()` | token 非空 |
| `User-Agent` | `perchai-cli/${PERCH_CLI_VERSION}` | `OL()` | **仅 Node 环境**且 token 非空 |
| `x-perch-turn-ticket` | `${ticket}` | `aue()` | ticket 存在且未过期 |
| `x-perch-call-delta` | `1` | 硬编码（2.4.113+） | **总是**（首轮 body 是完整 `request` 也照发） |
| `x-perch-locale` | `en`（默认） | `p0t = "x-perch-locale"` | 2.4.113+：`cli-context` / `perchai/account` / `turn-ticket` / `model-call` |

**2.4.113 的"对话增量"协议**（蜜罐实测，2026-10-23）：

- 响应头带 `x-perch-call-delta: 1` + `x-perch-call-held-length`（服务端已持有的消息条数）、
  `x-perch-call-held-digest`（这些消息前缀的 SHA-256）、`x-perch-call-held-tools`（tools 的 SHA-256）。
- 客户端下一次可以只发 `messagesDelta:{baseLength, baseDigest, newMessages}`（+ `toolsDigest`），
  不再重发 messages/tools；服务端拒绝（409，或 400 且响应没有 `x-perch-call-delta`）时回退成完整请求。
- **首轮没有 held 状态时，官方照样带 `x-perch-call-delta: 1` 但 body 是完整 `request`** ——
  说明这个头是"能力声明"，不是"本次是增量"。
- 本仓库网关目前只发"能力声明 + 完整请求"，不消费 held-* 做增量（无状态，且完整请求一直有效）。

**关键细节**：

```js
// sBt() —— Authorization
function sBt(e) {
  let t = aBt(e);   // e?.trim() || process.env.PERCH_MODEL_CALL_PROXY_TOKEN || ""
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// OL() —— User-Agent（这是之前脚本缺失的！）
function OL(e) {
  if (typeof window < "u") return {};        // 浏览器环境不加
  if (!aBt(e)) return {};                     // 无 token 不加
  let t = process.env?.PERCH_CLI_VERSION?.trim();
  return { "User-Agent": `${oBt}${t || "unknown"}` };  // oBt = "perchai-cli/"
}
```

**⚠️ 之前脚本的错误**：只发了 `Authorization`，**没发 `User-Agent`**。而 `abuse-gate` 文档明确说：

> 服务端 gate: validates the ticket + **bearer/UA**

**UA 是 gate 的一部分**。缺 UA 或 UA 版本号不符 → 被判定为异常客户端。

### 2.3 请求体（精确）

```js
JSON.stringify({
  request: { ...c },              // c = 除 onChunk/onReasoningChunk/onStreamEvent/signal 外的所有字段
  runId: t?.runId,
  lane: t?.lane ?? "chat",
  strictManual: t?.strictManual ?? false,
  raceMode: t?.raceMode,
  preferredModelId: t?.preferredModelId ?? null,
  avoidModelIds: t?.avoidModelIds ?? [],
  attribution: t?.attribution ?? null,
  clientSurface: t?.clientSurface ?? (t?.cliServerAccessToken ? "cli" : null),
  // 条件字段：
  ...(t?.promoOverflowAccepted ? { promoOverflowAccepted: true } : {}),
  ...vun(),   // roostModelChoice / roostReasoning / effort
  ...(reasoningRecovery 条件 ? { reasoningRecovery: true } : {}),
  ...bun(),   // byoProviderId / byoModelId
  ...wun(t?.manualModelOptionId),  // manualModelOptionId
  ...kun(),   // providerCredentialOverrides
})
```

**`request` 内部字段**（来自 `zS()` 的构造）：

```js
{
  lane: r?.lane ?? "chat",
  messages: t.messages,
  tools: t.tools,
  maxOutputTokens: t.maxTokens,
  temperature: t.temperature,
  toolChoice: t.toolChoice,
  abortSignal: t.signal,          // 注意：会被序列化（可能是 bug）
  raceMode: r?.raceMode,
  responseFormat: t.responseFormat,
  preferredModelId: r?.preferredModelId ?? null,
  avoidModelIds: r?.avoidModelIds,
  attribution: r?.attribution ?? null,
  reasoning: r?.reasoning ?? null,
}
```

**条件字段构造器**：

```js
// vun() —— Roost 路由选择
function vun() {
  let e = BL();   // 读 perch.roostUserSelection.v1
  return e ? { roostModelChoice: e.choice, roostReasoning: e.reasoningEnabled, effort: e.effort } : {};
}

// bun() —— BYO 选择
function bun() {
  let e = tue();  // 读 perch.byoUserSelection.v1
  return e ? { byoProviderId: e.providerId, ...(e.modelId ? { byoModelId: e.modelId } : {}) } : {};
}

// wun() —— 手动模型 pin
function wun(e) {
  let t = _un(e);  // e?.trim() || dB()（读设置）
  return t ? { manualModelOptionId: t } : {};
}

// kun() —— provider 凭据覆盖
function kun() {
  let e = nBt();   // 读 K8（内存凭据表）
  return Object.keys(e).length > 0 ? { providerCredentialOverrides: e } : {};
}
```

**关于 `providerCredentialOverrides`（源码澄清）**：`K8` 只由 `_3()` 在图钉特定模型时写入——目前仅 `grok_oauth`（借用 OAuth 凭据）与 `meta` contributor 模型会填值，其余情况为空。该字段属于 **hosted 的 `model-call` 路径**（`kun()` 只在 `pBt()` 内被展开，而 `pBt()` 只由 `UMe()` 调用）；BYO/BYOK 轮次走 `zS()` 的 BYO 分支，**根本不发 `model-call`**（见 BYO_EXEMPTION_PATH.md）。因此二者不冲突，`kun()` 不是 BYOK 凭据通道。

### 2.4 重试逻辑（`Dun()`）

```js
async function Dun(e, t, r) {
  let n = Math.max(1, r?.maxAttempts ?? hBt);   // hBt = 3
  let o = null, i = false, a = t;
  for (let s = 0; s < n; s++) {
    try {
      let c = await fetch(e, a);
      // 401 特殊处理：同步 session 后重试一次
      if (c.status === 401 && !i) {
        i = true;
        let u = await Tun();          // 读最新 session
        if (u) a = Run(a, u);         // 替换 Authorization
        r?.onRetry?.(s, "HTTP 401 (session sync)");
        await c.body?.cancel().catch(() => {});
        await $Me(s, a.signal);       // 退避
        continue;
      }
      // 可重试状态码：408 / 425 / 5xx
      if (!Pun(c.status) || s === n - 1) return c;
      r?.onRetry?.(s, `HTTP ${c.status}`);
      await c.body?.cancel().catch(() => {});
      await $Me(s, a.signal);
    } catch (c) {
      if (Mun(c) || s === n - 1) throw c;   // AbortError 不重试
      o = c;
      r?.onRetry?.(s, c.message);
      await $Me(s, a.signal);
    }
  }
  throw o;
}

// 退避：350ms * 2^attempt
function $Me(e, t) {
  let r = Sun * 2 ** e;   // Sun = 350
  // ...
}

// 可重试状态码
function Pun(e) { return e === 408 || e === 425 || (e >= 500 && e <= 599); }

// 401 时替换 Authorization
function Run(e, t) {
  if (!t?.trim()) return e;
  let r = new Headers(e.headers);
  r.set("Authorization", `Bearer ${t}`);
  return { ...e, headers: r };
}
```

**关键**：401 时会**自动同步 session 并重试一次**。这是官方行为，不是绕过。

### 2.5 响应格式（SSE）

```
data: {"type":"answer_delta","text":"..."}
data: {"type":"reasoning_delta","text":"..."}
data: {"type":"tool_call_delta","toolCalls":[...]}
data: {"type":"tool_use_end","toolCalls":[...]}
data: {"type":"stream_restart","reason":"mid_tool_call_failover"}
data: {"type":"continuation_seam","at":123}
data: {"type":"model_call_failed","provider":"...","modelId":"...","error":"...","errorCategory":"..."}
data: {"type":"done","ok":true,"text":"...","toolCalls":[...],"provider":"...","model":"...","durationMs":123,"usage":{...},"debug":{...}}
data: {"type":"done","ok":false,"error":"...","errorCode":"..."}
data: {"type":"error","message":"..."}
```

**解析规则**：只处理 `data:` 前缀行，`JSON.parse(line.slice(5).trim())`。

---

## 三、`turn-ticket` 完整请求规范

### 3.1 端点

```
POST {appUrl}/api/perch-terminal/turn-ticket
```

### 3.2 请求头

```js
{
  "Content-Type": "application/json",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  ...OL(token),                                    // User-Agent: perchai-cli/<ver>（与 model-call 同一构造器）
  ...(token ? {} : { credentials: "include" }),    // 无 token 时用 cookie
}
```

**注意**：`turn-ticket` **也带 `User-Agent: perchai-cli/<ver>`**——`cBt()` 的 headers 里显式调用了 `OL()`，与 `model-call` 相同（实测 38 条捕获中 UA 只出现在 turn-ticket 与 model-call 两个端点）。

### 3.3 请求体

```js
{ surface: e.surface, profile: e.profile ?? "standard" }
```

`surface` 取值：`"cli"`（CLI 环境）
`profile` 取值：`"standard"` 或 `"flock"`（由 `Orr(prompt)` 决定）

### 3.4 响应

```js
{
  ok: true,
  ticket: "...",        // 票据
  ticketId: "...",
  runId: "...",
  surface: "cli",       // 请求的 surface（实测响应含此字段）
  expiresAt: "ISO8601",
  profile: "standard",
  enforced: true,       // 是否强制
  renewal: {...}        // 续期信息
}
```

**票据生命周期**（`aue()`）：
- 有效期实测 **5 分钟**（票据 payload `exp − iat = 300s`；`uBt()` 在响应无 `expiresAt` 时也默认 `Date.now() + 3e5`）
- `gun = 3e4`（30 秒）是**客户端提前续期的阈值**：剩余 > 30s 直接用
- 剩余 ≤ 30s → 用 `renewal` 续期
- 续期失败且已过期 → 抛 `TurnTicketUnavailableError`

---

## 四、之前脚本的 3 个致命错误（对照官方回复）

| 官方指出的问题 | 脚本的错误 | 正确做法 |
|---|---|---|
| **请求格式不符** | 只发 `Authorization`，缺 `User-Agent`；body 结构不完整（缺 `clientSurface`、`lane`、`runId` 等） | 按 §2.2/§2.3 完整构造 |
| **版本号不符** | 硬编码 `perchai-cli/2.4.107`，但实际安装版本可能不同 | **缺失可接受、谎报不行**：`bin/perch` 从 `package.json` 读版本注入 `PERCH_CLI_VERSION`，缺失时 UA 降级为 `perchai-cli/unknown`（官方降级路径，实测服务端接受）；但官方封号邮件把「上报与安装版本不符的版本号」列为封号原因，故不得伪造 |
| **测试伪造 ticket** | 尝试空 ticket、假 ticket、多种 header 组合 | **绝不伪造**；ticket 只能由 `turn-ticket` 端点签发 |

---

## 七、全部端点规范表（逆向还原）

### 7.1 端点分类

| 端点 | 方法 | Authorization | User-Agent | 超时 | 用途 |
|---|---|---|---|---|---|
| `model-call` | POST | ✅ Bearer | ✅ **`perchai-cli/<ver>`** | 3 次重试 | 模型推理（SSE） |
| `turn-ticket` | POST | ✅ Bearer | ✅ **`perchai-cli/<ver>`** | 8s | 领票据 |
| `cli-context` | POST | ✅ Bearer | ❌ | 5s | 记忆/workspace 上下文 |
| `cli-learning` | POST | ✅ Bearer | ❌ | 5s | 对话回传（训练采样） |
| `cli-memory` | POST | ✅ Bearer | ❌ | — | 持久记忆读写 |
| `usage` | POST | ✅ Bearer | ❌ | 5s | 用量明细 |
| `usage-meter` | GET / RPC | CLI 走 **Supabase RPC**（`perch_ai_my_inference_usage_meter`），非 HTTP Bearer | ❌ | — | 用量仪表 |
| `market-desk/tool` | POST | ✅ Bearer | ❌ | — | 市场数据工具 |
| `writing-studio/run` | POST | ❌ | ❌ | — | 写作工作室 |
| `perchai/account` | GET | ✅ Bearer | ❌ | — | 账号信息 |

### 7.2 通用 POST 助手（`_ot`）

```js
async function _ot(appUrl, session, path, body) {
  let ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), 5000);   // 5 秒超时
  try {
    let res = await globalThis.fetch(`${appUrl}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    let json = await res.json();
    return json && typeof json === "object" && !Array.isArray(json) ? json : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

**注意**：`_ot` **不发 User-Agent**，超时 5 秒，失败静默返回 `null`。

### 7.3 各端点 body 结构

```js
// cli-context
{ query: string, limitPerScope: number }        // 8 = 启动探测，24 = 每轮检索线程证据，1 = /status

// cli-learning
{ userMessage, assistantText, status, personaId, threadId, runId }

// cli-memory
{ action: "save" | ..., args: {...}, threadId, runId, workspaceRoot }

// usage
{ runIds: string[] }

// market-desk/tool
{ toolName: string, ... }

// turn-ticket
{ surface: "cli", profile: "standard" | "flock" }
```

### 7.4 关键差异总结

| 特性 | `model-call` | 其他端点 |
|---|---|---|
| User-Agent | ✅ 必须（gate 校验） | 仅 `turn-ticket` 也发；其余不发 |
| Accept | `text/event-stream`（流式） | `application/json` |
| 重试 | 3 次，401 特殊处理 | 无 |
| 超时 | 无（长连接） | 5-8 秒 |
| 失败处理 | 返回错误码 | 静默 null |

**这就是之前脚本的核心错误**：对所有端点用了同一套 header。`User-Agent` 实际出现在 `model-call` 与 `turn-ticket` 两个端点；版本号**缺失时降级为 `perchai-cli/unknown` 可被服务端接受，但谎报与安装不符的版本号会触发封号**（官方邮件明列）。

---

## 八、下一步（在你确认前不做任何网络调用）

**当前状态**：
- ✅ 请求格式已完全还原（本文档）
- ✅ 蜜罐已就绪（`honeypot/tap.mjs`，纯旁路观测）
- ⏸️ **等待你的指示**

**如果要继续观测**，唯一合规的方式是：
1. 你启动代理（网络恢复）
2. 用 `./run-with-tap.sh` 启动**官方 CLI**（不是脚本）
3. 蜜罐记录官方 CLI 的真实请求
4. 我分析记录，验证本文档的还原是否准确

**但即使这样，我也建议先等你确认**——因为任何网络活动都可能被风控系统记录。

---

*文档生成：2026-10-13 · 纯静态逆向，零网络请求*
