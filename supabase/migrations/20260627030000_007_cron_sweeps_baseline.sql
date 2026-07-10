-- Production provisioned pg_cron/pg_net outside its historical migration
-- ledger. Keep this ordered, idempotent bootstrap so local and remote histories
-- converge and later cache-retention schedules can be installed. Portable,
-- bounded sweep schedules are defined by 033; no legacy hard-coded production
-- URL is replayed here.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
