#!/usr/bin/env node
// 模型注册表同步：从已安装的 Perch CLI bundle（dist/perch.mjs）提取官方 /model 菜单的
// 模型清单，写入同目录 models.json。
//
//   node sync-models.mjs             重新提取并对比（打印新增/移除）
//   node sync-models.mjs --check     只检查是否落后于 CLI，不写文件
//   node sync-models.mjs --debug     打印锚点定位与解析情况（排查新 CLI 结构用）
//   node sync-models.mjs --bundle <dist/perch.mjs 路径>
//
// 提取策略为「结构锚点」，不依赖压缩后的变量/函数名（每次 CLI 更新都会变）：
//   - 显示名表：锚定 "laguna-s":"Laguna S 2.1" 所在的字面量对象
//   - 菜单映射：锚定 "laguna-s":<引用>（Starter 组）与 "claude-opus-5.5":<引用>（Pro 组）
//   - 模型元数据：按 providerId:"…",modelId:"…" 模式定位注册项对象
//   - 引用解析：顺藤摸到 <ref>=f("provider","model") 或 <ref>="…" 的定义
//
// 更新流程：npm i -g perchai-cli@latest 后重跑一次即可；
// openai-gateway.mjs 启动时会自动做同样的检查（CLI 版本变化或 bundle 更新就重提取）。

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = import.meta.dirname;
export const MODELS_FILE = path.join(HERE, "models.json");

export async function findBundle() {
  const candidates = [
    process.env.PERCH_CLI_DIR && path.join(process.env.PERCH_CLI_DIR, "dist", "perch.mjs"),
    path.join(HERE, "..", "dist", "perch.mjs"),
    path.join(process.cwd(), "dist", "perch.mjs"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "perchai-cli", "dist", "perch.mjs"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (await fs.stat(c).then((st) => st.isFile()).catch(() => false)) return c;
  }
  return null;
}

async function cliVersion(bundlePath) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(path.dirname(path.dirname(bundlePath)), "package.json"), "utf8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function balanced(text, start) {
  let depth = 0;
  let inStr = false;
  let q = "";
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === q) inStr = false;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = true;
      q = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// 从 "=" 之后读取一段赋值表达式（尊重括号/字符串嵌套，到顶层 , ; } 截止）
function readExpr(s, afterEq) {
  let depth = 0;
  let inStr = false;
  let q = "";
  let out = "";
  for (let i = afterEq; i < s.length && out.length < 400; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += s[++i] ?? "";
        continue;
      }
      if (c === q) inStr = false;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = true;
      q = c;
      out += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if ((c === "," || c === ";") && depth === 0) break;
    out += c;
  }
  return out.trim();
}

const makeId = (providerId, modelId) =>
  providerId.replace(/_/g, "-") + "-" +
  modelId.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();

const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function extractModels(s) {
  // 1) 显示名表（名字 → 界面显示名）
  const labelAnchor = s.indexOf('"laguna-s":"Laguna S 2.1"');
  if (labelAnchor === -1) throw new Error("未找到显示名表锚点（CLI 结构可能又变了）");
  const labelsText = balanced(s, s.lastIndexOf("{", labelAnchor));
  const labels = {};
  for (const m of labelsText.matchAll(/"([^"]+)":"([^"]*)"/g)) labels[m[1]] = m[2];

  // 2) 菜单映射（Starter / Pro 两组）
  const menus = [];
  for (const [group, anchorRe] of [
    ["starter", /"laguna-s":\s*[A-Za-z_$][\w$]*/g],
    ["pro", /"claude-opus-5\.5":\s*[A-Za-z_$][\w$]*/g],
  ]) {
    const m = anchorRe.exec(s);
    if (!m) throw new Error(`未找到 ${group} 模型映射锚点（CLI 结构可能又变了）`);
    const mapText = balanced(s, s.lastIndexOf("{", m.index));
    const map = {};
    for (const x of mapText.matchAll(/["']([^"']+)["']\s*:\s*([A-Za-z_$][\w$]*)/g)) map[x[1]] = x[2];
    menus.push([group, map]);
  }

  // 3) 注册项元数据（不依赖构建函数名）
  const registry = {};
  for (const m of s.matchAll(/providerId:"([^"]+)",modelId:"([^"]+)"/g)) {
    const own = balanced(s, s.lastIndexOf("{", m.index)) ?? "";
    const id = makeId(m[1], m[2]);
    const ctx = /contextWindow:([\d.e+]+)/.exec(own);
    const maxOut = /maxOutputTokens:([\d.e+]+)/.exec(own);
    const label = /label:"([^"]*)"/.exec(own);
    const entry = {
      contextWindow: ctx ? Number(ctx[1]) : null,
      maxOutputTokens: maxOut ? Number(maxOut[1]) : null,
      regLabel: label?.[1] ?? null,
      internal: /userFacing:!1/.test(own),
      manualOnly: /manualOnly:!0/.test(own),
    };
    const prev = registry[id];
    if (!prev || (!prev.contextWindow && entry.contextWindow)) registry[id] = entry;
  }

  // 4) 引用 → optionId：找 <ref>=<expr> 定义；expr 形如 f("provider","model") 或 "字面量 id"
  const resolveRef = (ref) => {
    const re = new RegExp("[,;{]" + escapeRe(ref) + "\\s*=\\s*");
    const m = re.exec(s);
    if (!m) return null;
    const expr = readExpr(s, m.index + m[0].length);
    const call = /\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/.exec(expr);
    if (call) return makeId(call[1], call[2]);
    const lit = /^"([^"]+)"$/.exec(expr);
    if (lit) return lit[1];
    return null;
  };

  // 5) 组装清单
  const out = [];
  const seen = new Set();
  const unresolved = [];
  for (const [group, map] of menus) {
    for (const [name, ref] of Object.entries(map)) {
      const id = resolveRef(ref);
      if (!id) {
        unresolved.push(name);
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      const meta = registry[id] ?? {};
      out.push({
        group, name, id,
        label: labels[name] ?? meta.regLabel ?? name,
        contextWindow: meta.contextWindow ?? null,
        maxOutputTokens: meta.maxOutputTokens ?? null,
        ...(meta.internal ? { internal: true } : {}),
        ...(meta.manualOnly ? { manualOnly: true } : {}),
      });
    }
  }
  return {
    models: out,
    unresolved,
    debug: {
      labelAnchor: labelAnchor >= 0,
      menuSizes: menus.map(([g, m]) => `${g}:${Object.keys(m).length} 项`),
      registryCount: Object.keys(registry).length,
    },
  };
}

