// ========================================================================
// SUPABASE CONFIG
// Shared across all pages. This file must be loaded before any
// page-specific script that calls supabaseClient.
// ========================================================================

// Project URL from Supabase dashboard (Settings > API > Project URL)
const SUPABASE_URL = 'https://zfffboipbdegrzyyzoto.supabase.co';

// Publishable (anon) key - safe to include in frontend code.
// Anyone can view this in source, but RLS policies control what they
// can actually read or write in the database.
// NEVER put the service role key here.
const SUPABASE_ANON_KEY = 'sb_publishable_f58saCGut6ALNzE2IJ7YNA_81tKmyvG';

// Create the Supabase client. Named supabaseClient (not supabase) to avoid
// a naming conflict with window.supabase, which is the CDN library object itself.
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
