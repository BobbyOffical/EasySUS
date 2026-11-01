#!/usr/bin/env bash
# EasySUS 启动脚本（macOS，双击运行）
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js，请先安装（建议 >= 18）:"
  echo "  brew install node   或访问 https://nodejs.org/"
  read -p "按回车退出"
  exit 1
fi
echo "正在启动 EasySUS 控制台..."
node client/server.js
