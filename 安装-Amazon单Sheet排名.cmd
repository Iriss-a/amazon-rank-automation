@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-amazon-sheet-rank.ps1"
if errorlevel 1 (
  echo.
  echo 安装失败，请把上方错误信息发给管理员。
) else (
  echo.
  echo 安装完成，请重启 Codex 后使用 Amazon 单 Sheet 自然排名 Skill。
)
pause
