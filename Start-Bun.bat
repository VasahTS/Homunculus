@echo off
REM Force Homunculus to use Bun instead of Node.js.
setlocal
set "HOMUNCULUS_USE_NODE="
set "HOMUNCULUS_USE_BUN=1"
call "%~dp0Start.bat" %*
set "_exit=%errorlevel%"
endlocal & exit /b %_exit%
