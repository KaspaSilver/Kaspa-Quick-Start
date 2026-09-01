#!/bin/sh
# Replaces the image's /app/run-webserver.sh. Two things change, and both are
# the same thing: upstream assumes host networking, where localhost is both the
# database and the translation engine. See README.md here.
#
# --libretranslate-url is what serves POST /translate. Missing it is not an
# error anybody sees -- the binary defaults to 127.0.0.1:5000, finds nothing
# there, and every translation request fails with TRANSLATION_FAILED.
exec /app/kachat-webserver \
  --db-host "${DB_HOST}" --db-port "${DB_PORT}" --db-name "${DB_NAME}" \
  --db-user "${DB_USER}" --db-password "${DB_PASSWORD}" \
  --bind-address "0.0.0.0:${WEBSERVER_PORT}" \
  --worker-threads 6 --db-max-connections 18 --request-timeout 30 --rate-limit 600000 \
  --libretranslate-url "${LIBRETRANSLATE_URL:-http://libretranslate:5000}"
