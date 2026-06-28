// Service-role Supabase client for the Edge Function. Used to validate incoming
// bearer tokens (auth.getUser) and to delete an auth identity when a user
// deletes their account. Supabase auto-injects SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY into every Edge Function's environment.
//
// No session is persisted and tokens aren't auto-refreshed — this is a
// stateless server that only ever inspects tokens handed to it per request.
import { createClient } from '@supabase/supabase-js';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

export const adminClient = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
