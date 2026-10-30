@echo off
setlocal DisableDelayedExpansion
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-docling-windows.ps1" %*
set "mttResult=%ERRORLEVEL%"
if not "%PAPER_DOCLING_NO_PAUSE%"=="1" pause
exit /b %mttResult%
