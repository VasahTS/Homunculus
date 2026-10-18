# Installs SillyBunny with the Classic (SillyTavern-style) interface into this folder.
# Run it from the extracted kit folder through Instalar.bat.
param(
    [string]$Branch = 'release',
    [string]$SillyBunnyFolder = ''
)

$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Fail([string]$Message) {
    Write-Host ''
    Write-Host "[Classic] $Message" -ForegroundColor Red
    exit 1
}

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

if (Test-Path (Join-Path $root '.git')) {
    Fail 'Esta pasta ja esta instalada. Para atualizar use o Atualizar-Classic.bat.'
}

# Git is required (same requirement as SillyBunny's own launcher).
if (-not (Test-Command 'git')) {
    foreach ($dir in @("$env:ProgramFiles\Git\cmd", "${env:ProgramFiles(x86)}\Git\cmd", "$env:LocalAppData\Programs\Git\cmd")) {
        if ($dir -and (Test-Path $dir)) { $env:PATH = "$dir;$env:PATH" }
    }
}
if (-not (Test-Command 'git')) {
    if (Test-Command 'winget') {
        Write-Host '[Classic] Instalando o Git...'
        winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
        $env:PATH = "$env:ProgramFiles\Git\cmd;$env:PATH"
    }
}
if (-not (Test-Command 'git')) {
    Fail 'Preciso do Git. Instale em https://git-scm.com/download/win e rode o Instalar.bat de novo.'
}

$runtime = if (Test-Command 'node') { 'node' } elseif (Test-Command 'bun') { 'bun' } elseif (Test-Path "$env:USERPROFILE\.bun\bin\bun.exe") { "$env:USERPROFILE\.bun\bin\bun.exe" } else { $null }
if (-not $runtime) {
    Fail 'Nao encontrei o Bun nem o Node.js. Como voce ja usa o SillyBunny, abra-o uma vez pelo Start.bat dele e tente de novo.'
}

Write-Host '[Classic] Baixando o SillyBunny (pode levar alguns minutos)...'
git init -q
git fetch --depth=1 https://github.com/SillyBunnyTeam/SillyBunny.git $Branch
if ($LASTEXITCODE -ne 0) {
    Remove-Item -Recurse -Force (Join-Path $root '.git')
    Fail 'Nao consegui baixar o SillyBunny (sem internet?).'
}
$base = (git rev-parse FETCH_HEAD).Trim()
git checkout -q -f -B classic-ui $base
if ($LASTEXITCODE -ne 0) { Fail 'Falha ao preparar os arquivos.' }

& $runtime classic-ui/apply-classic.mjs
if ($LASTEXITCODE -ne 0) { Fail 'O SillyBunny mudou demais nesta versao; peca ajuda para ajustar a interface classica.' }

git add -A -- public classic-ui Atualizar-Classic.bat Instalar.bat LEIA-ME.txt
git -c user.name='Classic UI installer' -c user.email='classic@localhost' commit -q -m 'Classic UI: SillyTavern interface on top of SillyBunny'
git tag -f classic-base $base | Out-Null

# Bring the user's characters, chats, agents and settings over from the old SillyBunny folder.
if (-not $SillyBunnyFolder) {
    Write-Host ''
    Write-Host 'Quer trazer seus personagens, chats, agentes e configuracoes do SillyBunny atual?'
    Write-Host 'Arraste a pasta do SillyBunny para esta janela e aperte Enter (ou so Enter para pular):'
    $SillyBunnyFolder = (Read-Host).Trim().Trim('"')
}
if ($SillyBunnyFolder) {
    $sourceData = Join-Path $SillyBunnyFolder 'data'
    if (Test-Path $sourceData) {
        Write-Host '[Classic] Copiando seus dados (o SillyBunny original nao e alterado)...'
        Copy-Item -Recurse -Force -Path $sourceData -Destination $root
        Write-Host '[Classic] Dados copiados.'
    } else {
        Write-Host "[Classic] Nao achei a pasta 'data' em $SillyBunnyFolder. Pulei a copia." -ForegroundColor Yellow
    }
}

Write-Host ''
Write-Host '[Classic] Pronto! Feche o SillyBunny antigo (se estiver aberto) e abra o Start.bat desta pasta.' -ForegroundColor Green
