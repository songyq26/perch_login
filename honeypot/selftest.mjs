#!/usr/bin/env node
/**
 * 蜜罐透明性自测
 *
 * 验证目标：tap.mjs 对请求/响应**零改动**
 *
 * 方法：
 *   1. 起一个本地回环 HTTP 服务器，返回已知的固定字节
 *   2. 分别用「无 tap」和「有 tap」的 fetch 请求它
 *   3. 逐字节比对响应体、状态码、响应头
 *   4. 同时验证 tap 记录的请求体与服务器实际收到的完全一致
 *
 * 用法：node selftest.mjs
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const TAP = `file://${join(HERE, "tap.mjs")}`;

// 固定的测试载荷（含二进制、Unicode、特殊字符）
const TEST_BODY = JSON.stringify({
  ok: true,
  unicode: "中文测试 🎯 émoji",
  binary: Buffer.from([0, 1, 2, 253, 254, 255]).toString("base64"),
  nested: { a: [1, 2, 3], b: { c: "d" } },
  special: 'quotes " \' backslash \\ newline \n tab \t',
});

const TEST_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-custom-header": "test-value-123",
  "cache-control": "no-store",
};

function startServer() {
  return new Promise((resolve) => {
    const received = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.writeHead(200, TEST_HEADERS);
        res.end(TEST_BODY);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, received });
    });
  });
}

async function runClient(port, useTap) {
  const script = `
    const res = await fetch("http://127.0.0.1:${port}/api/perch-terminal/test", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test": "abc" },
      body: ${JSON.stringify(JSON.stringify({ hello: "world", n: 42 }))},
    });
    const text = await res.text();
    const headers = {};
    for (const [k, v] of res.headers.entries()) headers[k] = v;
    console.log(JSON.stringify({ status: res.status, headers, text }));
  `;
  const env = { ...process.env };
  if (useTap) {
    env.NODE_OPTIONS = `--import ${TAP}`;
    env.PERCH_TAP_EXTRA_HOSTS = "127.0.0.1";
    env.PERCH_TAP_LOG_DIR = process.env.TEST_LOG_DIR;
  } else {
    delete env.NODE_OPTIONS;
  }
  // 用异步 spawn，避免阻塞父进程事件循环（否则同进程的 HTTP 服务器无法响应）
  const { stdout, stderr, code } = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (c) => resolve({ stdout: out, stderr: err, code: c }));
  });
  if (code !== 0) throw new Error(`client failed (${code}): ${stderr}`);
  const line = stdout.trim().split("\n").filter((l) => l.startsWith("{"))[0];
  return JSON.parse(line);
}

async function main() {
  const logDir = mkdtempSync(join(tmpdir(), "perch-tap-selftest-"));
  process.env.TEST_LOG_DIR = logDir;

  const { server, port, received } = await startServer();
  let pass = 0, fail = 0;
  const check = (name, cond, detail = "") => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name} ${detail}`); }
  };

  try {
    console.log("=== 1. 无 tap 基线 ===");
    const baseline = await runClient(port, false);
    check("基线状态码 200", baseline.status === 200);
    check("基线响应体正确", baseline.text === TEST_BODY);

    console.log("\n=== 2. 有 tap ===");
    const tapped = await runClient(port, true);
    check("tap 后状态码一致", tapped.status === baseline.status,
          `${tapped.status} vs ${baseline.status}`);
    check("tap 后响应体逐字节一致", tapped.text === baseline.text,
          `len ${tapped.text.length} vs ${baseline.text.length}`);

    console.log("\n=== 3. 响应头一致性 ===");
    for (const k of Object.keys(baseline.headers)) {
      check(`响应头 ${k} 一致`, tapped.headers[k] === baseline.headers[k],
            `${tapped.headers[k]} vs ${baseline.headers[k]}`);
    }

    console.log("\n=== 4. 服务器实际收到的请求 ===");
    check("服务器收到 2 次请求", received.length === 2, `实际 ${received.length}`);
    if (received.length === 2) {
      const [a, b] = received;
      check("两次请求 method 一致", a.method === b.method);
      check("两次请求 url 一致", a.url === b.url);
      check("两次请求 body 一致", a.body === b.body);
      check("两次请求 content-type 一致",
            a.headers["content-type"] === b.headers["content-type"]);
      check("两次请求 x-test 一致", a.headers["x-test"] === b.headers["x-test"]);
      // 关键：tap 不得添加任何额外 header
      const extraA = Object.keys(a.headers).sort().join(",");
      const extraB = Object.keys(b.headers).sort().join(",");
      check("tap 未添加额外请求头", extraA === extraB,
            `\n      baseline: ${extraA}\n      tapped:   ${extraB}`);
    }

    console.log("\n=== 5. tap 日志内容 ===");
    const files = readdirSync(logDir).filter((f) => f.endsWith(".json"));
    check("生成了日志文件", files.length >= 1, `实际 ${files.length}`);
    if (files.length >= 1) {
      const rec = JSON.parse(readFileSync(join(logDir, files[0]), "utf8"));
      check("记录了请求体", rec.requestBody?.includes("hello"), rec.requestBody?.slice(0, 60));
      check("记录了响应体", rec.responseBody === TEST_BODY);
      check("记录了状态码", rec.status === 200);
    }

    // ---- 流式响应透明性 ----
    console.log("\n=== 6. 流式响应（SSE）透明性 ===");
    const SSE_BODY = [
      'data: {"type":"answer_delta","text":"PONG"}\n',
      'data: {"type":"reasoning_delta","text":"thinking"}\n',
      'data: {"type":"done","ok":true,"text":"PONG"}\n',
    ].join("\n");

    const sseServer = createServer((req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-sse-test": "yes",
      });
      // 分块发送，模拟真实 SSE
      const chunks = SSE_BODY.split("\n");
      let i = 0;
      const timer = setInterval(() => {
        if (i >= chunks.length) { clearInterval(timer); res.end(); return; }
        res.write(chunks[i] + "\n");
        i++;
      }, 10);
    });
    await new Promise((r) => sseServer.listen(0, "127.0.0.1", r));
    const ssePort = sseServer.address().port;

    const sseScript = `
      const res = await fetch("http://127.0.0.1:${ssePort}/api/perch-terminal/model-call", {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "text/event-stream" },
        body: "{}",
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
      console.log(JSON.stringify({ status: res.status, text, ct: res.headers.get("content-type") }));
    `;

    const runSse = async (useTap) => {
      const env = { ...process.env };
      if (useTap) {
        env.NODE_OPTIONS = `--import ${TAP}`;
        env.PERCH_TAP_EXTRA_HOSTS = "127.0.0.1";
        env.PERCH_TAP_LOG_DIR = process.env.TEST_LOG_DIR;
      } else {
        delete env.NODE_OPTIONS;
      }
      const { stdout, stderr, code } = await new Promise((resolve) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", sseScript], { env });
        let out = "", err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (c) => resolve({ stdout: out, stderr: err, code: c }));
      });
      if (code !== 0) throw new Error(`sse client failed: ${stderr}`);
      const line = stdout.trim().split("\n").filter((l) => l.startsWith("{"))[0];
      return JSON.parse(line);
    };

    const sseBaseline = await runSse(false);
    const sseTapped = await runSse(true);
    check("SSE 状态码一致", sseTapped.status === sseBaseline.status);
    check("SSE 响应体逐字节一致", sseTapped.text === sseBaseline.text,
          `len ${sseTapped.text.length} vs ${sseBaseline.text.length}`);
    check("SSE content-type 一致", sseTapped.ct === sseBaseline.ct);
    check("SSE 含全部 3 个事件", sseTapped.text.includes("answer_delta")
          && sseTapped.text.includes("reasoning_delta")
          && sseTapped.text.includes("done"));

    sseServer.close();

    console.log(`\n${"=".repeat(50)}\n${pass} passed, ${fail} failed`);
    return fail === 0 ? 0 : 1;
  } finally {
    server.close();
    rmSync(logDir, { recursive: true, force: true });
  }
}

process.exit(await main());
