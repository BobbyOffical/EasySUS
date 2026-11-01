@echo off
chcp 65001 >nul
title EasySUS - 获取捐赠令牌
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装: https://nodejs.org/
  pause
  exit /b 1
)
node admin-cli.js take --note "issue 申请"
echo.
echo ============================================
echo  把上面方框里的令牌回复到用户的 issue 即可
echo ============================================
pause