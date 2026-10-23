// Perch 共享核心：会话存取/刷新、领票、model-call（SSE）——client 与 gateway 共用
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const APP_URL = (process.env.PERCH_CLI_APP_URL || process.env.PERCH_APP_URL || "https://app.perchai.app").replace(/\/+$/, "");
export const TOKEN_FILE = path.join(import.meta.dirname, "token.json");
export const UA = "perchai-cli/unknown";
// 官方 2.4.113 起在 cli-context / account / turn-ticket / model-call 上带 locale；
// model-call 另外固定带 x-perch-call-delta: 1（能力声明：首轮 body 是完整 request 也照发）
export const LOCALE = process.env.PERCH_LOCALE?.trim() || "en";
export const LOCALE_HEADER = { "x-perch-locale": LOCALE };
export const SUPA_CLIENT_INFO = "supabase-js-node/2.106.0";
export const EXPIRY_MARGIN_S = 90;

// 刷新锁参数（与官方 CLI 一致）：15s 等待上限 / 30s 陈旧阈值 / 50ms 轮询 / 30s 失败退避 / 24h 吊销缓存
const LOCK_WAIT_MS = 15000;
const LOCK_STALE_MS = 30000;
const LOCK_POLL_MS = 50;
const REFRESH_FAIL_BACKOFF_MS = 30000;
const REVOKED_TTL_MS = 24 * 60 * 60 * 1000;

// 票据参数（与官方 CLI 一致）：头部名 / 8s 超时 / 30s 提前续期阈值 / 5 分钟默认有效期
const TICKET_HEADER = "x-perch-turn-ticket";
const TICKET_TIMEOUT_MS = 8000;
const TICKET_RENEW_THRESHOLD_MS = 30000;
const TICKET_DEFAULT_TTL_MS = 300000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

export async function fetchAuthConfig() {
  const res = await fetch(`${APP_URL}/api/perch-terminal/cli-auth/config`, { headers: { Accept: "application/json" } });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok || !data.supabaseUrl || !data.supabaseAnonKey) {
    throw new Error(`获取 cli-auth/config 失败（HTTP ${res.status}）`);
  }
  return data;
}

export async function supabaseToken(supabaseUrl, anonKey, grantType, body) {
  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=${grantType}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "X-Client-Info": SUPA_CLIENT_INFO,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    const msg = data?.error_description || data?.msg || data?.message || `HTTP ${res.status}`;
    throw new Error(`Supabase ${grantType} 失败：${msg}`);
  }
  return data;
}

export function sessionFromToken(data, appUrl) {
  const s = data.session ?? data;
  return {
    version: 1,
    appUrl,
    accessToken: s.access_token,
    refreshToken: s.refresh_token ?? null,
    expiresAt: s.expires_at ?? null,
    userId: s.user?.id ?? null,
    email: s.user?.email ?? null,
    updatedAt: new Date().toISOString(),
  };
}

let sessionFile = TOKEN_FILE;

export async function saveSessionAt(session, file) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(session, null, 2) + "\n", { mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => {});
}

export async function saveSession(session) {
  await saveSessionAt(session, sessionFile);
}

export async function loadSessionAt(file) {
  try {
    const s = JSON.parse(await fs.readFile(file, "utf8"));
    if (s?.accessToken) return { ...s, appUrl: s.appUrl || APP_URL };
  } catch {}
  return null;
}

export async function loadSession() {
  for (const file of [TOKEN_FILE, path.join(import.meta.dirname, "state", "token.json")]) {
    const s = await loadSessionAt(file);
    if (s) {
      sessionFile = file;
      return s;
    }
  }
  return null;
}

function sha256hex(s) {
  return createHash("sha256").update(s).digest("hex");
}

function authDir() {
  return process.env.PERCH_CLI_AUTH_DIR?.trim() || path.join(os.homedir(), ".perch");
}

