# BYO/BYOK 豁免路径完整逆向

> 来源：`dist/perch.mjs` 静态逆向（v2.4.107），纯离线
> 日期：2026-10-13
> 目的：理解 abuse-gate 的边界画在哪 —— 官方认可的豁免路径

---

## 一、结论速览

**BYO/BYOK 轮次完全不经过 Perch 的 model-call 网关，因此天然豁免 turn-ticket + bearer/UA 校验。**

服务端 gate 只挂在 `/api/perch-terminal/model-call` 这一个入口上。BYO 轮次在客户端直接 fetch 模型厂商的端点（OpenRouter / W&B / 本地 Ollama），Perch 服务器根本不参与推理，自然没有 gate 可言。

---

## 二、调用总入口 `zS()` 的三分支

```js
async function zS(e, t, r) {
  // 1. 浏览器环境（Desktop）：
  //    BYO → Eun()  ← 走 Desktop 本机 provider subscription
  //    非 BYO → UMe() ← 走 model-call + ticket
  if (typeof window < "u") {
    let s = tue();   // 读 byok-selection.json
    return s && UB(s.providerId) ? Eun(s, t, r) : UMe(t, r, n ?? void 0);
  }

  // 2. Node 环境 + 非 BYO：
  //    有 cliServerAppUrl → UMe()；有本地端点 → UMe()
  if (!TB()) {
    if (n) return UMe(t, r, n);
    let s = Oun();
    if (s) return UMe(t, r, s);
  }

  // 3. Node 环境 + BYO（TB() 为真）：
  //    走到这里 = BYO 轮次，走 aPt/j8 → sPt → 直连厂商
  let o = BMe(), ...;
  // 流式: aPt(a) / 非流式: j8(a)
}
```

**关键**：`TB()` 为真（BYO 激活）时，**完全不调用 `UMe()`**，也就不会发 `model-call` 请求。

---

## 三、BYO 开关 `TB()`：AsyncLocalStorage 上下文标记

```js
function TB() {
  return wV.getStore()?.byo === true;   // wV = AsyncLocalStorage
}
```

- BYO 状态存在 **AsyncLocalStorage 的 store 里**，不是全局变量
- 这解释了为什么 BYO 只对当前轮次生效、不会污染其他并发轮次
- `Fce(e)`：`store.byo===true && store.overrides[e]!==undefined` —— BYO 下的 provider 级 override

---

## 四、BYO 轮次的实际调用链（Node 环境）

```
zS()  →  j8()/aPt()  →  vMe()/vln()  →  sPt()
                                            │
              ┌─────────────────────────────┤
              │ (按 provider 类型分派)
              ▼
   custom-byok-runtime (qst)  →  UDt()  →  fetch(厂商端点)  ← 直连！
   local-byolm-runtime (Jb)   →  UDt()  →  fetch(localhost)
   azure_foundry / codex_oauth / claude_code_oauth / grok_oauth → 各自 OAuth/直连
```

### 4.1 `sPt()` 的 provider 分派

```js
async function sPt(e, t, r, n) {
  let o = $Pt(e);
  if (Vce(o)) return kln(...);                    // azure_foundry GPT 系列
  if (o.providerId === "codex_oauth") return Cln(...);
  if (o.providerId === "claude_code_oauth" || xMe(o.providerId)) return Iln(...);
  if (o.providerId === "grok_oauth") return Tln(...);
  let i = jce(o);                                  // 判断 provider 类型
  await jPt(o);
  let a = RL(o), s = await SL(QS(o, t.attribution), W8(o, t));
  // ...
  let c = await Kce(() => UDt(i, o, t, a, false, true), {...});
  // ...
}
```

### 4.2 `UDt()` — 最终请求（直连厂商）

```js
function UDt(e, t, r, n, o, i) {
  let a = MB(r.abortSignal, Wce(t));
  return fetch(zPt(TL(t)), {          // ← zPt(TL(t)) = 厂商端点 URL
    method: "POST",
    headers: QPt(e, t),               // ← 厂商 API key，不是 Perch bearer
    body: JSON.stringify(OPt(t, r, n, o, i)),
    signal: a.signal,
  }).finally(a.clear);
}
```

**注意**：请求目标是 `TL(t)`（模型厂商的 base URL），请求头是 `QPt(e,t)`（厂商 credential）。Perch 服务器不在这条链上。

---

## 五、BYO 下 model-call 还发不发 ticket？—— 不发

证据链：

1. `zS()` 的 BYO 分支（Node）**直接跳过 `UMe()`**，`UMe()` 是唯一调用 `pBt()`（model-call 构造）的地方
2. `pBt()` 里 `...await aue()` 是 ticket 头的唯一来源 —— 不调 `pBt()` 就不取票
3. `vMe()` 里 `if (TB()) throw iPt(a, s)` —— BYO 下模型失败**直接抛错，不 failover**（没有回退到 hosted 模型）
4. `j8()`/`aPt()` 里 `TB() ? "single" : ...` —— BYO 强制单模型模式，不 race

**推论**：BYO 轮次 = 零 Perch 推理流量 = 零 gate 接触面。这就是官方 invariant「BYOK/BYO turns are exempt from the hosted-model access gate」的代码级含义。

---

## 六、BYO 凭证管理端点（不走 gate，但也不用于推理）

```js
Zet = "/api/perch-terminal/byo/credentials"   // 保存/读取 BYO 凭证
Pto = "/api/perch-terminal/byo/test"          // 测试 BYO 连接
```

这两个端点只做**凭证管理**，不承载推理。BYO 的实际推理在客户端直连厂商。

---

## 七、对研究的意义

| 问题 | 答案 |
|---|---|
| BYO 轮次是否触发 abuse gate？ | **否**，完全不经过 gate |
| 服务端怎么识别 BYO 轮次？ | **不需要识别** —— BYO 轮次根本没有服务端推理请求 |
| 请求体里有没有 byo 标记？ | 有 `byoProviderId`/`byoModelId`（`bun()`），但那是给 **Desktop 本机** 用的，不是给服务端 gate 用的 |
| BYO 下 model-call 还发 ticket 吗？ | 不发。`aue()` 只在 `pBt()` 里被调用 |
| 本地模型（byolm）呢？ | 同样直连 localhost，零 Perch 流量 |

**一句话**：abuse gate 的边界 = `model-call` 这一个端点。BYO 从架构上绕开了它 —— 因为 Perch 服务器在 BYO 轮次里根本不参与推理。

---

## 八、附：关键符号表

| 符号 | 作用 |
|---|---|
| `zS()` | 模型调用总入口（三分支） |
| `TB()` | BYO 开关（AsyncLocalStorage） |
| `tue()` | 读 `byok-selection.json` |
| `UB()` | provider 是否 BYO 类型 |
| `Eun()` | Desktop 本机 provider 调用 |
| `UMe()` | model-call 调用（带 promo 重试） |
| `pBt()` | model-call 请求构造 + ticket 头 |
| `aue()` | 取/续 ticket 头 |
| `sPt()` | 最终模型调用（provider 分派） |
| `UDt()` | 直连厂商 fetch |
| `bun()` | `{byoProviderId, byoModelId}` 标记 |
| `vun()` | `{roostModelChoice, roostReasoning, effort}` |
| `wun()` | `{manualModelOptionId}` |
| `kun()` | `{providerCredentialOverrides}` |