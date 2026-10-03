# Prepara e inicia o Visualizador de Pastas (executado pelo "Iniciar Visualizador.bat").
#
#   1. Programas (dependencias.json): instala os que faltam ou estão abaixo da versão
#      mínima e, uma vez por dia, atualiza os marcados com "atualizar": true.
#   2. Pacotes npm (package.json): instala sempre que a lista muda e atualiza 1x por dia.
#   3. Inicia o servidor.
#
# Opções (também aceitas pelo .bat):
#   --atualizar          procura atualizações agora, sem esperar o intervalo
#   --sem-atualizar      não procura atualizações nesta execução
#   --simular            mostra o que seria instalado/atualizado, sem alterar nada
#   --somente-preparar   prepara tudo e não inicia o servidor
# As demais opções (ex.: --port=5000, --no-open, --tailscale) são repassadas ao servidor.
#
# Salvo em UTF-8 com BOM: o Windows PowerShell 5.1 precisa disso para os acentos.

$ErrorActionPreference = 'Continue'
$raiz = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'dependencias.ps1')

$opcoesProprias = @('--atualizar', '--sem-atualizar', '--simular', '--somente-preparar')
$forcarAtualizacao = $args -contains '--atualizar'
$semAtualizar = $args -contains '--sem-atualizar'
$simular = $args -contains '--simular'
$somentePreparar = $args -contains '--somente-preparar'
$argsServidor = @($args | Where-Object { $opcoesProprias -notcontains $_ })

Write-Host ''
Write-Host '  Visualizador de Pastas' -ForegroundColor White -NoNewline
Write-Host ' — verificando dependências...' -ForegroundColor Gray
if ($simular) { Write-Host '  (modo simulação: nada será instalado nem alterado)' -ForegroundColor Yellow }

try {
    $manifesto = Get-Content -LiteralPath (Join-Path $raiz 'dependencias.json') -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Escrever-Erro "não foi possível ler dependencias.json: $($_.Exception.Message)"
    exit 1
}

# --------------------------------------------- é hora de procurar atualizações?

$horas = 24
if ($manifesto.verificarAtualizacoesACadaHoras) { $horas = [double]$manifesto.verificarAtualizacoesACadaHoras }
$dirEstado = if ($env:VISUALIZADOR_ESTADO) { $env:VISUALIZADOR_ESTADO } else { Join-Path $env:LOCALAPPDATA 'VisualizadorDePastas' }
$marcaAtualizacao = Join-Path $dirEstado 'ultima-verificacao-de-atualizacoes.txt'

