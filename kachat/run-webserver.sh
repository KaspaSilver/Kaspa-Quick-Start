#!/bin/sh
# Replaces the image's /app/run-webserver.sh. Two things change, and both are
# the same thing: upstream assumes host networking, where localhost is both the
# database and the translation engine. See README.md here.
#
# --libretranslate-url is what serves POST /translate. Missing it is not an
# error anybody sees -- the binary defaults to 127.0.0.1:5000, finds nothing
# there, and every translation request fails with TRANSLATION_FAILED.
#
# --rate-limit is per client IP per minute: the webserver honours X-Real-IP / X-Forwarded-For
# from the stack's proxy (kachat-audits IDX-006), so each user counts on their own.
# The password comes from DB_PASSWORD in the environment (kachat-audits IDX-011), never this
# command line -- unless the image predates that and its binary still needs the flag: then
# pass it, so updating the panel before the indexer never breaks a restart.
set --
/app/kachat-webserver --help 2>/dev/null | grep -q 'env: DB_PASSWORD' || set -- --db-password "${DB_PASSWORD}"
exec /app/kachat-webserver \
  --db-host "${DB_HOST}" --db-port "${DB_PORT}" --db-name "${DB_NAME}" \
  --db-user "${DB_USER}" "$@" \
  --bind-address "0.0.0.0:${WEBSERVER_PORT}" \
  --worker-threads 6 --db-max-connections 18 --request-timeout 30 --rate-limit "${WEBSERVER_RATE_LIMIT:-6000}" \
  --libretranslate-url "${LIBRETRANSLATE_URL:-http://libretranslate:5000}"
