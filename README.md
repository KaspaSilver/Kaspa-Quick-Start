# Quick Start Kaspa

One command installs Docker (if needed), runs a Kaspa node with the right
arguments, and gives you a web control panel to manage it — node settings,
domains, HTTPS and updates.

The node always runs with `--utxoindex`, and always listens on the P2P, gRPC and
wRPC ports. **To go public you only have to open the ports on your router.**
A stratum bridge is included, so miners and ASICs can point straight at your
node — with a dashboard for hashrate, workers and blocks found.

This repository is packaging only. The node itself is stock
[kaspad](https://github.com/kaspanet/rusty-kaspa) — the installer builds its
image from the official release archive, and the update button in the panel
tracks releases in that same repository.

---

## Install

### Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/KaspaSilver/Quick-Start-Kaspa/main/install.sh | bash
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/KaspaSilver/Quick-Start-Kaspa/main/install.ps1 | iex
```

When it finishes it prints the panel URL, `http://localhost:8080`. There is no
login: the panel is bound to `127.0.0.1`, so only this machine can open it.
See [Opening the panel to other machines](#opening-the-panel-to-other-machines)
if you want to reach it from elsewhere.

### Uninstall — removes everything

Same two dialects as the install above: Linux and macOS run shell scripts,
Windows runs PowerShell. There is no single line that both understand.

**Linux / macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/KaspaSilver/Quick-Start-Kaspa/main/uninstall.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/KaspaSilver/Quick-Start-Kaspa/main/uninstall.ps1 | iex
```

Both do exactly the same thing and take the same options. Containers, images,
the chain-data volume, the network and the install directory all go. Add
`--keep-data` / `-KeepData` to preserve the synced blockchain.

The installer also leaves a copy of both scripts in the install directory, so
you never need the URL twice:

```bash
bash ~/.kaspa-node/uninstall.sh
```

Docker itself is never removed. It is shared machine-wide, so uninstalling it
would destroy every unrelated container, image and volume too — if you want
Docker gone, remove it yourself afterwards.

---

## Ports

| Port    | What                | Open it to…                             |
| ------- | ------------------- | --------------------------------------- |
| `16111` | P2P                 | be a public node — this is the only one that is required |
| `16110` | gRPC RPC            | let wallets and tools reach your node    |
| `17110` | wRPC Borsh          | serve Rusty/KDX style clients            |
| `18110` | wRPC JSON           | serve browser / JSON clients (off by default) |
| `5555`  | stratum             | only if you mine, and only for miners outside this machine |
| `80`,`443` | nginx            | only if you use the domain / HTTPS features |
| `8080`  | control panel       | bound to `127.0.0.1` — do not forward it |

Testnet-10 uses `16211 / 16210 / 17210 / 18210`; the panel switches them for you.

Every listener is bound inside the stack regardless of these toggles. The
"Published" switch controls whether Docker maps it to a host port — that is the
line between private and public.

---

## What the panel does

**Dashboard** — sync progress, block/header counts, DAA score, mempool, peers,
disk usage, start/stop/restart, and a per-port reachability test. Inbound peer
count is used as the real answer to "is my P2P port actually open?", because
nobody can dial in if it is closed.

**Node settings** — every kaspad argument worth exposing as a toggle: network,
which RPC listeners bind and which get published, archival mode, unsafe RPC,
UPnP, DNS seeding, log level, peer and RPC client limits, RAM scale, retention
period, external IP, user-agent comment, explicit peers, plus a free-form field
for anything else. It shows the exact command line before you apply it.

`--utxoindex`, `--appdir` and `--yes` are added by the container entrypoint and
cannot be switched off from the UI.

**Proxy & domains** — what you would otherwise hand-write nginx config for:

- point any domain at the node's wRPC/gRPC ports or at the panel itself
- free HTTPS from Let's Encrypt, issued and auto-renewed in the background
- websocket support (required for wRPC), http→https redirect
- optional username/password, IP allow-lists and per-IP rate limits
- DuckDNS: enter a subdomain and token to keep a free domain pointed here

**Mining** — switches on the stratum bridge that ships with rusty-kaspa, so
ASICs and miners can point at your own node instead of a pool:

- pool hashrate, active workers, blocks found and accepted shares at a glance
- per-worker table: hashrate, current VarDiff difficulty, shares, stale,
  invalid, blocks, session uptime and online/idle/offline state
- recent blocks your miners found, with blue score and hash
- as many stratum ports as you want, each with its own starting difficulty, so
  a big ASIC and a small home miner do not have to share one
- VarDiff tuning, extranonce size, coinbase tag
- the exact `stratum+tcp://` address to paste into each miner

Miners supply their own payout address as the stratum username
(`kaspa:YOUR_ADDRESS.WORKERNAME`), so there is no wallet key anywhere in this
stack. The bridge needs kaspad's gRPC listener enabled — it does not have to be
published — and the panel says so if it is off.

The bridge container only exists while mining is on: it sits behind a compose
profile, so a normal node install never starts a stratum server.

**Update node** — checks `kaspanet/rusty-kaspa` for a newer release, shows the
release notes, and on confirmation rebuilds the kaspad image at that tag and
restarts the container. The chain data volume is untouched, so there is no
resync. Only the newest upstream release can be installed, and a failed build
rolls the pinned version back.

---

## Layout

Everything lives in `~/.kaspa-node` (`%USERPROFILE%\.kaspa-node` on Windows):

```
docker-compose.yml     the three services
.env                   install settings + admin password hash (chmod 600)
conf/node.json         node settings from the panel
conf/kaspad.args       generated kaspad command line
conf/ports.yml         generated compose override for published ports
conf/proxies.json      proxy host definitions
conf/mining.json       mining settings from the panel
conf/bridge.yaml       generated stratum bridge config
conf/bridge-ports.yml  generated compose override for stratum ports
proxy/conf.d/          generated nginx config
proxy/letsencrypt/     certificates
kaspad/ manager/       image build contexts
```

Chain data is a named Docker volume (`kaspa-node-data`), not a bind mount —
bind-mounting a RocksDB database into Docker Desktop is painfully slow.

### Services

| Service   | Image                        | Role |
| --------- | ---------------------------- | ---- |
| `kaspad`  | built from the release binary | the node |
| `manager` | Node 22, zero npm deps        | control panel + Docker control plane |
| `proxy`   | `nginx:1.27-alpine`           | domains, TLS, reverse proxying |
| `bridge`  | built from the release binary | stratum server for miners (only when mining is on) |

On `linux/amd64` the kaspad image is built by downloading the official release
archive — those binaries are static musl builds, so the image is a bare Alpine
plus one file and builds in seconds. There is no upstream `linux/arm64` asset,
so on arm64 the image compiles kaspad from source at the same tag instead; the
installer warns first, and it takes 30–60 minutes.

---

## Installer options

```
--dir <path>          install location (default ~/.kaspa-node)
--gui-port <port>     control panel port (default 8080)
--http-port <port>    nginx http port (default 80)
--https-port <port>   nginx https port (default 443)
--bind <address>      address the panel listens on (default 127.0.0.1)
--password <pass>     require a password to open the panel
--no-password         drop a password set by an earlier run
--version <vX.Y.Z>    install a specific kaspad release
--yes                 no prompts
```

PowerShell uses the same names as parameters: `-Dir`, `-GuiPort`, `-Password`, …

Re-running the installer is safe: it upgrades the stack files and keeps your
settings, chain data and existing password.

---

## Opening the panel to other machines

The panel drives the Docker socket, which is root on the host. Without a
password, anything that can reach port 8080 owns the machine — which is exactly
why the default bind is loopback. To reach it from elsewhere, set a password
first:

```bash
bash ~/.kaspa-node/install.sh --password 'something-long' --bind 0.0.0.0
```

Or keep it loopback-only and forward the port over SSH, which needs no password
and no open port at all:

```bash
ssh -N -L 8080:127.0.0.1:8080 you@your-node
```

Two guard rails enforce this. The installer warns and asks for confirmation if
you widen `--bind` with no password set. And because nginx can reach the manager
over the internal Docker network regardless of what the panel is bound to, the
panel refuses to create a proxy host pointing at itself unless either an admin
password is set or that host has its own basic auth.

---

## Security notes

- The panel has no password by default and is bound to `127.0.0.1`, so reaching
  the port already means sitting at the machine. Those two defaults belong
  together — see below before changing either.
- The manager container has access to the Docker socket, which is equivalent to
  root on the host. Treat the admin password accordingly.
- Values that end up in nginx config or on the kaspad command line are validated
  against strict patterns; anything that does not match is rejected rather than
  escaped.
- `--unsaferpc` exposes RPC calls that change node state. Leave it off unless
  you know you need it, and never combine it with a publicly published RPC port.
