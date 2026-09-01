#!/bin/sh
# Replaces the image's own /app/run-admin.sh, changing two things: the database
# host, and the interface the admin API binds to.
#
# Upstream binds it to 127.0.0.1 because it has no authentication of its own,
# and their deployment reaches it over an SSH tunnel. Inside a container that
# means its own loopback, so nothing else can reach it -- including this stack's
# control panel, which is where the KaChat screens live.
#
# Binding it to the container's network interface makes it reachable from the
# stack's private Docker network and nowhere else. The port is never published
# to the host, so it does not become reachable from the LAN or the internet, and
# the panel that proxies it is itself bound to 127.0.0.1. What changes is that
# other containers in this stack could reach it, where before only processes
# inside this one container could. Everything on that network is part of this
# stack.
#
# Kept in step with upstream's script by hand: if they add an argument to the
# admin binary, add it here too.
#
# --libretranslate-url is the third change. It defaults to 127.0.0.1:5000
# upstream, which under host networking is the translation engine sitting beside
# the indexer; here it is a container of its own on the stack network. Without
# this the panel's Translation tab reports the engine as down while it is
# running perfectly well.
exec /app/kachat-admin \
  --db-host "${DB_HOST}" --db-port "${DB_PORT}" --db-name "${DB_NAME}" \
  --db-user "${DB_USER}" --db-password "${DB_PASSWORD}" \
  --db-max-connections 4 --bind-address "0.0.0.0:${ADMIN_PORT}" \
  --libretranslate-url "${LIBRETRANSLATE_URL:-http://libretranslate:5000}"
