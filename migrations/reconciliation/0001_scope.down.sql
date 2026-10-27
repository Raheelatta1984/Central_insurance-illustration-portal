-- Only an empty, unextended foundation may be rolled back. Never discard data.
DO $$
DECLARE table_name text;
DECLARE has_rows boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM reconciliation_private.insurer)
     OR EXISTS (SELECT 1 FROM reconciliation_private.partner)
     OR EXISTS (SELECT 1 FROM reconciliation_private.access_grant)
     OR EXISTS (SELECT 1 FROM reconciliation.channel_type)
     OR EXISTS (SELECT 1 FROM reconciliation.subchannel_type) THEN
    RAISE EXCEPTION 'refusing reconciliation rollback: configuration or memberships exist';
  END IF;
  FOREACH table_name IN ARRAY ARRAY['policy', 'source_file', 'reconciliation_run', 'statement', 'payment_instruction'] LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM reconciliation.%I)', table_name) INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION 'refusing reconciliation rollback: owned records exist';
    END IF;
  END LOOP;
END;
$$;

DROP TABLE reconciliation.payment_instruction;
DROP TABLE reconciliation.statement;
DROP TABLE reconciliation.reconciliation_run;
DROP TABLE reconciliation.source_file;
DROP TABLE reconciliation.policy;
DROP TABLE reconciliation_private.access_grant;
DROP TABLE reconciliation_private.partner;
DROP TABLE reconciliation.subchannel_type;
DROP TABLE reconciliation.channel_type;
DROP FUNCTION reconciliation.can_view(text, text, text);
DROP FUNCTION reconciliation.can_access_insurer(text);
DROP FUNCTION reconciliation_private.check_partner_hierarchy();
DROP TABLE reconciliation_private.insurer;
-- No CASCADE: unexpected later objects also make rollback fail transactionally.
DROP SCHEMA reconciliation;
DROP SCHEMA reconciliation_private;
