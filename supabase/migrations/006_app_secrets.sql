-- Private key/value store for backend secrets (JWT signing key, internal sweep
-- token). Read only via the Edge Function's direct Postgres connection (service
-- role bypasses RLS); RLS-enabled with no policies seals it from the public REST API.
CREATE TABLE IF NOT EXISTS app_secrets (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
ALTER TABLE app_secrets ENABLE ROW LEVEL SECURITY;

-- Generated once; never overwritten on re-run.
INSERT INTO app_secrets (key, value)
VALUES
  ('jwt_secret', encode(gen_random_bytes(48), 'hex')),
  ('internal_secret', encode(gen_random_bytes(32), 'hex'))
ON CONFLICT (key) DO NOTHING;
