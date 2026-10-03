# Abre um arquivo ou pasta com o aplicativo padrao do Windows.
# O caminho chega pela variavel de ambiente VISUALIZADOR_ALVO (sem problemas de aspas).

$ErrorActionPreference = 'Stop'
$alvo = $env:VISUALIZADOR_ALVO
if (-not $alvo) { exit 2 }
[void][System.Diagnostics.Process]::Start($alvo)
