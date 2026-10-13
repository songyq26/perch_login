#!/bin/bash
# Perch 工具箱统一入口（网络全自动：直连优先，失败自动切代理）
#
#   ./run.sh login [--provider google|github] [--timeout 300] [--port 8976] [--callback]
#   ./run.sh ask "你的问题" [--model <id或显示名>] [--telemetry]
#   ./run.sh models [--sync]
#   ./run.sh status
#   ./run.sh gateway [--port 8787] [--host 127.0.0.1|0.0.0.0] [--key auto|<自定义key>]
#   ./run.sh sync
#
# 网络策略（无需手动切换）：
#   默认    直连探测 → 通：直连；不通：自动切代理（默认 http://127.0.0.1:7890）
#           两者都不通 → 报错退出。结果缓存 30 分钟，命令失败会清缓存重新探测。
#   逃生舱  PERCH_NO_PROXY=1 → 强制直连；HTTPS_PROXY=http://... → 强制指定代理
# 登录：默认粘贴式（--manual，免端口转发）；加 --callback 才启用本地回调服务器。

cd "$(dirname "$0")" || exit 1
MODE_FILE=".netmode"
PROXY_CANDIDATE="${HTTPS_PROXY:-http://127.0.0.1:7890}"
PROBE_URL="https://app.perchai.app/api/perch-terminal/cli-auth/config"

probe() { # $1 = 代理地址；空 = 直连探测
  if command -v curl >/dev/null 2>&1; then
    if [ -n "$1" ]; then
      curl -sS -m 3 -o /dev/null -x "$1" "$PROBE_URL" >/dev/null 2>&1
    else
      curl -sS -m 3 -o /dev/null "$PROBE_URL" >/dev/null 2>&1
    fi
    return $?
  fi
  if [ -n "$1" ]; then
    HTTPS_PROXY="$1" HTTP_PROXY="$1" node --no-warnings --use-env-proxy \
      -e "fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" "$PROBE_URL" >/dev/null 2>&1
  else
    node --no-warnings \
      -e "fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" "$PROBE_URL" >/dev/null 2>&1
  fi
}

use_direct() {
  unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy
  NODE_FLAGS=(--no-warnings)
}

use_proxy() {
  export HTTPS_PROXY="$1" HTTP_PROXY="$1"
  export NO_PROXY="${NO_PROXY:-127.0.0.1,localhost}"
  NODE_FLAGS=(--no-warnings --use-env-proxy)
}

if [ "${PERCH_NO_PROXY:-}" = "1" ] || [ "${PERCH_NO_PROXY:-}" = "true" ]; then
  use_direct
elif [ -n "${HTTPS_PROXY:-}" ]; then
  use_proxy "$HTTPS_PROXY"
else
  cached_mode=""; cached_at=0
  [ -f "$MODE_FILE" ] && read -r cached_mode cached_at < "$MODE_FILE" 2>/dev/null
  now=$(date +%s)
  if [ -n "$cached_mode" ] && [ $((now - ${cached_at:-0})) -lt 1800 ]; then
    if [ "$cached_mode" = "direct" ]; then use_direct; else use_proxy "$PROXY_CANDIDATE"; fi
  elif probe ""; then
    use_direct
    echo "direct $now" > "$MODE_FILE"
  elif probe "$PROXY_CANDIDATE"; then
    use_proxy "$PROXY_CANDIDATE"
    echo "proxy $now" > "$MODE_FILE"
    echo "[net] 直连不通，已自动切换代理 ${PROXY_CANDIDATE}" >&2
  else
    echo "× 直连和代理（${PROXY_CANDIDATE}）都不通，无法访问 Perch。" >&2
    echo "  · 检查网络与代理是否运行；或用 HTTPS_PROXY=http://<其他代理>:<端口> 指定" >&2
    exit 1
  fi
fi

case "$1" in
  gateway)
    shift
    node "${NODE_FLAGS[@]}" openai-gateway.mjs "$@"
    rc=$?
    ;;
  sync)
    shift
    node "${NODE_FLAGS[@]}" sync-models.mjs "$@"
    rc=$?
    ;;
  *)
    node "${NODE_FLAGS[@]}" perch-client.mjs "$@"
    rc=$?
    ;;
esac

# 本次失败则清掉网络模式缓存，下次自动重新探测/切换
if [ "${rc:-0}" -ne 0 ] && [ -f "$MODE_FILE" ]; then
  rm -f "$MODE_FILE"
fi
exit "${rc:-0}"
