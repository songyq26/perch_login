# Perch 并发与限制机制全景

> 证据源：`dist/perch.mjs` 静态逆向（常量还原 + 错误码枚举）+ 蜜罐实测验证限额档位
> 日期：2026-10-13
> 归属：本文是 [FULL_LIFECYCLE.md](./FULL_LIFECYCLE.md) 的限制机制专题篇

---

## 一、七层限制体系总览

```
┌─────────────────────────────────────────────────────┐
│ L1  单轮 Agent 并发      16 并发（池 8）    本地调度  │
│ L2  轮次闸门             一票一轮          403       │
│ L3  轮次速率             turn_rate_limited 429      │
│ L4  消费限额             滚动窗口 $        429       │
│ L5  后台任务并发         maxConcurrent     本地拒绝  │
│ L6  工具调用预算         maxSteps/迭代上限 本地拒绝  │
│ L7  跨进程互斥           刷新锁/thread 覆盖 文件锁   │
└─────────────────────────────────────────────────────┘
```

---

## 二、逐层详解

### L1：单轮 Agent 并发（本地调度层）

```js
// 逆向还原（tWt / rWt）
function maxAgentsPerTurn() {
  let t = parseInt(process.env.PERCH_MAX_AGENTS_PER_TURN);
  return Number.isFinite(t) && t > 0 ? Math.min(t, 64) : 16;   // 默认 16，上限 64
}
function agentPoolConcurrency() {
  let t = parseInt(process.env.PERCH_AGENT_POOL_CONCURRENCY);
  return Number.isFinite(t) && t > 0 ? Math.min(t, 16) : 8;    // 默认 8，上限 16
}
```

| 参数 | 默认 | 可调上限 |
|---|---|---|
| `PERCH_MAX_AGENTS_PER_TURN` | 16 | 64 |
| `PERCH_AGENT_POOL_CONCURRENCY` | 8 | 16 |

**作用对象**：`spawn_worker` / `spawn_worker_batch` / `dispatch_agent` 派发的子 agent。
超出并发数的 agent 在本地池排队，不触发服务端错误。

### L2：轮次闸门（turn-ticket，服务端）

**一票一轮**是 abuse gate 的核心设计：

- 每轮对话前 `POST /api/perch-terminal/turn-ticket` 领票
- **一张票绑定一个 runId**（`tkt-cli-<ts>-<rand>`），不可复用到其他轮
- 有效期实测 **5 分钟**（payload `exp`）；客户端 30s 前开始续期
- 票据 claims：`{tid, uid, wid, surface, plan, run, exp}` + 32 字节 HMAC 签名
- 无票调用 `model-call` → **403 not_authorized**

**并发含义**：想并行发起多轮，就需要多张票；票据签发本身受 L3 速率限制。

### L3：轮次速率（服务端）

- 错误码 `turn_rate_limited`（429）
- 触发文案："Your plan's Perch turn rate limit has been reached."
- 由票据签发端点执行（响应 `enforced: true` 表示强制执行）
- 属于**滑动窗口限流**，等待窗口滚动即可恢复，不影响账号

### L4：消费限额（服务端，滚动窗口）

| 档位 | 5 小时窗口 | 每周窗口 |
|---|---|---|
| Starter | **$2.50**（≈2,500 PT） | **$7.50** |
| Roost | **$5.00** | **$20.00** |
| Manual | **$15.00** | **$37.50** |

**Pilot（独立维度：每日）**：每日上限 `PERCH_PILOT_USER_DAILY_CAP_USD = **$5.00**`，不套用上表的 5 小时/每周滚动窗口。

> 实测修正：Pilot 是「每日」上限（代码里的 `userDailyCap`），此前误放进 5 小时列；每日池与 Starter/Roost/Manual 的 5h/每周窗口是互相独立的维度。

**计费规则**（usage-billing 文档 + 逆向）：

- 1 PT = $0.001 billed provider-equivalent 用量
- Starter 20,000 PT/月；Pro 75,000 PT/月 + 无限 Roost fair use
- 按 **BILLED tokens** 计（非原始 tokens）
- **promo pin 排除**在限流外（避免双重门控）
- 费率两处存储必须一致：`FALLBACK_RATES`（inferenceCost.ts，权威）与 `perch_ai_inference_model_rates` 表

**逆向还原的配置函数**（`oDt`）：

