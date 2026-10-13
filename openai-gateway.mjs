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

import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { APP_URL, loadSession, ensureFresh, postJson, callModel, readSSE, createTicketManager, fallbackRunId, loadModels, resolveModel, resolveTier, roostFields, ROOST_TIERS, ROOST_EFFORT_LEVELS } from "./perch-core.mjs";
import { syncIfStale } from "./sync-models.mjs";

const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const PORT = Number(process.env.PORT ?? flagValue("--port") ?? 8787);
const HOST = flagValue("--host") ?? process.env.HOST ?? "127.0.0.1";
const MAX_TOKENS_CAP = 32000;
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
      msg.content = msg.content
        .map((p) => (typeof p === "string" ? p : p?.type === "text" ? p.text ?? "" : p?.type === "image_url" ? "[image]" : ""))
        .join("\n");
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
async function getServerDefaultIds(session) {
  if (Date.now() - defaultsCache.at < CTX_TTL_MS) return defaultsCache.ids;
  try {
    const fresh = await ensureFresh(session);
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
  let toolCalls = [];
  let doneEv = null;
  let streamError = null;
  await readSSE(up, (ev) => {
    if (ev.type === "answer_delta" && typeof ev.text === "string") {
      text += ev.text;
      onDelta?.({ content: ev.text });
    } else if (ev.type === "reasoning_delta" && typeof ev.text === "string") {
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
  return { text, toolCalls: sealed, doneEv, streamError };
}

function finishReasonOf(doneEv, toolCalls) {
  if (toolCalls.length > 0) return "tool_calls";
  if (doneEv?.finishReason === "length") return "length";
  return "stop";
}

async function handleChatCompletions(req, res) {
  const started = Date.now();
  const body = await readJson(req);
  const stream = body.stream === true;
  const includeUsage = body.stream_options?.include_usage === true;
  const requestedModel = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "perch";
  const isAuto = /^(perch|perch-default|default)$/i.test(requestedModel);
  // 支持 "档位@强度" 写法（如 pro@max / pro@off），强度默认 high
  let tierPart = requestedModel;
  let effortLevel = "high";
  if (!isAuto && requestedModel.includes("@")) {
    const at = requestedModel.indexOf("@");
    tierPart = requestedModel.slice(0, at);
    effortLevel = requestedModel.slice(at + 1);
    if (!ROOST_EFFORT_LEVELS.includes(effortLevel)) {
      throw httpError(400, `未知推理强度 "${effortLevel}"（可选：${ROOST_EFFORT_LEVELS.join(" / ")}），写法如 pro@max`);
    }
  }
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

  let session = await loadSession();
  if (!session?.accessToken) throw httpError(503, "未登录：请先运行 node perch-client.mjs login");
  session = await ensureFresh(session);

  // 本地注册表没有的 id，再对照服务端 public-model-default 的实时默认值（服务端可能先行上线新模型）
  if (!isAuto && !tier && !pin) {
    const defaults = await getServerDefaultIds(session);
    if (defaults.has(requestedModel)) {
      pin = { id: requestedModel, label: requestedModel, serverDefault: true };
      pinFromServerDefaults = true;
    } else {
      throw httpError(400, `未知模型 "${requestedModel}"：用 "perch" 走服务端自动路由；或用档位 standard / standard_max / pro / pro_max（可加推理强度，如 pro@max / pro@off）；或在 GET /v1/models 里选一个可固定（pin）的模型 id（如 dashscope-deepseek-v4-1-flash / DeepSeek V4.1 Flash）`);
    }
  }

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
      ? { preferredModelId: pin.id, manualModelOptionId: pin.id }
      : tier
        ? roostFields(tier, effortLevel)
        : { preferredModelId: null }),
    avoidModelIds: [],
    attribution: {
      userId: info.userId, workspaceId: info.workspaceId, runId,
      lane: "chat", source: "cli", billingMultiplier: null,
    },
    clientSurface: "cli",
  };

  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });

  const { res: up } = await callModel(session, await tickets.headers(), perchBody, ac.signal);
  const ct = up.headers.get("content-type") ?? "";
  if (!ct.includes("text/event-stream")) {
    const raw = await up.text().catch(() => "");
    throw httpError(up.status === 200 ? 502 : up.status, `上游返回非 SSE（HTTP ${up.status}）：${raw.slice(0, 200)}`);
  }

  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    const { text, toolCalls, doneEv, streamError } = await consumeUpstream(up);
    if (streamError) throw httpError(502, `上游流错误：${streamError}`);
    if (doneEv?.ok === false) throw httpError(502, `上游失败：${doneEv.error ?? doneEv.errorCode ?? "unknown"}`);
    const message = { role: "assistant", content: text || null };
    if (toolCalls.length) message.tool_calls = toOpenAIToolCalls(toolCalls).map(({ index, ...tc }) => tc);
    sendJson(res, 200, {
      id, object: "chat.completion", created,
      model: doneEv?.model ?? modelLabel,
      choices: [{ index: 0, message, finish_reason: finishReasonOf(doneEv, toolCalls) }],
      usage: toOpenAIUsage(doneEv?.usage),
    });
    console.log(`[${new Date().toISOString()}] ${modelLabel} msgs=${messages.length} tools=${tools?.length ?? 0} ${pin ? `pin=${pin.id}${pinFromServerDefaults ? "(server-default)" : ""}` : tier ? `tier=${tier}` : "auto"} → 200 (${Date.now() - started}ms, ${text.length} chars, ${toolCalls.length} tool calls)`);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const chunk = (delta, finish = null) => send({
    id, object: "chat.completion.chunk", created, model: modelLabel,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  chunk({ role: "assistant" });
  const { text, toolCalls, doneEv, streamError } = await consumeUpstream(up, (d) => chunk(d));

  if (streamError) {
    send({ error: { message: streamError, type: "upstream_error" } });
  } else if (doneEv?.ok === false) {
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
  console.log(`[${new Date().toISOString()}] ${modelLabel} msgs=${messages.length} tools=${tools?.length ?? 0} ${pin ? `pin=${pin.id}${pinFromServerDefaults ? "(server-default)" : ""}` : tier ? `tier=${tier}` : "auto"} stream → 200 (${Date.now() - started}ms, ${text.length} chars, ${toolCalls.length} tool calls)`);
}

async function handleModels(res) {
  const ids = new Set(["perch"]);
  for (const m of await loadModels()) {
    if (!m.internal) ids.add(m.id);
  }
  try {
    const session = await loadSession();
    if (session?.accessToken) {
      for (const id of await getServerDefaultIds(session)) ids.add(id);
    }
  } catch {}
  const data = [...ids].map((id) => ({ id, object: "model", created: 0, owned_by: "perch" }));
  for (const t of ROOST_TIERS) {
    data.push({ id: t, object: "model", created: 0, owned_by: "perch-roost" });
  }
  sendJson(res, 200, { object: "list", data });
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
    if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
      return await handleChatCompletions(req, res);
    }
    sendError(res, 404, `没有这个端点：${req.method} ${url.pathname}`);
  } catch (e) {
    if (e?.name === "AbortError") {
      if (!res.headersSent) res.end();
      return;
    }
    const status = e?.errorCode === "turn_rate_limited" ? 429
      : e?.errorCode === "turn_ticket_unavailable" ? 502
      : e?.status ?? 500;
    const msg = e?.message ?? String(e);
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
  if (apiKey) {
    console.log(`  API key 鉴权：已开启${keyInfo?.generated ? "（本次新生成）" : keyInfo?.fromFile ? "（读自 api-key.txt）" : ""}`);
    if (keyInfo?.generated) console.log(`  你的 API key（请保存）：${apiKey}`);
  } else {
    console.log(`  API key 鉴权：未开启（本地端口谁都能访问；用 ./run.sh gateway --key auto 生成并启用）`);
  }
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
