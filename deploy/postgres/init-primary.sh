#!/bin/bash
# Runs once, on the first initialisation of the primary's data volume.
#
# Two things the official image does not do for us:
#   1. a replication role that pg_basebackup can log in as;
#   2. an explicit pg_hba rule for *replication* connections — the image's
#      `host all all all …` rule covers ordinary databases, and physical
#      replication is matched against the special `replication` database.
set -euo pipefail

: "${REPLICATION_PASSWORD:?REPLICATION_PASSWORD must be set — see deploy/example.env}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v rep_password="$REPLICATION_PASSWORD" <<'SQL'
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD :'rep_password';
SQL

# Trust inside the compose network only for the replication pseudo-database; passwords still apply.
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
echo "replication role created and pg_hba rule added for replicator"
