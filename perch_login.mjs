#!/usr/bin/env node
// Minimal Perch CLI client: loopback login (you click the link) + one chat turn.
// Usage:
//   node perch_login.mjs login [--github]     log in via browser, save session
//   node perch_login.mjs whoami                show stored session
//   node perch_login.mjs chat "hello" [--dry-run] [--system FILE]
//   node perch_login.mjs logout                delete stored session
// Session file: perch_login_py/state/token.json (0600)

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_URL = (process.env.PERCH_CLI_APP_URL || "https://app.perchai.app").replace(/\/$/, "");
const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, "state");
const SESSION_FILE = join(STATE_DIR, "token.json");
const CLI_VERSION = (process.env.PERCH_CLI_VERSION || "unknown").trim();
const UA = `perchai-cli/${CLI_VERSION}`;
const REFRESH_MARGIN_S = 90;
const LOGIN_TIMEOUT_MS = 120_000;

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

async function readSession() {
  try {
    return JSON.parse(await readFile(SESSION_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function saveSession(session) {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await writeFile(SESSION_FILE, JSON.stringify(session, null, 2) + "\n", { mode: 0o600 });
  await stat(STATE_DIR).catch(() => {});
}

async function getAuthConfig() {
  const res = await fetch(`${APP_URL}/api/perch-terminal/cli-auth/config`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`cli-auth/config failed: HTTP ${res.status}`);
  const cfg = await res.json();
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    throw new Error("cli-auth/config did not return supabaseUrl/supabaseAnonKey");
  }
  return cfg;
}

async function login(provider) {
  const cfg = await getAuthConfig();
  const verifier = b64url(randomBytes(64));
  const challenge = b64url(createHash("sha256").update(verifier).digest());

  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get("error");
      const authCode = url.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(err ? "Login failed, you can close this tab." : "Login complete, you can close this tab.");
      clearTimeout(timer);
      server.close();
      err ? reject(new Error(`authorization failed: ${err}`)) : resolve(authCode);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`login timed out after ${LOGIN_TIMEOUT_MS / 1000}s`));
    }, LOGIN_TIMEOUT_MS);

    server.listen(0, "127.0.0.1", () => {
      const redirectTo = `http://${cfg.redirectHost || "127.0.0.1"}:${server.address().port}/callback`;
      const url = new URL(`${cfg.supabaseUrl}/auth/v1/authorize`);
      url.searchParams.set("provider", provider);
      url.searchParams.set("redirect_to", redirectTo);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "s256");
      if (provider === "google") url.searchParams.set("prompt", "select_account");
      console.log(`\nOpen this link in your browser to log in (${provider}):\n\n${url}\n`);
      console.log(`Waiting for the callback on ${redirectTo} ...`);
    });
  });

  if (!code) throw new Error("callback did not contain a code");

  const res = await fetch(`${cfg.supabaseUrl}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: cfg.supabaseAnonKey },
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  });
  const tok = await res.json();
  if (!res.ok || !tok.access_token) {
    throw new Error(`token exchange failed: HTTP ${res.status} ${JSON.stringify(tok)}`);
  }

  const session = {
    version: 1,
    appUrl: cfg.appUrl || APP_URL,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + (tok.expires_in ?? 3600),
    userId: tok.user?.id ?? null,
    email: tok.user?.email ?? null,
    updatedAt: new Date().toISOString(),
  };
  await saveSession(session);
  console.log(`\nSession saved to ${SESSION_FILE}`);
  console.log(`user: ${session.email || session.userId} (expires ${new Date(session.expiresAt * 1000).toISOString()})`);
  return session;
}

async function refreshSession(session) {
  const cfg = await getAuthConfig();
  const res = await fetch(`${cfg.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: cfg.supabaseAnonKey },
    body: JSON.stringify({ refresh_token: session.refreshToken }),
  });
  const tok = await res.json();
  if (!res.ok || !tok.access_token) {
    throw new Error(`refresh failed: HTTP ${res.status} ${JSON.stringify(tok)}`);
  }
  const next = {
    ...session,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? session.refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + (tok.expires_in ?? 3600),
    updatedAt: new Date().toISOString(),
  };
  await saveSession(next);
  return next;
}

