#!/bin/sh
# Write the credential file at start-up, then hand over to PgBouncer.
#
# `auth_type = scram-sha-256` accepts either a stored SCRAM verifier or a plain password in
# userlist.txt (PgBouncer derives the verifier). The file is 0600 and lives only inside the
# container, so the password comes from the orchestrator's secret store, not from git.
set -eu

: "${DB_USER:?DB_USER is required}"
: "${DB_PASSWORD:?DB_PASSWORD is required}"

umask 077
printf '"%s" "%s"\n' "$DB_USER" "$DB_PASSWORD" > /etc/pgbouncer/userlist.txt
chmod 0600 /etc/pgbouncer/userlist.txt

exec pgbouncer /etc/pgbouncer/pgbouncer.ini
