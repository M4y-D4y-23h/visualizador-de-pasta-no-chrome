@echo off
setlocal
title Visualizador de Pastas
cd /d "%~dp0"

rem Instala/atualiza as dependencias (dependencias.json e package.json) e inicia o servidor.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\iniciar.ps1" %*

if errorlevel 1 (
  echo.
  echo   O Visualizador foi encerrado com um erro. Veja as mensagens acima.
  echo.
  pause
)
