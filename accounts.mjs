/**
 * 多账号：accounts.json 的列表顺序就是优先级；每个账号的会话在 accounts/<名字>/token.json。
 *
 * - 发送前预检：读 /api/perchai/account（缓存 30s），manual 的 5h 或 7d 任一窗口用满就跳过该账号。
 * - 全部账号都满 → 抛 429（带最早恢复时间）；读不到额度 → 不拦（失败后照常换下一个）。
 * - 没有 accounts.json 时退回单账号：token.json（或 state/token.json）。
 *
 * 账号名会拼进路径，因此不允许分隔符或以点开头。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { APP_URL, TOKEN_FILE, ensureFresh, loadSessionAt, LOCALE_HEADER } from "./perch-core.mjs";

const HERE = import.meta.dirname;
export const ACCOUNTS_FILE = path.join(HERE, "accounts.json");
export const ACCOUNTS_DIR = path.join(HERE, "accounts");
const STATE_TOKEN = path.join(HERE, "state", "token.json");
const DEFAULT_USAGE_TTL_MS = 30_000;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function accountTokenFile(name) {
  const safe = String(name ?? "").trim();
  if (!safe || safe.startsWith(".") || /[\\/]/.test(safe)) throw new Error(`账号名不合法：${JSON.stringify(name)}`);
  return path.join(ACCOUNTS_DIR, safe, "token.json");
}

export async function loadAccountConfig() {
  try {
    const j = JSON.parse(await fs.readFile(ACCOUNTS_FILE, "utf8"));
    const list = Array.isArray(j?.accounts) ? j.accounts : [];
    const accounts = list
      .filter((a) => a && typeof a.name === "string" && a.name.trim())
      .map((a) => ({ name: a.name.trim(), enabled: a.enabled !== false, ...(a.note != null ? { note: a.note } : {}) }));
    return {
      accounts,
      usageTtlMs: Number(j?.usageTtlMs) > 0 ? Number(j.usageTtlMs) : DEFAULT_USAGE_TTL_MS,
      // autoSwitch=false：只用序列里第一个可用账号，额度满了就报错，不自动换号（更保守）
      autoSwitch: j?.autoSwitch !== false,
    };
  } catch {
    return { accounts: [], usageTtlMs: DEFAULT_USAGE_TTL_MS, autoSwitch: true };
  }
}

export async function saveAccountConfig(cfg) {
  await fs.writeFile(ACCOUNTS_FILE, JSON.stringify(cfg, null, 2) + "\n");
}

export async function addAccountConfig(name, { enabled = true, note = null } = {}) {
  const cfg = await loadAccountConfig();
  const i = cfg.accounts.findIndex((a) => a.name === name);
  if (i === -1) cfg.accounts.push({ name, enabled, ...(note != null ? { note } : {}) });
  else cfg.accounts[i] = { ...cfg.accounts[i], enabled, ...(note != null ? { note } : {}) };
  await saveAccountConfig(cfg);
  return cfg;
}

/** 配置里的账号（按列表顺序）；没有配置则退回单账号。 */
export async function listAccounts() {
  const cfg = await loadAccountConfig();
  if (!cfg.accounts.length) {
    const file = (await loadSessionAt(TOKEN_FILE)) ? TOKEN_FILE : STATE_TOKEN;
    const session = await loadSessionAt(file);
    return session ? [{ name: "default", enabled: true, note: null, tokenFile: file, session }] : [];
  }
  const out = [];
  for (const a of cfg.accounts) {
    const tokenFile = accountTokenFile(a.name);
    out.push({ ...a, tokenFile, session: await loadSessionAt(tokenFile) });
  }
  return out;
}

// ---- 额度（manual 窗口） ----

const usageCache = new Map();
// 撞到 usage_limit_reached 的账号冷却到恢复时间（或 5 分钟）：即使额度接口读不到也不再选它，
// 免得在已经满额的账号上反复试（那在服务端看来就是"撞限额"）。
const cooldowns = new Map();
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

export function markExhausted(name, untilMs = null) {
  const until = Number.isFinite(untilMs) && untilMs > Date.now() ? untilMs : Date.now() + DEFAULT_COOLDOWN_MS;
  cooldowns.set(name, until);
  usageCache.delete(name);
  return until;
}

export function cooldownUntil(name) {
  const until = cooldowns.get(name) ?? 0;
  if (until <= Date.now()) {
    cooldowns.delete(name);
    return null;
  }
  return until;
}

export function clearCooldown(name) {
  if (name == null) cooldowns.clear();
  else cooldowns.delete(name);
}

export function invalidateUsage(name) {
  if (name == null) usageCache.clear();
  else usageCache.delete(name);
}

