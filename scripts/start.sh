#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -f ".env" ]; then
  echo "首次运行，生成 Gateway 密钥..."
  node scripts/setup.mjs
fi

if curl -fsS "http://127.0.0.1:8000/health" >/dev/null 2>&1; then
  echo "Kiro Gateway 已在运行"
else
  echo "启动 Kiro Gateway（Node 原生模式）..."
  mkdir -p data
  export $(grep -v '^#' .env | xargs)
  nohup node native-gateway.mjs >>"data/gateway.log" 2>&1 &
  for i in {1..30}; do
    if curl -fsS "http://127.0.0.1:8000/health" >/dev/null 2>&1; then
      echo "Kiro Gateway 已就绪"
      break
    fi
    sleep 1
    if [ "$i" -eq 30 ]; then
      echo "警告: Gateway 启动超时，请查看 data/gateway.log"
    fi
  done
fi

echo "启动中转管理页..."
node server.mjs