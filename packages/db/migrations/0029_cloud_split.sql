-- Deliberately a no-op. Drizzle generated DROP statements here because the open schema no
-- longer declares the cloud tables, columns and the "plan" type (audit_logs, sso_provider,
-- workspace_sso, workspaces' billing columns, user.referral_code and user.heard_from). They
-- belong to packages/cloud-db now and every database that has them keeps them. This file
-- exists so this package's snapshot (meta/0029_snapshot.json) forgets them without touching
-- any data. Never replace it with the generated SQL.
SELECT 1;
