-- Rollback is refused once financial facts or command receipts exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM financial_private.state) OR EXISTS (SELECT 1 FROM financial_private.commands) THEN
    RAISE EXCEPTION 'refusing financial rollback: retained financial facts require an approved archival migration';
  END IF;
END;
$$;
DROP SCHEMA financial_private CASCADE;
