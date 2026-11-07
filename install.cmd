@echo off
rem 双击即可安装「中转站用量」DSH 插件。
rem 需要时可带参数，例如：
rem   install.cmd -Proxy http://192.168.31.9:7893
rem   install.cmd -Profile desktop
rem   install.cmd -Uninstall
chcp 65001 >nul
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set code=%ERRORLEVEL%
echo.
if not "%code%"=="0" (
  echo 安装失败，错误码 %code%。把上面的输出发给我即可。
) else (
  echo 完成。重启 DSH 后左侧栏会出现「中转站」。
)
pause
endlocal
exit /b %code%
