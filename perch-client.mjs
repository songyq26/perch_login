#!/usr/bin/env node
// Perch CLI 登录 + 发送请求流程（仅 Node 内置模块，无第三方依赖）
//
//   node perch-client.mjs login [--provider google|github] [--timeout 300] [--port 8976] [--callback]
//   node perch-client.mjs ask "你的问题" [--model <id/显示名/档位[@强度]>] [--effort <off|low|medium|high|xhigh|max|ultra>] [--telemetry]
//   node perch-client.mjs models [--sync]
//   node perch-client.mjs status
//
// 会话保存在同目录 token.json（0600）。User-Agent 固定为官方降级值
// perchai-cli/unknown——不伪造版本号（谎报版本是官方列出的封号原因之一）。
//
// 与官方 CLI 的已知差异：不发 Saffron system prompt、不发 57 个工具 Schema
// （因此模型不会产生工具调用）、默认不发 cli-turn / cli-learning 遥测
// （cli-learning 可用 --telemetry 开启）。

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import {
  APP_URL, TOKEN_FILE, b64url, fetchAuthConfig, supabaseToken, sessionFromToken,
  saveSession, loadSession, ensureFresh, postJson, callModel, readSSE,
  createTicketManager, fallbackRunId, loadModels, resolveModel, resolveTier, roostFields, ROOST_TIERS,
} from "./perch-core.mjs";
import { syncModels } from "./sync-models.mjs";

const CALLBACK_PATH = "/callback";

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

function htmlPage(ok) {
  const title = ok ? "Perch CLI 登录成功" : "Perch CLI 登录失败";
  const hint = ok ? "可以关闭此页面，回到终端继续。" : "请回到终端查看错误并重试。";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui;padding:32px"><h1>${title}</h1><p>${hint}</p></body></html>`;
}

function pickProvider(providers, requested) {
  const set = new Set(providers);
  if (requested && set.has(requested)) return requested;
  if (set.has("google")) return "google";
  if (set.has("github")) return "github";
  return null;
}

async function startCallbackServer(host, timeoutMs, port = 0) {
  let resolveCode;
  const codePromise = new Promise((r) => { resolveCode = r; });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    const code = url.searchParams.get("code");
    const err = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(htmlPage(false));
      resolveCode({ ok: false, error: err ?? "回调未携带 code" });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(htmlPage(true));
    resolveCode({ ok: true, code });
  });
  const timer = setTimeout(() => resolveCode({ ok: false, error: `等待登录超时（${Math.round(timeoutMs / 1000)} 秒）` }), timeoutMs);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const { port: boundPort } = server.address();
  return {
    redirectTo: `http://${host}:${boundPort}${CALLBACK_PATH}`,
    waitForCode: () => codePromise,
    close: () => {
      clearTimeout(timer);
      server.closeAllConnections?.();
      server.close();
    },
  };
}

async function updateSignupSource(cfg, session, signupSource) {
  if (signupSource && signupSource !== "unknown") return;
  try {
    await fetch(`${cfg.supabaseUrl}/auth/v1/user`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.supabaseAnonKey,
        Authorization: `Bearer ${session.accessToken}`,
        "X-Client-Info": "supabase-js-node/2.106.0",
      },
      body: JSON.stringify({ data: { signup_source: "cli" } }),
    });
  } catch {}
}

