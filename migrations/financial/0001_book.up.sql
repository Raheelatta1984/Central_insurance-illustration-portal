-- Explicit migration, never run by application startup. The runtime role gets DML only.
CREATE SCHEMA financial_private;
REVOKE ALL ON SCHEMA financial_private FROM PUBLIC;
CREATE TABLE financial_private.state (
  singleton integer PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  version bigint NOT NULL CHECK (version >= 0),
  environment text NOT NULL CHECK (environment IN ('live', 'demo')),
  payload jsonb NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
CREATE TABLE financial_private.commands (
  scope text NOT NULL CHECK (length(scope) BETWEEN 1 AND 300),
  key text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  command_id text NOT NULL UNIQUE CHECK (command_id ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status integer NOT NULL CHECK (status BETWEEN 100 AND 599),
  result jsonb NOT NULL,
  state_version bigint NOT NULL CHECK (state_version >= 0),
  at timestamptz NOT NULL,
  PRIMARY KEY (scope, key)
);
CREATE FUNCTION financial_private.commands_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'financial commands are append-only'; END;
$$;
CREATE TRIGGER commands_no_update_or_delete BEFORE UPDATE OR DELETE ON financial_private.commands
FOR EACH ROW EXECUTE FUNCTION financial_private.commands_immutable();
REVOKE ALL ON ALL TABLES IN SCHEMA financial_private FROM PUBLIC;
REVOKE ALL ON FUNCTION financial_private.commands_immutable() FROM PUBLIC;
