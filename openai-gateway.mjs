#!/usr/bin/env node
// OpenAI 兼容网关：把 OpenAI Chat Completions 请求翻译成 Perch model-call
//
//   HTTPS_PROXY=http://127.0.0.1:7890 node --use-env-proxy openai-gateway.mjs [--port 8787]
//
// 然后任何使用 OpenAI SDK 的 agent 直接接入：
//   new OpenAI({ baseURL: "http://127.0.0.1:8787/v1", apiKey: "perch-local" })
//
// model 传 "perch" 走服务端自动路由；传真实模型 id（如 wandb-qwen3-6-35b-a3b）
// 会作为 preferredModelId 上报。tools / tool_choice / tool_calls 按 OpenAI 格式
// 透传，工具执行在客户端（你的 agent）完成，与官方 CLI 的分工一致。
//
// 与 OpenAI 协议的已知差异（上游决定）：工具调用参数不做增量流式（在
// tool_use_end/done 后整段下发）；reasoning_delta 映射为 delta.reasoning_content
// （非标准扩展字段）；stream_restart 无法在 OpenAI 协议里表达回滚。
//
// 流式心跳：Perch 的 /model-call 每 15.00s 发一行 `: keepalive` 注释（官方客户端只拿它
// 续命、丢弃注释，且自身没有空闲超时）。本网关发同款注释——连上先发一个，之后默认每 5s 一个
// （比官方 15s 更密，纯本地行为、不额外消耗额度），覆盖推理期的长静默；PERCH_KEEPALIVE_MS=0 关闭。
// 注释后不带空行（照 magpie 的写法）：空块会被 openai-go v2 那类客户端当成事件而报错。
//
// 推理强度（reasoning_effort / reasoning.effort，none→off、minimal→low 自动映射）：
//   · 档位请求（model=pro 等）：随 Roost 三件套发送（官方行为）
//   · pin / 自动路由请求：默认也随请求转发（实测服务端会采纳；官方 CLI 不发送
//     这一组合，属本网关的扩展能力）；PERCH_FORWARD_PIN_EFFORT=0 可关闭
//   · 每个请求打印逐行 trace（收到→解析→effort→外发→完成），便于排查
//
// 用量：GET /usage 返回本进程记录的每次请求的用量流水（含 runId，可对账）；
// GET /usage/upstream 用 runId 调服务端 /api/perch-terminal/usage 拿权威用量。
// 余额：GET /balance 完整配额视图（plan/月用量、Roost 与 manual 的 rolling 窗口、credit）；
// GET /v1/usage 是 magpie 的余额地址：只交出 manual（手动模型）那组窗口，并改名为
//   magpie 认得的 5h / 7d（它只认这三个名字、同名只取第一条），路由与卡片都按它权衡。
//   magpie 侧余额地址填 http://<host>:<port>/v1/usage、key 填本网关的 API key。

import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { APP_URL, loadSession, ensureFresh, postJson, callModel, readSSE, createTicketManager, fallbackRunId, loadModels, resolveModel, resolveTier, roostFields, ROOST_TIERS, ROOST_EFFORT_LEVELS, LOCALE_HEADER } from "./perch-core.mjs";
import { pickAccount, describeAccount, invalidateUsage, markExhausted } from "./accounts.mjs";
import { syncIfStale } from "./sync-models.mjs";

const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const PORT = Number(process.env.PORT ?? flagValue("--port") ?? 8787);
const HOST = flagValue("--host") ?? process.env.HOST ?? "127.0.0.1";
const MAX_TOKENS_CAP = 32000;
// SSE 心跳：官方 Perch 在 /model-call 上每 15.00s 发一行 `: keepalive` 注释（实测 181s 里 13 个，
// 间隔恒定），客户端只拿它续命、不当内容——推理阶段是全程静默的，没有它客户端会被空闲超时误杀。
// 本网关默认收紧到 5s（比官方密，纯本地行为、不额外消耗额度），PERCH_KEEPALIVE_MS=0 可关闭。
const KEEPALIVE_MS = Number(process.env.PERCH_KEEPALIVE_MS ?? 5000);
// pin/自动路由的 effort 转发：默认开启（实测服务端会采纳这个组合；官方 CLI 不发送它）
// 关闭方式：PERCH_FORWARD_PIN_EFFORT=0
const FORWARD_PIN_EFFORT = !["0", "false", "off"].includes(String(process.env.PERCH_FORWARD_PIN_EFFORT ?? "").trim().toLowerCase());
const ts = () => new Date().toISOString().slice(11, 23);
const CTX_TTL_MS = 15 * 60 * 1000;
const API_KEY_FILE = path.join(import.meta.dirname, "api-key.txt");

let apiKey = null;

async function setupApiKey() {
  const flagKey = flagValue("--key") ?? process.env.GATEWAY_API_KEY;
  if (flagKey === "auto") {
    const existing = (await fs.readFile(API_KEY_FILE, "utf8").catch(() => null))?.trim();
    if (existing) {
      apiKey = existing;
      return { generated: false };
    }
    const key = randomBytes(24).toString("hex");
    await fs.writeFile(API_KEY_FILE, key + "\n", { mode: 0o600 });
    await fs.chmod(API_KEY_FILE, 0o600).catch(() => {});
    apiKey = key;
    return { generated: true };
  }
  if (flagKey) {
    apiKey = flagKey.trim();
    return { generated: false, fromEnv: true };
  }
  const fileKey = (await fs.readFile(API_KEY_FILE, "utf8").catch(() => null))?.trim();
  if (fileKey) {
    apiKey = fileKey;
    return { generated: false, fromFile: true };
  }
  return null;
}

