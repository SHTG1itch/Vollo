-- 026: match create idempotency + login_attempts primary key.
--
-- client_key is a client-generated UUID sent with POST /matches. A retry after
-- a network timeout carries the same key, and the partial unique index maps it
-- back to the original row instead of double-logging the match (which would
-- count Elo/streak/territory twice).
ALTER TABLE matches ADD COLUMN IF NOT EXISTS client_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS matches_user_client_key_idx
  ON matches (user_id, client_key)
  WHERE client_key IS NOT NULL;

-- login_attempts had no primary key (flagged by the performance advisor).
-- An identity PK keeps replication/vacuum tooling happy and costs nothing.
ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY;
