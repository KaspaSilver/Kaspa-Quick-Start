<#
.SYNOPSIS
    Removes everything install.ps1 created.

.DESCRIPTION
    irm https://raw.githubusercontent.com/KaspaSilver/Kaspa-Quick-Start/main/uninstall.ps1 | iex

    By default this removes the containers, the built images and the network,
    but KEEPS your synced blockchain (and every app's data volume) and the
    install directory. A later reinstall then re-adopts the data and your node
    is already synced - no hours of re-downloading the chain.

    Docker Desktop itself is deliberately never touched - it is shared
    machine-wide, and removing it would take every unrelated container, image
    and volume with it.

    Pass -DeleteData for a full wipe: also removes the data volumes and the
    install directory. -KeepData is still accepted and is now the default.
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

# Keep the synced chain and the install directory by default, so a reinstall is
# instant. Deleting them (a full wipe) is opt-in via -DeleteData, because
# re-syncing a node from scratch takes hours.
$Keep = -not $DeleteData

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
    Write-Host '  run with -DeleteData to wipe everything instead' -ForegroundColor DarkGray
} else {
    Write-Host '  chain + app data and the install directory will be DELETED (re-syncing takes hours)' -ForegroundColor Yellow
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
        $down = @('--profile', 'mining', '--profile', 'kachat', '--profile', 'nextcloud',
                  '--profile', 'proxy', 'down', '--remove-orphans', '--rmi', 'local')
        if (-not $Keep) { $down += '--volumes' }
        & docker compose @files --project-directory $StackDir @down 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Warn 'compose down reported an error; removing objects individually.' }
    }

    Say 'Removing leftover containers'
    foreach ($name in @('kaspa-node-kaspad', 'kaspa-node-manager', 'kaspa-node-proxy', 'kaspa-node-bridge',
                        'kaspa-node-kachat', 'kaspa-node-kachat-db', 'kaspa-node-nextcloud',
                        'kaspa-node-nextcloud-db', 'kaspa-node-nextcloud-redis', 'kaspa-node-nextcloud-imaginary')) {
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
        foreach ($image in @('nginx:1.27-alpine', 'certbot/certbot:latest', 'node:22-alpine', 'alpine:3.21',
                             'postgres:17-alpine', 'mariadb:10.11', 'redis:7-alpine',
                             'nextcloud/aio-imaginary:latest', 'nextcloud:stable')) {
            & docker rmi $image 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { Ok "removed image $image" }
        }
    }

    if (-not $Keep) {
        Say 'Removing volumes'
        foreach ($volume in @('kaspa-node-data', 'kaspa-node-bridge-data',
                              'kaspa-node-kachat-db-data', 'kaspa-node-kachat-app-data',
                              'kaspa-node-nextcloud-db-data', 'kaspa-node-nextcloud-data')) {
            & docker volume rm -f $volume 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { Ok "removed volume $volume" }
        }
    }

    Say 'Removing the network'
    & docker network rm kaspa-node-net 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Ok 'removed network kaspa-node-net' }

    # Our images are gone by this point, so their build cache is now dangling
    # and this reclaims it. Without -a, cache still referenced by other
    # projects' images is left alone.
    & docker builder prune -f 2>&1 | Out-Null
} else {
    Warn 'Docker is not available - skipping container, image and volume removal.'
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
    Write-Host 'To wipe everything including the chain: rerun with -DeleteData' -ForegroundColor DarkGray
} else {
    Write-Host 'Done. Every container, image, volume and file this stack created is gone.' -ForegroundColor Green
    Write-Host 'Docker Desktop itself was left installed.' -ForegroundColor DarkGray
}
Write-Host ''
