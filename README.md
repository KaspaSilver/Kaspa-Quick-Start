# Quick Start Kaspa

One command installs Docker (if needed), runs a Kaspa node with the right
arguments, and gives you a web control panel to manage it: node settings,
domains, HTTPS and updates.

The node always runs with `--utxoindex`. Everything else starts switched off:
the installer brings up the panel on its own, and you decide which listeners to
bind and which ports to publish before you press Start. **To go public, switch
on the ports you want in the panel and open them on your router.**
A stratum bridge is included, so miners and ASICs can point straight at your
node, with a dashboard for hashrate, workers and blocks found. The
[KaChat indexer](https://github.com/KaspaSilver/KaChat-Indexer) and
[Nextcloud](https://github.com/KaspaSilver/KaChat-NextCloud) can be switched on
from the same panel, each tracking its own repository.

This repository is packaging only. The node itself is stock
[kaspad](https://github.com/kaspanet/rusty-kaspa). The installer builds its
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

The node itself is not running at that point, and that is deliberate. Syncing
the chain costs hours and tens of gigabytes, and publishing a port is a
decision about your network, so neither happens until you make it. Open the
panel, go to **Kaspad, Ports**, switch on what you want, then press **Start**.
Until then the node listens on P2P and on the wRPC-JSON channel the panel
speaks, and publishes nothing at all.

### Uninstall, which removes everything

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
would destroy every unrelated container, image and volume too. If you want
Docker gone, remove it yourself afterwards.

---

## Working on this repo

Generated state (`conf/`, issued certificates, `.env`) belongs to a running
stack, not to a checkout, and `.gitignore` keeps it out. That only covers files
nobody asked for, so there is also a hook that refuses a commit carrying a
private key, an environment file, or a credential pasted into a tracked file.
Turn it on once per clone:

```bash
git config core.hooksPath .githooks
```

It reads only the lines a commit adds, and `git commit --no-verify` gets past it
when that is genuinely what you want.

## Ports

| Port    | What                | Open it to…                             |
| ------- | ------------------- | --------------------------------------- |
| `16111` | P2P                 | be a public node. The only one that is required |
| `16110` | gRPC RPC            | let wallets and tools reach your node    |
| `17110` | wRPC Borsh          | serve Rusty/KDX style clients            |
| `18110` | wRPC JSON           | serve browser / JSON clients (the panel already uses it internally) |
| `5555`  | stratum             | only if you mine, and only for miners outside this machine |
| `3080`  | KaPosts REST API    | only if KaChat clients connect from outside this machine |
| `8600`  | chat indexer API    | as above |
| `8081`  | Nextcloud           | only if you reach Nextcloud without a proxy host |
| `80`,`443` | reverse proxy    | only if you switch the proxy on for domains / HTTPS |
| `8080`  | control panel       | bound to `127.0.0.1`, so do not forward it |

Testnet-10 uses `16211 / 16210 / 17210 / 18210`; the panel switches them for you.

A fresh install binds only P2P and the wRPC-JSON channel the panel speaks, and
publishes nothing at all. Each row carries two independent switches, and both
matter:

* **On** binds the listener inside the stack. It is what the stratum bridge
  (gRPC) and the KaChat indexer (wRPC Borsh) need over the internal network, and
  both tell you which one is missing when you switch them on.
* **Public** maps it to a host port, which is the line between private and
  public.

A new install also publishes on `127.0.0.1`, so a port switched on by mistake is
still reachable from this machine only. **Publish on**, under the table, is what
lets the rest of the network in.

Changing either while the node is stopped simply saves it. Nothing in the panel
starts a node you have switched off: settings, updates and port changes all wait
for you to press Start.

---

## What the panel does

**Dashboard.** Sync progress, block/header counts, DAA score, mempool, peers,
disk usage, start/stop/restart, and a per-port reachability test. Inbound peer
count is used as the real answer to "is my P2P port actually open?", because
nobody can dial in if it is closed.

**Node settings.** Every kaspad argument worth exposing as a toggle: network,
which RPC listeners bind and which get published, archival mode, unsafe RPC,
UPnP, DNS seeding, log level, peer and RPC client limits, RAM scale, retention
period, external IP, user-agent comment, explicit peers, plus a free-form field
for anything else. It shows the exact command line before you apply it.

`--utxoindex`, `--appdir` and `--yes` are added by the container entrypoint and
cannot be switched off from the UI.

**Proxy and domains.** Off by default, because it claims ports 80 and 443 and a
node with no domains has no use for it. Switch it on and you get what you would
otherwise hand-write nginx config for:

- point any domain at the node's wRPC/gRPC ports or at the panel itself
- free HTTPS from Let's Encrypt, issued and auto-renewed in the background
- websocket support (required for wRPC), http→https redirect
- optional username/password, IP allow-lists and per-IP rate limits
- DuckDNS: enter a subdomain and token to keep a free domain pointed here

**Mining.** Switches on the stratum bridge that ships with rusty-kaspa, so
ASICs and miners can point at your own node instead of a pool:

- pool hashrate, active workers, blocks found and accepted shares at a glance
- per-worker table: hashrate, current VarDiff difficulty, shares, stale,
  invalid, blocks, session uptime and online/idle/offline state
- recent blocks your miners found, with blue score and hash
- as many stratum ports as you want, each with its own starting difficulty, so
  a big ASIC and a small home miner do not have to share one
- VarDiff tuning, extranonce size, coinbase tag
- the exact `stratum+tcp://` address to paste into each miner

It also shows the current block reward, when the next monthly reduction lands
and what it drops to, and what your hashrate would earn over 1, 6 and 12 months
with those reductions applied. Kaspa reduces the reward every month by
2^(-1/12), so twelve months compound to exactly half. Over a year that is
roughly 29% less than a flat reward would suggest, which is the point of showing
it. The emission table is generated from the node's own source rather than
transcribed, and the projection is arithmetic on current difficulty, not a
forecast: it says nothing about price and assumes difficulty holds.

Miners supply their own payout address as the stratum username
(`kaspa:YOUR_ADDRESS.WORKERNAME`), so there is no wallet key anywhere in this
stack. The bridge needs kaspad's gRPC listener enabled, though it does not have to
be published, and the panel says so if it is off.

The bridge container only exists while mining is on: it sits behind a compose
profile, so a normal node install never starts a stratum server.

**Mining** and **KaChat** stay greyed out in the sidebar until the node is
running *and* synced. Both read live chain data, and a stratum server on a syncing
node hands miners stale work, and the indexer would index a chain that is not
there yet. The API refuses to enable them for the same reason, so the greying is
a courtesy rather than the actual rule. Nextcloud is never gated; it has nothing
to do with the chain.

**KaChat-Indexer.** Runs the [KaChat indexer](https://github.com/KaspaSilver/KaChat-Indexer)
and gives you the whole thing here: Overview, KaPosts, Broadcasts, Chats, Group
chats, Export / Import and Settings, built into this panel rather than framed
from somewhere else. The indexer is the engine and this is the interface to it,
so moderation, deny lists, channel purges, imports and every indexer setting are
all in the sidebar with everything else. Switch it on, pick a branch or tag, and
the panel builds it and keeps it running.

It reads the chain from the node already in this stack over wRPC Borsh, so there
is no second node and no second sync. Upstream's bundled kaspad, Portainer and
nginx-proxy-manager are not used, since this stack already provides all three and
a second nginx would collide on ports 80 and 443. Its Postgres does run, as its
own container.

The first build compiles the indexer from Rust source and takes a while; follow
it under Logs → kachat indexer.

**KaChat-Desktop.** The KaChat client itself, served from this machine instead
of a website. Switch it on and open the address it gives you in a browser. It is
a browser app, so accounts and settings live in the browser you open it with,
and it talks to whichever node and indexer you point it at from inside the app.
It does not wait for this node to sync, because it does not have to.

**Nextcloud.** Your own cloud for the files, photos and video KaChat shares and
backs up, from [KaChat-NextCloud](https://github.com/KaspaSilver/KaChat-NextCloud).
Video thumbnails (ffmpeg) and iPhone HEIC previews (Imaginary) are configured for
you. Publish it on a port, or give it a domain and HTTPS under Proxy and domains,
remember to add that domain to its trusted-domains list too, or Nextcloud will
refuse the request.

Both apps have a **Check for updates** button. Neither publishes releases, so the
honest question is how far the branch you track has moved: the panel compares the
commit your running image was built from against the newest commit on that
branch, and rebuilds on request.

**Update node.** Checks `kaspanet/rusty-kaspa` for a newer release, shows the
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
conf/apps.json         KaChat / Nextcloud settings from the panel
conf/apps-ports.yml    generated compose override for their ports
conf/*-build.json      which upstream commit each app image was built from
proxy/conf.d/          generated nginx config
proxy/letsencrypt/     certificates
kaspad/ manager/       image build contexts
```

Chain data is a named Docker volume (`kaspa-node-data`), not a bind mount,
bind-mounting a RocksDB database into Docker Desktop is painfully slow.

### Services

| Service   | Image                        | Role |
| --------- | ---------------------------- | ---- |
| `kaspad`  | built from the release binary | the node |
| `manager` | Node 22, zero npm deps        | control panel + Docker control plane |
| `proxy`   | `nginx:1.27-alpine`           | domains, TLS, reverse proxying |
| `bridge`  | built from the release binary | stratum server for miners (only when mining is on) |
| `kachat-app` + `kachat-db` | built from KaChat-Indexer | chat/KaPosts indexer and its Postgres (only when KaChat is on) |
| `nextcloud` + db/redis/imaginary | `nextcloud:stable` + ffmpeg | private cloud (only when Nextcloud is on) |

On `linux/amd64` the kaspad image is built by downloading the official release
archive. Those binaries are static musl builds, so the image is a bare Alpine
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
password, anything that can reach port 8080 owns the machine, which is exactly
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
  together, so see below before changing either.
- The manager container has access to the Docker socket, which is equivalent to
  root on the host. Treat the admin password accordingly.
- Values that end up in nginx config or on the kaspad command line are validated
  against strict patterns; anything that does not match is rejected rather than
  escaped.
- `--unsaferpc` exposes RPC calls that change node state. Leave it off unless
  you know you need it, and never combine it with a publicly published RPC port.
