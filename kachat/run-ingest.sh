#!/bin/sh
# Replaces the image's /app/run-ingest.sh. Only the Postgres host changes, from
# 0.0.0.0 to the database container: upstream assumes host networking, where
# they are the same thing. See README.md here.
#
# -l stays on localhost. That is this process's own metrics listener, not a
# connection to anything, and nothing in this stack reads it.
exec /usr/local/bin/simply-kaspa-indexer \
  -s "ws://${KASPA_NODE_ADDRESS}:${KASPA_NODE_PORT}" \
  -l "localhost:${SKI_PORT}" \
  -n "${NETWORK}" \
  -d "postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}" \
  --prune-db="0 * * * *" --retention=1h --upgrade-db \
  --disable=virtual_chain_processing,transaction_acceptance,blocks_table,block_parent_table,transactions_inputs \
  --exclude-fields=block_accepted_id_merkle_root,block_merge_set_blues_hashes,block_merge_set_reds_hashes,block_selected_parent_hash,block_bits,block_blue_work,block_blue_score,block_daa_score,block_hash_merkle_root,block_nonce,block_pruning_point,block_timestamp,block_utxo_commitment,block_version,tx_subnetwork_id,tx_hash,tx_mass,tx_in_previous_outpoint,tx_in_signature_script,tx_in_sig_op_count,tx_out_amount
