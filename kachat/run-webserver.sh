#!/bin/sh
# Replaces the image's /app/run-webserver.sh. Only --db-host changes: upstream
# assumes host networking, where localhost is the database. See README.md here.
exec /app/kachat-webserver \
  --db-host "${DB_HOST}" --db-port "${DB_PORT}" --db-name "${DB_NAME}" \
  --db-user "${DB_USER}" --db-password "${DB_PASSWORD}" \
  --bind-address "0.0.0.0:${WEBSERVER_PORT}" \
  --worker-threads 6 --db-max-connections 18 --request-timeout 30 --rate-limit 600000
