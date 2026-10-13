/**
 * Perch 本地观测蜜罐（passive tap）
 *
 * 设计原则（严格遵守 Perch 服务条款）：
 *   - 只观测，不修改：请求/响应字节原样透传，服务端看到的与官方 CLI 完全一致
 *   - 不伪造：不改 header、不改 body、不改版本号、不造 ticket
 *   - 不重放：不缓存后重发，不并发额外请求
 *   - 不绕过：不尝试认证变体，不探测端点
 *
 * 用法：
 *   NODE_OPTIONS="--import file:///.../honeypot/tap.mjs" perch
 *   或：./run-with-tap.sh
 *
 * 输出：
 *   honeypot/logs/<timestamp>-<seq>.json   单次请求/响应完整记录
 *   honeypot/logs/index.jsonl              索引（每行一条摘要）
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = process.env.PERCH_TAP_LOG_DIR?.trim() || join(HERE, "logs");
const INDEX = join(LOG_DIR, "index.jsonl");

mkdirSync(LOG_DIR, { recursive: true });

// 只观测 Perch 自己的端点，其他流量（npm registry、模型厂商等）不记录
const TARGET_HOSTS = [
  "app.perchai.app",
  "chat.perchai.app",
  "perchai.app",
  "www.perchai.app",
  // 仅用于透明性自测（本地回环），生产观测时留空
  ...(process.env.PERCH_TAP_EXTRA_HOSTS?.split(",").map((s) => s.trim()).filter(Boolean) ?? []),
];

// 敏感 header 脱敏（避免把 token 明文落盘）
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "apikey",
]);

let seq = 0;
const startedAt = new Date().toISOString().replace(/[:.]/g, "-");

function redactHeaders(headers) {
  const out = {};
  try {
    const entries =
      headers instanceof Headers
        ? [...headers.entries()]
        : Array.isArray(headers)
          ? headers
          : Object.entries(headers ?? {});
    for (const [k, v] of entries) {
      const key = String(k).toLowerCase();
      if (SENSITIVE_HEADERS.has(key)) {
        const s = String(v);
        out[k] = s.length > 24 ? `${s.slice(0, 12)}…${s.slice(-6)} (${s.length})` : "***";
      } else {
        out[k] = v;
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

function shouldTap(url) {
  try {
    const u = new URL(String(url));
    return TARGET_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

const REQ_PREVIEW_LIMIT = Number(process.env.PERCH_TAP_REQ_LIMIT ?? 524288);
const RES_PREVIEW_LIMIT = Number(process.env.PERCH_TAP_RES_LIMIT ?? 524288);

function bodyPreview(body) {
  if (body == null) return null;
  try {
    if (typeof body === "string") return body.slice(0, REQ_PREVIEW_LIMIT);
    if (body instanceof Uint8Array) {
      return new TextDecoder().decode(body.slice(0, REQ_PREVIEW_LIMIT));
    }
    if (body instanceof ArrayBuffer) {
      return new TextDecoder().decode(new Uint8Array(body).slice(0, REQ_PREVIEW_LIMIT));
    }
    return String(body).slice(0, REQ_PREVIEW_LIMIT);
  } catch {
    return "(unreadable)";
  }
}

function record(entry) {
  const id = `${startedAt}-${String(++seq).padStart(4, "0")}`;
  try {
    writeFileSync(join(LOG_DIR, `${id}.json`), JSON.stringify(entry, null, 2), "utf8");
    appendFileSync(
      INDEX,
      JSON.stringify({
        id,
        at: entry.at,
        method: entry.method,
        url: entry.url,
        status: entry.status ?? null,
        ms: entry.ms ?? null,
        note: entry.note ?? null,
      }) + "\n",
      "utf8",
    );
  } catch (e) {
    console.error("[tap] write failed:", e?.message ?? e);
  }
}

const realFetch = globalThis.fetch;

globalThis.fetch = async function tappedFetch(input, init) {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (!shouldTap(url)) return realFetch(input, init);

  const method = String(
    init?.method ?? (typeof input === "object" ? input?.method : null) ?? "GET",
  ).toUpperCase();
  const reqHeaders = redactHeaders(init?.headers ?? (typeof input === "object" ? input?.headers : null));
  const reqBody = bodyPreview(init?.body);
  const t0 = Date.now();

  let res;
  try {
    res = await realFetch(input, init);
  } catch (err) {
    record({
      at: new Date().toISOString(),
      method,
      url,
      requestHeaders: reqHeaders,
      requestBody: reqBody,
      error: err?.message ?? String(err),
      ms: Date.now() - t0,
      note: "network error",
    });
    throw err;
  }

  const ms = Date.now() - t0;
  const resHeaders = redactHeaders(res.headers);
  const contentType = res.headers.get("content-type") ?? "";
  const isStream = contentType.includes("text/event-stream");

  // 关键：用 clone() 读取副本，原响应对象完全不被触碰
  // clone() 是 WHATWG Fetch 标准 API，保证字节级一致
  if (isStream) {
    const clone = res.clone();
    (async () => {
      let text = "";
      try {
        const reader = clone.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += dec.decode(value, { stream: true });
          if (text.length > 400_000) break;
        }
      } catch {
        /* ignore */
      }
      record({
        at: new Date().toISOString(),
        method,
        url,
        requestHeaders: reqHeaders,
        requestBody: reqBody,
        status: res.status,
        responseHeaders: resHeaders,
        responseBody: text.slice(0, RES_PREVIEW_LIMIT),
        streamed: true,
        ms,
      });
    })();
    return res;   // 原响应原样返回，未做任何包装
  }

  // 非流式：同样用 clone()
  let resBody = null;
  try {
    resBody = (await res.clone().text()).slice(0, RES_PREVIEW_LIMIT);
  } catch {
    resBody = "(unreadable)";
  }
  record({
    at: new Date().toISOString(),
    method,
    url,
    requestHeaders: reqHeaders,
    requestBody: reqBody,
    status: res.status,
    responseHeaders: resHeaders,
    responseBody: resBody,
    streamed: false,
    ms,
  });
  return res;   // 原响应原样返回
};

console.error(`[tap] Perch 观测蜜罐已启用 → ${LOG_DIR}`);
