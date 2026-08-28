# KaChat launch script overrides

The scripts here replace the ones baked into the `kachat-app` image, and exist
for one reason: **upstream runs its containers with `network_mode: "host"`, and
this stack does not.**

With host networking, the app container and the Postgres container share the
host's network namespace, so `localhost` reaches the database and binding the
admin API to `127.0.0.1` still leaves it reachable from the box. Every launch
script in `docker/kachat/app/` is written on that assumption.

This stack puts each service in its own container on a private bridge network,
because host networking would collide with the things already running: kaspad's
P2P and RPC ports, nginx on 80 and 443, and the panel on 8080. On a bridge
network `localhost` means the container itself, so those assumptions stop
holding and the Postgres-backed processes never connect.

Each file here is upstream's script with the smallest possible change:

| file | change |
|---|---|
| `run-admin.sh` | `--db-host` to `$DB_HOST`, and the bind address from `127.0.0.1` to `0.0.0.0` |
| `run-webserver.sh` | `--db-host` to `$DB_HOST` |
| `run-processor.sh` | `--db-host` to `$DB_HOST` |
| `run-ingest.sh` | Postgres URL host from `0.0.0.0` to `$DB_HOST` |

## About the admin bind address

Upstream binds the admin API to loopback because it has no authentication of its
own, and reaches it over an SSH tunnel. The panel's KaChat screens need to reach
it from a different container, which loopback makes impossible.

Binding it to the container's interface puts it on this stack's private network
and nowhere else. The port is never published to the host, so it does not become
reachable from the LAN or the internet, and the panel that proxies it is itself
bound to `127.0.0.1`. What actually changes: other containers in this stack
could reach it, where before only processes inside that one container could.
Everything on that network is part of this stack.

## Keeping these in step

These are copies, so they do not follow upstream. **If the indexer stops working
after an update, check these against `docker/kachat/app/` in KaChat-Indexer
first**. A new argument added upstream will simply be missing here, with no
error to say so.

The long-term fix is upstream honouring `DB_HOST` and an admin bind variable
instead of hardcoding both, at which point every file here can be deleted.
