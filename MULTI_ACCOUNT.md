# 多账号（openai-gateway.mjs）

> 单账号用法完全不变：没有 `accounts.json` 时，网关仍然只读 `token.json`（或 `state/token.json`）。

## 一句话

`accounts.json` 的**列表顺序就是优先级**。每个请求发出前，网关用 `/api/perchai/account` 的额度数据（缓存 30 秒）检查该账号 **manual 的 5h / 7d 窗口**；任一窗口用满就跳到下一个账号；全部用满则直接返回 **429**（消息里带每个账号的用量和最早恢复时间）。

## 配置

```json
{
  "accounts": [
    { "name": "主号", "enabled": true },
    { "name": "备用", "enabled": true }
  ],
  "usageTtlMs": 30000,
  "autoSwitch": true
}
```

**这个文件不用手写**：第一次 `login --account <名字>` 就会自动生成；之后每次加号会自动把名字**追加到末尾**（= 最低优先级），已有条目的位置保持不变。想调优先级就手动挪数组。

已有单账号的可以一键迁移（不重新登录）：

```bash
./run.sh migrate 主号     # 把现有 token.json 移动成 accounts/主号/token.json，并建 accounts.json
```

（用"移动"而不是复制：同一个 refresh_token 留两份会互相作废。）

| 字段 | 说明 |
|---|---|
| `name` | 账号名，同时是 token 的目录名：`accounts/<name>/token.json`（不允许 `\` `/` 或以点开头） |
| `enabled` | `false` = 完全不用它（会话保留） |
| `usageTtlMs` | 额度缓存时间，默认 30000（30 秒） |
| `autoSwitch` | 默认 `true`。**设为 `false` 时只用序列里第一个可用账号：额度满了直接 429，不自动换号**（更保守，适合"不想把多个号当成一个池子用"的场景） |

从 `accounts.example.json` 复制一份改名即可。

## 登录

```bash
./run.sh login --account 主号      # 浏览器登录，存到 accounts/主号/token.json
./run.sh login --account 备用
./run.sh accounts                  # 看顺序与额度
```

（`node perch-client.mjs ...` 等价；`run.sh` 除 `gateway`/`sync` 外都原样转给它，并自动处理直连/代理。）

- **`accounts.json` 不需要手建**：第一条 `login --account` 自动生成；之后每次加号把名字**追加到末尾**，已有条目的位置不变。
- 不带 `--account` 时仍写 `token.json`（单账号模式），**不会**碰 `accounts/`。
- 两个命令都支持 `--provider google|github`、`--callback`（本地回调）。

## 查看状态

```bash
node perch-client.mjs accounts            # 顺序 / 登录状态 / manual 窗口用量 / 是否已满
node perch-client.mjs accounts --no-usage # 只看配置，不请求额度
```

输出示例：

```
共 2 个账号（列表顺序即优先级）：
  1. 主号 — 已登录 | manual 5h 15/15 · 7d 37.5/37.5 ← 已满，2026-10-21T06:00:00.000Z 恢复
  2. 备用 — 已登录 | manual 5h 3.3/15 · 7d 31/37.5