async function ensureSession() {
  let session = await readSession();
  if (!session?.accessToken) return login("google");
  if (session.expiresAt - Math.floor(Date.now() / 1000) < REFRESH_MARGIN_S) {
    console.log("Access token near expiry, refreshing ...");
    session = await refreshSession(session);
  }
  return session;
}

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${APP_URL}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _raw: text };
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${path}: ${data.error || data.message || text.slice(0, 300)}`);
    err.status = res.status;
    err.code = data.error;
    throw err;
  }
  return data;
}

function handleEvent(evt) {
  switch (evt.type) {
    case "answer_delta":
      process.stdout.write(evt.text);
      break;
    case "done": {
      if (!evt.ok) {
        console.error(`\n[done] ok=false error=${evt.error || evt.message || "unknown"}`);
        break;
      }
      const u = evt.usage || {};
      console.log(
        `\n[done] model=${evt.model} provider=${evt.provider} finishReason=${evt.finishReason} ` +
          `durationMs=${evt.durationMs} tokens=${u.totalTokens}`,
      );
      break;
    }
    case "error":
      console.error(`\n[error] ${evt.message}`);
      break;
    case "model_call_failed":
      console.error(`\n[model_call_failed] ${evt.provider}/${evt.modelId} ${evt.errorCategory || ""} ${evt.error || ""}`);
      break;
  }
}

async function streamSSE(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) handleEvent(JSON.parse(line.slice(5).trim()));
    }
  }
  if (buf.startsWith("data:")) handleEvent(JSON.parse(buf.slice(5).trim()));
}

async function chat(prompt, { dryRun = false, systemFile = null } = {}) {
  const session = await ensureSession();

  const send = async (sess) => {
    const ctx = await api("/api/perch-terminal/cli-context", {
      method: "POST",
      token: sess.accessToken,
      body: { query: prompt, limitPerScope: 8 },
    });
    const ticket = await api("/api/perch-terminal/turn-ticket", {
      method: "POST",
      token: sess.accessToken,
      body: { surface: "cli", profile: "standard" },
    });

    const messages = [];
    if (systemFile) messages.push({ role: "system", content: await readFile(systemFile, "utf8") });
    messages.push({ role: "user", content: prompt });

    const body = {
      request: { messages, temperature: 0.6, maxTokens: 32000, toolChoice: "auto" },
      runId: ticket.runId,
      lane: "chat",
      strictManual: false,
      preferredModelId: null,
      avoidModelIds: [],
      attribution: {
        userId: ctx.session?.userId ?? null,
        workspaceId: ctx.session?.workspaceId ?? null,
        runId: ticket.runId,
        lane: "chat",
        source: "cli",
        billingMultiplier: null,
      },
      clientSurface: "cli",
    };

    if (dryRun) {
      console.log("POST /api/perch-terminal/model-call  (not sent)");
      console.log(JSON.stringify(body, null, 2));
      return;
    }

    const res = await fetch(`${APP_URL}/api/perch-terminal/model-call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${sess.accessToken}`,
        "user-agent": UA,
        "x-perch-turn-ticket": ticket.ticket,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`model-call failed: HTTP ${res.status} ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    await streamSSE(res);
  };

  try {
    await send(session);
  } catch (e) {
    if (e.status === 401) {
      console.log("401 on model-call, refreshing session and retrying once ...");
      await send(await refreshSession(session));
    } else {
      throw e;
    }
  }
}

function usage() {
  console.log(`usage:
  node perch_login.mjs login [--github]
  node perch_login.mjs whoami
  node perch_login.mjs chat "your message" [--dry-run] [--system FILE]
  node perch_login.mjs logout`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));

  switch (cmd) {
    case "login":
      await login(flags.has("--github") ? "github" : "google");
      break;
    case "whoami": {
      const s = await readSession();
      if (!s) {
        console.log("no session; run: node perch_login.mjs login");
        break;
      }
      const left = s.expiresAt - Math.floor(Date.now() / 1000);
      console.log(`email:    ${s.email}`);
      console.log(`userId:   ${s.userId}`);
      console.log(`appUrl:   ${s.appUrl}`);
      console.log(`expires:  ${new Date(s.expiresAt * 1000).toISOString()} (${left}s left)`);
      console.log(`file:     ${SESSION_FILE}`);
      break;
    }
    case "chat": {
      const sysIdx = args.indexOf("--system");
      const systemFile = sysIdx >= 0 ? args[sysIdx + 1] : null;
      const words = sysIdx >= 0 ? args.toSpliced(sysIdx, 2) : args;
      const prompt = words.filter((a) => !a.startsWith("--")).join(" ").trim();
      if (!prompt) return usage();
      await chat(prompt, { dryRun: flags.has("--dry-run"), systemFile });
      break;
    }
    case "logout":
      await rm(SESSION_FILE, { force: true });
      console.log(`removed ${SESSION_FILE}`);
      break;
    default:
      usage();
  }
}

main().catch((e) => {
  console.error(`\nerror: ${e.message}`);
  process.exitCode = 1;
});
