#!/usr/bin/env bash
# 一键启动指挥大屏
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-8080}"
exec python3 -m trail_rescue serve --port "$PORT"
