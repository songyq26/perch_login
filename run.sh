#!/bin/bash
# Perch 工具箱统一入口（自动带上本机代理参数）
#
#   ./run.sh login [--provider google|github] [--timeout 300]
#   ./run.sh ask "你的问题" [--model <id或显示名>] [--telemetry]
#   ./run.sh models [--sync]
#   ./run.sh status
#   ./run.sh gateway [--port 8787] [--host 127.0.0.1|0.0.0.0] [--key auto|<自定义key>]
#   ./run.sh sync
#
# 代理默认取 Clash 的 127.0.0.1:7890，可用 HTTPS_PROXY 环境变量覆盖。

export HTTPS_PROXY="${HTTPS_PROXY:-http://127.0.0.1:7890}"
export HTTP_PROXY="${HTTP_PROXY:-http://127.0.0.1:7890}"
export NO_PROXY="${NO_PROXY:-127.0.0.1,localhost}"

cd "$(dirname "$0")" || exit 1

case "$1" in
  gateway)
    shift
    exec node --no-warnings --use-env-proxy openai-gateway.mjs "$@"
    ;;
  sync)
    shift
    exec node --no-warnings sync-models.mjs "$@"
    ;;
  *)
    exec node --no-warnings --use-env-proxy perch-client.mjs "$@"
    ;;
esac
