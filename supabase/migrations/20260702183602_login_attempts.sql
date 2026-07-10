-- Durable brute-force throttle for the sign-in proxy. The edge function's
-- in-memory limiter is per-isolate (Supabase spins up many, recycled often),
-- so it cannot bound credential stuffing across the fleet — count failed
-- attempts in Postgres instead, keyed by client IP and by target identifier.
create table if not exists public.login_attempts (
  key text not null,
  attempted_at timestamptz not null default now()
);

create index if not exists login_attempts_key_time_idx
  on public.login_attempts (key, attempted_at desc);

-- Sealed: no policies, so only the service-role edge function can touch it.
alter table public.login_attempts enable row level security;
-- Migration version is normalized against the production Supabase ledger.
