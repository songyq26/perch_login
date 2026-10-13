#!/bin/bash
# 诊断 perch 的网络连通性
echo "=== 1. 代理环境变量 ==="
env | grep -i proxy || echo "(无)"

echo
echo "=== 2. 代理端口状态 ==="
for p in 7890 7891 1087 1080 8080 8888; do
  if nc -z -w1 127.0.0.1 $p 2>/dev/null; then
    echo "  ✓ $p 开放"
  else
    echo "  ✗ $p 关闭"
  fi
done

echo
echo "=== 3. 直连测试（绕过代理）==="
env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
  curl -s -m 10 -o /dev/null -w "  app.perchai.app: HTTP %{http_code} in %{time_total}s\n" \
  https://app.perchai.app/api/perch-terminal/public-model-default -H 'Accept: application/json'

echo
echo "=== 4. 走代理测试 ==="
curl -s -m 10 -o /dev/null -w "  app.perchai.app: HTTP %{http_code} in %{time_total}s\n" \
  https://app.perchai.app/api/perch-terminal/public-model-default -H 'Accept: application/json'

echo
echo "=== 5. Node fetch 测试（perch 用的方式）==="
node -e "
const t0=Date.now();
fetch('https://app.perchai.app/api/perch-terminal/public-model-default',{headers:{Accept:'application/json'}})
 .then(r=>console.log('  HTTP',r.status,'in',Date.now()-t0,'ms'))
 .catch(e=>console.log('  ERR',e.message,'in',Date.now()-t0,'ms'));
" 2>&1 | tail -3
