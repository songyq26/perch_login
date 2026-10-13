# `/model` 模型选择与固定机制（逆向 + 实测双证）

> 证据：`dist/perch.mjs` 逆向（`Y_r`/`fL`/`Xlo`/`wun`）+ 蜜罐实测 3 次对比（无 pin / `--model pro` / `--model "DeepSeek V4.1 Flash"`）
> 日期：2026-10-13

---

## 一、TUI 菜单如何刷出来（逆向确认：纯本地）

### 1.1 菜单构建器 `Y_r()`

```js
function Y_r(now = new Date()) {
  let items = [{ kind: "group", label: "Roost" }];
  // 4 个 tier
  for (let n of eco)   // eco = ["standard","standard_max","pro","pro_max"]
    items.push({ kind: "tier", label: a2[n],
                 hint: `${n.startsWith("pro") ? "premium" : "everyday"} · ${Wle[n].replace(" context","")}`,
                 choice: n });
  // 两个模型组
  let addGroup = (label, list, map, hint) => {
    items.push({ kind: "group", label });
    for (let s of list) {
      let id = map[s];
      id && items.push({ kind: "manual", label: yBe(s, now), hint, name: s, optionId: id });
    }
  };
  addGroup("Models",      uRt(now), SB, "");   // Starter 列表（含促销标记）
  addGroup("Pro Models",  dRt(now), SB, "pro"); // Pro 列表（过滤促销期模型）
  return items;
}
```

### 1.2 菜单结构（还原）

```
▸ Roost
    Standard       everyday · 200K
    Standard Max   everyday · 1M
    Pro            premium · 200K
    Pro Max        premium · 1M
  Models
    Laguna S 2.1 …
    Qwen 3.8 27B (Starter) …
    …
  Pro Models
    Claude Opus 5.5 …            pro
    GPT-6.1 Sol …                pro
    DeepSeek V4.1 Flash …        pro   ← 目标
    …
──────────────────────────────────
↑/↓ move · Enter select · Esc cancel
（每页 12 条，↑ N more / ↓ N more 翻页）
```

### 1.3 关键结论

- **零网络请求**：列表完全来自内存注册表（`SB` = optionId 映射、`uRt`/`dRt` = 动态过滤促销），不调任何 API
- **`(Promo)` 标记**：`yBe(name, now)` 对促销期模型（至 2026-10-13 18:30 UTC）加后缀
- **促销过滤**：`dRt()` 在促销期把 `qwen-3.8-27b` 换成 flash/max 变体；过期后恢复

---

## 二、选中后发生什么（逆向 + 实测）

### 2.1 本地状态更新

```
Enter 选中 →
  state.manualModelOptionId = optionId      （如 "dashscope-deepseek-v4-1-flash"）
  写 perch.manualModelUserSelection.v1（内存+localStorage 语义）
  写 ~/.perch/cli-settings.json             （持久化，跨会话生效）
  uB(optionId)  ← BYOK OAuth 特例处理（非 OAuth 模型为空操作）
```

### 2.2 唯一的网络调用（只读）

```
Gre() → GET /api/perchai/account
        Headers: Authorization: Bearer …
        响应: {ok, session: {membershipRole, planCode}}
        用途: 判断 internal/admin 权限（决定 internal 模型是否可见）
        特性: 只读、幂等、5s 超时
```

### 2.3 下一次对话生效（实测捕获）

pin 后的 `model-call` 请求体**新增字段**：

```json
{
  "preferredModelId": "dashscope-deepseek-v4-1-flash",
  "manualModelOptionId": "dashscope-deepseek-v4-1-flash",   ← 关键字段（wun() 注入）
  ...
}
```

**服务端强制执行**（model-routing 文档："Manual pins are enforced server-side"）——即使 preferredModelId 与 avoid 列表冲突，服务端按 manualModelOptionId 路由。

---

## 四、三次实测对比（蜜罐数据，均为用户正常使用产生的流量）

