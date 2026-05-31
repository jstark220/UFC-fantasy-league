// ============================================================================
// api/cron-ingest.js
// Vercel Cron entry point for the live fight-results ingest. Triggered on the
// schedule in vercel.json. Replaces the old GitHub `live-updates` workflow,
// whose scheduled cron fired unreliably (delayed/dropped), so results often
// never loaded. Vercel's scheduler is dependable.
//
// Event-aware: it only runs the heavy ESPN ingest when a UFC event is inside
// its window (from ~2h before the first bout through ~12h after). Outside that
// window every tick is a cheap no-op, so we don't re-scrape a finished card
// every couple of minutes for days. The ingest itself is idempotent, so manual
// GitHub runs (if you keep them) can coexist with no conflict.
//
// Security: only Vercel's scheduler can call this — it must present the
// CRON_SECRET as a bearer token (Vercel injects that header automatically when
// the CRON_SECRET env var is set).
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const { runIngest } = require('../ingestFightResults');

module.exports = async function handler(req, res) {
  // Only Vercel's cron may trigger this. Vercel sends this header when the
  // CRON_SECRET env var is configured; reject anything else.
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Event-aware gate: is any ESPN-linked event currently in its window?
  // prelim_start_time within [now - 12h, now + 2h]. If not, skip cheaply.
  const now = Date.now();
  const lo = new Date(now - 12 * 3600 * 1000).toISOString();
  const hi = new Date(now + 2 * 3600 * 1000).toISOString();
  const { data: active, error } = await supabase
    .from('ufc_events')
    .select('full_name, prelim_start_time')
    .not('espn_event_id', 'is', null)
    .gte('prelim_start_time', lo)
    .lte('prelim_start_time', hi);
  if (error) return res.status(500).json({ error: error.message });

  if (!active || active.length === 0) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'no event in window' });
  }

  // An event is live (or imminent) — ingest recent results from ESPN.
  try {
    const summary = await runIngest({ back: 2 });
    return res.status(200).json({ ok: true, active: active.map((e) => e.full_name), ...summary });
  } catch (err) {
    console.error('[cron-ingest] ingest failed:', err);
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};
