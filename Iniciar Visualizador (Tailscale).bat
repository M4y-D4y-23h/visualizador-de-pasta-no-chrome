@echo off
rem Igual ao "Iniciar Visualizador.bat", mas tambem libera o acesso pelos outros
rem aparelhos da sua rede Tailscale (ex.: http://100.x.y.z:4321 no outro computador).
call "%~dp0Iniciar Visualizador.bat" --tailscale %*
