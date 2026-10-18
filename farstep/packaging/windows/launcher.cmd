@echo off
set "FARSTEP_PACKAGE_PATH=%~dp0.."
if "%~2"=="--help" goto runtime
rem Release the batch context before uninstall removes this launcher
if /I "%~1"=="uninstall" ((goto) 2>nul & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\share\farstep\install\uninstall.ps1" %2 %3 %4 %5 %6 %7 %8 %9)
:runtime
"%~dp0bun.exe" "%~dp0..\lib\farstep\farstep\runtime\main.ts" %*
