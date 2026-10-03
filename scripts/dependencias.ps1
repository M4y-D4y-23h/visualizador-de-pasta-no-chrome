# Funções de instalação e atualização de dependências (usadas por iniciar.ps1).
# Salvo em UTF-8 com BOM: o Windows PowerShell 5.1 precisa disso para os acentos.

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'   # sem isso, downloads no PowerShell 5.1 ficam muito lentos

# Códigos de retorno do winget
$WINGET_SEM_ATUALIZACAO = -1978335189      # 0x8A15002B: nenhuma atualização aplicável
$WINGET_NAO_ENCONTRADO = -1978335212       # 0x8A150014: nenhum pacote com esse id

# ------------------------------------------------------------------ mensagens

function Escrever-Etapa([string]$texto) { Write-Host ''; Write-Host "  $texto" -ForegroundColor Cyan }
function Escrever-Ok([string]$texto) { Write-Host '    [ok] ' -ForegroundColor Green -NoNewline; Write-Host $texto }
function Escrever-Info([string]$texto) { Write-Host "    $texto" -ForegroundColor Gray }
function Escrever-Aviso([string]$texto) { Write-Host '    [aviso] ' -ForegroundColor Yellow -NoNewline; Write-Host $texto }
function Escrever-Erro([string]$texto) { Write-Host '    [erro] ' -ForegroundColor Red -NoNewline; Write-Host $texto }

# ------------------------------------------------------------ localização

# Relê o PATH do sistema (programas recém-instalados passam a ser encontrados).
function Atualizar-Path {
    $maquina = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $usuario = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($maquina, $usuario, $env:Path) | Where-Object { $_ }) -join ';'
}

function Localizar-Programa($prog) {
    if ($prog.comando) {
        $c = Get-Command $prog.comando -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($c) { return $c.Source }
    }
    foreach ($p in @($prog.caminhos)) {
        if (-not $p) { continue }
        $e = [Environment]::ExpandEnvironmentVariables([string]$p)
        if (Test-Path -LiteralPath $e -PathType Leaf) { return $e }
    }
    return $null
}

function Ler-Versao([string]$exe, [string]$argumento) {
    try {
        $saida = & $exe $argumento 2>$null | Select-Object -First 1
        if ("$saida" -match '(\d+(?:\.\d+){1,3})') { return [version]$Matches[1] }
    } catch { }
    return $null
}

function Tem-Internet([string]$url) {
    try {
        $req = [Net.WebRequest]::Create($url)
        $req.Method = 'HEAD'
        $req.Timeout = 6000
        $resp = $req.GetResponse()
        $resp.Close()
        return $true
    } catch [Net.WebException] {
        # Qualquer resposta HTTP (mesmo erro) significa que há conexão.
        return [bool]$_.Exception.Response
    } catch {
        return $false
    }
}

# --------------------------------------------------------------- Node.js

# Node.js administrado por nvm, Volta, fnm ou Scoop: não mexemos nele.
function Node-Gerenciado([string]$exe) {
    if ($env:NVM_HOME -or $env:NVM_SYMLINK -or $env:VOLTA_HOME -or $env:FNM_DIR) { return $true }
    return ($exe -match '\\(nvm|volta|fnm|scoop)\\')
}

function Obter-VersaoNodeLts {
    $indice = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 20 -UseBasicParsing
    $lts = @($indice | Where-Object { $_.lts }) | Select-Object -First 1
    if (-not $lts) { throw 'não foi possível descobrir a versão LTS atual do Node.js' }
    return [version]($lts.version.TrimStart('v'))
}

function Arquitetura-Node {
    $a = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    switch ($a) { 'ARM64' { 'arm64' } 'x86' { 'x86' } default { 'x64' } }
}

function Endereco-InstaladorNode([version]$versao) {
    $nome = "node-v$versao-$(Arquitetura-Node).msi"
    return [pscustomobject]@{
        Nome   = $nome
        Url    = "https://nodejs.org/dist/v$versao/$nome"
        Somas  = "https://nodejs.org/dist/v$versao/SHASUMS256.txt"
    }
}

