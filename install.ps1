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
    # Not 8080: that is the first port anyone reaches for when 80 belongs to
    # something else, and a panel sitting there is in the way of the job it
    # exists to do.
    [int]    $GuiPort    = $(if ($env:KASPA_GUI_PORT) { [int]$env:KASPA_GUI_PORT } else { 8420 }),
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
    foreach ($item in @('docker-compose.yml', 'kaspad', 'manager', 'bridge', 'kachat', 'kassigner', 'nextcloud', 'uninstall.sh', 'uninstall.ps1', 'README.md')) {
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

    # kaspad reads this the moment it boots, so it has to exist before anyone
    # presses Start -- otherwise the node comes up on kaspad's own defaults
    # (gRPC on 127.0.0.1, no wRPC at all) and the panel cannot reach it.
    # It seeds what the panel defaults to: P2P, and the wRPC-JSON channel the
    # panel speaks. gRPC and wRPC Borsh stay unbound until something asks.
    $argsFile = Join-Path $StackDir 'conf\kaspad.args'
    if (-not (Test-Path $argsFile)) {
        Write-TextFile $argsFile @'
# Seeded by install.ps1; regenerated by the control panel when you change settings.
# --appdir, --yes and --utxoindex are added by the container entrypoint; the
# marker below is what decides whether the index is on.
# utxoindex-managed: on
--listen=0.0.0.0:16111
--nogrpc
--rpclisten-json=0.0.0.0:18110
--loglevel=info
--outpeers=8
--maxinpeers=128
--rpcmaxclients=128
'@
    }

    # No published ports. The node talks out to the network either way; letting
    # the world talk back is a decision made in the panel.
    $portsFile = Join-Path $StackDir 'conf\ports.yml'
    if (-not (Test-Path $portsFile)) {
        Write-TextFile $portsFile @'
# Regenerated by the control panel whenever you change which ports are public.
services:
  kaspad:
    ports:
      []
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
$isLoopback = $Bind -eq '127.0.0.1' -or $Bind -eq '::1' -or $Bind -eq 'localhost' -or $Bind.StartsWith('127.')

# Ask when nobody said either way. The flags are for scripted installs; a person
# running this by hand should be offered the choice rather than have to know
# that -Password exists. Asked before the long build, not after it.
if (-not $Password -and -not $NoPassword -and -not $existingHash -and -not $Yes) {
    Write-Host ''
    Write-Host 'The panel controls the Docker daemon on this machine.'
    if ($isLoopback) {
        Write-Host "It is bound to $Bind, so a password is optional. Set one anyway if you may" -ForegroundColor DarkGray
        Write-Host 'ever want to reach it from another machine or put it on a domain.' -ForegroundColor DarkGray
    } else {
        Write-Host "You asked for it on $Bind, so it needs one." -ForegroundColor Yellow
    }

    while ($true) {
        $first = Read-Host 'Panel password (leave empty for none)' -AsSecureString
        $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR(
            [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($first))

        if ([string]::IsNullOrEmpty($plain)) {
            if ($isLoopback) {
                Warn 'No password. The panel stays reachable from this machine only.'
                break
            }
            Warn 'A password is required when the panel is not on loopback.'
            continue
        }
        if ($plain.Length -lt 8) { Warn 'Use at least 8 characters.'; continue }

        $second = Read-Host 'Repeat it' -AsSecureString
        $plain2 = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR(
            [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($second))
        if ($plain -ne $plain2) { Warn 'Those did not match.'; continue }

        $Password = $plain
        Ok 'Password set. You will be asked for it when you open the panel.'
        break
    }
}

$authState = 'none'
if ($Password)          { $authState = 'set' }
elseif ($NoPassword)    { $authState = 'cleared' }
elseif ($existingHash)  { $authState = 'kept' }


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

# The panel, and nothing else. The node stays off until it is switched on
# there, so a fresh install never syncs a chain, opens a port or fills a disk
# that nobody has asked it to.
Say 'Starting the control panel'
Invoke-Compose up -d manager

# The node is not touched here at all. It is installed, started, stopped and
# removed from the panel, like everything else the stack can run.

Write-Host ''
Write-Host '-------------------------------------------------' -ForegroundColor DarkGray
Write-Host 'Your Kaspa control panel is running.' -ForegroundColor Green
Write-Host ''
Write-Host "  Control panel   http://localhost:$GuiPort"
Write-Host '  Nothing else    not installed yet, including the node' -ForegroundColor Yellow
Write-Host '                  every service is installed from the panel, when you want it' -ForegroundColor DarkGray
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

  First run        Only the panel is installed. Open it and press Install on
                   Kaspad to build and start the node; every other service
                   works the same way, and each has an Uninstall tab that
                   takes its data with it. The UTXO index starts on, because
                   wallets and explorers ask the node for exactly that; it is
                   a checkbox under Indexes & flags if you want it off.

                   Anything you do publish binds 127.0.0.1 until you change
                   "Publish on" to 0.0.0.0, so going public takes both.

  Ports to forward on your router, once you have switched them on:
      16111/tcp   P2P            (required to be a public node)
      16110/tcp   gRPC           (wallets and tools, and the stratum bridge)
      17110/tcp   wRPC Borsh     (the KaChat indexer reads the chain here)
      18110/tcp   wRPC JSON      (the panel already uses it internally)
      5555/tcp    stratum        (only if you mine, and only for remote miners)
      80, 443     only if you use the domain / HTTPS features

  Mining          Open the Mining tab to switch on the stratum bridge and
                  watch hashrate, workers and blocks found. It needs the gRPC
                  listener, and tells you so if it is still off.

  Everything lives in $StackDir
  Remove it all with:
      powershell -ExecutionPolicy Bypass -File "$StackDir\uninstall.ps1"

"@
Write-Host '-------------------------------------------------' -ForegroundColor DarkGray
Write-Host ''

Say 'First lines from the control panel'
Start-Sleep -Seconds 3
& docker logs --tail 25 kaspa-node-manager
Write-Host ''
Write-Host 'Follow along with: docker logs -f kaspa-node-manager' -ForegroundColor DarkGray
Write-Host 'And the node, once you have started it: docker logs -f kaspa-node-kaspad' -ForegroundColor DarkGray
Write-Host ''

# ------------------------------------------------------------------- open ---
#
# The last thing, and the one thing anybody wants after all of that: the panel,
# open. Offered rather than done, because an installer that seizes the browser
# on a machine somebody is working on is a rude thing to be.
#
# Skipped when nobody is there to answer: -Yes, or a host with no interactive
# console, where Read-Host either throws or blocks a scripted install forever.
if (-not $Yes -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
    $url = "http://localhost:$GuiPort"
    Write-Host ''
    Write-Host "  Press Enter to open the panel at $url, or Ctrl-C to leave it. " -NoNewline
    try {
        [void](Read-Host)
        Start-Process $url
        Ok "Opened $url"
    } catch {
        Write-Host ''
        Warn "Could not open a browser. The panel is at $url"
    }
}
