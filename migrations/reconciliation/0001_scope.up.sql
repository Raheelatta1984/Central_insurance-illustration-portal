-- Reconciliation ownership foundation only. No financial amounts or payable operations.
-- Execute as a dedicated migration/owner role, never as the application login.
CREATE SCHEMA reconciliation;
CREATE SCHEMA reconciliation_private;
REVOKE ALL ON SCHEMA reconciliation FROM PUBLIC;
REVOKE ALL ON SCHEMA reconciliation_private FROM PUBLIC;

CREATE TABLE reconciliation_private.insurer (
  insurer_id text PRIMARY KEY CHECK (length(btrim(insurer_id)) BETWEEN 1 AND 200),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 500)
);

-- These are reference rows, not database enums; adding a channel needs no DDL.
CREATE TABLE reconciliation.channel_type (
  insurer_id text NOT NULL REFERENCES reconciliation_private.insurer(insurer_id),
  code text NOT NULL CHECK (length(btrim(code)) BETWEEN 1 AND 100),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 500),
  PRIMARY KEY (insurer_id, code)
);
CREATE TABLE reconciliation.subchannel_type (
  insurer_id text NOT NULL,
  channel_type_code text NOT NULL,
  code text NOT NULL CHECK (length(btrim(code)) BETWEEN 1 AND 100),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 500),
  PRIMARY KEY (insurer_id, channel_type_code, code),
  FOREIGN KEY (insurer_id, channel_type_code)
    REFERENCES reconciliation.channel_type(insurer_id, code)
);

CREATE TABLE reconciliation_private.partner (
  insurer_id text NOT NULL REFERENCES reconciliation_private.insurer(insurer_id),
  partner_id text NOT NULL CHECK (length(btrim(partner_id)) BETWEEN 1 AND 200),
  channel_partner_id text NOT NULL,
  parent_partner_id text,
  channel_type_code text NOT NULL,
  subchannel_type_code text,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 500),
  PRIMARY KEY (insurer_id, partner_id),
  UNIQUE (insurer_id, channel_partner_id, partner_id),
  FOREIGN KEY (insurer_id, channel_type_code)
    REFERENCES reconciliation.channel_type(insurer_id, code),
  FOREIGN KEY (insurer_id, channel_type_code, subchannel_type_code)
    REFERENCES reconciliation.subchannel_type(insurer_id, channel_type_code, code),
  FOREIGN KEY (insurer_id, channel_partner_id)
    REFERENCES reconciliation_private.partner(insurer_id, partner_id),
  FOREIGN KEY (insurer_id, channel_partner_id, parent_partner_id)
    REFERENCES reconciliation_private.partner(insurer_id, channel_partner_id, partner_id),
  CHECK (parent_partner_id IS DISTINCT FROM partner_id),
  CHECK ((parent_partner_id IS NULL AND channel_partner_id = partner_id)
      OR (parent_partner_id IS NOT NULL AND channel_partner_id <> partner_id))
);

-- Parent must already exist and hierarchy keys cannot be mutated. This intentionally
-- defers reparenting until there is an audited, effective-dated transfer model.
CREATE FUNCTION reconciliation_private.check_partner_hierarchy()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    OLD.insurer_id IS DISTINCT FROM NEW.insurer_id OR
    OLD.partner_id IS DISTINCT FROM NEW.partner_id OR
    OLD.channel_partner_id IS DISTINCT FROM NEW.channel_partner_id OR
    OLD.parent_partner_id IS DISTINCT FROM NEW.parent_partner_id
  ) THEN
    RAISE EXCEPTION 'partner hierarchy identifiers are immutable in this foundation';
  END IF;
  IF NEW.parent_partner_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM reconciliation_private.partner p
    WHERE p.insurer_id = NEW.insurer_id
      AND p.channel_partner_id = NEW.channel_partner_id
      AND p.partner_id = NEW.parent_partner_id
  ) THEN
    RAISE EXCEPTION 'parent partner must already exist under the same insurer and root';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION reconciliation_private.check_partner_hierarchy() FROM PUBLIC;
CREATE TRIGGER check_partner_hierarchy
BEFORE INSERT OR UPDATE ON reconciliation_private.partner
FOR EACH ROW EXECUTE FUNCTION reconciliation_private.check_partner_hierarchy();

-- Grants are provisioned only by a trusted administrator, not by the app reader.
-- No implicit insurer-wide or descendant visibility is granted.
CREATE TABLE reconciliation_private.access_grant (
  insurer_id text NOT NULL,
  subject_id text NOT NULL CHECK (length(btrim(subject_id)) BETWEEN 1 AND 200),
  partner_id text NOT NULL,
  view_self boolean NOT NULL DEFAULT false,
  view_descendants boolean NOT NULL DEFAULT false,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  PRIMARY KEY (insurer_id, subject_id, partner_id),
  FOREIGN KEY (insurer_id, partner_id)
    REFERENCES reconciliation_private.partner(insurer_id, partner_id),
  CHECK (view_self OR view_descendants),
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);

