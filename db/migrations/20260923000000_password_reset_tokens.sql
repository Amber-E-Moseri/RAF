-- Local password recovery: stores SHA-256 hashed one-time reset tokens.
-- Raw tokens are NEVER stored. Tokens expire in 1 hour and are single-use.

BEGIN;

CREATE TABLE IF NOT EXISTS raf.password_reset_tokens (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid         NOT NULL REFERENCES raf.app_users(id) ON DELETE CASCADE,
  token_hash  text         NOT NULL,
  expires_at  timestamptz  NOT NULL,
  consumed_at timestamptz  NULL,
  created_at  timestamptz  NOT NULL DEFAULT now()
);

-- Fast lookup by hash (the primary query path — O(1) by hash).
CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_tokens_hash
  ON raf.password_reset_tokens (token_hash);

-- For invalidating all outstanding tokens when a new one is requested.
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id
  ON raf.password_reset_tokens (user_id);

-- Partial index for the "find valid unconsumed token" query path.
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_active
  ON raf.password_reset_tokens (user_id, expires_at)
  WHERE consumed_at IS NULL;

-- RLS: enable row-level security.
-- Operations happen outside user sessions (the user has forgotten their
-- password and has no JWT). Policies mirror the bootstrap INSERT pattern
-- used for app_users and workspaces: any session may INSERT and SELECT;
-- the token_hash is a 256-bit unguessable value that gates all operations.
ALTER TABLE raf.password_reset_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS prt_insert ON raf.password_reset_tokens;
CREATE POLICY prt_insert ON raf.password_reset_tokens
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS prt_select ON raf.password_reset_tokens;
CREATE POLICY prt_select ON raf.password_reset_tokens
  FOR SELECT USING (true);

DROP POLICY IF EXISTS prt_update ON raf.password_reset_tokens;
CREATE POLICY prt_update ON raf.password_reset_tokens
  FOR UPDATE USING (true);

-- Grant table access to the runtime raf_app role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'raf_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON raf.password_reset_tokens TO raf_app';
  END IF;
END
$$;

COMMIT;
