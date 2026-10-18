# Applies a newer Classic kit (or a new theme folder) to an existing installation.
# Use it after extracting a new SillyBunny-Classic-kit.zip over this folder, or after
# adding/editing a folder in public\classic-themes. Your data folder is never touched.

$ErrorActionPreference = 'Continue'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Fail([string]$Message) {
    Write-Host ''
    Write-Host "[Classic] $Message" -ForegroundColor Red
    exit 1
}

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

$runtime = if (Test-Command 'node') { 'node' } elseif (Test-Command 'bun') { 'bun' } elseif (Test-Path "$env:USERPROFILE\.bun\bin\bun.exe") { "$env:USERPROFILE\.bun\bin\bun.exe" } else { $null }
if (-not $runtime) {
    Fail 'Nao encontrei o Node.js nem o Bun. Rode o Start.bat uma vez e tente de novo.'
}
if (-not (Test-Path 'public/index.html')) {
    Fail 'Esta pasta nao parece ser uma instalacao do SillyBunny Classic (falta public\index.html).'
}

Write-Host '[Classic] Aplicando os arquivos novos...'
& $runtime classic-ui/apply-classic.mjs
if ($LASTEXITCODE -ne 0) {
    Fail 'Algo nao encaixou. Nada foi salvo; peca ajuda mostrando a mensagem acima.'
}

# Record the change so Atualizar-Classic.bat keeps working (it needs a clean folder).
if ((Test-Command 'git') -and (Test-Path '.git')) {
    git add -A -- public classic-ui Aplicar-Kit.bat Atualizar-Classic.bat Instalar.bat LEIA-ME.txt
    git diff --cached --quiet
    if ($LASTEXITCODE -ne 0) {
        git -c user.name='Classic UI kit' -c user.email='classic@localhost' commit -q -m 'Classic UI: kit update'
        if ($LASTEXITCODE -ne 0) { Fail 'Os arquivos foram aplicados, mas nao consegui salvar no Git.' }
    }
}

Write-Host '[Classic] Pronto! Abra (ou recarregue) o SillyBunny pelo Start.bat como sempre.' -ForegroundColor Green
Write-Host '[Classic] O novo icone de paleta na barra do topo abre a Personalizacao.' -ForegroundColor Green
