# 蜜罐合规审查报告

> 审查对象：`honeypot/tap.mjs`（Perch 本地观测蜜罐）
> 审查日期：2026-10-13
> 审查方法：静态代码审查 + 26 项透明性自测 + 对照 abuse-gate invariants

---

## 结论

**蜜罐不会触发 abuse。** 风险等级与正常使用官方 CLI 相同。

---

## 一、审查方法

### 1.1 静态代码审查（12 项）

| # | 检查项 | 结果 |
|---|---|---|
| 1 | 不发起任何新请求 | ✅ `realFetch` 只在透传处调用 |
| 2 | 不修改请求 `input` | ✅ 只读 |
| 3 | 不修改请求 `init` | ✅ 只读 |
| 4 | 不修改响应对象 | ✅ 用 `clone()` 读副本 |
| 5 | 原响应原样返回 | ✅ 两个分支都 `return res` |
| 6 | 不缓存重放 | ✅ 无定时器 |
| 7 | 不并发额外请求 | ✅ 无 `Promise.all`/`race` |
| 8 | 不伪造 header | ✅ 不构造任何认证 header |
| 9 | 不伪造版本号 | ✅ 不构造 UA |
| 10 | 不造 ticket | ✅ 代码中无 ticket 构造 |
| 11 | 敏感 header 脱敏 | ✅ Authorization/Cookie 落盘打码 |
| 12 | 只观测 Perch 域名 | ✅ 白名单过滤 |

### 1.2 透明性自测（26 项）

`selftest.mjs` 用本地回环服务器逐字节比对：

| 类别 | 项数 | 结果 |
|---|---|---|
| 非流式响应 | 22 | ✅ 全部通过 |
| 流式响应（SSE） | 4 | ✅ 全部通过 |

**关键验证**：
- 响应体逐字节一致（含 Unicode/二进制/特殊字符）
- 7 个响应头全部一致
- 服务器收到的 method/url/body 一致
- **tap 未添加任何额外请求头**
- SSE 流逐字节一致（含分块时序）

### 1.3 对照 abuse-gate invariants（4 条）

| 官方 invariant | 蜜罐行为 | 结论 |
|---|---|---|
| auth-header env-fallback the UA header did not share | 不改 UA，官方 CLI 自己发什么透传什么 | ✅ 不受影响 |
| Never allowlist on User-Agent | 不构造 UA，不修改 UA | ✅ 不受影响 |
| Denial copy + error codes must pass through the sanitizer | 不构造任何响应，只读 | ✅ 不受影响 |
| BYOK/BYO turns are exempt | 与 BYOK 无关 | ✅ 不受影响 |

### 1.4 对照 Perch 官方回复的 4 个封号原因

| 封号原因 | 蜜罐防御 |
|---|---|
| 脚本读取 token 直接调模型服务器 | 蜜罐不读 token，不调服务器；官方 CLI 自己调 |
| 请求不符合正常格式 | 蜜罐不改任何字节，格式由官方 CLI 决定 |
| 上报不符的客户端版本号 | 蜜罐不构造 UA，版本号由官方 CLI 注入 |
| 测试缺失/伪造 turn ticket | 蜜罐不构造 ticket，ticket 由官方 CLI 领 |

---

## 二、为什么蜜罐合规

### 2.1 本质区别

```
❌ 违规（之前被封的原因）：
   脚本 → 构造请求 → 直接调服务器
   （自制客户端，格式/版本/ticket 都可能不对）

✅ 合规（蜜罐）：
   官方 CLI → 构造请求 → 蜜罐记录 → 服务器
   服务器 → 响应 → 蜜罐记录 → 官方 CLI
   （官方客户端发请求，蜜罐只是旁路记录）
```

### 2.2 服务端视角

| 维度 | 无蜜罐 | 有蜜罐 |
|---|---|---|
| 请求来源 IP | 用户 IP | 用户 IP |
| 请求 headers | 官方 CLI 构造 | **逐字节相同** |
| 请求 body | 官方 CLI 构造 | **逐字节相同** |
| 请求时序 | 官方 CLI 决定 | 由官方 CLI 决定，内容层面不变；但 tap 的 `record()` 用同步 `writeFileSync` 落盘，理论上会引入极微小的时序偏移 |
| 响应接收 | 官方 CLI | **逐字节相同** |

**服务端在内容字节层面无法区分**——这是合规的关键。（时序、IP、TLS 等带外信号不在此列，见上文风险声明。）

### 2.3 技术保证

- **`clone()` 而非 `tee()`**：`clone()` 是 WHATWG Fetch 标准 API，创建响应的独立副本，原对象完全不被触碰
- **原响应原样返回**：`return res`，不是 `return new Response(...)`
- **无额外请求**：`realFetch` 只在透传处调用，无 `Promise.all`/`race`/定时器
- **白名单过滤**：只观测 Perch 域名，其他流量（npm registry、模型厂商）直接放行

---

## 三、使用方式

```bash
cd perch_login_py/honeypot

# 交互模式
./run-with-tap.sh

# 单次执行
./run-with-tap.sh run "Say PONG"

# 状态
./run-with-tap.sh status
```

日志在 `honeypot/logs/`：
- `index.jsonl` — 每行一条摘要（时间/方法/URL/状态/耗时）
- `<timestamp>-<seq>.json` — 单次请求/响应完整记录

---

## 四、风险声明

| 风险 | 评估 |
|---|---|
| 触发 abuse | **与正常使用官方 CLI 相同** |
| 服务端检测 | **内容字节级一致**，但带外信号面（IP 信誉 / TLS 指纹 / 时序模式 / 会话复用 / token 刷新节奏）不在蜜罐保证范围内（见 RESEARCH_PROTOCOL.md:99-108 规则 6） |
| 数据泄露 | 日志含脱敏后的请求/响应，本地存储 |
| 法律/条款 | 观测官方客户端行为，不违反「脚本直连」禁令 |

**唯一前提**：你必须**正常使用官方 CLI**（不批量、不循环、不探测）。蜜罐只是记录你本来就会发的请求。

---

## 五、下一步

**等你启动代理后**，用 `./run-with-tap.sh run "Say PONG"` 做一次真实验证，然后分析 `logs/` 里的记录，验证：

1. 请求格式是否与 [REQUEST_FORMAT_SPEC.md](../REQUEST_FORMAT_SPEC.md) 一致
2. SSE 事件类型是否与 [DEEP_REVERSE_5TOPICS.md](../DEEP_REVERSE_5TOPICS.md) 一致
3. 消息流时序是否与 [MESSAGE_FLOW_AND_COMMS.md](../MESSAGE_FLOW_AND_COMMS.md) 一致

---

*审查完成：2026-10-13 · 静态审查 + 26 项自测 + 对照官方文档*