function readCodeFromStdin(timeoutMs) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.pause();
    };
    const onData = (buf) => {
      const lines = String(buf).split("\n").map((x) => x.trim()).filter(Boolean);
      for (const text of lines) {
        const codeM = /[?&]code=([^&\s]+)/.exec(text);
        const errM = /[?&]error=([^&\s]+)/.exec(text);
        if (codeM) {
          cleanup();
          resolve(decodeURIComponent(codeM[1]));
          return;
        }
        if (errM) {
          cleanup();
          reject(new Error(`登录被拒：${decodeURIComponent(errM[1])}`));
          return;
        }
      }
      if (lines.length) {
        cleanup();
        resolve(lines[0]);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等待粘贴超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

async function cmdLogin(args) {
  const providerArg = flagValue(args, "--provider");
  const timeoutSec = Number(flagValue(args, "--timeout") ?? 300);
  const portArg = flagValue(args, "--port");
  const manual = !args.includes("--callback");
  const port = portArg === undefined ? 0 : Number(portArg);
  if (portArg !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`--port 需要 1-65535 的整数（收到：${portArg}）`);
  }

  console.log("正在获取登录配置…");
  const cfg = await fetchAuthConfig();
  const provider = pickProvider(cfg.providers ?? [], providerArg);
  if (!provider) throw new Error("服务端未启用任何支持 CLI 的 OAuth provider");

  const host = (cfg.redirectHost || "127.0.0.1").trim();
  const verifier = b64url(randomBytes(64));
  const challenge = b64url(createHash("sha256").update(verifier).digest());

  let server = null;
  let callbackUrl;
  if (manual) {
    const cbPort = port || 30000 + Math.floor(Math.random() * 30000);
    callbackUrl = `http://${host}:${cbPort}${CALLBACK_PATH}`;
  } else {
    server = await startCallbackServer(host, timeoutSec * 1000, port);
    callbackUrl = server.redirectTo;
  }

  const url = new URL(`${cfg.supabaseUrl}/auth/v1/authorize`);
  url.searchParams.set("provider", provider);
  url.searchParams.set("redirect_to", callbackUrl);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "s256");
  if (provider === "google") url.searchParams.set("prompt", "select_account");

  console.log(`\n请用浏览器打开以下链接完成 ${provider} 登录（${timeoutSec} 秒内有效）：\n`);
  console.log(url.toString());

  try {
    let code;
    if (manual) {
      console.log(`\n粘贴式登录（默认模式）：登录后浏览器会跳到 ${callbackUrl}?code=…`);
      console.log("页面显示「无法访问/连接被拒绝」是正常的——把地址栏里的完整 URL 复制下来，");
      console.log("粘贴到本终端并回车（只粘 code 参数值也可以）：");
      code = await readCodeFromStdin(timeoutSec * 1000);
    } else {
      console.log(`\n等待回调 ${callbackUrl} …`);
      const r = await server.waitForCode();
      if (!r.ok) throw new Error(r.error);
      code = r.code;
    }
    console.log("收到授权码，正在换取会话…");
    const data = await supabaseToken(cfg.supabaseUrl, cfg.supabaseAnonKey, "pkce", { auth_code: code, code_verifier: verifier });
    const session = sessionFromToken(data, cfg.appUrl || APP_URL);
    await updateSignupSource(cfg, session, data.user?.user_metadata?.signup_source);
    await saveSession(session);
    console.log(`\n√ 登录成功，会话已保存到 ${TOKEN_FILE}`);
    console.log(`  userId: ${session.userId}`);
    console.log(`  email:  ${session.email}`);
  } finally {
    server?.close();
  }
}

function positionalArgs(args, valueFlags) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (valueFlags.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

async function cmdAsk(args) {
  const text = positionalArgs(args, ["--model", "--effort"])[0];
  if (!text) throw new Error('用法: node perch-client.mjs ask "你的问题" [--model <id/显示名/档位>] [--effort <off|low|medium|high|xhigh|max|ultra>]');

  const modelArg = flagValue(args, "--model");
  const tier = modelArg ? resolveTier(modelArg) : null;
  const pin = modelArg && !tier ? await resolveModel(modelArg) : null;
  if (modelArg && !pin && !tier) {
    throw new Error(`未知模型：${modelArg}（可用：模型 id/显示名见 models；档位 standard / standard_max / pro / pro_max）`);
  }
  const effortArg = flagValue(args, "--effort");
  if (effortArg && !tier) {
    throw new Error("--effort 需要配合 Roost 档位使用（官方语义里 effort 属于档位选择），例如：--model pro --effort max");
  }

  let session = await loadSession();
  if (!session?.accessToken) throw new Error("没有可用会话，请先运行: node perch-client.mjs login");
  session = await ensureFresh(session);

  const auth = { Authorization: `Bearer ${session.accessToken}` };

  const ctx = await postJson(`${APP_URL}/api/perch-terminal/cli-context`, {
    Accept: "application/json", "Content-Type": "application/json", ...auth,
  }, { query: text, limitPerScope: 8 });
  const sess = ctx.data?.session;
  if (ctx.status !== 200 || !sess?.workspaceId) {
    throw new Error(`cli-context 失败（HTTP ${ctx.status}）：${JSON.stringify(ctx.data).slice(0, 200)}`);
  }

  // 领票（官方 dBt 语义：失败时非 enforced 可无票继续，用 fallback runId；enforced 失败会抛错）
  const tickets = createTicketManager();
  const runId = (await tickets.obtain({ appUrl: APP_URL, accessToken: session.accessToken, profile: "standard" })) ?? fallbackRunId();

  const body = {
    request: {
      lane: "chat",
      messages: [{ role: "user", content: text }],
      temperature: 0.6,
      maxTokens: 32000,
    },
    runId,
    lane: "chat",
    strictManual: false,
    ...(pin
      ? { preferredModelId: pin.id, manualModelOptionId: pin.id }
      : tier
        ? roostFields(tier, effortArg ?? "high")
        : { preferredModelId: null }),
    avoidModelIds: [],
    attribution: {
      userId: sess.userId, workspaceId: sess.workspaceId, runId,
      lane: "chat", source: "cli", billingMultiplier: null,
    },
    clientSurface: "cli",
  };

  const { res } = await callModel(session, await tickets.headers(), body);
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("text/event-stream")) {
    const raw = await res.text().catch(() => "");
    throw new Error(`model-call 返回非 SSE（HTTP ${res.status}）：${raw.slice(0, 300)}`);
  }

  let done = null;
  let answer = "";
  let reasoningChars = 0;
  let streamError = null;
  await readSSE(res, (ev) => {
    if (ev.type === "answer_delta") {
      answer += ev.text ?? "";
      process.stdout.write(ev.text ?? "");
    } else if (ev.type === "reasoning_delta") {
      reasoningChars += (ev.text ?? "").length;
    } else if (ev.type === "done") {
      done = ev;
    } else if (ev.type === "error") {
      streamError = ev.message ?? "stream error";
    }
  });
  console.log();

  if (streamError) {
    console.log(`流错误：${streamError}`);
    process.exitCode = 1;
    return;
  }
  if (done && done.ok === false) {
    console.log(`失败：${done.error ?? done.errorCode ?? "unknown"}`);
    process.exitCode = 1;
    return;
  }
  if (done?.ok) {
    const u = done.usage ?? {};
    console.log(`\n[model: ${done.model ?? "?"} · ${done.durationMs ?? "?"}ms · ${u.totalTokens ?? "?"} tokens${reasoningChars ? ` · reasoning ${reasoningChars} 字符` : ""}]`);
    if (done.toolCalls?.length) {
      console.log("注意：模型请求了工具调用，本脚本不执行工具。");
    }
  }

  if (args.includes("--telemetry")) {
    const cwdHash = createHash("sha256").update(await fs.realpath(process.cwd()).catch(() => process.cwd())).digest("hex").slice(0, 16);
    await postJson(`${APP_URL}/api/perch-terminal/cli-learning`, {
      Accept: "application/json", "Content-Type": "application/json", ...auth,
    }, {
      userMessage: text, assistantText: answer, status: "completed",
      personaId: "saffron", threadId: `cli-cwd-${cwdHash}`, runId,
    }).then((r) => {
      if (r.data?.ok) console.log("[cli-learning 已上报]");
    }).catch(() => {});
  }
}

