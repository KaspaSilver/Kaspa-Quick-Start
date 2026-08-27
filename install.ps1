<#
.SYNOPSIS
    One-command installer for a public Kaspa node with a web control panel.

.DESCRIPTION
    irm https://raw.githubusercontent.com/KaspaSilver/Quick-Start-Kaspa/main/install.ps1 | iex

    Installs Docker Desktop if it is missing, fetches the stack, builds a kaspad
    image from the official rusty-kaspa release and starts the node (always with
    --utxoindex), the web control panel and an nginx reverse proxy.
#>
[CmdletBinding()]
param(
    [string] $Dir        = $(if ($env:KASPA_STACK_DIR) { $env:KASPA_STACK_DIR } else { Join-Path $env:USERPROFILE '.kaspa-node' }),
    [int]    $GuiPort    = $(if ($env:KASPA_GUI_PORT) { [int]$env:KASPA_GUI_PORT } else { 8080 }),
    [int]    $HttpPort   = 80,
    [int]    $HttpsPort  = 443,
    # Loopback by default. The panel ships without a password, and it drives the
    # Docker socket, so binding it anywhere reachable would hand the host to
    # whoever finds the port. -Password is what makes a wider bind reasonable.
    [string] $Bind       = '127.0.0.1',
    [string] $Password   = $env:KASPA_ADMIN_PASSWORD,
    [switch] $NoPassword,
    [string] $Version    = $env:KASPA_VERSION,
    [string] $StackRepo  = $(if ($env:KASPA_STACK_REPO) { $env:KASPA_STACK_REPO } else { 'KaspaSilver/Quick-Start-Kaspa' }),
    [string] $StackRef   = $(if ($env:KASPA_STACK_REF) { $env:KASPA_STACK_REF } else { 'main' }),
    [string] $UpstreamRepo = 'kaspanet/rusty-kaspa',
    [switch] $Yes,
    [switch] $SkipDockerInstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ManagerImage = 'kaspa-one-click/manager:1'

function Say  { param($m) Write-Host "==> $m" -ForegroundColor Cyan }
function Ok   { param($m) Write-Host "  ok $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "warn $m" -ForegroundColor Yellow }
function Die  { param($m) Write-Host "fail $m" -ForegroundColor Red; exit 1 }

function Confirm-Step {
    param([string] $Question)
    if ($Yes) { return $true }
    $reply = Read-Host "$Question [Y/n]"
    return ($reply -eq '' -or $reply -match '^(y|yes)$')
}

# --------------------------------------------------------------- docker ----

function Test-Docker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
    docker info 2>&1 | Out-Null
    return ($LASTEXITCODE -eq 0)
}

function Wait-Docker {
    param([int] $Seconds = 300)
    Say 'Waiting for the Docker daemon (Docker Desktop can take a minute to start)'
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Docker) { Ok 'Docker is running'; return $true }
        Start-Sleep -Seconds 3
    }
    return $false
}

function Install-Docker {
    Say 'Installing Docker Desktop'
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Die 'winget is not available. Install Docker Desktop from https://www.docker.com/products/docker-desktop/ and re-run this script.'
    }
    winget install --exact --id Docker.DockerDesktop --silent `
        --accept-package-agreements --accept-source-agreements
    # winget returns a non-zero code when a reboot is pending; that is not fatal.
    if ($LASTEXITCODE -ne 0) { Warn "winget exited with $LASTEXITCODE - continuing." }

    $exe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (Test-Path $exe) {
        Say 'Starting Docker Desktop'
        Start-Process -FilePath $exe | Out-Null
    } else {
        Warn 'Could not find Docker Desktop - start it from the Start menu once installation finishes.'
    }
}

function Initialize-Docker {
    if (Test-Docker) { Ok 'Docker is already installed and running'; }
    else {
        if (Get-Command docker -ErrorAction SilentlyContinue) {
            Say 'Docker is installed but not responding - trying to start Docker Desktop'
            $exe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
            if (Test-Path $exe) { Start-Process -FilePath $exe | Out-Null }
            if (-not (Wait-Docker 180)) { Die 'Docker did not start. Start Docker Desktop manually and re-run this script.' }
        } else {
            if ($SkipDockerInstall) { Die 'Docker is not available and -SkipDockerInstall was given.' }
            if (-not (Confirm-Step 'Docker is not installed. Install Docker Desktop now?')) { Die 'Docker is required.' }
            Install-Docker
            if (-not (Wait-Docker 600)) {
                Die 'Docker did not start. This usually means Windows needs a reboot to finish enabling WSL2 - reboot and re-run this script.'
            }
        }
    }

    docker compose version 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Die "'docker compose' (v2) is missing. Update Docker Desktop." }
    Ok 'docker compose is available'
}

# ---------------------------------------------------------------- stack ----

# Compose and the Docker daemon both accept forward slashes on Windows, and
# forward slashes avoid backslash escaping inside the .env file.
$StackDir     = $Dir.TrimEnd('\', '/')
$StackDirPosix = $StackDir -replace '\\', '/'

function Invoke-Compose {
    param([Parameter(ValueFromRemainingArguments = $true)] $ComposeArgs)
    $files = @('-f', (Join-Path $StackDir 'docker-compose.yml'))
    $ports = Join-Path $StackDir 'conf\ports.yml'
    if (Test-Path $ports) { $files += @('-f', $ports) }
    & docker compose @files --project-directory $StackDir @ComposeArgs
    if ($LASTEXITCODE -ne 0) { throw "docker compose $($ComposeArgs -join ' ') failed with exit code $LASTEXITCODE" }
}

function Write-TextFile {
    param([string] $Path, [string] $Content)
    # LF endings and no BOM: docker compose keeps a trailing CR as part of the
    # value, which would corrupt STACK_DIR and every path derived from it.
    $normalized = $Content -replace "`r`n", "`n"
    [System.IO.File]::WriteAllText($Path, $normalized, (New-Object System.Text.UTF8Encoding $false))
}

