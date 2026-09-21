<#
.SYNOPSIS
    Removes everything install.ps1 created.

.DESCRIPTION
    irm https://raw.githubusercontent.com/KaspaSilver/Kaspa-Quick-Start/main/uninstall.ps1 | iex

    By default this is a TRUE uninstall: nothing from the install is left behind.
    It removes the containers, the built images, the network, every data volume
    (including the synced blockchain), and the install directory. A later
    reinstall starts clean and re-syncs the chain from scratch (that takes hours).

    Want a reinstall to be instant instead? Pass -KeepData: it keeps the synced
    chain, the app data volumes and the install directory, so a reinstall
    re-adopts them and the node is already synced.

    Docker Desktop itself is deliberately never touched - it is shared
    machine-wide, and removing it would take every unrelated container, image
    and volume with it.
#>
[CmdletBinding()]
param(
    [string] $Dir = $(if ($env:KASPA_STACK_DIR) { $env:KASPA_STACK_DIR } else { Join-Path $env:USERPROFILE '.kaspa-node' }),
    [switch] $KeepData,
    [switch] $DeleteData,
    [switch] $KeepBaseImages,
    [switch] $Yes
)

$ErrorActionPreference = 'Continue'

# A true uninstall by default: wipe everything so nothing lingers. -KeepData opts
# into keeping the synced chain + install dir for an instant reinstall. -DeleteData
# is accepted for explicitness (it is already the default) and always wins.
$Keep = $KeepData.IsPresent -and -not $DeleteData.IsPresent

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
if ($Keep) {
    Write-Host '  chain + app data and the install directory will be KEPT (a reinstall is instant)' -ForegroundColor DarkGray
} else {
    Write-Host '  EVERYTHING is removed: containers, images, network, the chain + all app' -ForegroundColor Yellow
    Write-Host "  data, and $StackDir. A reinstall re-syncs from scratch (hours)." -ForegroundColor Yellow
    Write-Host '  run with -KeepData to keep the chain for an instant reinstall' -ForegroundColor DarkGray
}
Write-Host ''

if (-not (Confirm-Step 'Proceed?')) { Write-Host 'Nothing was removed.'; exit 0 }

$dockerUsable = $false
if (Get-Command docker -ErrorAction SilentlyContinue) {
    docker info 2>&1 | Out-Null
    $dockerUsable = ($LASTEXITCODE -eq 0)
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Warn 'Docker is not installed, so there are no containers, images or volumes to remove.'
} elseif (-not $dockerUsable) {
    # Present but unreachable - say so plainly. Silently doing nothing is exactly
    # how a "panel still running after uninstall" happens.
    Warn 'Docker is installed but not reachable (Docker Desktop may be stopped, or it needs elevated access).'
    Warn 'Start Docker Desktop, or open an elevated PowerShell, then re-run the uninstall.'
    exit 1
} else {
    # Graceful path: compose down with EVERY profile (kachat-desktop / bot /
    # translate were missing before, so those services were left running).
    $composeFile = Join-Path $StackDir 'docker-compose.yml'
    if (Test-Path $composeFile) {
        Say 'Stopping the stack (docker compose down)'
        $files = @('-f', $composeFile)
        $ports = Join-Path $StackDir 'conf\ports.yml'
        if (Test-Path $ports) { $files += @('-f', $ports) }
        $down = @('--profile','mining','--profile','kachat','--profile','kachat-desktop',
                  '--profile','nextcloud','--profile','proxy',
                  '--profile','bot','--profile','translate',
                  'down','--remove-orphans','--rmi','local')
        if (-not $Keep) { $down += '--volumes' }
        & docker compose @files --project-directory $StackDir @down 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Warn 'compose down reported an error; sweeping objects directly.' }
    }

    # Hard backstop: sweep EVERY container this stack created - by name prefix AND
    # by the compose-project label - instead of trusting a hardcoded list or the
    # right set of profiles. This guarantees the panel (and every service) is gone.
    Say 'Removing all Kaspa Quick Start containers'
    $ids = @()
    $ids += & docker ps -aq --filter 'name=^kaspa-node-' 2>$null
    $ids += & docker ps -aq --filter 'label=com.docker.compose.project=kaspa-node' 2>$null
    $ids = $ids | Where-Object { $_ } | Sort-Object -Unique
    if ($ids.Count -gt 0) {
        & docker rm -f @ids 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Ok "removed $($ids.Count) container(s)" }
        else { Warn 'some containers would not remove (checked again below)' }
    } else {
        Ok 'no Kaspa Quick Start containers were running'
    }

    Say 'Removing images'
    $built = & docker images --format '{{.Repository}}:{{.Tag}}' 2>$null | Where-Object { $_ -like 'kaspa-one-click/*' }
    foreach ($image in $built) {
        & docker rmi -f $image 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Ok "removed image $image" }
    }

    if (-not $KeepBaseImages) {
        # These may be shared with other projects, so a refusal is expected.
        foreach ($image in @('nginx:1.27-alpine', 'certbot/certbot:latest', 'node:22-alpine', 'alpine:3.21',
                             'postgres:17-alpine', 'mariadb:10.11', 'redis:7-alpine',
                             'nextcloud/aio-imaginary:latest', 'nextcloud:stable')) {
            & docker rmi $image 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { Ok "removed image $image" }
        }
    }

    if (-not $Keep) {
        Say 'Removing data volumes'
        # Sweep by name prefix so a newly-added data volume can't be missed.
        $vols = & docker volume ls -q --filter 'name=kaspa-node-' 2>$null | Where-Object { $_ }
        foreach ($volume in $vols) {
            & docker volume rm -f $volume 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { Ok "removed volume $volume" }
        }
    }

    Say 'Removing the network'
    & docker network rm kaspa-node-net 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Ok 'removed network kaspa-node-net' }

    & docker builder prune -f 2>&1 | Out-Null

    # Verify: never claim success while a container is still up. This is the check
    # that would have caught "panel still running" instead of printing Done.
    $survivors = @(& docker ps -aq --filter 'name=^kaspa-node-' 2>$null | Where-Object { $_ })
    if ($survivors.Count -gt 0) {
        Warn "$($survivors.Count) Kaspa Quick Start container(s) are STILL present after uninstall:"
        & docker ps -a --filter 'name=^kaspa-node-' --format '       {{.Names}}  ({{.Status}})' 2>$null | ForEach-Object { Write-Host $_ }
        Warn 'Remove them by hand with:'
        Warn '    docker rm -f $(docker ps -aq --filter name=kaspa-node-)'
        exit 1
    }
    Ok 'verified: no Kaspa Quick Start containers remain'
}

if (Test-Path $StackDir) {
    if ($Keep) {
        # The directory holds .env, and install re-reads its password hash and
        # session secret. Keeping it (and the data volumes) is what lets a
        # reinstall re-adopt the synced chain and the apps' databases as-is.
        Say "Keeping $StackDir (its .env holds what a reinstall needs to re-adopt your data)"
    } else {
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
}

Write-Host ''
if ($Keep) {
    Write-Host 'Done. The containers, images and network are gone; your synced chain,' -ForegroundColor Green
    Write-Host "app data and $StackDir were kept. Reinstall any time and it picks up where it left off." -ForegroundColor Green
} else {
    Write-Host 'Done. Nothing from the install is left: every container, image, volume,' -ForegroundColor Green
    Write-Host "the network and $StackDir are gone. Only Docker Desktop was left installed." -ForegroundColor Green
    Write-Host 'Next time, uninstall with -KeepData to keep the chain for an instant reinstall.' -ForegroundColor DarkGray
}
Write-Host ''
