@echo off
rem Classic UI fork: updates to the latest SillyBunny release and re-applies the classic interface.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0classic-ui\Update-Classic.ps1" %*
pause