| | run3（无 pin） | run5a（--model pro） | run5b（--model "DeepSeek V4.1 Flash"） |
|---|---|---|---|
| `manualModelOptionId` | ❌ 无 | ❌ 无 | ✅ `dashscope-deepseek-v4-1-flash` |
| `preferredModelId` | `wandb-qwen3-6-35b-a3b` | `wandb-zai-org-glm-5-1` | `dashscope-deepseek-v4-1-flash` |
| `roostModelChoice` | ❌ 无 | ✅ `"pro"` | ❌ 无 |
| `roostReasoning` | ❌ 无 | ✅ `true` | ❌ 无 |
| `effort` | ❌ 无 | ✅ `{level:"high"}` | ❌ 无 |
| 实际模型（done） | `poolside/laguna-s-2.1` | `gpt-6-luna` | **`deepseek-v4.1-flash`** |
| snapshot modelId | `Qwen/Qwen3.6-35B-A3B` | `zai-org/GLM-5.1` | `deepseek-v4.1-flash` |
| 上下文窗口 | 200k | 200k | **1M（980k effective）** |
| 缓存 | cacheRead 7,776 | cacheCreation 21,832 | cacheRead 0 |

### 关键观察

1. **字段互斥规律**：tier 选择注入 `roostModelChoice/roostReasoning/effort` 三件套；具名 pin 注入 `manualModelOptionId`。二者不共存
2. **三个"模型"字段三层含义**：
   - `preferredModelId` = 客户端偏好（建议）
   - `manualModelOptionId` = 强制 pin（服务端执行）
   - done 事件 `model` = **实际运行的模型（唯一真相）**
3. **窗口跳变**：pin DeepSeek 后 UI 显示 `47k / 1000k`——contextWindow 来自被 pin 模型的元数据（1M），effectiveLimit 打 98 折
4. **缓存重置**：换模型后缓存键变化，cacheRead 归零

### 与 model-routing 文档的相互印证

内嵌文档的三条 invariants 在正常使用流量中得到体现：

| invariant | 流量证据 |
|---|---|
| "A manual pin needs BOTH the selection override AND manualModelOptionId" | 非交互 `perch run` 不注入已保存 pin → 服务端按 Roost 路由（设计如此）；显式 `--model "<名字>"` 时字段齐全 → pin 生效 |
| "verify which model ACTUALLY ran, use billing attribution, NEVER contextSnapshot.modelId" | 档位模式下 snapshot 显示 GLM-5.1 但实际运行 gpt-6-luna |
| "Manual pins are enforced server-side" | 请求带 manualModelOptionId 后 done.model 严格等于该模型 |

**pin 在两种场景下的行为（均为官方设计）**：
- 交互模式（TUI `/model` 后对话）：pin 生效
- `perch run --model "<名字>"`：显式指定时生效

---

## 五、名字 → optionId 解析链（`fL`）

```
输入 "DeepSeek V4.1 Flash"
  ↓ fRt(): 小写 + 非字母数字转连字符 → "deepseek-v4-1-flash"
  ↓ Qnn[归一化名] 反查 → 原始名 "deepseek-v4.1-flash"
  ↓ lRt[原始名] → optionId "dashscope-deepseek-v4-1-flash"
```

**归一化规则**（`fRt`）：`trim().toLowerCase().replace(/[\s_.-]+/g, "-")`——所以 `/model deepseek v4.1 flash`、`/model DeepSeek-V4.1_Flash` 等写法都解析到同一个。

**tier 归一化**（`jnn`）：`standardmax→standard_max`、`promax|max→pro_max`、`auto→standard`。

---

## 六、abuse 风险评估（实测前的判断依据）

| 操作 | 网络影响 | 风险 |
|---|---|---|
| TUI 打开 `/model` 菜单 | **零**（本地构建） | 无 |
| 键盘浏览/翻页 | 零 | 无 |
| Enter 选中 | 1 个只读 `GET /api/perchai/account`（幂等） | 与正常使用无异 |
| 之后的对话 | 正常 model-call 链（多一个字段） | 与正常使用无异 |

**结论**：整个 `/model` 流程本质是「本地设置切换 + 下次请求多带一个字段」，无任何探测/伪造性质，蜜罐实测 3 次全部 200。

---

*分析完成：2026-10-13 · 逆向先行 + 蜜罐验证，全程合规*
