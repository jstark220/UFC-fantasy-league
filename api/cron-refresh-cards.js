// ============================================================================
// api/cron-refresh-cards.js
// Vercel Cron entry point for the hourly fight-card refresh.
//
// COMPLEMENTS cron-ingest.js (the per-minute live-scoring tick):
//   * cron-ingest only does work when an event is in its narrow live window
//     (~12h before through 2h after first bout) — built for live scoring.
//   * THIS cron runs hourly and refreshes the matchup composition of every
//     non-completed ESPN-linked event in the next 7 days, so ESPN dropping /
//     swapping a fighter propagates within an hour instead of sitting stale
//     until fight-eve. Without this, a card 3 days out could still show a
//     bout that's been pulled — exactly the bug that prompted this file.
//
// ingestFightResults.runIngest now includes an orphan-prune pass, so this
// path also cleans up rows ESPN no longer lists. Idempotent — runs that
// see no changes are cheap.
//
// Security: gated by the same CRON_SECRET bearer-token check the other
// cron endpoint uses.
// ============================================================================

const { runIngest } = require('../ingestFightResults');

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' });
  }

  try {
    // back: 0   → only today + future events.
    // ahead: 7  → cap at events in the next week. Cards >1wk out rarely
    //             change in meaningful ways (replacements happen mostly in
    //             the final 7 days), and this keeps the function fast.
    const result = await runIngest({ back: 0, ahead: 7 });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron-refresh-cards] failed:', err);
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};