function checkAuth(req) {
  if (!apiKey) return true;
  const auth = String(req.headers["authorization"] ?? "");
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const xKey = String(req.headers["x-api-key"] ?? "").trim();
  return bearer === apiKey || xKey === apiKey;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJson(res, status, obj) {
  if (res.headersSent) return res.end();
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: { message: String(message), type: status === 400 ? "invalid_request_error" : "api_error" } });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) {
        reject(httpError(413, "请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(httpError(400, "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function normalizeMessages(messages) {
  return messages.map((m) => {
    const msg = { ...m };
    if (Array.isArray(msg.content)) {
      const parts = [];
      let hasImage = false;
      for (const p of msg.content) {
        if (typeof p === "string") {
          parts.push({ type: "text", text: p });
          continue;
        }
        if (p?.type === "text" && typeof p.text === "string") {
          parts.push({ type: "text", text: p.text });
          continue;
        }
        // 图片按官方线上格式原样透传（{type:"image_url", image_url:{url: dataUrl|http(s)}}
        if (p?.type === "image_url" && typeof p.image_url?.url === "string") {
          const url = p.image_url.url;
          if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(url) || /^https?:\/\//i.test(url)) {
            parts.push({ type: "image_url", image_url: { url } });
            hasImage = true;
          } else {
            parts.push({ type: "text", text: "[image: 不支持的 URL 格式，已省略]" });
          }
          continue;
        }
        parts.push({ type: "text", text: `[${p?.type ?? "unknown"} 内容已省略]` });
      }
      msg.content = hasImage ? parts : parts.map((x) => x.text).join("\n");
    }
    if (msg.role === "assistant" && msg.tool_calls && (msg.content == null)) msg.content = "";
    if (msg.role !== "assistant" && msg.tool_calls) delete msg.tool_calls;
    delete msg.refusal;
    delete msg.audio;
    return msg;
  });
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && typeof messages[i].content === "string" && messages[i].content.trim()) {
      return messages[i].content;
    }
  }
  return "";
}

function mapToolChoice(tc) {
  if (tc == null) return "auto";
  if (tc === "auto" || tc === "required") return tc;
  if (tc === "none") return null;
  if (typeof tc === "object" && tc.type === "function") return "required";
  return "auto";
}

function toOpenAIToolCalls(tcs) {
  return (tcs ?? []).flatMap((tc, i) => {
    const fn = tc?.function ?? tc;
    const name = typeof fn?.name === "string" ? fn.name : null;
    if (!name) return [];
    const argv = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    return [{
      index: i,
      id: typeof tc.id === "string" && tc.id ? tc.id : `call_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      type: "function",
      function: { name, arguments: argv },
    }];
  });
}

function toOpenAIUsage(u) {
  if (!u) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    prompt_tokens: u.inputTokens ?? 0,
    completion_tokens: u.outputTokens ?? 0,
    total_tokens: u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
    prompt_tokens_details: { cached_tokens: u.cacheReadInputTokens ?? 0 },
  };
}

let ctxCache = null;
async function getWorkspace(session, query) {
  if (ctxCache && ctxCache.userId === session.userId && Date.now() - ctxCache.at < CTX_TTL_MS) return ctxCache.info;
  const r = await postJson(`${APP_URL}/api/perch-terminal/cli-context`, {
    Accept: "application/json", "Content-Type": "application/json",
    Authorization: `Bearer ${session.accessToken}`,
    ...LOCALE_HEADER,
  }, { query: (query || "/status").slice(0, 500), limitPerScope: 8 });
  const info = r.data?.session;
  if (r.status !== 200 || !info?.workspaceId) {
    throw httpError(502, `上游 cli-context 失败（HTTP ${r.status}）：${JSON.stringify(r.data).slice(0, 200)}`);
  }
  ctxCache = { at: Date.now(), userId: session.userId, info };
  return info;
}

// 服务端实时默认模型（public-model-default），15 分钟缓存；服务端先行上线的模型会出现在这里
let defaultsCache = { at: 0, ids: new Set() };
async function getServerDefaultIds(session, tokenFile = null) {
  if (Date.now() - defaultsCache.at < CTX_TTL_MS) return defaultsCache.ids;
  try {
    const fresh = await ensureFresh(session, false, tokenFile);
    const r = await fetch(`${APP_URL}/api/perch-terminal/public-model-default`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${fresh.accessToken}` },
    });
    const sel = (await r.json().catch(() => null))?.selection ?? {};
    defaultsCache = { at: Date.now(), ids: new Set(Object.values(sel).filter((v) => typeof v === "string" && v)) };
  } catch {
    defaultsCache = { at: Date.now(), ids: new Set() };
  }
  return defaultsCache.ids;
}

async function consumeUpstream(up, onDelta) {
  let text = "";
  let reasoning = "";
  let toolCalls = [];
  let doneEv = null;
  let streamError = null;
  // 诊断：流"静悄悄结束"时（没有 done、也没有 error）要能说清它经历了什么
  const stat = { events: 0, kinds: [], lastAt: 0, started: Date.now(), otherTypes: [] };
  await readSSE(up, (ev) => {
    stat.events++;
    stat.lastAt = Date.now();
    const kind = ev.type === "answer_delta" ? "answer" : ev.type === "reasoning_delta" ? "reasoning" : ev.type ?? "?";
    if (stat.kinds[stat.kinds.length - 1] !== kind) stat.kinds.push(kind);
    if (stat.kinds.length > 12) stat.kinds.shift();
    if (!["answer_delta", "reasoning_delta", "tool_call_delta", "tool_use_end", "done", "error"].includes(ev.type)) {
      stat.otherTypes.push(String(ev.type ?? "?"));
    }
    if (ev.type === "answer_delta" && typeof ev.text === "string") {
      text += ev.text;
      onDelta?.({ content: ev.text });
    } else if (ev.type === "reasoning_delta" && typeof ev.text === "string") {
      reasoning += ev.text;
      onDelta?.({ reasoning_content: ev.text });
    } else if ((ev.type === "tool_call_delta" || ev.type === "tool_use_end") && Array.isArray(ev.toolCalls)) {
      toolCalls = ev.toolCalls;
    } else if (ev.type === "done") {
      doneEv = ev;
    } else if (ev.type === "error") {
      streamError = String(ev.message ?? "stream error");
    }
  });
  const finalRaw = doneEv?.toolCalls?.length ? doneEv.toolCalls : toolCalls;
  const sealed = (finalRaw ?? []).filter((tc) => tc?.sealed !== false);
  return { text, reasoning, toolCalls: sealed, doneEv, streamError, stat };
}

