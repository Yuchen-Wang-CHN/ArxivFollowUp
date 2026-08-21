@echo off
setlocal
cd /d "%~dp0"
start "ArxivFollowUp" powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\afu-tray.ps1"
exit /b 0
