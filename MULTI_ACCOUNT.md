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
  "usageTtlMs": 30000
}
```

| 字段 | 说明 |
|---|---|
| `name` | 账号名，同时是 token 的目录名：`accounts/<name>/token.json`（不允许 `\` `/` 或以点开头） |
| `enabled` | `false` = 完全不用它（会话保留） |
| `usageTtlMs` | 额度缓存时间，默认 30000（30 秒） |

从 `accounts.example.json` 复制一份改名即可。

## 登录

```bash
node perch-client.mjs login --account 主号      # 浏览器登录，存到 accounts/主号/token.json
node perch-client.mjs login --account 备用
```

- `login --account` 会把名字**追加**到 `accounts.json`；已存在的保留原位置（顺序不变）。
- 不带 `--account` 时仍写 `token.json`（单账号模式）。
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

## 注意

- `accounts/` 和 `accounts.json` 已在 `.gitignore`（token 与个人信息都不入库）。
- **不要靠复制 `token.json` 造账号**：Supabase 会轮换 refresh_token，两份同样的 token 会互相作废。用 `login --account` 重新登录。
- token 刷新沿用官方同款文件锁（`~/.perch/cli-auth-refresh.lock`），多账号 / 多进程并发刷新是安全的。
- `/balance` 与 `/v1/usage`（magpie 的余额地址）报告的是**当前会用来服务请求的那个账号**；全部满额时退回显示第一个账号的真实数字（方便看到 100% 与恢复时间）。