// 收尾不正常时（没有 done、error 事件、done 说失败、done 缺模型/用量）把它"怎么结束的"打成一行
function logUpstreamTail(up, tag) {
  const { stat, doneEv, streamError, text, reasoning, toolCalls } = up;
  if (streamError) {
    console.warn(`[${ts()}] ${tag} 上游 error 事件：${streamError.slice(0, 300)} | 事件 ${stat.events} 个 | 序列 ${stat.kinds.join("→")}`);
    return true;
  }
  if (!doneEv) {
    const ended = Date.now();
    const quiet = stat.lastAt ? `${ended - stat.lastAt}ms` : "从未收到事件";
    console.warn(
      `[${ts()}] ${tag} 上游流结束但没给 done：开了 ${ended - stat.started}ms | 事件 ${stat.events} 个 | ` +
      `最后事件后静默 ${quiet} | 事件序列 ${stat.kinds.join("→") || "（无）"} | 正文 ${text.length} 字符 | 推理 ${reasoning.length} 字符 | 工具 ${toolCalls.length}` +
      (stat.otherTypes.length ? ` | 其他类型 ${[...new Set(stat.otherTypes)].join(",")}` : ""),
    );
    return true;
  }
  if (doneEv.ok === false) {
    console.warn(`[${ts()}] ${tag} 上游 done(ok=false)：${JSON.stringify(doneEv).slice(0, 400)}`);
    return true;
  }
  if (!doneEv.model || !doneEv.usage) {
    console.warn(`[${ts()}] ${tag} 上游 done 缺 model/usage：${JSON.stringify(doneEv).slice(0, 400)}`);
    return true;
  }
  return false;
}

function finishReasonOf(doneEv, toolCalls) {
  if (toolCalls.length > 0) return "tool_calls";
  if (doneEv?.finishReason === "length") return "length";
  return "stop";
}

let reqSeq = 0;