function lockFile() {
  return path.join(authDir(), "cli-auth-refresh.lock");
}

function invalidCacheFile() {
  return path.join(authDir(), "cli-auth-refresh.invalid.json");
}

export async function acquireRefreshLock() {
  const file = lockFile();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fh = await fs.open(file, "wx", 0o600);
      await fh.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      await fh.close();
      break;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      const st = await fs.stat(file).catch(() => null);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await fs.rm(file, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("获取刷新锁超时（另一进程正在刷新会话），请稍后重试");
      }
      await sleep(LOCK_POLL_MS);
    }
  }
  return async () => {
    await fs.rm(file, { force: true }).catch(() => {});
  };
}

async function isRevokedCached(hash) {
  try {
    const c = JSON.parse(await fs.readFile(invalidCacheFile(), "utf8"));
    return c?.tokenHash === hash && c.expiresAt > Date.now();
  } catch {
    return false;
  }
}

async function writeRevokedCache(hash) {
  try {
    await fs.writeFile(invalidCacheFile(), JSON.stringify({ tokenHash: hash, expiresAt: Date.now() + REVOKED_TTL_MS }), { mode: 0o600 });
  } catch {}
}

const inflightRefreshes = new Map();
const refreshBackoffUntil = new Map();

export async function ensureFresh(session, force = false, file = null) {
  const now = Math.floor(Date.now() / 1000);
  if (!force && session.expiresAt && session.expiresAt > now + EXPIRY_MARGIN_S) return session;
  if (!session.refreshToken) throw new Error("会话已过期且无 refresh_token，请重新运行 login");

  const key = `${session.appUrl ?? APP_URL}::${session.userId?.trim() || session.refreshToken.slice(0, 16)}`;
  const inflight = inflightRefreshes.get(key);
  if (inflight) return inflight;
  const backoff = refreshBackoffUntil.get(key);
  if (backoff && backoff > Date.now()) throw new Error("会话刷新失败退避中（30 秒），请稍后重试");

  const p = doRefresh(session, key, file ?? sessionFile).finally(() => inflightRefreshes.delete(key));
  inflightRefreshes.set(key, p);
  return p;
}

async function doRefresh(session, key, file) {
  const release = await acquireRefreshLock();
  try {
    // 锁内二次检查：并发进程可能刚刷新过，直接采用最新会话
    const latest = await loadSessionAt(file);
    const nowS = Math.floor(Date.now() / 1000);
    if (
      latest?.accessToken &&
      latest.accessToken !== session.accessToken &&
      latest.expiresAt &&
      latest.expiresAt > nowS + EXPIRY_MARGIN_S
    ) {
      return latest;
    }

    const tokenHash = sha256hex(session.refreshToken);
    if (await isRevokedCached(tokenHash)) {
      throw new Error("refresh_token 已被吊销（24 小时内缓存），请重新运行 login");
    }

    const cfg = await fetchAuthConfig();
    try {
      const data = await supabaseToken(cfg.supabaseUrl, cfg.supabaseAnonKey, "refresh_token", { refresh_token: session.refreshToken });
      const fresh = sessionFromToken(data, session.appUrl || cfg.appUrl || APP_URL);
      await saveSessionAt(fresh, file);
      refreshBackoffUntil.delete(key);
      return fresh;
    } catch (e) {
      if (/refresh_token_not_found|invalid/i.test(e.message)) {
        await writeRevokedCache(tokenHash);
        throw new Error("refresh_token 已被吊销，请重新运行 login");
      }
      refreshBackoffUntil.set(key, Date.now() + REFRESH_FAIL_BACKOFF_MS);
      throw e;
    }
  } finally {
    await release();
  }
}

export async function postJson(url, headers, body) {
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

export async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }
        onEvent(ev);
      }
    }
  }
}

export class PerchTicketError extends Error {
  constructor(message, errorCode) {
    super(message);
    this.name = "PerchTicketError";
    this.errorCode = errorCode;
  }
}