-- SECURITY DEFINER sees only private membership/hierarchy data owned by the
-- migration role. Its search_path is fixed and all private references qualified.
-- A trusted server must set subject/insurer transaction-locally after IdP validation.
CREATE FUNCTION reconciliation.can_view(
  requested_insurer text, requested_root text, requested_owner text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH RECURSIVE lineage(partner_id, parent_partner_id) AS (
    SELECT p.partner_id, p.parent_partner_id
      FROM reconciliation_private.partner p
     WHERE p.insurer_id = requested_insurer
       AND p.channel_partner_id = requested_root
       AND p.partner_id = requested_owner
    UNION
    SELECT p.partner_id, p.parent_partner_id
      FROM reconciliation_private.partner p
      JOIN lineage l ON p.partner_id = l.parent_partner_id
     WHERE p.insurer_id = requested_insurer
       AND p.channel_partner_id = requested_root
  )
  SELECT COALESCE(
    requested_insurer = current_setting('reconciliation.insurer_id', true)
    AND NULLIF(current_setting('reconciliation.subject_id', true), '') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM reconciliation_private.access_grant g
      JOIN lineage l ON l.partner_id = g.partner_id
      WHERE g.insurer_id = requested_insurer
        AND g.subject_id = current_setting('reconciliation.subject_id', true)
        AND g.valid_from <= transaction_timestamp()
        AND (g.valid_until IS NULL OR g.valid_until > transaction_timestamp())
        AND ((g.partner_id = requested_owner AND g.view_self)
          OR (g.partner_id <> requested_owner AND g.view_descendants))
    ), false
  );
$$;

CREATE FUNCTION reconciliation.can_access_insurer(requested_insurer text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT COALESCE(
    requested_insurer = current_setting('reconciliation.insurer_id', true)
    AND NULLIF(current_setting('reconciliation.subject_id', true), '') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM reconciliation_private.access_grant g
      WHERE g.insurer_id = requested_insurer
        AND g.subject_id = current_setting('reconciliation.subject_id', true)
        AND g.valid_from <= transaction_timestamp()
        AND (g.valid_until IS NULL OR g.valid_until > transaction_timestamp())
        AND (g.view_self OR g.view_descendants)
    ), false
  );
$$;
REVOKE ALL ON FUNCTION reconciliation.can_view(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION reconciliation.can_access_insurer(text) FROM PUBLIC;

ALTER TABLE reconciliation.channel_type ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation.channel_type FORCE ROW LEVEL SECURITY;
CREATE POLICY channel_type_read ON reconciliation.channel_type FOR SELECT
  USING (reconciliation.can_access_insurer(insurer_id));
ALTER TABLE reconciliation.subchannel_type ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation.subchannel_type FORCE ROW LEVEL SECURITY;
CREATE POLICY subchannel_type_read ON reconciliation.subchannel_type FOR SELECT
  USING (reconciliation.can_access_insurer(insurer_id));

-- Minimal ownership records only: no document bytes, policy facts, financial
-- amounts, statement state, AP queue or payment instruction can be operated here.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['policy', 'source_file', 'reconciliation_run', 'statement', 'payment_instruction'] LOOP
    EXECUTE format($ddl$
      CREATE TABLE reconciliation.%I (
        insurer_id text NOT NULL,
        resource_id text NOT NULL CHECK (length(btrim(resource_id)) BETWEEN 1 AND 200),
        channel_partner_id text NOT NULL,
        subpartner_id text,
        owner_partner_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
        PRIMARY KEY (insurer_id, resource_id),
        FOREIGN KEY (insurer_id, channel_partner_id, owner_partner_id)
          REFERENCES reconciliation_private.partner(insurer_id, channel_partner_id, partner_id),
        CHECK ((subpartner_id IS NULL AND owner_partner_id = channel_partner_id)
            OR (subpartner_id IS NOT NULL AND subpartner_id = owner_partner_id
                AND owner_partner_id <> channel_partner_id))
      )
    $ddl$, table_name);
    EXECUTE format('CREATE INDEX %I ON reconciliation.%I (insurer_id, channel_partner_id, owner_partner_id)',
      table_name || '_owner_idx', table_name);
    EXECUTE format('ALTER TABLE reconciliation.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE reconciliation.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY scoped_read ON reconciliation.%I FOR SELECT USING (reconciliation.can_view(insurer_id, channel_partner_id, owner_partner_id))', table_name);
  END LOOP;
END;
$$;

-- No grants to the application login are made automatically. An operator must
-- separately grant only schema USAGE, these functions' EXECUTE and SELECT on the
-- named public tables to a dedicated non-owner, non-BYPASSRLS role after review.
