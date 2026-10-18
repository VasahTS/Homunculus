# Updates the Classic UI fork to the latest SillyBunny release and re-applies the classic interface.
# Your data folder (characters, chats, agents, settings) is never touched by this script.
param(
    [string]$Branch = 'release'
)

$ErrorActionPreference = 'Continue'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Fail([string]$Message) {
    Write-Host ''
    Write-Host "[Classic] $Message" -ForegroundColor Red
    exit 1
}

# Files that belong to the Classic UI fork (everything else comes from SillyBunny).
$ClassicPaths = @(
    'Aplicar-Kit.bat',
    'Atualizar-Classic.bat',
    'Instalar.bat',
    'LEIA-ME.txt',
    'classic-ui',
    'public/scripts/classic-ui.js',
    'public/style-classic.css',
    'public/css/classic-ui.css',
    'public/css/classic-sb-extras.css',
    'public/css/classic-themes.css',
    'public/css/classic-layout.css',
    'public/classic-themes',
    'public/webfonts/NotoSans/classic-stylesheet.css',
    'public/webfonts/NotoSansMono/classic-stylesheet.css'
)

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail 'O Git nao esta instalado. Instale em https://git-scm.com/download/win e rode de novo.'
}
$runtime = if (Get-Command node -ErrorAction SilentlyContinue) { 'node' } elseif (Get-Command bun -ErrorAction SilentlyContinue) { 'bun' } else { $null }
if (-not $runtime) {
    Fail 'Nao encontrei o Node.js nem o Bun. Rode o Start.bat uma vez e tente de novo.'
}

$status = git status --porcelain --untracked-files=no
if ($status) {
    Fail "Existem arquivos do programa modificados. Nada foi alterado.`n$status"
}

Write-Host '[Classic] Baixando a versao mais nova do SillyBunny...'
git fetch --depth=1 https://github.com/SillyBunnyTeam/SillyBunny.git $Branch
if ($LASTEXITCODE -ne 0) { Fail 'Nao consegui baixar a atualizacao (sem internet?). Nada foi alterado.' }

$newBase = (git rev-parse FETCH_HEAD).Trim()
$oldBase = (git rev-parse classic-base).Trim()
if ($newBase -eq $oldBase) {
    Write-Host '[Classic] Voce ja esta na versao mais nova.' -ForegroundColor Green
    exit 0
}

$previous = (git rev-parse HEAD).Trim()
$classicFiles = @(git ls-files -- 'public/css/classic--*.css' 'public/scripts/classic-*.js') + $ClassicPaths |
    Where-Object { git cat-file -e "${previous}:$_" 2>$null; $LASTEXITCODE -eq 0 }

try {
    git checkout -q -B classic-ui-update $newBase
    if ($LASTEXITCODE -ne 0) { throw 'checkout' }
    git checkout -q $previous -- $classicFiles
    if ($LASTEXITCODE -ne 0) { throw 'copy classic files' }
    & $runtime classic-ui/apply-classic.mjs
    if ($LASTEXITCODE -ne 0) { throw 'index.html' }
    git add -A -- public classic-ui Aplicar-Kit.bat Atualizar-Classic.bat Instalar.bat LEIA-ME.txt
    git -c user.name='Classic UI updater' -c user.email='classic@localhost' commit -q -m 'Classic UI: SillyTavern interface on top of SillyBunny'
    if ($LASTEXITCODE -ne 0) { throw 'commit' }
    git branch -f classic-ui HEAD
    git checkout -q classic-ui
    git branch -D classic-ui-update | Out-Null
    git tag -f classic-base $newBase | Out-Null
} catch {
    git checkout -q -f classic-ui 2>$null
    git reset -q --hard $previous
    git branch -D classic-ui-update 2>$null | Out-Null
    Fail 'A versao nova do SillyBunny mudou partes que a interface classica precisa. Voltei tudo como estava; peca ajuda para ajustar.'
}

Write-Host '[Classic] Atualizado! Abra pelo Start.bat como sempre.' -ForegroundColor Green
