@echo off
chcp 65001 >nul
title EasySUS - Minecraft 开服助手
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装: https://nodejs.org/ （选 LTS 版本）
  pause
  exit /b 1
)
echo 正在启动 EasySUS 控制台...
node "%~dp0client\server.js"
pause