export async function fetchAccountUsage(account, { force = false, ttlMs } = {}) {
  const ttl = ttlMs ?? (await loadAccountConfig()).usageTtlMs;
  const hit = usageCache.get(account.name);
  if (!force && hit && Date.now() - hit.at < ttl) return hit.data;
  if (!account.session) return null;
  const session = await ensureFresh(account.session, false, account.tokenFile ?? undefined);
  account.session = session;
  const r = await fetch(`${session.appUrl || APP_URL}/api/perchai/account`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${session.accessToken}`, ...LOCALE_HEADER },
    signal: AbortSignal.timeout(8000),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data?.ok) throw new Error(`读取账号额度失败（HTTP ${r.status}）`);
  usageCache.set(account.name, { at: Date.now(), data });
  return data;
}

/** manual 5h / 7d 两个窗口的状态；任一用满即 exhausted。 */
export function manualWindowState(data) {
  const meter = data?.usageMeter ?? {};
  const m = meter.manual_rolling ?? meter.manualRolling ?? null;
  if (!m || m.enabled === false) return { enabled: false, exhausted: false, reason: null, nextFreedAt: null, windows: [] };
  const windows = [
    { id: "5h", used: num(m.window5hUsd), cap: num(m.window5hCapUsd), next: m.window5hNextFreedAt ?? null },
    { id: "7d", used: num(m.window7dUsd), cap: num(m.window7dCapUsd), next: m.window7dNextFreedAt ?? null },
  ];
  const full = (w) => w.cap != null && w.cap > 0 && w.used != null && w.used >= w.cap - 1e-9;
  const reasons = windows.filter(full).map((w) => `${w.id} ${w.used.toFixed(2)}/${w.cap}`);
  const nexts = windows.map((w) => (w.next ? Date.parse(w.next) : NaN)).filter(Number.isFinite);
  return {
    enabled: true,
    exhausted: reasons.length > 0,
    reason: reasons.length ? reasons.join("、") : null,
    nextFreedAt: nexts.length ? new Date(Math.min(...nexts)).toISOString() : null,
    windows,
  };
}

/**
 * 按配置顺序挑第一个可用的账号。
 * preflight=true 时会读额度并跳过 manual 窗口已满的账号；全部满 → 抛 status=429。
 */
export async function pickAccount({ preflight = true } = {}) {
  const cfg = await loadAccountConfig();
  const accounts = await listAccounts();
  let usable = accounts.filter((a) => a.enabled && a.session);
  if (!usable.length) {
    const err = new Error(accounts.length
      ? `没有可用账号（${accounts.map((a) => `${a.name}${a.enabled ? " 未登录" : " 已禁用"}`).join("、")}）；先运行 node perch-client.mjs login --account <名字>`
      : "没有可用会话，请先运行 node perch-client.mjs login（或 login --account <名字>）");
    err.status = 503;
    throw err;
  }
  if (!cfg.autoSwitch) usable = usable.slice(0, 1); // autoSwitch=false：只看序列里第一个可用账号
  const skipped = [];
  for (const account of usable) {
    const cooling = cooldownUntil(account.name);
    if (cooling) {
      skipped.push(`${account.name}（已撞额度，冷却到 ${new Date(cooling).toISOString()}）`);
      continue;
    }
    if (!preflight) return { account, usage: null, state: null, skipped };
    let usage;
    try {
      usage = await fetchAccountUsage(account);
    } catch (e) {
      // 额度读不到就不拦——真发不出去时客户端会重试，下一个请求再换号
      skipped.push(`${account.name}（额度读取失败：${e.message}）`);
      return { account, usage: null, state: null, skipped };
    }
    const state = manualWindowState(usage);
    if (!state.enabled || !state.exhausted) return { account, usage, state, skipped };
    skipped.push(`${account.name}（manual ${state.reason}，最早恢复 ${state.nextFreedAt ?? "未知"}）`);
  }
  const err = new Error(cfg.autoSwitch
    ? `所有账号的 manual 额度窗口都已用尽：${skipped.join("；")}`
    : `当前账号额度已用尽（accounts.json autoSwitch=false，不自动换号）：${skipped.join("；")}`);
  err.status = 429;
  err.skipped = skipped;
  throw err;
}

/** 给日志用的一行摘要：名字（manual 5h/7d 用量）。 */
export function describeAccount({ account, state }) {
  if (!state?.enabled) return account.name;
  const parts = state.windows.map((w) => (w.cap ? `${w.id} ${w.used ?? 0}/${w.cap}` : null)).filter(Boolean);
  return parts.length ? `${account.name}（manual ${parts.join(" · ")}）` : account.name;
}
