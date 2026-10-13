#!/usr/bin/env python3
"""
蜜罐响应语料库构建器（纯离线）

输入：honeypot/logs-run{1..5}/ 及 logs/ 下的所有 JSON 日志
输出：honeypot/corpus/ 下的结构化语料

目的：把蜜罐捕获的请求/响应建成可差分的语料库，
     从错误形状反推服务端校验顺序（gate 层级的指纹）。
"""

import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_DIRS = [os.path.join(HERE, d) for d in os.listdir(HERE)
            if d.startswith("logs") and os.path.isdir(os.path.join(HERE, d))]
OUT_DIR = os.path.join(HERE, "corpus")
os.makedirs(OUT_DIR, exist_ok=True)

records = []

def load_logs():
    for d in LOG_DIRS:
        for f in sorted(os.listdir(d)):
            if not f.endswith(".json"):
                continue
            path = os.path.join(d, f)
            try:
                with open(path, encoding="utf-8") as fh:
                    rec = json.load(fh)
                rec["_src"] = os.path.basename(d) + "/" + f
                records.append(rec)
            except Exception as e:
                print(f"[skip] {path}: {e}", file=sys.stderr)

def parse_body(body, streamed):
    """解析响应体：JSON 或 SSE 流"""
    if not body:
        return None
    if not streamed:
        try:
            return json.loads(body)
        except Exception:
            return {"_raw": body[:500]}
    # SSE 流：逐 data: 行解析
    events = []
    for line in body.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            payload = line[5:].strip()
            try:
                events.append(json.loads(payload))
            except Exception:
                events.append({"_raw": payload[:200]})
    return {"_sse_events": events}

def main():
    load_logs()
    print(f"加载 {len(records)} 条记录")

    # 1. 端点 × 状态码 矩阵
    endpoint_status = Counter()
    status_counts = Counter()
    endpoint_times = defaultdict(list)
    for r in records:
        ep = r["url"].split("/api/")[-1] if "/api/" in r["url"] else r["url"]
        ep = "/api/" + ep.split("?")[0]
        status = r.get("status")
        endpoint_status[(ep, status)] += 1
        status_counts[status] += 1
        endpoint_times[ep].append(r.get("ms", 0))

    # 2. 错误响应体收集（非 2xx）
    errors = []
    for r in records:
        if r.get("status", 200) >= 300:
            body = parse_body(r.get("responseBody"), r.get("streamed", False))
            errors.append({
                "src": r["_src"],
                "at": r.get("at"),
                "method": r.get("method"),
                "url": r["url"],
                "status": r.get("status"),
                "ms": r.get("ms"),
                "body": body,
                "resp_headers": {k: v for k, v in (r.get("responseHeaders") or {}).items()
                                 if k.lower() in ("retry-after", "x-ratelimit-*", "content-type")},
            })

    # 3. 输出
    out = {
        "meta": {
            "generated": datetime.utcnow().isoformat() + "Z",
            "total_records": len(records),
            "log_dirs": [os.path.basename(d) for d in LOG_DIRS],
        },
        "endpoint_status_matrix": {
            f"{ep} {st}": cnt for (ep, st), cnt in sorted(endpoint_status.items())
        },
        "status_counts": dict(status_counts),
        "endpoint_latency_ms": {
            ep: {"count": len(v), "mean": round(sum(v)/len(v), 1),
                 "min": min(v), "max": max(v)}
            for ep, v in endpoint_times.items()
        },
        "errors": errors,
    }

    with open(os.path.join(OUT_DIR, "response_corpus.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    # 4. 控制台摘要
    print("\n=== 状态码分布 ===")
    for st, cnt in status_counts.most_common():
        print(f"  {st}: {cnt}")
    print("\n=== 端点 × 状态码 ===")
    for (ep, st), cnt in sorted(endpoint_status.items()):
        print(f"  {ep} -> {st} x{cnt}")
    print("\n=== 错误响应 ===")
    for e in errors:
        b = e["body"]
        if isinstance(b, dict) and "error" in b:
            err = b["error"]
        else:
            err = str(b)[:100]
        print(f"  [{e['status']}] {e['method']} {e['url'].split('/api/')[-1]} @{e['at']} :: {err}")
    print(f"\n输出: {os.path.join(OUT_DIR, 'response_corpus.json')}")

if __name__ == "__main__":
    main()