```js
function spendCaps() {
  return {
    enabled:      env.PERCH_PILOT_SPEND_CAP_ENABLED !== "false",
    userDailyCap: num(env.PERCH_PILOT_USER_DAILY_CAP_USD, 5),
    starter: { 5h: num(env.PERCH_STARTER_5H_CAP_USD, 2.5),
               weekly: num(env.PERCH_STARTER_WEEKLY_CAP_USD, 7.5) },
    roost:    { 5h: num(env.PERCH_ROOST_5H_CAP_USD, 5),
               weekly: num(env.PERCH_ROOST_WEEKLY_CAP_USD, 20) },
    manual:   { 5h: num(env.PERCH_MANUAL_5H_CAP_USD, 15),
               weekly: num(env.PERCH_MANUAL_WEEKLY_CAP_USD, 37.5) },
  };
}
```

**错误码**：`usage_limit_reached`（429）；文案特征（HMe 分类器匹配）："usage limit" / "pilot capacity" / "monthly allowance"。

**已知服务端缺陷**（官方文档承认）：强制路径用未分页 PostgREST select（可能被 max-rows 截断），显示路径用 SQL 聚合——**两者可能不一致**。

### L5：后台任务并发（本地）

- 错误码 `too_many_concurrent`
- 文案："Too many concurrent background tasks (max ${p4.maxConcurrent}). Wait for one to finish or kill it."
- 作用对象：`run_in_background` 启动的 shell 任务
- 本地拒绝，不发服务端请求

### L6：工具调用预算（本地 + 编排层）

| 场景 | 上限 | 错误码 |
|---|---|---|
| suite 执行器（multiStepExecutor） | **maxSteps 10** | `suite_execution_failed` |
| worker 迭代 | `maxIterations 3~20`（reader 20 / analyst 3 / chart 2） | `tool_call_budget_exhausted` |
| 主对话 toolLoop | ~64 迭代（invariants 提及） | — |
| 源分析轮次 | `source_analysis_iteration_cap` | `source_analysis_max_iteration_*` |

### L7：跨进程互斥（本地文件锁）

**Token 刷新互斥**（防止 refresh_token 轮换竞争）：

```
~/.perch/cli-auth-refresh.lock     ← open(wx) 排他创建，内容含 pid
  - 其他进程 EEXIST → 轮询等待（50ms 间隔）
  - 等待上限 15s（URr）
  - 锁文件 >30s 视为陈旧（LRr），强制删除重试
  - 配套退避：刷新失败后 30s 内不重试（Roe）
  - 配套吊销缓存：cli-auth-refresh.invalid.json（SHA-256 + 24h TTL）
```

**并发风险点**：threadId 由 cwd 哈希决定（`cli-cwd-<hash>`），**同目录开两个 perch 进程会共享同一 thread JSON**，后写覆盖先写的对话历史（这是设计上的已知竞态，无锁保护）。

---

## 三、错误码速查（限制类）

| 错误码 | HTTP | 层 | 恢复方式 |
|---|---|---|---|
| `not_authorized` | 403 | L2 | 领票后重试 |
| `turn_rate_limited` | 429 | L3 | 等窗口滚动 |
| `usage_limit_reached` | 429 | L4 | 等窗口滚动 / 升级套餐 |
| `starter_model_blocked` | 403 | L4 | "Upgrade to Pro" |
| `too_many_concurrent` | — | L5 | 等任务结束 / kill |
| `tool_call_budget_exhausted` | — | L6 | 新开一轮 |
| `context_overflow` | — | 上下文 | 触发 compaction |
| `promo_overflow_decision` | 200* | L4 | 弹窗选 Continue on Manual |

---

## 四、实测验证状态

| 结论 | 来源 |
|---|---|
| 票据 5 分钟有效期、绑定 runId | 蜜罐实测（exp 字段 + 三端点同 runId） |
| 消费档位 $2.5/$5/$15 5h | 逆向常量（未触限，无需实测） |
| 16/8 agent 并发默认 | 逆向（env 可覆盖） |
| 票据 enforced 标志 | 蜜罐实测（响应含 enforced 字段） |
| avoidModelIds 28 个 | 蜜罐实测（请求体捕获） |

---

## 五、对使用与研究的意义

1. **正常使用几乎只会碰到 L4**（消费限额）：Starter $2.50/5h ≈ 每轮 26k input tokens 的话约几十轮
2. **多进程并行研究要注意 L7**：同目录并发会互踩 thread 历史；刷新有锁保护是安全的
3. **flock 多 agent 受 L1 约束**：超过 16 并发的 worker 会在本地排队
4. **限额触发不封号**：L3/L4 是保护性限流，与 abuse 封禁是完全独立的机制——abuse 是条款问题（脚本直连），限额是商业问题（套餐额度）

---

*整理完成：2026-10-13 · 全部来自既有逆向与蜜罐数据，零新增网络请求*