# Baixa o instalador oficial e confere o SHA-256 publicado pelo projeto.
# Devolve o caminho do arquivo baixado.
function Baixar-InstaladorNode([version]$versao, [string]$pasta) {
    $inst = Endereco-InstaladorNode $versao
    $destino = Join-Path $pasta $inst.Nome
    Escrever-Info "Baixando o Node.js $versao (instalador oficial)..."
    Invoke-WebRequest -Uri $inst.Url -OutFile $destino -UseBasicParsing -TimeoutSec 900
    $somas = (Invoke-WebRequest -Uri $inst.Somas -UseBasicParsing -TimeoutSec 60).Content
    if ($somas -is [byte[]]) { $somas = [Text.Encoding]::ASCII.GetString($somas) }
    $linha = ($somas -split "`n") | Where-Object { $_ -match ('\s' + [regex]::Escape($inst.Nome) + '\s*$') } | Select-Object -First 1
    $esperado = if ($linha) { ($linha.Trim() -split '\s+')[0] } else { '' }
    $obtido = (Get-FileHash -Algorithm SHA256 -LiteralPath $destino).Hash
    if (-not $esperado -or $esperado.ToLowerInvariant() -ne $obtido.ToLowerInvariant()) {
        Remove-Item -LiteralPath $destino -Force -ErrorAction SilentlyContinue
        throw 'o arquivo baixado não confere com a assinatura oficial (SHA-256)'
    }
    $assinatura = Get-AuthenticodeSignature -LiteralPath $destino
    if ($assinatura.Status -ne 'Valid' -or "$($assinatura.SignerCertificate.Subject)" -notmatch 'OpenJS Foundation') {
        Remove-Item -LiteralPath $destino -Force -ErrorAction SilentlyContinue
        throw 'o instalador não tem a assinatura digital válida da OpenJS Foundation'
    }
    return $destino
}

function Instalar-NodeLts([version]$versao, [bool]$simular) {
    if ($simular) {
        Escrever-Info "(simulação) baixaria $((Endereco-InstaladorNode $versao).Url), conferiria o SHA-256 e instalaria"
        return
    }
    $destino = Baixar-InstaladorNode $versao $env:TEMP
    Escrever-Info 'Instalando... se o Windows pedir permissão, clique em "Sim".'
    $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', "`"$destino`"", '/passive', '/norestart') -Wait -PassThru
    Remove-Item -LiteralPath $destino -Force -ErrorAction SilentlyContinue
    if ($p.ExitCode -eq 1602) { throw 'a instalação foi cancelada' }
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "o instalador terminou com o código $($p.ExitCode)" }
}

# ---------------------------------------------------------------- winget

function Caminho-Winget {
    $c = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return $c.Source }
    return $null
}

function Executar-Winget([string]$acao, [string]$id, [bool]$silencioso) {
    $wg = Caminho-Winget
    if (-not $wg) { throw 'o winget (Instalador de Aplicativos do Windows) não está disponível' }
    $argumentos = @($acao, '--id', $id, '--exact', '--source', 'winget', '--silent',
        '--accept-package-agreements', '--accept-source-agreements')
    $versaoWinget = Ler-Versao $wg '--version'
    if ($versaoWinget -and $versaoWinget -ge [version]'1.4') { $argumentos += '--disable-interactivity' }
    if ($silencioso) {
        $log = Join-Path $env:TEMP 'visualizador-winget.log'
        $p = Start-Process -FilePath $wg -ArgumentList $argumentos -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    } else {
        $p = Start-Process -FilePath $wg -ArgumentList $argumentos -NoNewWindow -Wait -PassThru
    }
    return $p.ExitCode
}

# ------------------------------------------------- instalar / atualizar