async function handleChatCompletions(req, res) {
  const started = Date.now();
  const reqId = ++reqSeq;
  const body = await readJson(req);
  const stream = body.stream === true;
  const includeUsage = body.stream_options?.include_usage === true;
  const requestedModel = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "perch";
  const isAuto = /^(perch|perch-default|default)$/i.test(requestedModel);
  // 推理强度（effort）解析，优先级：model 里的 "@强度" > 请求体 reasoning_effort / reasoning.effort > 官方默认 high
  let tierPart = requestedModel;
  let effortSuffix = null;
  if (!isAuto && requestedModel.includes("@")) {
    const at = requestedModel.indexOf("@");
    tierPart = requestedModel.slice(0, at);
    effortSuffix = requestedModel.slice(at + 1);
    if (!ROOST_EFFORT_LEVELS.includes(effortSuffix)) {
      throw httpError(400, `未知推理强度 "${effortSuffix}"（可选：${ROOST_EFFORT_LEVELS.join(" / ")}），写法如 pro@max`);
    }
  }
  const rawEffort = typeof body.reasoning_effort === "string" ? body.reasoning_effort
    : typeof body.reasoning?.effort === "string" ? body.reasoning.effort
    : null;
  const rawEffortSource = rawEffort == null ? null : (typeof body.reasoning_effort === "string" ? "body.reasoning_effort" : "body.reasoning.effort");
  let effortBody = null;
  if (rawEffort != null) {
    const mapped = { none: "off", minimal: "low" }[String(rawEffort).toLowerCase()] ?? String(rawEffort).toLowerCase();
    if (!ROOST_EFFORT_LEVELS.includes(mapped)) {
      throw httpError(400, `不支持的 reasoning_effort "${rawEffort}"（可选：${ROOST_EFFORT_LEVELS.join(" / ")}；none→off、minimal→low 自动映射）`);
    }
    effortBody = mapped;
  }
  const effortRequested = effortSuffix ?? effortBody;
  console.log(`[${ts()} #${reqId}] 收到: model="${requestedModel}" | effort=${effortSuffix ?? rawEffort ?? "未指定"}${effortSuffix ? "（model 后缀）" : rawEffortSource ? `（${rawEffortSource}）` : ""} | stream=${stream} | 消息=${Array.isArray(body.messages) ? body.messages.length : 0} | tools=${Array.isArray(body.tools) ? body.tools.length : 0} | max_tokens=${body.max_tokens ?? body.max_completion_tokens ?? "默认"} | temperature=${body.temperature ?? "默认"} | UA=${(req.headers["user-agent"] ?? "无").slice(0, 70)}`);
  const tier = isAuto ? null : resolveTier(tierPart);
  let pin = isAuto || tier ? null : await resolveModel(requestedModel);
  let pinFromServerDefaults = false;
  const modelLabel = requestedModel;
  const messages = normalizeMessages(Array.isArray(body.messages) ? body.messages : []);
  if (messages.length === 0) throw httpError(400, "messages 不能为空");
  const tools = Array.isArray(body.tools) && body.tools.length > 0 ? body.tools : undefined;
  const toolChoice = tools ? mapToolChoice(body.tool_choice) : null;
  const rawMax = Number(body.max_tokens ?? body.max_completion_tokens ?? MAX_TOKENS_CAP);
  const maxTokens = Math.min(Math.max(Number.isFinite(rawMax) ? rawMax : MAX_TOKENS_CAP, 1), MAX_TOKENS_CAP);
  const temperature = typeof body.temperature === "number" ? body.temperature : 0.6;

  const picked = await pickAccount();
  const accountLabel = describeAccount(picked);
  let session = picked.account.session;
  if (!session?.accessToken) throw httpError(503, "未登录：请先运行 node perch-client.mjs login");
  session = await ensureFresh(session, false, picked.account.tokenFile ?? undefined);
  console.log(`[${ts()} #${reqId}] 账号: ${accountLabel}${picked.skipped?.length ? ` | 跳过: ${picked.skipped.join("；")}` : ""}`);

  // 本地注册表没有的 id，再对照服务端 public-model-default 的实时默认值（服务端可能先行上线新模型）
  if (!isAuto && !tier && !pin) {
    const defaults = await getServerDefaultIds(session, picked.account.tokenFile);
    if (defaults.has(requestedModel)) {
      pin = { id: requestedModel, label: requestedModel, serverDefault: true };
      pinFromServerDefaults = true;
    } else {
      throw httpError(400, `未知模型 "${requestedModel}"：用 "perch" 走服务端自动路由；或用档位 standard / standard_max / pro / pro_max（可加推理强度，如 pro@max / pro@off）；或在 GET /v1/models 里选一个可固定（pin）的模型 id（如 dashscope-deepseek-v4-1-flash / DeepSeek V4.1 Flash）`);
    }
  }

  console.log(`[${ts()} #${reqId}] 解析: ${isAuto ? "自动路由" : tier ? `档位=${tier}` : `pin=${pin?.id ?? "未解析"}${pin ? `（"${pin.label}"）` : ""}${pinFromServerDefaults ? "（服务端默认值兜底）" : ""}`}`);

  const info = await getWorkspace(session, lastUserText(messages));

  // 每请求即一轮：用官方同款票据管理器领票（enforced 失败/限流会抛 PerchTicketError）
  const tickets = createTicketManager();
  const runId = (await tickets.obtain({ appUrl: APP_URL, accessToken: session.accessToken, profile: "standard" })) ?? fallbackRunId();

  const perchBody = {
    request: {
      lane: "chat",
      messages,
      ...(tools ? { tools } : {}),
      temperature,
      maxTokens,
      ...(tools && toolChoice ? { toolChoice } : {}),
    },
    runId,
    lane: "chat",
    strictManual: false,
    ...(pin
      ? {
          preferredModelId: pin.id, manualModelOptionId: pin.id,
          ...(FORWARD_PIN_EFFORT && effortRequested ? { roostReasoning: effortRequested !== "off", effort: { level: effortRequested } } : {}),
        }
      : tier
        ? roostFields(tier, effortRequested ?? "high")
        : {
            preferredModelId: null,
            ...(FORWARD_PIN_EFFORT && effortRequested ? { roostReasoning: effortRequested !== "off", effort: { level: effortRequested } } : {}),
          }),
    avoidModelIds: [],
    attribution: {
      userId: info.userId, workspaceId: info.workspaceId, runId,
      lane: "chat", source: "cli", billingMultiplier: null,
    },
    clientSurface: "cli",
  };

  const selDesc = pin ? `pin=${pin.id}${pinFromServerDefaults ? "(server-default)" : ""}` : tier ? `tier=${tier}` : "auto";
  const effortIgnored = Boolean(effortRequested) && !tier && !FORWARD_PIN_EFFORT;
  const effortDesc = effortRequested ? ` effort=${effortRequested}${effortIgnored ? "(ignored)" : ""}` : "";
  if (effortIgnored) {
    console.warn(`[warn] reasoning_effort=${effortRequested} 已忽略：PERCH_FORWARD_PIN_EFFORT=0 且非档位请求；要控制推理强度请用档位（如 "pro@${effortRequested}"）或去掉该环境变量（默认会随 pin/自动路由转发）`);
  }
  console.log(`[${ts()} #${reqId}] effort: 请求值=${effortRequested ?? "未指定"}${effortRequested
    ? tier
      ? " → ✅ 随档位发送"
      : effortIgnored
        ? " → ❌ 已忽略（PERCH_FORWARD_PIN_EFFORT=0，非档位不转发）"
        : ` → ✅ 随${pin ? "pin" : "自动路由"}转发（roostReasoning=${effortRequested !== "off"}, level=${effortRequested}）`
    : tier ? " → 未指定，档位默认 high" : ""}`);
  console.log(`[${ts()} #${reqId}] 外发: runId=${runId} ${JSON.stringify({ preferredModelId: perchBody.preferredModelId, manualModelOptionId: perchBody.manualModelOptionId, roostModelChoice: perchBody.roostModelChoice, roostReasoning: perchBody.roostReasoning, effort: perchBody.effort })}`);
  const usageEntry = (doneEv, isStream) => ({
    ts: new Date().toISOString(),
    runId,
    account: picked.account.name,
    requested: modelLabel,
    actual: doneEv?.model ?? null,
    inputTokens: doneEv?.usage?.inputTokens ?? null,
    outputTokens: doneEv?.usage?.outputTokens ?? null,
    cacheReadInputTokens: doneEv?.usage?.cacheReadInputTokens ?? null,
    totalTokens: doneEv?.usage?.totalTokens ?? null,
    ms: Date.now() - started,
    stream: isStream,
    modelSource: selDesc,
    effort: effortRequested ?? null,
  });

  const ac = new AbortController();
  // 诊断用：客户端到底等了多久才走、走到哪一步（日志里最缺的就是这行）
  let upHeadAt = 0, firstDeltaAt = 0, sentChunks = 0;
  const sinceStart = (t) => (t ? `${t - started}ms` : "未到");
  res.on("close", () => {
    if (res.writableEnded) return;
    console.log(`[${ts()} #${reqId}] 客户端中断：已等 ${Date.now() - started}ms | 上游响应头 ${sinceStart(upHeadAt)} | 上游首个增量 ${sinceStart(firstDeltaAt)} | 已下发 ${sentChunks} 块`);
    ac.abort();
  });

  const { res: up } = await callModel(session, await tickets.headers(), perchBody, ac.signal, picked.account.tokenFile ?? null);
  upHeadAt = Date.now();
  console.log(`[${ts()} #${reqId}] 上游响应头 ${upHeadAt - started}ms（HTTP ${up.status}）`);
  const ct = up.headers.get("content-type") ?? "";
  if (!ct.includes("text/event-stream")) {
    const raw = await up.text().catch(() => "");
    throw httpError(up.status === 200 ? 502 : up.status, `上游返回非 SSE（HTTP ${up.status}）：${raw.slice(0, 200)}`);
  }

  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    const upstream = await consumeUpstream(up);
    logUpstreamTail(upstream, `#${reqId}（非流式）`);
    const { text, reasoning, toolCalls, doneEv, streamError } = upstream;
    if (streamError) throw httpError(502, `上游流错误：${streamError}`);
    if (doneEv?.ok === false) {
      const code = doneEv.errorCode;
      if (code === "usage_limit_reached") {
        const until = picked.state?.nextFreedAt ? Date.parse(picked.state.nextFreedAt) : null;
        markExhausted(picked.account.name, until); // 冷却到恢复时间，避免在下个请求里再撞它
      }
      throw httpError(code === "usage_limit_reached" ? 429 : 502, `上游失败：${doneEv.error ?? code ?? "unknown"}`);
    }
    const message = { role: "assistant", content: text || null };
    if (toolCalls.length) message.tool_calls = toOpenAIToolCalls(toolCalls).map(({ index, ...tc }) => tc);
    sendJson(res, 200, {
      id, object: "chat.completion", created,
      model: doneEv?.model ?? modelLabel,
      choices: [{ index: 0, message, finish_reason: finishReasonOf(doneEv, toolCalls) }],
      usage: toOpenAIUsage(doneEv?.usage),
    });
    recordUsage(usageEntry(doneEv, false));
    console.log(`[${ts()} #${reqId}] 完成: 实际模型=${doneEv?.model ?? "?"} | 用时=${Date.now() - started}ms | ${selDesc}${effortDesc} | 输出 ${text.length} 字符 | 推理 ${reasoning.length} 字符 | tokens 输入${doneEv?.usage?.inputTokens ?? "?"}/输出${doneEv?.usage?.outputTokens ?? "?"}/总${doneEv?.usage?.totalTokens ?? "?"} | 工具 ${toolCalls.length}`);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (obj) => {
    sentChunks++;
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const chunk = (delta, finish = null) => {
    if (!firstDeltaAt && (delta.content || delta.reasoning_content)) {
      firstDeltaAt = Date.now();
      console.log(`[${ts()} #${reqId}] 上游首个增量 ${firstDeltaAt - started}ms`);
    }
    send({
      id, object: "chat.completion.chunk", created, model: modelLabel,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
  };

  // 心跳：连上就发第一个，之后每 KEEPALIVE_MS 一行，客户端丢弃注释只当续命。
  // 注释后不带空行（照 magpie 的写法）：把"没有 data 的空块"当事件读的客户端
  // （openai-go v2 / Crush）会报 unexpected end of JSON input；按行解析的客户端不受影响。
  const ka = KEEPALIVE_MS > 0
    ? setInterval(() => {
        if (!res.writableEnded) res.write(": keepalive\n");
      }, KEEPALIVE_MS)
    : null;
  ka?.unref?.();
  if (ka) res.write(": keepalive\n");

  chunk({ role: "assistant" });
  let upstream;
  try {
    upstream = await consumeUpstream(up, (d) => chunk(d));
  } finally {
    if (ka) clearInterval(ka);
  }
  logUpstreamTail(upstream, `#${reqId}（流式）`);
  const { text, reasoning, toolCalls, doneEv, streamError } = upstream;

  if (streamError) {
    send({ error: { message: streamError, type: "upstream_error" } });
  } else if (doneEv?.ok === false) {
    // 额度用尽：冷却该账号（到恢复时间或 5 分钟），下一次请求预检就会跳过它
    if (doneEv.errorCode === "usage_limit_reached") {
      const until = picked.state?.nextFreedAt ? Date.parse(picked.state.nextFreedAt) : null;
      markExhausted(picked.account.name, until);
    }
    send({ error: { message: String(doneEv.error ?? doneEv.errorCode ?? "upstream failed"), type: "upstream_error" } });
  } else {
    if (toolCalls.length) chunk({ tool_calls: toOpenAIToolCalls(toolCalls) });
    chunk({}, finishReasonOf(doneEv, toolCalls));
    if (includeUsage) {
      send({ id, object: "chat.completion.chunk", created, model: doneEv?.model ?? modelLabel, choices: [], usage: toOpenAIUsage(doneEv?.usage) });
    }
  }
  res.write("data: [DONE]\n\n");
  res.end();
  recordUsage(usageEntry(doneEv, true));
  console.log(`[${ts()} #${reqId}] 完成: 实际模型=${doneEv?.model ?? "?"} | 用时=${Date.now() - started}ms | ${selDesc}${effortDesc} | 输出 ${text.length} 字符 | 推理 ${reasoning.length} 字符 | tokens 输入${doneEv?.usage?.inputTokens ?? "?"}/输出${doneEv?.usage?.outputTokens ?? "?"}/总${doneEv?.usage?.totalTokens ?? "?"} | 工具 ${toolCalls.length}`);
}

async function handleModels(res) {
  // 每个模型的推理能力（供客户端生成模型目录用）：graded → 其 levels；binary → off/on；未知 → null
  const reasoningLevelsOf = (m) => {
    if (m.reasoning === false) return [];
    if (m.effort?.kind === "graded") return m.effort.levels ?? [];
    if (m.effort?.kind === "binary") return ["off", "on"];
    if (m.effort?.kind === "none") return [];
    return null; // 未知（注册项为模板生成且未覆盖到）
  };
  // OpenRouter 风格的模态信息；vision 未知 → null
  const archOf = (vision) =>
    vision == null ? null : { input_modalities: ["text", ...(vision ? ["image"] : [])], output_modalities: ["text"] };
  const data = [{ id: "perch", object: "model", created: 0, owned_by: "perch", perch_model_id: null, supported_reasoning_levels: ROOST_EFFORT_LEVELS, architecture: null }];
  const shown = new Set(["perch"]);
  const knownIds = new Set();
  for (const m of await loadModels()) {
    if (m.internal) continue;
    knownIds.add(m.id);
    // 用显示名做主 id（客户端界面友好）；技术 id 放 perch_model_id，两个都能用来 pin
    let id = m.label || m.id;
    if (shown.has(id)) id = m.id;
    shown.add(id);
    data.push({
      id, object: "model", created: 0, owned_by: "perch",
      perch_model_id: m.id,
      context_length: m.contextWindow ?? null,
      max_output_tokens: m.maxOutputTokens ?? null,
      supported_reasoning_levels: reasoningLevelsOf(m),
      architecture: archOf(m.vision),
    });
  }
  try {
    const session = await loadSession();
    if (session?.accessToken) {
      for (const id of await getServerDefaultIds(session)) {
        if (knownIds.has(id) || shown.has(id)) continue;
        shown.add(id);
        data.push({ id, object: "model", created: 0, owned_by: "perch", context_length: null, max_output_tokens: null, supported_reasoning_levels: null, architecture: null });
      }
    }
  } catch {}
  for (const t of ROOST_TIERS) {
    data.push({ id: t, object: "model", created: 0, owned_by: "perch-roost", context_length: null, max_output_tokens: null, supported_reasoning_levels: ROOST_EFFORT_LEVELS, architecture: null });
  }
  sendJson(res, 200, { object: "list", data });
}

// ---------- 用量统计（GET /usage 本地流水；GET /usage/upstream 查服务端权威用量） ----------
const usageJournal = [];
const USAGE_JOURNAL_MAX = 500;

function recordUsage(entry) {
  usageJournal.push(entry);
  if (usageJournal.length > USAGE_JOURNAL_MAX) usageJournal.splice(0, usageJournal.length - USAGE_JOURNAL_MAX);
}

function summarizeUsage(entries) {
  const totals = { calls: entries.length, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, durationMs: 0 };
  const byModel = {};
  for (const e of entries) {
    const i = e.inputTokens ?? 0;
    const o = e.outputTokens ?? 0;
    const c = e.cacheReadInputTokens ?? 0;
    const t = e.totalTokens ?? 0;
    totals.promptTokens += i; totals.completionTokens += o; totals.cachedTokens += c; totals.totalTokens += t;
    totals.durationMs += e.ms ?? 0;
    const key = e.actual ?? e.requested ?? "unknown";
    const m = byModel[key] ?? (byModel[key] = { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 });
    m.calls++; m.promptTokens += i; m.completionTokens += o; m.cachedTokens += c; m.totalTokens += t;
  }
  return { totals, byModel };
}

function handleUsage(res, url) {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), USAGE_JOURNAL_MAX);
  const { totals, byModel } = summarizeUsage(usageJournal);
  sendJson(res, 200, {
    object: "usage.summary",
    generatedAt: new Date().toISOString(),
    totals,
    byModel,
    recent: usageJournal.slice(-limit),
  });
}

async function handleUsageUpstream(res, url) {
  let runIds = String(url.searchParams.get("runIds") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (runIds.length === 0) runIds = [...new Set(usageJournal.map((e) => e.runId).filter(Boolean))].slice(-50);
  if (runIds.length === 0) {
    throw httpError(400, "没有可查询的 runId：先通过网关发几条对话（网关会记录 runId），或用 ?runIds=a,b,c 指定");
  }
  const picked = await pickAccount({ preflight: false });
  let session = picked.account.session;
  if (!session?.accessToken) throw httpError(503, "未登录：请先运行 node perch-client.mjs login");
  session = await ensureFresh(session, false, picked.account.tokenFile ?? undefined);
  const r = await fetch(`${APP_URL}/api/perch-terminal/usage`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
    body: JSON.stringify({ runIds }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await r.json().catch(() => null);
  console.log(`[${ts()}] /usage/upstream: 查询 ${runIds.length} 个 runId → HTTP ${r.status}`);
  sendJson(res, r.ok ? 200 : r.status, data ?? { ok: false, error: `上游返回非 JSON（HTTP ${r.status}）` });
}

// ---------- 余额/配额（GET /balance 自定义完整视图；GET /v1/usage magpie 兼容窗口形状） ----------
const ALLOWANCE_TTL_MS = 30 * 1000;

// 按账号名缓存（多账号时各看各的）
let allowanceCache = new Map();
async function fetchAccount(session, force = false, key = "default") {
  const hit = allowanceCache.get(key);
  if (!force && hit && Date.now() - hit.at < ALLOWANCE_TTL_MS) return hit.account;
  const r = await fetch(`${APP_URL}/api/perchai/account`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${session.accessToken}`, ...LOCALE_HEADER },
    signal: AbortSignal.timeout(8000),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data?.ok) {
    throw httpError(502, `上游 /api/perchai/account 失败（HTTP ${r.status}）：${JSON.stringify(data)?.slice(0, 200)}`);
  }
  allowanceCache.set(key, { at: Date.now(), account: data });
  return data;
}

const asNum = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function buildBalance(account) {
  const meter = account?.usageMeter ?? {};
  const get = (...keys) => { for (const k of keys) if (meter[k] != null) return meter[k]; return null; };
  const toWindows = (rolling, kind) => {
    if (!rolling || typeof rolling !== "object" || rolling.enabled === false) return [];
    const out = [];
    const push = (id, label, usedUsd, capUsd, nextFreedAt) => {
      if (usedUsd == null && capUsd == null) return;
      out.push({
        id, label, kind,
        usedUsd: usedUsd ?? 0,
        capUsd: capUsd ?? null,
        percent: capUsd != null && capUsd > 0 ? Math.max(0, Math.min(Math.round(((usedUsd ?? 0) / capUsd) * 100), 100)) : null,
        nextFreedAt: typeof nextFreedAt === "string" ? nextFreedAt : null,
      });
    };
    push("5h", "5-hour", asNum(rolling.window5hUsd), asNum(rolling.window5hCapUsd), rolling.window5hNextFreedAt);
    push("7d", "Weekly", asNum(rolling.window7dUsd), asNum(rolling.window7dCapUsd), rolling.window7dNextFreedAt);
    return out;
  };
  const windows = [
    ...toWindows(get("roost_rolling", "roostRolling"), "roost"),
    ...toWindows(get("manual_rolling", "manualRolling"), "manual"),
  ];
  const creditPt = asNum(account?.creditBalancePt) ?? 0;
  return {
    ok: true,
    plan: {
      code: account?.session?.planCode ?? null,
      name: account?.session?.planName ?? null,
      membershipRole: account?.session?.membershipRole ?? null,
    },
    usage: {
      dailyUsd: asNum(get("daily_usd", "dailyUsd")),
      weeklyUsd: asNum(get("weekly_usd", "weeklyUsd")),
      monthlyUsd: asNum(get("monthly_usd", "monthlyUsd")),
      monthlyManualUsd: asNum(get("monthly_manual_usd", "monthlyManualUsd")),
      dailyCalls: asNum(get("daily_calls", "dailyCalls")),
      weeklyCalls: asNum(get("weekly_calls", "weeklyCalls")),
      monthlyCalls: asNum(get("monthly_calls", "monthlyCalls")),
      dailyTokens: asNum(get("daily_tokens", "dailyTokens")),
      weeklyTokens: asNum(get("weekly_tokens", "weeklyTokens")),
      monthlyTokens: asNum(get("monthly_tokens", "monthlyTokens")),
      periodStart: get("period_start", "periodStart"),
    },
    windows,
    creditBalancePt: creditPt,
    balanceUsd: creditPt > 0 ? creditPt / 1000 : null,
    fetchedAt: new Date().toISOString(),
  };
}

async function pickAccountForDisplay() {
  try {
    return await pickAccount();
  } catch (e) {
    // 全部账号都满了也照常显示（好让 magpie/用户看到 100% 与恢复时间）
    if (e?.status === 429) return await pickAccount({ preflight: false });
    throw e;
  }
}

async function handleBalance(res) {
  const picked = await pickAccountForDisplay();
  let session = picked.account.session;
  if (!session?.accessToken) throw httpError(503, "未登录：请先运行 node perch-client.mjs login");
  session = await ensureFresh(session, false, picked.account.tokenFile ?? undefined);
  const balance = buildBalance(await fetchAccount(session, false, picked.account.name));
  console.log(`[${ts()}] /balance: 账号=${picked.account.name} plan=${balance.plan.code ?? "?"} | ${balance.windows.map((w) => `${w.kind}-${w.id} ${w.usedUsd}/${w.capUsd ?? "∞"}`).join(" , ") || "无窗口"}`);
  sendJson(res, 200, balance);
}

// magpie 的窗口读取只认 5h / 1d / 7d 三个名字，同名只取第一条、limit<=0 的跳过；
// 所以这里只交出 manual（手动模型）那组并改名为标准窗口名——它才是会被用满的那组。
async function handleMagpieUsage(res) {
  const picked = await pickAccountForDisplay();
  let session = picked.account.session;
  if (!session?.accessToken) throw httpError(503, "未登录：请先运行 node perch-client.mjs login");
  session = await ensureFresh(session, false, picked.account.tokenFile ?? undefined);
  const balance = buildBalance(await fetchAccount(session, false, picked.account.name));
  const rate_limits = balance.windows
    .filter((w) => w.kind === "manual" && asNum(w.capUsd) != null && w.capUsd > 0)
    .map((w) => ({
      window: w.id,
      limit: w.capUsd,
      used: w.usedUsd,
      ...(w.nextFreedAt ? { reset_at: w.nextFreedAt } : {}),
    }));
  if (rate_limits.length === 0) console.warn(`[${ts()}] /v1/usage: 上游没有可用的 manual 窗口（rolling 可能未启用），返回空 rate_limits`);
  const out = { ...(balance.balanceUsd != null ? { remaining: balance.balanceUsd } : {}), rate_limits };
  console.log(`[${ts()}] /v1/usage(magpie): ${JSON.stringify(out)}`);
  sendJson(res, 200, out);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true });
    }
    if (!checkAuth(req)) {
      return sendError(res, 401, "无效的 API key：请用 Authorization: Bearer <key> 请求（key 见 perch_login_py/api-key.txt，或启动时的 --key/GATEWAY_API_KEY）");
    }
    if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      return await handleModels(res);
    }
    if (req.method === "GET" && url.pathname === "/usage") {
      return handleUsage(res, url);
    }
    if (req.method === "GET" && url.pathname === "/usage/upstream") {
      return await handleUsageUpstream(res, url);
    }
    if (req.method === "GET" && url.pathname === "/v1/usage") {
      return await handleMagpieUsage(res);
    }
    if (req.method === "GET" && url.pathname === "/balance") {
      return await handleBalance(res);
    }
    if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
      return await handleChatCompletions(req, res);
    }
    sendError(res, 404, `没有这个端点：${req.method} ${url.pathname}`);
  } catch (e) {
    if (e?.name === "AbortError") {
      if (!res.headersSent) res.end();
      return;
    }
    if (e?.errorCode === "usage_limit_reached" || /usage limit|allowance|额度/i.test(String(e?.message ?? ""))) {
      invalidateUsage(); // 让下一次请求重新读一遍各账号额度
    }
    const status = e?.errorCode === "turn_rate_limited" ? 429
      : e?.errorCode === "usage_limit_reached" ? 429
      : e?.errorCode === "turn_ticket_unavailable" ? 502
      : e?.status ?? 500;
    const msg = e?.message ?? String(e);
    console.warn(`[请求失败] HTTP ${status}: ${msg.slice(0, 200)}`);
    sendError(res, status, msg);
    if (/fetch failed|timed out|ECONN|ENOTFOUND/i.test(msg)) {
      console.error("上游网络不通：本机若走系统代理，请用 HTTPS_PROXY=http://127.0.0.1:7890 node --use-env-proxy openai-gateway.mjs 启动");
    }
  }
});

const keyInfo = await setupApiKey();

server.listen(PORT, HOST, () => {
  console.log(`Perch OpenAI 兼容网关已启动：http://${HOST}:${PORT}/v1`);
  console.log(`  POST /v1/chat/completions   对话（stream 支持 true/false）`);
  console.log(`  GET  /v1/models             可用模型列表`);
  console.log(`  GET  /usage                本地用量流水（?limit=N）；/usage/upstream 查服务端权威用量`);
  console.log(`  GET  /v1/usage             magpie 余额窗口：只含 manual 组（改名 5h/7d）；GET /balance 为完整配额视图`);
  console.log(`                             （magpie 余额地址就填 http://<host>:${PORT}/v1/usage；GET /balance 为完整配额视图）`);
  if (apiKey) {
    console.log(`  API key 鉴权：已开启${keyInfo?.generated ? "（本次新生成）" : keyInfo?.fromFile ? "（读自 api-key.txt）" : ""}`);
    if (keyInfo?.generated) console.log(`  你的 API key（请保存）：${apiKey}`);
  } else {
    console.log(`  API key 鉴权：未开启（本地端口谁都能访问；用 ./run.sh gateway --key auto 生成并启用）`);
  }
  console.log(`  pin/自动路由 effort 转发：${FORWARD_PIN_EFFORT ? "已开启（默认；PERCH_FORWARD_PIN_EFFORT=0 可关闭）" : "已关闭（仅档位请求携带 effort）"}`);
  const isLoopback = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";
  if (!isLoopback) {
    console.warn("  ⚠️ 监听在非本机地址（对外提供服务）：");
    console.warn("     · 能访问此端口的任何人都会消耗你的账号额度与轮次限速配额");
    console.warn(apiKey
      ? "     · 明文 HTTP，key 在局域网上可被嗅探——只在可信网络使用"
      : "     · 当前未启用 API key：请立刻加 --key auto，或改回 127.0.0.1");
    console.warn("     · 若对外共享，请自行评估 Perch 服务条款与账号风控风险");
  }
  console.log(`  OpenAI SDK: new OpenAI({ baseURL: "http://${isLoopback ? HOST : "<本机IP>"}:${PORT}/v1", apiKey: ${apiKey ? '"<上面的 key>"' : '"perch-local"'} })`);
});

// 启动时检查模型注册表是否落后于已安装的 CLI（bundle 更新则自动重提取）
try {
  const r = await syncIfStale();
  if (r?.synced) {
    const extra = [
      r.added.length ? `新增 ${r.added.join(", ")}` : "",
      r.removed.length ? `移除 ${r.removed.join(", ")}` : "",
    ].filter(Boolean).join("；");
    console.log(`模型注册表已随 CLI 更新（v${r.version}，共 ${r.count} 个模型 + ${ROOST_TIERS.length} 个路由档位）${extra ? "：" + extra : ""}`);
  } else if (r) {
    console.log(`模型注册表已是最新（CLI v${r.version}，${r.count} 个模型 + ${ROOST_TIERS.length} 个路由档位）`);
  } else {
    console.log("未找到 Perch CLI bundle，跳过模型注册表同步（现有 models.json 继续生效）");
  }
} catch (e) {
  console.log(`模型注册表同步跳过：${e?.message ?? e}`);
}
