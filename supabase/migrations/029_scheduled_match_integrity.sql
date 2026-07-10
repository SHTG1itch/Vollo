-- 029: scheduled-match/result lifecycle integrity.
--
-- A scheduled result is a one-to-one binding. Registered results reserve an
-- accepted schedule while verification is pending; confirmed (or off-app auto)
-- results complete it. The cleanup below makes every deterministic legacy case
-- safe before installing constraints. Constraints start NOT VALID so an
-- irreparable legacy row (for example, no opponent at all) cannot brick deploy;
-- they still protect every new/updated row immediately and validate when clean.

-- Blank free-text opponents are not opponents. When both forms were persisted,
-- retain the registered user, which is the unambiguous durable identity.
UPDATE scheduled_matches
   SET opponent_name = NULL
 WHERE opponent_name IS NOT NULL
   AND regexp_replace(opponent_name, '[[:space:]]', '', 'g') = '';

UPDATE scheduled_matches
   SET opponent_name = NULL
 WHERE opponent_id IS NOT NULL
   AND opponent_name IS NOT NULL;

-- Repair lifecycle state from the linked match where it is knowable. Rejected
-- results release the schedule; pending registered results remain accepted;
-- counted results are complete.
UPDATE scheduled_matches s
   SET status = 'accepted', match_id = NULL
  FROM matches m
 WHERE s.match_id = m.id
   AND m.verification_status = 'rejected';

UPDATE scheduled_matches s
   SET status = 'accepted'
  FROM matches m
 WHERE s.match_id = m.id
   AND s.status = 'completed'
   AND m.verification_status = 'pending';

UPDATE scheduled_matches s
   SET status = 'completed'
  FROM matches m
 WHERE s.match_id = m.id
   AND s.status = 'accepted'
   AND m.verification_status IN ('auto', 'verified');

-- A completed row without a result cannot display a result and is safely
-- reopened. Non-active terminal/proposal states must never retain a binding.
UPDATE scheduled_matches
   SET status = 'accepted'
 WHERE status = 'completed'
   AND match_id IS NULL;

UPDATE scheduled_matches
   SET match_id = NULL
 WHERE match_id IS NOT NULL
   AND status NOT IN ('accepted', 'completed');

-- Historical bugs could attach one match to multiple schedules. Keep the most
-- recently updated completed/accepted row and reopen every duplicate schedule.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY match_id
           ORDER BY CASE status WHEN 'completed' THEN 0 ELSE 1 END,
                    updated_at DESC,
                    id
         ) AS position
    FROM scheduled_matches
   WHERE match_id IS NOT NULL
)
UPDATE scheduled_matches s
   SET status = CASE WHEN s.status = 'completed' THEN 'accepted'::schedule_status ELSE s.status END,
       match_id = NULL
  FROM ranked r
 WHERE s.id = r.id
   AND r.position > 1;

DO $$
BEGIN
  ALTER TABLE scheduled_matches
    ADD CONSTRAINT scheduled_opponent_xor_nonblank_chk
    CHECK (
      num_nonnulls(
        opponent_id,
        NULLIF(regexp_replace(opponent_name, '[[:space:]]', '', 'g'), '')
      ) = 1
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE scheduled_matches
    ADD CONSTRAINT scheduled_completion_match_chk
    CHECK (
      (status <> 'completed' OR match_id IS NOT NULL)
      AND (match_id IS NULL OR status IN ('accepted', 'completed'))
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Validate opportunistically. If unknown legacy corruption remains, deployment
-- still succeeds with the NOT VALID constraint enforcing all future writes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM scheduled_matches
     WHERE num_nonnulls(
       opponent_id,
       NULLIF(regexp_replace(opponent_name, '[[:space:]]', '', 'g'), '')
     ) <> 1
  ) THEN
    ALTER TABLE scheduled_matches VALIDATE CONSTRAINT scheduled_opponent_xor_nonblank_chk;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM scheduled_matches
     WHERE NOT (
       (status <> 'completed' OR match_id IS NOT NULL)
       AND (match_id IS NULL OR status IN ('accepted', 'completed'))
     )
  ) THEN
    ALTER TABLE scheduled_matches VALIDATE CONSTRAINT scheduled_completion_match_chk;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS scheduled_matches_match_id_uidx
  ON scheduled_matches (match_id)
  WHERE match_id IS NOT NULL;