$verificarAtualizacoes = $false
$semInternet = $false
if (-not $semAtualizar) {
    if ($forcarAtualizacao -or -not (Test-Path -LiteralPath $marcaAtualizacao)) {
        $verificarAtualizacoes = $true
    } else {
        try {
            $ultima = [datetime]::Parse((Get-Content -LiteralPath $marcaAtualizacao -Raw).Trim(),
                [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
            $verificarAtualizacoes = ((Get-Date) - $ultima).TotalHours -ge $horas
        } catch {
            $verificarAtualizacoes = $true
        }
    }
}
if ($verificarAtualizacoes -and -not (Tem-Internet 'https://nodejs.org/dist/index.json')) {
    $verificarAtualizacoes = $false
    $semInternet = $true
}

# ---------------------------------------------------------------- programas

Escrever-Etapa 'Programas'
if ($verificarAtualizacoes) { Escrever-Info ('Procurando atualizações (feito no máximo uma vez a cada {0} h)...' -f $horas) }
if ($semInternet) { Escrever-Info 'Sem conexão com a internet: a busca por atualizações fica para a próxima vez.' }

$falhou = $false
$nodeExe = $null
$versaoNode = $null

foreach ($prog in @($manifesto.programas)) {
    $exe = Localizar-Programa $prog
    $versao = if ($exe -and $prog.argumentoVersao) { Ler-Versao $exe $prog.argumentoVersao } else { $null }
    $minima = if ($prog.versaoMinima) { [version]$prog.versaoMinima } else { $null }

    $problema = $null
    if (-not $exe) { $problema = 'não está instalado' }
    elseif ($minima -and $versao -and $versao -lt $minima) { $problema = "está na versão $versao, abaixo da mínima ($minima)" }

    if ($prog.comando -eq 'node') {
        $nodeExe = $exe
        $versaoNode = $versao
    }

    if ($problema -and $prog.fonte -eq 'nodejs' -and $exe -and (Node-Gerenciado $exe)) {
        Escrever-Erro "O Node.js $problema. Ele é gerenciado por nvm/Volta/fnm/Scoop — atualize-o por essa ferramenta."
        $falhou = $true
        continue
    }

    if ($problema) {
        Escrever-Aviso "O $($prog.nome) $problema — instalando a versão mais recente..."
        try {
            Instalar-Programa $prog $simular
        } catch {
            Escrever-Aviso "a instalação automática falhou: $($_.Exception.Message)"
        }
        if ($simular) { continue }
        Atualizar-Path
        $exe = Localizar-Programa $prog
        $versao = if ($exe -and $prog.argumentoVersao) { Ler-Versao $exe $prog.argumentoVersao } else { $null }
        $resolvido = $exe -and -not ($minima -and $versao -and $versao -lt $minima)
        if ($resolvido) {
            Escrever-Ok ("$($prog.nome) instalado" + $(if ($versao) { " ($versao)" } else { '' }))
        } elseif ($prog.obrigatorio) {
            Escrever-Erro "Não foi possível instalar o $($prog.nome) automaticamente. Instale-o por $($prog.site) e abra o visualizador de novo."
            $falhou = $true
        } else {
            Escrever-Aviso "Seguindo sem o $($prog.nome). $($prog.semEle)"
        }
    } else {
        Escrever-Ok ("$($prog.nome)" + $(if ($versao) { " $versao" } else { '' }))
        if ($verificarAtualizacoes -and $prog.atualizar) {
            Atualizar-Programa $prog $exe $versao $simular
            $exe = Localizar-Programa $prog
            if ($exe -and $prog.argumentoVersao) { $versao = Ler-Versao $exe $prog.argumentoVersao }
        }
    }

    # Após instalar/atualizar, guarda o executável e a versão novos.
    if ($prog.comando -eq 'node') {
        $nodeExe = $exe
        $versaoNode = $versao
    }
}

# --------------------------------------------------------------- pacotes npm

Escrever-Etapa 'Pacotes do projeto (npm)'
$pacote = Ler-PacoteNpm $raiz
$dependencias = @(Nomes-Dependencias $pacote)
# Sem os opcionais (optionalDependencies) o visualizador abre do mesmo jeito: uma falha
# neles vira só um aviso. Hoje: "sharp", que gera as miniaturas no servidor (bem mais rápido).
$obrigatorias = @(Nomes-Dependencias-Obrigatorias $pacote)
$semOpcionais = 'Seguindo sem eles: o visualizador funciona, só que com as miniaturas mais lentas.'

if (-not $dependencias.Count) {
    Escrever-Ok 'Nenhum pacote necessário no momento.'
} elseif (-not $nodeExe) {
    Escrever-Info 'Aguardando o Node.js para instalar os pacotes.'
} elseif ($simular) {
    Escrever-Info "(simulação) conferiria/instalaria: $($dependencias -join ', ')"
} else {
    $npm = Join-Path (Split-Path -Parent $nodeExe) 'npm.cmd'
    $marcaNpm = Join-Path $raiz 'node_modules\.visualizador-instalado'
    $instalada = if (Test-Path -LiteralPath $marcaNpm) { (Get-Content -LiteralPath $marcaNpm -Raw).Trim() } else { '' }
    $precisaInstalar = $instalada -ne (Assinatura-Npm $raiz $versaoNode)

    if (-not (Test-Path -LiteralPath $npm)) {
        $msg = "o npm não foi encontrado junto do Node.js ($npm). Reinstale o Node.js por https://nodejs.org."
        if ($obrigatorias.Count) { Escrever-Erro $msg; $falhou = $true } else { Escrever-Aviso "$msg $semOpcionais" }
    } elseif ($precisaInstalar -or $verificarAtualizacoes) {
        $acao = if ($precisaInstalar) { 'install' } else { 'update' }
        if (-not (Tem-Internet 'https://registry.npmjs.org/')) {
            if ($precisaInstalar -and -not $instalada) {
                $msg = 'Sem conexão com a internet para baixar os pacotes do projeto.'
                if ($obrigatorias.Count) { Escrever-Erro $msg; $falhou = $true } else { Escrever-Aviso "$msg $semOpcionais" }
            } else {
                Escrever-Aviso 'Sem internet: usando os pacotes já instalados.'
            }
        } else {
            if ($precisaInstalar) { Escrever-Info "Instalando pacotes: $($dependencias -join ', ')" }
            else { Escrever-Info 'Procurando atualizações dos pacotes...' }
            Push-Location -LiteralPath $raiz
            & $npm $acao --omit=dev --no-audit --no-fund --loglevel=error
            $codigoNpm = $LASTEXITCODE
            Pop-Location
            if ($codigoNpm -eq 0) {
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $marcaNpm) | Out-Null
                Set-Content -LiteralPath $marcaNpm -Value (Assinatura-Npm $raiz $versaoNode) -Encoding ASCII
                Escrever-Ok $(if ($precisaInstalar) { 'Pacotes instalados.' } else { 'Pacotes em dia.' })
            } elseif ($precisaInstalar) {
                $msg = "o npm não conseguiu instalar os pacotes (código $codigoNpm)."
                if ($obrigatorias.Count) { Escrever-Erro $msg; $falhou = $true } else { Escrever-Aviso "$msg $semOpcionais" }
            } else {
                Escrever-Aviso "não foi possível atualizar os pacotes agora (código $codigoNpm); usando os já instalados."
            }
        }
    } else {
        Escrever-Ok "$($dependencias.Count) pacote(s) instalado(s)."
    }
}

# ------------------------------------------------------------------ resultado

if ($falhou) {
    Write-Host ''
    Escrever-Erro 'O visualizador não pode ser iniciado até que os itens acima sejam resolvidos.'
    exit 1
}

if ($verificarAtualizacoes -and -not $simular) {
    New-Item -ItemType Directory -Force -Path $dirEstado | Out-Null
    Set-Content -LiteralPath $marcaAtualizacao -Value (Get-Date).ToString('o') -Encoding ASCII
}

if ($somentePreparar -or $simular) {
    Write-Host ''
    Escrever-Ok 'Tudo pronto.'
    exit 0
}

# ---------------------------------------------------- acesso pelo Tailscale

# Na primeira vez, o Firewall do Windows pergunta se o Node.js pode receber conexões.
# Se alguém clicou em "Cancelar", o Windows criou regras de bloqueio, que valem mais que
# qualquer permissão, e os outros aparelhos não conseguiriam se conectar. Aqui só avisa.
if ($argsServidor -contains '--tailscale') {
    Escrever-Etapa 'Acesso pelo Tailscale'
    $bloqueios = @()
    try {
        $nodeCompleto = [IO.Path]::GetFullPath($nodeExe)
        $bloqueios = @(Get-NetFirewallRule -Direction Inbound -Action Block -Enabled True -ErrorAction Stop |
            Where-Object {
                $programa = ($_ | Get-NetFirewallApplicationFilter).Program
                $programa -and ([Environment]::ExpandEnvironmentVariables($programa) -ieq $nodeCompleto)
            })
    } catch { }  # nenhuma regra de bloqueio (ou firewall inacessível): segue normalmente
    if ($bloqueios.Count) {
        Escrever-Aviso 'O Firewall do Windows está bloqueando o Node.js: os outros aparelhos não vão conseguir abrir o visualizador.'
        Escrever-Info 'Para liberar: no menu Iniciar, pesquise "Permitir um aplicativo" > Alterar configurações >'
        Escrever-Info 'marque "Node.js JavaScript Runtime" na coluna "Privada" > OK. Depois, abra este atalho de novo.'
    } else {
        Escrever-Info 'Se o Windows perguntar sobre o Firewall, clique em "Permitir" (redes privadas).'
    }
}

# Mais threads para leituras de disco e miniaturas (o padrão do Node é 4). O server.js também
# define isso, mas pelo ambiente vale com certeza desde o início.
if (-not $env:UV_THREADPOOL_SIZE) { $env:UV_THREADPOOL_SIZE = '24' }

& $nodeExe (Join-Path $raiz 'server.js') @argsServidor
exit $LASTEXITCODE
