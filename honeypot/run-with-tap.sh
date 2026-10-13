#!/bin/bash
# 用观测蜜罐启动官方 perch CLI
#
# 服务端看到的请求与正常 perch 完全一致（字节级透传），
# 蜜罐只在本地旁路记录，不修改任何内容。
#
# 用法：
#   ./run-with-tap.sh                    # 交互模式
#   ./run-with-tap.sh run "hello"        # 单次执行
#   ./run-with-tap.sh status            # 状态

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAP="file://${HERE}/tap.mjs"

# 保留用户已有的 NODE_OPTIONS（若有），追加 --import
if [ -n "${NODE_OPTIONS:-}" ]; then
  export NODE_OPTIONS="${NODE_OPTIONS} --import ${TAP}"
else
  export NODE_OPTIONS="--import ${TAP}"
fi

# Node 内置 fetch 默认不读代理环境变量；此 flag 让其读取 HTTPS_PROXY 等，
# 仅影响连接路由，不改变任何请求字节（官方 CLI 行为在其他平台也是走系统代理）
export NODE_USE_ENV_PROXY=1

echo "[run-with-tap] NODE_OPTIONS=${NODE_OPTIONS}"
echo "[run-with-tap] NODE_USE_ENV_PROXY=1 (让官方 CLI 的 fetch 走系统代理)"
echo "[run-with-tap] 日志目录: ${HERE}/logs"
echo

exec perch "$@"
