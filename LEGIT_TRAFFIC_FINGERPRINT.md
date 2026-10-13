# 合法流量指纹：官方 CLI 的规范请求序列与节奏

> 来源：蜜罐 5 个目录真实捕获（logs、logs-run1/2/3/5，共 38 条请求，全量 200）
> 实测修正：此前写「4 轮（logs-run1/2/3/5）」，遗漏了 `logs/` 目录；各目录条数为 run1=8、run2=8、run3=7、run5=8、logs=7（run4 为空）。
> 日期：2026-10-13
> 用途：作为「正常客户端长什么样」的基准，任何偏离都可量化

---

## 一、规范请求序列（一轮对话）

```
①  GET  /api/perch-terminal/cli-auth/config        (仅冷启动/登录态缺失时)
②  GET  /api/perch-terminal/public-model-default   (拿默认模型选择)
③  POST /api/perch-terminal/cli-context            (上下文准备)
④  POST /api/perch-terminal/turn-ticket            (领票)
⑤  POST /api/perch-terminal/cli-context            (再次准备，含工具上下文)
⑥  POST /api/perch-terminal/model-call             (推理，带 ticket 头)
⑦  POST /api/perch-terminal/cli-turn               (轮次收尾)
⑧  POST /api/perch-terminal/cli-learning           (训练采样上报)
```

**附加步骤（run5 实测）**：`GET /api/perchai/account` —— 仅在用 `--model` 显式选择模型后触发，位于 ② 与 ③ 之间；用途是拉取会话成员角色/套餐，以判断 internal 模型是否可见（见 MODEL_SWITCH_MECHANISM.md:79-84）。

**一次对话 = 7~8 个请求**（正常 7 个：②~⑧；冷启动多 ①，或经 `--model` 选择后多一个 account，均为 8 个。6 个的下限在任何一轮都未观测到）。

---

## 二、节奏指纹（4 轮实测，单位：秒）

| 步骤 | run1 | run2 | run3 | run5 | 典型值 |
|---|---|---|---|---|---|
| ①→② | — | 1.6 | — | — | ~1.6 |
| ②→③ | 1.2 | 1.3 | 2.2 | 2.2 | 1.2~2.2 |
| ③→④ | 0.5 | 0.5 | 0.6 | 0.5 | **0.5~0.6** |
| ④→⑤ | 8.1 | 3.3 | 3.9 | 3.1 | 3~8 |
| ⑤→⑥ | 4.2 | 4.1 | 5.4 | 5.0 | **4~5.4** |
| ⑥→⑦ | 1.3 | 1.2 | 1.3 | 1.3 | **~1.3** |
| ⑦→⑧ | 0.4 | 0.4 | 0.4 | 0.4 | **~0.4** |

> 实测修正：run5 的 ②→③（public-model-default → cli-context）实测为 2.2s；此前记的 1.1s 其实是 account → cli-context 的间隔（run5 因 `--model` 多了一个 account 请求，夹在 ② 与 ③ 之间）。

**稳定特征**：
- ③→④（context → ticket）恒为 **0.5~0.6s**（本地连续调用）
- ⑤→⑥（context → model-call）恒为 **4~5.4s**（含工具上下文组装）
- ⑥→⑦（model-call → cli-turn）恒为 **~1.3s**
- ⑦→⑧（cli-turn → cli-learning）恒为 **~0.4s**
- 单请求延迟：ticket 400~600ms，model-call 1.0~1.2s，cli-context 1.0~2.2s

---

## 三、请求头指纹

| 端点 | 头 | 值 |
|---|---|---|
| 全部 | `Content-Type` | `application/json` |
| 全部（有 token） | `Authorization` | `Bearer <JWT>` |
| turn-ticket / model-call（Node） | `User-Agent` | `perchai-cli/<PERCH_CLI_VERSION>`（实测为 `perchai-cli/unknown`） |
| model-call（流式） | `Accept` | `text/event-stream` |
| model-call | `x-perch-turn-ticket` | 领票返回的 ticket |

> 实测修正：`User-Agent` 只出现在 **turn-ticket** 与 **model-call** 两个端点；其余端点（cli-context、cli-turn、cli-learning、public-model-default、cli-auth/config、`perchai/account`）都不带 UA。此前标注「全部（Node）」与实测不符。

**关键**：`User-Agent` 是 hosted-model gate 校验的一部分（abuse-gate invariant），但服务端**接受版本缺失**——`PERCH_CLI_VERSION` 取不到时，客户端按官方设计降级为 `perchai-cli/unknown`（bin/perch 注释：missing version degrades to "unknown"）。官方封号邮件针对的是**谎报与安装不符的版本号**，而非缺失。实测 38 条日志的 UA 全部为 `perchai-cli/unknown`，全部 200 通过。

---

## 四、请求体指纹（model-call）

```json
{
  "request": { "messages": [...], "tools": [...57 个...], "temperature": 0.6, "maxTokens": 32000, "toolChoice": "auto" },
  "runId": "tkt-cli-<ts>-<rand>",
  "lane": "chat",
  "strictManual": false,
  "preferredModelId": "...",
  "avoidModelIds": [...28 个...],
  "attribution": { "userId": "...", "workspaceId": "...", "runId": "...", "lane": "chat", "source": "cli", "billingMultiplier": null },
  "clientSurface": "cli"
}
```

---

## 五、偏离检测清单（任何一项偏离 = 异常信号）

| # | 检查项 | 正常值 | 偏离含义 |
|---|---|---|---|
| 1 | 请求数/轮 | 7~8 | 少于 7 = 缺步骤；明显多出 = 探测 |
| 2 | ③→④ 间隔 | 0.5~0.6s | 太快 = 脚本；太慢 = 非官方节奏 |
| 3 | ⑤→⑥ 间隔 | 4~5.4s | 明显更短 = 脚本直连 |
| 4 | 端点顺序 | 固定 | 乱序 = 非官方客户端 |
| 5 | UA 版本号 | 与安装一致；缺失时降级为 `unknown`（服务端接受） | **谎报**与安装不符的版本号 = 官方列出的封号原因之一；仅缺失不构成封号信号 |
| 6 | ticket | 每轮新领 | 缺失/伪造 = 官方列出的封号原因之一 |
| 7 | 认证方式 | 仅 Bearer | 其他 = 凭证绕过尝试 |
| 8 | 写操作 | 无 | 有任何 insert/update/rpc = 越权 |
| 9 | 请求间隔 | ≥ 数百 ms | 突发高频 = 扫描特征 |

---

## 六、结论

**官方 CLI 的正常流量是高度规律、可预测的**：固定序列、固定节奏、固定头、固定体。服务端的 abuse gate 就是拿这个"正常形状"做基准，识别偏离者。

**对研究的含义**：
- 蜜罐观测到的就是"合法"的完整定义 —— 不需要再发明任何东西
- 任何"复刻"尝试，只要偏离上述任一指纹（哪怕 1 个请求头），就是把自己变成异常
- 唯一安全的"交互研究" = 继续用蜜罐观测官方 CLI 的自然行为，并扩大观测面（不同命令、不同模式、BYO 开关前后）

---

## 七、附：38 条记录全量状态

- 状态码：**38/38 全部 200**
- 错误响应：**0**
- 触发 gate：**0**
- 结论：官方 CLI 自然使用 = 零告警（与 COMPLIANCE_AUDIT 结论一致）