async function cmdStatus() {
  const s = await loadSession();
  if (!s) {
    console.log(`未登录（${TOKEN_FILE} 不存在）`);
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const left = s.expiresAt ? Math.round(s.expiresAt - now) : null;
  const mask = (t) => (t ? `${t.slice(0, 12)}…${t.slice(-6)}` : "—");
  console.log(`appUrl:      ${s.appUrl ?? "?"}`);
  console.log(`userId:      ${s.userId ?? "?"}`);
  console.log(`email:       ${s.email ?? "?"}`);
  console.log(`accessToken: ${mask(s.accessToken)}`);
  console.log(`有效期:      ${left == null ? "未知" : left > 0 ? `剩余 ${left}s` : "已过期（下次 ask 时自动刷新）"}`);
  console.log(`token 文件:  ${TOKEN_FILE}`);
}

async function cmdModels(args) {
  if (args.includes("--sync")) {
    const r = await syncModels();
    console.log(`已同步：CLI v${r.version}，${r.count} 个模型`);
  }
  const models = await loadModels();
  if (models.length === 0) {
    console.log("models.json 不存在或为空（运行 node sync-models.mjs 重新提取）");
    return;
  }
  for (const m of models) {
    const tag = m.group === "starter" ? "S" : "P";
    const ctx = m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : "?";
    const man = m.manualOnly ? " *" : "  ";
    console.log(`${tag}${man}${m.id.padEnd(46)} ${m.label.padEnd(26)} ${ctx}`);
  }
  for (const t of ROOST_TIERS) {
    console.log(`R   ${t.padEnd(46)} ${"Roost 路由档位（服务端挑模型）".padEnd(26)} —`);
  }
  console.log(`\n共 ${models.length} 个模型 + ${ROOST_TIERS.length} 个路由档位（S=Starter 组，P=Pro 组，R=Roost 档位；* = 仅手动可选，不参与自动路由）。ask --model 传左边 id / 显示名 / 档位均可。`);
  console.log("CLI 更新后用 models --sync 或 node sync-models.mjs 刷新本列表。");
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === "login") await cmdLogin(args);
  else if (cmd === "ask") await cmdAsk(args);
  else if (cmd === "status") await cmdStatus();
  else if (cmd === "models") await cmdModels(args);
  else {
    console.log('用法:\n  node perch-client.mjs login [--provider google|github] [--timeout 300] [--port 8976] [--callback]\n    （默认粘贴式登录；--callback 启用本地回调服务器）\n  node perch-client.mjs ask "你的问题" [--model <id/显示名/档位>] [--effort <off|low|medium|high|xhigh|max|ultra>] [--telemetry]\n  node perch-client.mjs models\n  node perch-client.mjs status');
    process.exitCode = cmd ? 1 : 0;
  }
} catch (e) {
  const msg = e?.message ?? String(e);
  console.error(`× ${msg}`);
  if (/fetch failed|timed out|ECONN|ENOTFOUND/i.test(msg)) {
    console.error("  网络不通？本机若走系统代理（如 Clash 127.0.0.1:7890），请这样运行：");
    console.error("    HTTPS_PROXY=http://127.0.0.1:7890 node --use-env-proxy perch-client.mjs ...");
  }
  process.exitCode = 1;
}