export function fallbackRunId(ts = Date.now()) {
  return `cli-turn-${ts}-${Math.random().toString(36).slice(2, 8)}`;
}

// 模型注册表（models.json，由 dist/perch.mjs 的 Yle+Jle 注册表提取，与官方 /model 菜单同源）
// 按文件 mtime 缓存失效：sync-models.mjs 重写后无需重启网关即可生效
let modelsCache = null;
let modelsMtime = 0;
export async function loadModels() {
  const file = path.join(import.meta.dirname, "models.json");
  try {
    const st = await fs.stat(file);
    if (!modelsCache || st.mtimeMs !== modelsMtime) {
      const data = JSON.parse(await fs.readFile(file, "utf8"));
      modelsCache = Array.isArray(data?.models) ? data.models : [];
      modelsMtime = st.mtimeMs;
    }
  } catch {
    if (!modelsCache) modelsCache = [];
  }
  return modelsCache;
}

// 名字/id → 模型（归一化规则同官方 fRt：小写 + [\s_.-] 折叠为 "-"）
export async function resolveModel(input) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;
  const norm = (x) => x.trim().toLowerCase().replace(/[\s_.-]+/g, "-");
  const q = norm(trimmed);
  const models = await loadModels();
  return models.find((m) => m.id === trimmed || norm(m.id) === q || norm(m.label) === q) ?? null;
}

// Roost 路由档位（官方 /model 菜单顶部四档；归一化规则同官方 jnn）
export const ROOST_TIERS = ["standard", "standard_max", "pro", "pro_max"];

