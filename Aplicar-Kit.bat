@echo off
rem Homunculus: applies a newer kit (or new theme folders) to this installation.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0classic-ui\Apply-Kit.ps1" %*
pause