# Instala um programa ausente ou antigo. Lança exceção se não conseguir.
function Instalar-Programa($prog, [bool]$simular) {
    switch ($prog.fonte) {
        'nodejs' {
            Instalar-NodeLts (Obter-VersaoNodeLts) $simular
        }
        'winget' {
            if ($simular) { Escrever-Info "(simulação) winget install --id $($prog.id)"; return }
            Escrever-Info 'Instalando pelo winget... se o Windows pedir permissão, clique em "Sim".'
            $codigo = Executar-Winget 'install' $prog.id $false
            if ($codigo -eq $WINGET_NAO_ENCONTRADO) { throw "o pacote '$($prog.id)' não existe no winget (confira o id em dependencias.json)" }
            if ($codigo -ne 0) { throw "o winget terminou com o código $codigo" }
        }
        default { throw "fonte de instalação desconhecida: '$($prog.fonte)'" }
    }
}

# Procura e aplica atualização. Nunca interrompe a inicialização.
function Atualizar-Programa($prog, [string]$exe, $versao, [bool]$simular) {
    try {
        switch ($prog.fonte) {
            'nodejs' {
                if (Node-Gerenciado $exe) {
                    Escrever-Info 'Node.js gerenciado por nvm/Volta/fnm/Scoop: atualize-o por essa ferramenta.'
                    return
                }
                $lts = Obter-VersaoNodeLts
                if (-not $versao -or $versao -ge $lts) {
                    Escrever-Info "Node.js já está atualizado (versão LTS mais recente: $lts)."
                    return
                }
                Escrever-Info "Nova versão do Node.js disponível: $versao -> $lts"
                Instalar-NodeLts $lts $simular
                if (-not $simular) {
                    Atualizar-Path
                    $nova = Ler-Versao (Localizar-Programa $prog) $prog.argumentoVersao
                    if ($nova -and $nova -ge $lts) { Escrever-Ok "Node.js atualizado para $nova" }
                    else { Escrever-Aviso 'a atualização do Node.js não foi concluída; seguindo com a versão atual.' }
                }
            }
            'winget' {
                if ($simular) { Escrever-Info "(simulação) winget upgrade --id $($prog.id)"; return }
                $codigo = Executar-Winget 'upgrade' $prog.id $true
                if ($codigo -eq 0) { Escrever-Ok "$($prog.nome) atualizado" }
                elseif ($codigo -eq $WINGET_SEM_ATUALIZACAO) { Escrever-Info "$($prog.nome) já está atualizado." }
                else { Escrever-Info "$($prog.nome): atualização automática indisponível (código $codigo)." }
            }
        }
    } catch {
        Escrever-Aviso "não foi possível atualizar o $($prog.nome) agora: $($_.Exception.Message)"
    }
}

# ------------------------------------------------------------------- npm

function Ler-PacoteNpm([string]$raiz) {
    return Get-Content -LiteralPath (Join-Path $raiz 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
}

# Todos os pacotes a instalar: obrigatórios (dependencies) e opcionais (optionalDependencies).
function Nomes-Dependencias($pacote) {
    $nomes = @()
    foreach ($grupo in 'dependencies', 'optionalDependencies') {
        if ($pacote.$grupo) { $nomes += @($pacote.$grupo.PSObject.Properties | ForEach-Object { $_.Name }) }
    }
    return $nomes
}

# Só os obrigatórios: sem eles, o visualizador não abre.
function Nomes-Dependencias-Obrigatorias($pacote) {
    if (-not $pacote.dependencies) { return @() }
    return @($pacote.dependencies.PSObject.Properties | ForEach-Object { $_.Name })
}

# Muda quando package.json, package-lock.json ou a versão do Node mudam.
function Assinatura-Npm([string]$raiz, $versaoNode) {
    $partes = @("node=$versaoNode")
    foreach ($nome in 'package.json', 'package-lock.json') {
        $arq = Join-Path $raiz $nome
        if (Test-Path -LiteralPath $arq) { $partes += (Get-FileHash -Algorithm SHA256 -LiteralPath $arq).Hash }
    }
    return ($partes -join ';')
}
