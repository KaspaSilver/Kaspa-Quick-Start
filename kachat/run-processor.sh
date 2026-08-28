#!/bin/sh
# Replaces the image's /app/run-processor.sh. Only --db-host changes: upstream
# assumes host networking, where localhost is the database. See README.md here.
exec /app/kachat-transaction-processor \
  --upgrade-db --network "${NETWORK}" \
  --db-host "${DB_HOST}" --db-port "${DB_PORT}" --db-name "${DB_NAME}" \
  --db-user "${DB_USER}" --db-password "${DB_PASSWORD}" \
  --db-max-connections 10 --workers 4 --channel transaction_channel \
  --retry-attempts 3 --retry-delay 1000 --broadcast-retention-days 30