export async function syncModels({ bundlePath, quiet = false, debug = false } = {}) {
  const bundle = bundlePath ?? (await findBundle());
  if (!bundle) throw new Error("未找到 Perch CLI bundle（dist/perch.mjs）——可用 PERCH_CLI_DIR 环境变量或 --bundle 指定路径");

  const s = await fs.readFile(bundle, "utf8");
  const { models, unresolved, debug: dbg } = extractModels(s);
  const version = await cliVersion(bundle);
  if (models.length === 0) {
    const hint = unresolved.length
      ? `（${unresolved.length} 个菜单引用未能解析，例如：${unresolved.slice(0, 5).join(", ")}）`
      : "";
    throw new Error(
      `从 ${bundle}（CLI v${version}）未解析出任何模型${hint}——该 CLI 版本的 bundle 结构变了，请用最新版 sync-models.mjs（结构锚点提取）重试`
    );
  }
  if (debug && !quiet) {
    console.log("调试信息:", JSON.stringify(dbg), unresolved.length ? `未解析: ${unresolved.join(", ")}` : "全部解析成功");
  }

  let prev = null;
  try {
    prev = JSON.parse(await fs.readFile(MODELS_FILE, "utf8"))?.models ?? null;
  } catch {}
  const prevIds = new Set((prev ?? []).map((m) => m.id));
  const nextIds = new Set(models.map((m) => m.id));
  const added = models.filter((m) => !prevIds.has(m.id)).map((m) => m.id);
  const removed = (prev ?? []).filter((m) => !nextIds.has(m.id)).map((m) => m.id);

  await fs.writeFile(
    MODELS_FILE,
    JSON.stringify({ extractedAt: new Date().toISOString(), cliVersion: version, source: bundle, models }, null, 2) + "\n"
  );

  if (!quiet) {
    console.log(`已从 ${bundle}（CLI v${version}）提取 ${models.length} 个模型 → ${MODELS_FILE}`);
    if (added.length) console.log(`  新增: ${added.join(", ")}`);
    if (removed.length) console.log(`  移除: ${removed.join(", ")}`);
    if (!added.length && !removed.length) console.log("  与上一版一致，无增删");
    if (unresolved.length) console.log(`  ⚠️ 未能解析引用（已跳过）: ${unresolved.join(", ")}`);
  }
  return { bundlePath: bundle, version, count: models.length, added, removed, unresolved };
}

async function staleness() {
  const bundle = await findBundle();
  if (!bundle) return null;
  const currentVersion = await cliVersion(bundle);
  let recorded = null;
  let count = 0;
  try {
    const d = JSON.parse(await fs.readFile(MODELS_FILE, "utf8"));
    recorded = d.cliVersion ?? null;
    count = d.models?.length ?? 0;
  } catch {}
  const bStat = await fs.stat(bundle).catch(() => null);
  const mStat = await fs.stat(MODELS_FILE).catch(() => null);
  // 主判据：记录里的 CLI 版本 ≠ 当前 CLI 版本；次判据：bundle 比 models.json 新（无记录版本时）
  const stale = !mStat || (recorded ? recorded !== currentVersion : bStat && mStat && mStat.mtimeMs < bStat.mtimeMs);
  return { bundle, currentVersion, recorded, count, stale };
}

export async function syncIfStale() {
  const st = await staleness();
  if (!st) return null;
  if (!st.stale) {
    return { synced: false, bundlePath: st.bundle, version: st.currentVersion, count: st.count, added: [], removed: [] };
  }
  const r = await syncModels({ quiet: true });
  return { synced: true, ...r };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const flagValue = (name) => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
  };
  try {
    if (args.includes("--check")) {
      const st = await staleness();
      if (!st) throw new Error("未找到 CLI bundle");
      console.log(
        st.stale
          ? `models.json 落后于 CLI（记录版本 v${st.recorded ?? "无"}，当前 v${st.currentVersion}；运行 node sync-models.mjs 更新）`
          : `models.json 已是最新（CLI v${st.currentVersion}，${st.count} 个模型）`
      );
    } else {
      await syncModels({ bundlePath: flagValue("--bundle"), debug: args.includes("--debug") });
    }
  } catch (e) {
    console.error(`× ${e?.message ?? e}`);
    process.exitCode = 1;
  }
}
