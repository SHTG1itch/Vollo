// Supabase clients for the Edge Function. Supabase auto-injects SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY into every Edge Function's
// environment.
//
// No session is persisted and tokens aren't auto-refreshed on either client —
// this is a stateless server. We never read a client's stored auth state; we
// only inspect tokens handed to us per request (adminClient) and read the
// session straight off the sign-in response (authClient), so the shared clients
// are safe under concurrency.
import { createClient } from '@supabase/supabase-js';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const STATELESS = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;

// Service-role client: validates incoming bearer tokens (auth.getUser) and
// deletes an auth identity when a user deletes their account.
export const adminClient = createClient(url, serviceKey, { auth: STATELESS });

// Anon-key client: used only by the server-side sign-in proxy
// (POST /api/auth/login → signInWithPassword) so a typed username can be turned
// into a session without ever handing the caller anyone's email. Least-privilege
// on purpose — the password grant needs no elevated key.
export const authClient = createClient(url, anonKey, { auth: STATELESS });