export function resolveTier(input) {
  const t = String(input ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const norm = t === "standardmax" ? "standard_max" : t === "promax" || t === "max" ? "pro_max" : t;
  return ROOST_TIERS.includes(norm) ? norm : null;
}

// 官方档位三件套（--model pro 实测：roostReasoning 与 effort.level 联动，官方默认 high）
// effort 级别全集（官方 jS 常量）；off ↔ reasoningEnabled:false（官方 sun() 归一化规则）
export const ROOST_EFFORT_LEVELS = ["off", "low", "medium", "high", "xhigh", "max", "ultra"];

export function roostFields(tier, level = "high") {
  if (!ROOST_EFFORT_LEVELS.includes(level)) {
    throw new Error(`未知 effort 级别：${level}（可选：${ROOST_EFFORT_LEVELS.join(" / ")}）`);
  }
  return level === "off"
    ? { roostModelChoice: tier, roostReasoning: false, effort: { level: "off" } }
    : { roostModelChoice: tier, roostReasoning: true, effort: { level } };
}

// 票据管理器：官方 dBt（领票） / aue（取头部，>30s 复用、≤30s 用 renewal 续期） / yun（续期）的等价实现。
// 官方在单进程内维护全局票据状态；网关并发场景按「每个请求即一轮」各建一个实例，语义与官方一致。
export function createTicketManager() {
  let current = null;
  let renewal = null;
  let seq = 0;
  let enforced = false;

  async function postTicket(ctx, body) {
    const token = ctx.accessToken?.trim();
    if (!token) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TICKET_TIMEOUT_MS);
    try {
      return await fetch(`${(ctx.appUrl ?? APP_URL).replace(/\/+$/, "")}/api/perch-terminal/turn-ticket`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "User-Agent": UA,
          ...LOCALE_HEADER,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function ticketFrom(data, renewalCtx, profile) {
    if (!data?.ok || !data.ticket || !data.ticketId || !data.runId) return null;
    const parsed = data.expiresAt ? Date.parse(data.expiresAt) : NaN;
    return {
      token: data.ticket,
      ticketId: data.ticketId,
      runId: data.runId,
      expiresAt: Number.isFinite(parsed) ? parsed : Date.now() + TICKET_DEFAULT_TTL_MS,
      profile: data.profile ?? profile,
      enforced: data.enforced === true,
      renewal: renewalCtx,
    };
  }

  async function fetchNew(ctx) {
    const res = await postTicket(ctx, { surface: "cli", profile: ctx.profile ?? "standard" });
    if (res?.status === 429) {
      const data = await res.json().catch(() => null);
      if (data?.enforced && data.errorCode === "turn_rate_limited") {
        throw new PerchTicketError(data.error || "已达套餐的轮次限速", "turn_rate_limited");
      }
      return null;
    }
    if (!res) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (data?.enforced) {
        throw new PerchTicketError("Perch 无法开始受管模型轮次，请检查网络后重试", "turn_ticket_unavailable");
      }
      return null;
    }
    return data ? ticketFrom(data, { appUrl: ctx.appUrl, accessToken: ctx.accessToken }, ctx.profile ?? "standard") : null;
  }

  async function renew() {
    const cur = current;
    if (!cur?.renewal) return null;
    const res = await postTicket(cur.renewal, { renew: true, ticketId: cur.ticketId });
    if (!res?.ok) return null;
    const data = await res.json().catch(() => null);
    return data ? ticketFrom(data, cur.renewal, cur.profile) : null;
  }

  return {
    async obtain(ctx) {
      const mySeq = ++seq;
      let ticket = null;
      try {
        ticket = await fetchNew(ctx);
      } catch (e) {
        if (mySeq === seq) {
          current = null;
          enforced = e instanceof PerchTicketError && e.errorCode === "turn_ticket_unavailable";
          renewal = null;
        }
        throw e;
      }
      if (mySeq !== seq) return null;
      current = ticket;
      enforced = ticket?.enforced === true;
      renewal = null;
      return ticket?.runId ?? null;
    },

    async headers() {
      const cur = current;
      if (!cur) {
        if (enforced) throw new PerchTicketError("Perch 无法开始受管模型轮次，请检查网络后重试", "turn_ticket_unavailable");
        return {};
      }
      if (cur.expiresAt > Date.now() + TICKET_RENEW_THRESHOLD_MS) return { [TICKET_HEADER]: cur.token };
      if (!cur.renewal) {
        if (cur.expiresAt > Date.now()) return { [TICKET_HEADER]: cur.token };
        current = null;
        if (enforced) throw new PerchTicketError("Perch 无法开始受管模型轮次，请检查网络后重试", "turn_ticket_unavailable");
        return {};
      }
      renewal ??= renew();
      const renewed = await renewal;
      renewal = null;
      if (current?.ticketId === cur.ticketId) current = renewed;
      if (renewed) return { [TICKET_HEADER]: renewed.token };
      if (cur.expiresAt > Date.now()) return { [TICKET_HEADER]: cur.token };
      if (enforced) throw new PerchTicketError("Perch 无法开始受管模型轮次，请检查网络后重试", "turn_ticket_unavailable");
      return {};
    },
  };
}

export async function callModel(session, ticketHeaders, body, signal, tokenFile = null) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(`${APP_URL}/api/perch-terminal/model-call`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${session.accessToken}`,
          "User-Agent": UA,
          "x-perch-call-delta": "1",
          ...LOCALE_HEADER,
          ...ticketHeaders,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      lastErr = e;
      if (attempt === 2) break;
      await sleep(350 * 2 ** attempt);
      continue;
    }
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      if (attempt === 0) {
        try { session = await ensureFresh(session, true, tokenFile); } catch {}
        continue;
      }
      return { res, session };
    }
    if (res.status === 408 || res.status === 425 || (res.status >= 500 && res.status <= 599)) {
      await res.body?.cancel().catch(() => {});
      lastErr = new Error(`HTTP ${res.status}`);
      if (attempt === 2) break;
      await sleep(350 * 2 ** attempt);
      continue;
    }
    return { res, session };
  }
  throw lastErr ?? new Error("model-call 请求失败");
}
