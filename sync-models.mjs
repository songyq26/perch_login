#!/usr/bin/env node
// 模型注册表同步：从已安装的 Perch CLI bundle（dist/perch.mjs）提取官方 /model 菜单的
// 模型清单（Yle+Jle 注册表），写入同目录 models.json。
//
//   node sync-models.mjs             重新提取并对比（打印新增/移除）
//   node sync-models.mjs --check     只检查是否落后于 CLI，不写文件
//   node sync-models.mjs --bundle <dist/perch.mjs 路径>
//
// 更新流程：npm i -g perchai-cli@latest 后重跑一次即可；
// openai-gateway.mjs 启动时会自动做同样的检查（bundle 比 models.json 新就重提取）。

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

const makeId = (providerId, modelId) =>
  providerId.replace(/_/g, "-") + "-" +
  modelId.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();

function extractModels(s) {
  const objAt = (name) => {
    const i = s.indexOf(name + "={");
    return i === -1 ? null : balanced(s, i + name.length);
  };

  // 注册项自身对象 → 元数据
  const registry = {};
  for (const m of s.matchAll(/Yn\(\{providerId:"([^"]+)",modelId:"([^"]+)"/g)) {
    const open = s.indexOf("{", m.index);
    const own = balanced(s, open) ?? s.slice(m.index, m.index + 400);
    const ctx = /contextWindow:([\d.e+]+)/.exec(own);
    const maxOut = /maxOutputTokens:([\d.e+]+)/.exec(own);
    const label = /label:"([^"]*)"/.exec(own);
    registry[makeId(m[1], m[2])] = {
      contextWindow: ctx ? Number(ctx[1]) : null,
      maxOutputTokens: maxOut ? Number(maxOut[1]) : null,
      regLabel: label?.[1] ?? null,
      internal: /userFacing:!1/.test(own),
      manualOnly: /manualOnly:!0/.test(own),
    };
  }

  // 变量 → optionId：hi() 定义与字符串字面量定义
  const nameToId = {};
  for (const m of s.matchAll(/([A-Za-z_$][\w$]*)=hi\("([^"]+)","([^"]+)"\)/g)) {
    nameToId[m[1]] = makeId(m[2], m[3]);
  }
  const resolveRef = (ref) => {
    if (nameToId[ref]) return nameToId[ref];
    const m = new RegExp("[,;{]" + ref.replace(/\$/g, "\\$") + '="([^"]+)"').exec(s);
    return m?.[1] ?? null;
  };

  const parseMap = (text) => {
    const out = {};
    const re = /(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))\s*:\s*([^,}]+)/g;
    let x;
    while ((x = re.exec(text))) out[x[1] ?? x[2]] = x[3].trim();
    return out;
  };
  const yle = parseMap(objAt("Yle"));
  const jle = parseMap(objAt("Jle"));

  const labels = {};
  const labelsText = objAt("$nn");
  if (labelsText) {
    for (const x of labelsText.matchAll(/"([^"]+)":"([^"]*)"/g)) labels[x[1]] = x[2];
  }

  const out = [];
  const seen = new Set();
  for (const [group, map] of [["starter", yle], ["pro", jle]]) {
    for (const [name, refExpr] of Object.entries(map)) {
      const id = resolveRef(refExpr);
      if (!id || seen.has(id)) continue;
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
  return out;
}

export async function syncModels({ bundlePath, quiet = false } = {}) {
  const bundle = bundlePath ?? (await findBundle());
  if (!bundle) throw new Error("未找到 Perch CLI bundle（dist/perch.mjs）——可用 PERCH_CLI_DIR 环境变量或 --bundle 指定路径");

  const s = await fs.readFile(bundle, "utf8");
  const models = extractModels(s);
  if (models.length === 0) throw new Error(`从 ${bundle} 未解析出任何模型（CLI 结构可能变了）`);

  let prev = null;
  try {
    prev = JSON.parse(await fs.readFile(MODELS_FILE, "utf8"))?.models ?? null;
  } catch {}
  const prevIds = new Set((prev ?? []).map((m) => m.id));
  const nextIds = new Set(models.map((m) => m.id));
  const added = models.filter((m) => !prevIds.has(m.id)).map((m) => m.id);
  const removed = (prev ?? []).filter((m) => !nextIds.has(m.id)).map((m) => m.id);

  const version = await cliVersion(bundle);
  await fs.writeFile(
    MODELS_FILE,
    JSON.stringify({ extractedAt: new Date().toISOString(), cliVersion: version, source: bundle, models }, null, 2) + "\n"
  );

  if (!quiet) {
    console.log(`已从 ${bundle}（CLI v${version}）提取 ${models.length} 个模型 → ${MODELS_FILE}`);
    if (added.length) console.log(`  新增: ${added.join(", ")}`);
    if (removed.length) console.log(`  移除: ${removed.join(", ")}`);
    if (!added.length && !removed.length) console.log("  与上一版一致，无增删");
  }
  return { bundlePath: bundle, version, count: models.length, added, removed };
}

export async function syncIfStale() {
  const bundle = await findBundle();
  if (!bundle) return null;
  const bStat = await fs.stat(bundle).catch(() => null);
  const mStat = await fs.stat(MODELS_FILE).catch(() => null);
  if (bStat && mStat && mStat.mtimeMs >= bStat.mtimeMs) {
    let count = 0;
    try {
      count = JSON.parse(await fs.readFile(MODELS_FILE, "utf8")).models?.length ?? 0;
    } catch {}
    return { synced: false, bundlePath: bundle, version: await cliVersion(bundle), count, added: [], removed: [] };
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
      const bundle = await findBundle();
      if (!bundle) throw new Error("未找到 CLI bundle");
      const bStat = await fs.stat(bundle).catch(() => null);
      const mStat = await fs.stat(MODELS_FILE).catch(() => null);
      const stale = !mStat || (bStat && mStat.mtimeMs < bStat.mtimeMs);
      console.log(
        stale
          ? "models.json 落后于 CLI（运行 node sync-models.mjs 更新）"
          : `models.json 已是最新（CLI v${await cliVersion(bundle)}）`
      );
    } else {
      await syncModels({ bundlePath: flagValue("--bundle") });
    }
  } catch (e) {
    console.error(`× ${e?.message ?? e}`);
    process.exitCode = 1;
  }
}
