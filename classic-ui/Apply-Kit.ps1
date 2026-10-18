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
    Fail 'Esta pasta nao parece ser uma instalacao do Homunculus / SillyBunny Classic (falta public\index.html).'
}

# Homunculus no longer follows SillyBunny releases: remove the old updater/installer if they are still here.
foreach ($old in @('Atualizar-Classic.bat', 'Instalar.bat', 'classic-ui/Update-Classic.ps1', 'classic-ui/Install-Classic.ps1')) {
    if (Test-Path $old) { Remove-Item -Force $old }
}

Write-Host '[Homunculus] Aplicando os arquivos novos...'
& $runtime classic-ui/apply-classic.mjs
if ($LASTEXITCODE -ne 0) {
    Fail 'Algo nao encaixou. Nada foi salvo; peca ajuda mostrando a mensagem acima.'
}

# Record the change in this folder's Git history (the data folder is ignored by .gitignore).
if ((Test-Command 'git') -and (Test-Path '.git')) {
    git add -A
    git diff --cached --quiet
    if ($LASTEXITCODE -ne 0) {
        git -c user.name='Homunculus kit' -c user.email='homunculus@localhost' commit -q -m 'Homunculus: kit update'
        if ($LASTEXITCODE -ne 0) { Fail 'Os arquivos foram aplicados, mas nao consegui salvar no Git.' }
    }
}

Write-Host '[Homunculus] Pronto! Abra (ou recarregue) pelo Start.bat como sempre.' -ForegroundColor Green
Write-Host '[Homunculus] Icone de casa = Home. Icone de paleta = Customize (perfis, layout e efeitos).' -ForegroundColor Green
Write-Host '[Homunculus] Icone de cerebro = Memory. Globo na aba Characters = Card Browser. Corrente na caixa de mensagem = troca rapida de conexao.' -ForegroundColor Green
Write-Host '[Homunculus] Feche e abra o Start.bat de novo para o Card Browser funcionar (ele usa uma parte nova do servidor).' -ForegroundColor Yellow
