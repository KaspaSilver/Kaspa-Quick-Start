<#
.SYNOPSIS
    Removes everything install.ps1 created.

.DESCRIPTION
    irm https://raw.githubusercontent.com/KaspaSilver/Quick-Start-Kaspa/main/uninstall.ps1 | iex

    Deletes the containers, images, the chain-data volume, the network and the
    install directory. Docker Desktop itself is left alone unless you pass
    -RemoveDocker, and the synced blockchain can be kept with -KeepData.
#>
[CmdletBinding()]
param(
    [string] $Dir = $(if ($env:KASPA_STACK_DIR) { $env:KASPA_STACK_DIR } else { Join-Path $env:USERPROFILE '.kaspa-node' }),
    [switch] $KeepData,
    [switch] $KeepBaseImages,
    [switch] $RemoveDocker,
    [switch] $Yes
)

$ErrorActionPreference = 'Continue'

function Say  { param($m) Write-Host "==> $m" -ForegroundColor Cyan }
function Ok   { param($m) Write-Host "  ok $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "warn $m" -ForegroundColor Yellow }

function Confirm-Step {
    param([string] $Question)
    if ($Yes) { return $true }
    $reply = Read-Host "$Question [y/N]"
    return ($reply -match '^(y|yes)$')
}

$StackDir = $Dir.TrimEnd('\', '/')

Write-Host ''
Write-Host 'Remove the Kaspa one-click node' -ForegroundColor White
Write-Host "  directory $StackDir" -ForegroundColor DarkGray
if ($KeepData) {
    Write-Host '  chain data will be KEPT' -ForegroundColor DarkGray
} else {
    Write-Host '  chain data will be DELETED (re-syncing takes hours)' -ForegroundColor Yellow
}
Write-Host ''

if (-not (Confirm-Step 'Proceed?')) { Write-Host 'Nothing was removed.'; exit 0 }

$dockerUsable = $false
if (Get-Command docker -ErrorAction SilentlyContinue) {
    docker info 2>&1 | Out-Null
    $dockerUsable = ($LASTEXITCODE -eq 0)
}

if ($dockerUsable) {
    $composeFile = Join-Path $StackDir 'docker-compose.yml'
    if (Test-Path $composeFile) {
        Say 'Stopping the stack'
        $files = @('-f', $composeFile)
        $ports = Join-Path $StackDir 'conf\ports.yml'
        if (Test-Path $ports) { $files += @('-f', $ports) }
        # --profile mining makes compose aware of the stratum bridge; without
        # it the bridge container and volume are left behind as orphans.
        $down = @('--profile', 'mining', 'down', '--remove-orphans', '--rmi', 'local')
        if (-not $KeepData) { $down += '--volumes' }
        & docker compose @files --project-directory $StackDir @down 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Warn 'compose down reported an error; removing objects individually.' }
    }

    Say 'Removing leftover containers'
    foreach ($name in @('kaspa-node-kaspad', 'kaspa-node-manager', 'kaspa-node-proxy', 'kaspa-node-bridge')) {
        & docker rm -f $name 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Ok "removed container $name" }
    }

    Say 'Removing images'
    $built = & docker images --format '{{.Repository}}:{{.Tag}}' 2>$null | Where-Object { $_ -like 'kaspa-one-click/*' }
    foreach ($image in $built) {
        & docker rmi -f $image 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Ok "removed image $image" }
    }

    if (-not $KeepBaseImages) {
        # These may be shared with other projects, so a refusal is expected.
        foreach ($image in @('nginx:1.27-alpine', 'certbot/certbot:latest', 'node:22-alpine', 'alpine:3.21')) {
            & docker rmi $image 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { Ok "removed image $image" }
        }
    }

    if (-not $KeepData) {
        Say 'Removing volumes'
        foreach ($volume in @('kaspa-node-data', 'kaspa-node-bridge-data')) {
            & docker volume rm -f $volume 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { Ok "removed volume $volume" }
        }
    }

    Say 'Removing the network'
    & docker network rm kaspa-node-net 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Ok 'removed network kaspa-node-net' }

    & docker builder prune -f 2>&1 | Out-Null
} else {
    Warn 'Docker is not available - skipping container, image and volume removal.'
}

if (Test-Path $StackDir) {
    # Refuse to delete anything that is not recognisably our install directory.
    if ((Test-Path (Join-Path $StackDir 'docker-compose.yml')) -or (Test-Path (Join-Path $StackDir '.env'))) {
        Say "Removing $StackDir"
        Remove-Item $StackDir -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path $StackDir)) { Ok "removed $StackDir" }
        else { Warn "Could not fully remove $StackDir - delete it by hand." }
    } else {
        Warn "$StackDir does not look like a Kaspa node install - leaving it alone."
    }
}

if ($RemoveDocker) {
    if (Confirm-Step 'Really uninstall Docker Desktop? Anything else using Docker will stop working.') {
        Say 'Uninstalling Docker Desktop'
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            winget uninstall --exact --id Docker.DockerDesktop --silent
            if ($LASTEXITCODE -eq 0) { Ok 'Docker Desktop removed' }
            else { Warn 'winget could not remove Docker Desktop - use Settings > Apps.' }
        } else {
            Warn 'winget is not available - remove Docker Desktop from Settings > Apps.'
        }
    }
}

Write-Host ''
Write-Host 'Done. The Kaspa node and everything the installer added are gone.' -ForegroundColor Green
Write-Host ''
