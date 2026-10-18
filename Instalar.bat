@echo off
rem Classic UI fork: installs SillyBunny with the SillyTavern-style interface into this folder.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0classic-ui\Install-Classic.ps1" %*
pause
