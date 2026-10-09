#!/bin/sh
# Replaces the image's /app/run-processor.sh. Only --db-host changes: upstream
# assumes host networking, where localhost is the database. See README.md here.
# The password comes from DB_PASSWORD in the environment (kachat-audits IDX-011), never this
# command line -- unless the image predates that and its binary still needs the flag: then
# pass it, so updating the panel before the indexer never breaks a restart.
set --
/app/kachat-transaction-processor --help 2>/dev/null | grep -q 'env: DB_PASSWORD' || set -- --db-password "${DB_PASSWORD}"
exec /app/kachat-transaction-processor \
  --upgrade-db --network "${NETWORK}" \
  --db-host "${DB_HOST}" --db-port "${DB_PORT}" --db-name "${DB_NAME}" \
  --db-user "${DB_USER}" "$@" \
  --db-max-connections 10 --workers 4 --channel transaction_channel \
  --retry-attempts 3 --retry-delay 1000 --broadcast-retention-days 30