```

## 预检与切换的边界

| 情况 | 行为 |
|---|---|
| 前一个账号的 manual 5h 或 7d 用满 | 跳过它，用下一个（日志里打 `跳过: 名字（manual …）`） |
| 额度接口读不到（网络失败等） | **不拦**（fail-open）：照常用它发；真失败时客户端重试，下一次再换号 |
| 全部账号都满 | 该请求直接 **429**，消息列出每个账号的窗口与最早恢复时间 |
| 请求进行中才发现额度不足 | **不能中途换号**（字节已经发给客户端了）：网关照实下发错误，同时作废该账号的额度缓存 → 下一个请求自动换 |
| 上游 `usage_limit_reached` | 非流式 → **429**；流式（响应头已发）→ 流内 `data:{"error":…}`（HTTP 仍 200） |
| 模型忙 / 其他上游错误 | 不影响选号，照实下发 |

## 日志

每次对话都会多一行（在 `解析:` 之后）：

```
[.. #12] 账号: 备用（manual 5h 3.3/15 · 7d 31/37.5） | 跳过: 主号（manual 5h 15.00/15、7d 37.50/37.5，最早恢复 2026-10-21T06:00:00.000Z）
```

## 合规与风控提醒（重要）

**这个功能天然带着"多凭证"的形状**，用之前请明确几点：

1. **服务端看到的模式**：同一台机器 / 同一出口 IP / 同一个 UA（`perchai-cli/unknown`）使用多个账号。仓库自己的风控笔记把"多凭证来源"直接列为**账号共享 / 凭证盗用**的特征（`ABUSE_SAFETY_GUIDE.md` 第 77 行）。
2. **自动跨号续跑 = 绕过套餐额度**：L3（轮次速率）/ L4（消费额度）是**商业限额**，触发它们不会封号；但"一个号用完自动换另一个号继续"在条款层面可能被当作**规避限额**——这是和"触发限额"完全不同性质的事。
3. 只放**你自己的**账号。把别人的账号挂进来，就是账号共享。

### 为此加的护栏

| 护栏 | 行为 |
|---|---|
| **冷却** | 一旦上游回 `usage_limit_reached`，该账号在**恢复时间（或 5 分钟）内不再被选中**，即使额度接口读不到也不会再去撞它 |
| **`autoSwitch: false`** | 只用序列里第一个可用账号，满了直接 429 —— 一键关掉"池化"行为 |
| **不自动重试** | 网关不会跨账号重放同一个请求；换号只发生在**下一个**请求上（客户端重试才会走到别的号） |
| **限速不换号** | `turn_rate_limited`（L3）**不会**触发换号：限速本来就是防 burst 的，换号绕过它更像滥用，所以照实回 429 |
| **禁止复制 token** | 文档明确要求用 `login --account` 重新登录；复制 `token.json` 会造成 refresh_token 互相作废，且形态上就是"凭证复用" |

### 建议

- 如果只是想给**自己的**两个订阅做容量冗余：建议 `"autoSwitch": false`，满额时自己决定要不要切。
- 不要为了"多号并行刷"去提高并发：服务端有每轮速率（L3），跨号并发在风控视角更像是账号池。
- 出现 `turn_rate_limited` / `usage_limit_reached` 时**等窗口滚动**，不要靠加号或加并发硬顶。

## token 会被覆盖吗？不会

| 场景 | 写到哪 |
|---|---|
| `login --account 主号` | **只写** `accounts/主号/token.json` |
| `login`（不带 `--account`） | 只写 `token.json`（单账号），**不碰** `accounts/` 下任何文件 |
| 网关里 token 过期自动刷新 | 显式带上该账号的文件：对话 / `/balance` / `/v1/usage` / 额度预检 / **model-call 的 401 重试**，全部只写回 `accounts/<该账号>/token.json` |
| `ask` 命令 | 有 `accounts.json` 时按优先级选号，刷新同样只写该号的文��� |

实测（把两个号的 token 都设成过期，触发真实刷新路径）：

```
刷新 a: → new-access-rt-a      写回 accounts/a/token.json
刷新 b: → new-access-rt-b      写回 accounts/b/token.json
token.json                    不存在 ✓（没有被创建/覆盖）
```

要点：

- **同一账号**被多进程同时刷新：`~/.perch/cli-auth-refresh.lock` 文件锁串行化，锁内会二次读文件，采用别人刚刷新好的结果，不会重复轮换。
- **不同账号**刷新互相独立：各自的文件、各自在内存里的 in-flight 去重 key（按 `appUrl::userId` 区分）。
- 已知的**极小竞态**：同时跑两个 `login --account` 时，`accounts.json` 是"读-改-写"，理论上可能丢一条记录（交互式登录很难同时发生；丢了手工补一行即可，token 文件本身不受影响）。
- 旧脚本 `perch_login.mjs` 是独立入口，只写 `state/token.json`，不参与多账号。

## 注意

- `accounts/` 和 `accounts.json` 已在 `.gitignore`（token 与个人信息都不入库）。
- **不要靠复制 `token.json` 造账号**：Supabase 会轮换 refresh_token，两份同样的 token 会互相作废。用 `login --account` 重新登录。
- token 刷新沿用官方同款文件锁（`~/.perch/cli-auth-refresh.lock`），多账号 / 多进程并发刷新是安全的。
- `/balance` 与 `/v1/usage`（magpie 的余额地址）报告的是**当前会用来服务请求的那个账号**；全部满额时退回显示第一个账号的真实数字（方便看到 100% 与恢复时间）。