function Get-Stack {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $null }

    if ($scriptDir -and (Test-Path (Join-Path $scriptDir 'docker-compose.yml'))) {
        Say "Using the stack files next to this script ($scriptDir)"
        $src = $scriptDir
        $tmp = $null
    } else {
        Say "Downloading the stack from $StackRepo@$StackRef"
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("kaspa-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        $archive = Join-Path $tmp 'stack.tar.gz'
        Invoke-WebRequest -Uri "https://codeload.github.com/$StackRepo/tar.gz/$StackRef" -OutFile $archive -UseBasicParsing
        # bsdtar ships with Windows 10 1803 and later.
        & tar -xzf $archive -C $tmp
        if ($LASTEXITCODE -ne 0) { Die 'Could not unpack the downloaded archive.' }
        # GitHub wraps the archive in a <repo>-<ref>\ directory.
        $found = Get-ChildItem -Path $tmp -Directory |
                 Where-Object { Test-Path (Join-Path $_.FullName 'docker-compose.yml') } |
                 Select-Object -First 1
        if (-not $found) { Die "The archive from $StackRepo@$StackRef did not contain the stack." }
        $src = $found.FullName
    }

    New-Item -ItemType Directory -Path $StackDir -Force | Out-Null
    # Only these are replaced wholesale on a re-install. conf\ holds generated
    # state (node.json, proxies.json) and proxy\ holds issued certificates and
    # generated vhosts - wiping either would cost the user real work.
    foreach ($item in @('docker-compose.yml', 'kaspad', 'manager', 'bridge', 'nextcloud', 'uninstall.sh', 'uninstall.ps1', 'README.md')) {
        $from = Join-Path $src $item
        if (-not (Test-Path $from)) { continue }
        $to = Join-Path $StackDir $item
        if (Test-Path $to) { Remove-Item $to -Recurse -Force }
        Copy-Item $from $to -Recurse -Force
    }

    foreach ($sub in @('conf', 'proxy\conf.d', 'proxy\snippets', 'proxy\letsencrypt', 'proxy\webroot')) {
        New-Item -ItemType Directory -Path (Join-Path $StackDir $sub) -Force | Out-Null
    }
    Copy-Item (Join-Path $src 'proxy\nginx-base.conf') (Join-Path $StackDir 'proxy\nginx-base.conf') -Force

    $defaultConf = Join-Path $StackDir 'proxy\conf.d\00-default.conf'
    if (-not (Test-Path $defaultConf)) {
        Copy-Item (Join-Path $StackDir 'proxy\nginx-base.conf') $defaultConf -Force
    }

    $portsFile = Join-Path $StackDir 'conf\ports.yml'
    if (-not (Test-Path $portsFile)) {
        Write-TextFile $portsFile @'
# Regenerated by the control panel whenever you change which ports are public.
services:
  kaspad:
    ports:
      - "0.0.0.0:16111:16111/tcp"
      - "0.0.0.0:16110:16110/tcp"
      - "0.0.0.0:17110:17110/tcp"
'@
    }

    # The entrypoint is copied into a Linux image, so it must keep LF endings.
    $entry = Join-Path $StackDir 'kaspad\entrypoint.sh'
    if (Test-Path $entry) { Write-TextFile $entry ([System.IO.File]::ReadAllText($entry)) }

    if ($tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    Ok "Stack files are in $StackDir"
}

function Get-LatestRelease {
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$UpstreamRepo/releases/latest" `
            -Headers @{ 'User-Agent' = 'kaspa-one-click-installer'; 'Accept' = 'application/vnd.github+json' } `
            -TimeoutSec 20
        return $release.tag_name
    } catch {
        return $null
    }
}

function New-RandomHex {
    param([int] $Bytes = 32)
    $buffer = New-Object byte[] $Bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
    return ([BitConverter]::ToString($buffer) -replace '-', '').ToLower()
}

function Read-EnvValue {
    param([string] $Path, [string] $Key)
    if (-not (Test-Path $Path)) { return '' }
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ($line -match "^$Key=(.*)$") { return $Matches[1] }
    }
    return ''
}

# ----------------------------------------------------------------- main ----

Write-Host ''
Write-Host 'Kaspa one-click node' -ForegroundColor White
Write-Host "install dir $StackDir"
Write-Host "panel       http://localhost:$GuiPort"
Write-Host ''

Initialize-Docker
Get-Stack

if (-not $Version) {
    Say "Looking up the newest kaspad release from $UpstreamRepo"
    $Version = Get-LatestRelease
    if (-not $Version) { $Version = 'v2.0.1'; Warn "Could not reach the GitHub API; falling back to $Version." }
}
Ok "kaspad $Version"

$envFile   = Join-Path $StackDir '.env'
$existingHash   = Read-EnvValue $envFile 'ADMIN_PASSWORD_HASH'
$existingSecret = Read-EnvValue $envFile 'SESSION_SECRET'
if (-not $existingSecret) { $existingSecret = New-RandomHex 32 }

Write-TextFile $envFile @"
# Generated by install.ps1. Delete this file only if you also remove the stack.
STACK_DIR=$StackDirPosix
KASPAD_VERSION=$Version
KASPAD_REPO_URL=https://github.com/$UpstreamRepo
UPSTREAM_REPO=$UpstreamRepo
GUI_PORT=$GuiPort
MANAGER_BIND=$Bind
HTTP_PORT=$HttpPort
HTTPS_PORT=$HttpsPort
SESSION_SECRET=$existingSecret
ADMIN_PASSWORD_HASH=$existingHash
"@

# Work out the final auth state before building anything, so the warning lands
# before the user walks away from a long build.
$authState = 'none'
if ($Password)          { $authState = 'set' }
elseif ($NoPassword)    { $authState = 'cleared' }
elseif ($existingHash)  { $authState = 'kept' }

$isLoopback = $Bind -eq '127.0.0.1' -or $Bind -eq '::1' -or $Bind -eq 'localhost' -or $Bind.StartsWith('127.')

if ($authState -notin @('set', 'kept') -and -not $isLoopback) {
    Warn "The panel has no password and you asked for it on $Bind."
    Warn "It controls the Docker daemon, so anyone who reaches port $GuiPort owns this machine."
    Warn 'Use -Password <pass>, or -Bind 127.0.0.1 to keep it on this machine only.'
    if (-not (Confirm-Step 'Continue anyway?')) { Die 'Aborted.' }
}

Say 'Building images'
Invoke-Compose build manager

function Write-PasswordHash {
    param([string] $Hash)
    $lines = [System.IO.File]::ReadAllLines($envFile) | Where-Object { $_ -notmatch '^ADMIN_PASSWORD_HASH=' }
    Write-TextFile $envFile (($lines + "ADMIN_PASSWORD_HASH=$Hash") -join "`n")
}

if ($authState -eq 'set') {
    $hash = $Password | & docker run --rm -i $ManagerImage node lib/hash-password.js
    if ($LASTEXITCODE -ne 0 -or -not $hash) { Die 'Could not hash the admin password.' }
    Write-PasswordHash $hash
} elseif ($authState -eq 'cleared') {
    Write-PasswordHash ''
}

Invoke-Compose build kaspad

Say 'Starting the stack'
Invoke-Compose up -d

Write-Host ''
Write-Host '-------------------------------------------------' -ForegroundColor DarkGray
Write-Host 'Your Kaspa node is running.' -ForegroundColor Green
Write-Host ''
Write-Host "  Control panel   http://localhost:$GuiPort"
switch ($authState) {
    'set'  { Write-Host '  Sign in         with the password you supplied' -ForegroundColor DarkGray }
    'kept' { Write-Host '  Sign in         with the password from your previous install' -ForegroundColor DarkGray }
    default {
        Write-Host '  Sign in         not required' -ForegroundColor Green
        if ($isLoopback) {
            Write-Host "                  the panel is bound to $Bind, so only this machine can open it" -ForegroundColor DarkGray
        } else {
            Write-Host "                  WARNING: bound to $Bind with no password" -ForegroundColor Yellow
        }
    }
}
Write-Host @"

  Node arguments   --utxoindex is always on, plus the ports below.
  Ports to forward on your router to go public:
      16111/tcp   P2P            (required to be a public node)
      16110/tcp   gRPC           (optional, for wallets and tools)
      17110/tcp   wRPC Borsh     (optional)
      18110/tcp   wRPC JSON      (optional, off by default)
      5555/tcp    stratum        (only if you mine, and only for remote miners)
      80, 443     only if you use the domain / HTTPS features

  Mining          Open the Mining tab to switch on the stratum bridge and
                  watch hashrate, workers and blocks found.

  Everything lives in $StackDir
  Remove it all with:
      powershell -ExecutionPolicy Bypass -File "$StackDir\uninstall.ps1"

"@
Write-Host '-------------------------------------------------' -ForegroundColor DarkGray
Write-Host ''

Say 'First lines from the node'
Start-Sleep -Seconds 3
& docker logs --tail 25 kaspa-node-kaspad
Write-Host ''
Write-Host 'Follow along with: docker logs -f kaspa-node-kaspad' -ForegroundColor DarkGray
Write-Host ''
