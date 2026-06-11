// ============================================================================
// scoreEvents.js
// Turns raw fight_results into fantasy points in the `scores` table, which the
// standings page reads. This is the automatic, server-side equivalent of the
// commissioner's manual "Score Event" page (public/js/score-event.js) — same
// math, same table, same idempotent upsert — so the two paths agree exactly
// and can coexist.
//
// CORE RULE: a team only earns points from the fighters it STARTED. We drive
// every score row off starter_selections (the locked lineup), never off the
// full roster. A fighter a manager rostered but did not start scores nothing.
//
// HOW IT WORKS, per event:
//   1. Load fight_results for the event (stats, method, round, title, etc.).
//   2. Load starter_selections for the event, joined to their league so we
//      know which league_id (and thus which scoring_config) each one uses.
//   3. For each started fighter who actually fought, run the shared Scoring
//      engine with that league's config and upsert one row into `scores`,
//      keyed (league_member_id, event_id, fighter_id) so re-runs overwrite
//      rather than duplicate. Live events can be scored every couple minutes
//      as results land; each pass just refreshes the totals.
//
// Reuses public/js/scoring.js unchanged — the SAME pure function the browser
// uses — so there is a single source of truth for the scoring rules.
//
// Run:
//   node scoreEvents.js                 score completed events in the last 21 days
//   node scoreEvents.js --back=45       widen the lookback window
//   node scoreEvents.js <event_uuid>    score one event by its ufc_events id
//   node scoreEvents.js --dry-run       compute + log, write nothing
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
// The exact scoring engine the frontend uses. In Node this module.exports's
// { computeFighterScore, SCORING_DEFAULTS_V1_2 } (see the UMD wrapper at the
// top of scoring.js), so the rules never diverge between server and browser.
const Scoring = require('./public/js/scoring');

// The fight_results columns the scoring engine reads. Kept in one place so the
// select stays in sync with what computeFighterScore actually consumes.
const FIGHT_COLS = [
  'id', 'event_id', 'fighter_a_id', 'fighter_b_id', 'winner_id', 'outcome',
  'end_round', 'end_time_seconds', 'card_position', 'title_type', 'is_title_defense',
  'fighter_a_sig_strikes', 'fighter_a_takedowns', 'fighter_a_knockdowns', 'fighter_a_control_seconds',
  'fighter_b_sig_strikes', 'fighter_b_takedowns', 'fighter_b_knockdowns', 'fighter_b_control_seconds',
  'fighter_a_opponent_rank', 'fighter_b_opponent_rank'
].join(', ');

// ----------------------------------------------------------------------------
// scoreEvents(opts)
//   opts.supabase   — reuse an existing client (the cron passes its own); else
//                     one is created from env.
//   opts.eventIds   — explicit list of ufc_events ids to score (the cron passes
//                     the events currently in their live window).
//   opts.back       — if no eventIds, score every event in the last N days
//                     (default 21). Used by the standalone / daily run.
//   opts.dryRun     — compute and log, but write nothing.
// Returns { eventsScored, rowsWritten, skippedNoFight }.
// ----------------------------------------------------------------------------
async function scoreEvents(opts = {}) {
  const supabase = opts.supabase
    || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const dryRun = !!opts.dryRun;

  // 1) Decide which events to score.
  let eventIds = opts.eventIds || null;
  if (!eventIds) {
    const back = opts.back != null ? opts.back : 21;
    const cutoff = new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
    const r = await supabase
      .from('ufc_events')
      .select('id')
      .gte('event_date', cutoff);
    if (r.error) throw new Error('Failed to load events: ' + r.error.message);
    eventIds = (r.data || []).map((e) => e.id);
  }
  if (!eventIds.length) {
    console.log('No events to score.');
    return { eventsScored: 0, rowsWritten: 0, skippedNoFight: 0 };
  }

  // 2) Load every fight for those events, then index by (event, fighter) so we
  //    can look up a started fighter's fight instantly. Only fights that have
  //    actually happened (outcome set) score points — this mirrors the
  //    standings breakdown modal, which skips fights with no outcome yet.
  const frRes = await supabase
    .from('fight_results')
    .select(FIGHT_COLS)
    .in('event_id', eventIds);
  if (frRes.error) throw new Error('Failed to load fight_results: ' + frRes.error.message);
  const fights = frRes.data || [];

  const fightByKey = new Map(); // `${event_id}|${fighter_id}` -> { fight, isA }
  fights.forEach((f) => {
    if (!f.outcome) return; // not fought yet — no points
    if (f.fighter_a_id) fightByKey.set(f.event_id + '|' + f.fighter_a_id, { fight: f, isA: true });
    if (f.fighter_b_id) fightByKey.set(f.event_id + '|' + f.fighter_b_id, { fight: f, isA: false });
  });

  // 3) Load every started fighter for those events, joined to its league so we
  //    know which scoring_config applies. starter_selections is the lineup that
  //    was locked at the first prelim — the ONLY fighters that can score.
  const selRes = await supabase
    .from('starter_selections')
    .select('league_member_id, event_id, fighter_id, member:league_members(id, league_id)')
    .in('event_id', eventIds);
  if (selRes.error) throw new Error('Failed to load starter_selections: ' + selRes.error.message);
  const selections = selRes.data || [];

  // Reconcile the scores table to the CURRENT starters before scoring. Any
  // score row for these events whose fighter is no longer a starter (e.g. the
  // commish swapped the lineup) is deleted, or the benched fighter's points
  // would keep counting toward the total.
  await reconcileScores(supabase, eventIds, selections, dryRun);

  if (selections.length === 0) {
    console.log('No starter selections for these events — nothing to score.');
    return { eventsScored: eventIds.length, rowsWritten: 0, skippedNoFight: 0 };
  }

  // 4) Load the scoring_config for every league referenced by a selection.
  const leagueIds = Array.from(new Set(
    selections.map((s) => s.member && s.member.league_id).filter(Boolean)
  ));
  const cfgByLeague = new Map();
  if (leagueIds.length) {
    const lgRes = await supabase
      .from('leagues')
      .select('id, scoring_config')
      .in('id', leagueIds);
    if (lgRes.error) throw new Error('Failed to load leagues: ' + lgRes.error.message);
    (lgRes.data || []).forEach((l) => cfgByLeague.set(l.id, l.scoring_config || null));
  }

  // 5) Score each started fighter who fought, building the upsert payload.
  const rows = [];
  let skippedNoFight = 0;
  const now = new Date().toISOString();

  selections.forEach((sel) => {
    const leagueId = sel.member && sel.member.league_id;
    if (!leagueId) return; // orphaned selection (member deleted) — skip safely

    const entry = fightByKey.get(sel.event_id + '|' + sel.fighter_id);
    if (!entry) { skippedNoFight++; return; } // started but didn't fight / no result yet

    const cfg = cfgByLeague.has(leagueId) ? cfgByLeague.get(leagueId) : null;
    const s = Scoring.computeFighterScore(entry.fight, entry.isA, cfg);

    rows.push({
      league_member_id: sel.league_member_id,
      league_id:        leagueId,
      event_id:         sel.event_id,
      fight_result_id:  entry.fight.id,
      fighter_id:       sel.fighter_id,
      base_points:      s.base_points,
      win_bonus:        s.win_bonus,
      title_bonus:      s.title_bonus,
      ranked_opp_bonus: s.ranked_opp_bonus,
      card_multiplier:  s.card_multiplier,
      total_points:     s.total,
      scoring_detail:   s.scoring_detail,
      calculated_at:    now
    });
  });

  console.log(
    'Events: ' + eventIds.length +
    ' | started fighters: ' + selections.length +
    ' | scored: ' + rows.length +
    ' | not yet fought: ' + skippedNoFight
  );

  if (dryRun) {
    rows.forEach((r) => console.log('  would write', r.fighter_id, '=>', r.total_points, 'pts'));
    console.log('(dry run — nothing written)');
    return { eventsScored: eventIds.length, rowsWritten: 0, skippedNoFight };
  }

  if (rows.length === 0) {
    return { eventsScored: eventIds.length, rowsWritten: 0, skippedNoFight };
  }

  // 6) Upsert. The unique constraint (league_member_id, event_id, fighter_id)
  //    makes this idempotent: a fighter's row is created once, then refreshed
  //    on every later pass as live stats change. Chunked to stay well under any
  //    request-size limits (payloads are tiny in practice).
  let written = 0;
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const up = await supabase
      .from('scores')
      .upsert(slice, { onConflict: 'league_member_id,event_id,fighter_id' });
    if (up.error) throw new Error('Failed to upsert scores: ' + up.error.message);
    written += slice.length;
  }

  console.log('Wrote ' + written + ' score rows.');

  // 7) Stamp the hub's version token. The Fight Night Hub treats a higher
  //    last_scored_at as strictly newer data (its only merge rule), and its
  //    fallback poll watches this one column instead of refetching scores.
  //    Stamped AFTER the upserts so a client that sees the new token is
  //    guaranteed to read the rows that produced it. Failure is non-fatal:
  //    the column may not exist until 2026-06-10_hub_realtime.sql runs.
  const stamp = await supabase
    .from('ufc_events')
    .update({ last_scored_at: new Date().toISOString() })
    .in('id', eventIds);
  if (stamp.error) console.warn('last_scored_at stamp failed (run 2026-06-10_hub_realtime.sql):', stamp.error.message);

  return { eventsScored: eventIds.length, rowsWritten: written, skippedNoFight };
}

// Delete score rows that no longer match a member's CURRENT starters for the
// given events. Scoped safely: a member's stale row is only removed when that
// member HAS current starters for the event (so a transient empty read can't
// wipe a whole lineup's points). This is what makes a lineup change — including
// a commissioner edit — drop the benched fighter's points on the next pass.
async function reconcileScores(supabase, eventIds, selections, dryRun) {
  // Which (member|event) pairs have a known current lineup, and the exact
  // (member|event|fighter) starters within them.
  const memberEventWithStarters = new Set();
  const starterKey = new Set();
  selections.forEach((s) => {
    memberEventWithStarters.add(s.league_member_id + '|' + s.event_id);
    starterKey.add(s.league_member_id + '|' + s.event_id + '|' + s.fighter_id);
  });

  const existing = await supabase
    .from('scores')
    .select('id, league_member_id, event_id, fighter_id')
    .in('event_id', eventIds);
  if (existing.error) throw new Error('Failed to load scores for reconcile: ' + existing.error.message);

  const staleIds = (existing.data || [])
    .filter((r) => {
      const me = r.league_member_id + '|' + r.event_id;
      if (!memberEventWithStarters.has(me)) return false;            // unknown lineup — leave it
      return !starterKey.has(me + '|' + r.fighter_id);               // not a current starter
    })
    .map((r) => r.id);

  if (staleIds.length === 0) return;

  if (dryRun) {
    console.log('(dry run) would remove ' + staleIds.length + ' stale score row(s) (no longer starters).');
    return;
  }

  const CHUNK = 200;
  for (let i = 0; i < staleIds.length; i += CHUNK) {
    const del = await supabase.from('scores').delete().in('id', staleIds.slice(i, i + CHUNK));
    if (del.error) throw new Error('Failed to delete stale scores: ' + del.error.message);
  }
  console.log('Removed ' + staleIds.length + ' stale score row(s) (benched / swapped out).');
}

module.exports = { scoreEvents };

// CLI entry — only when run directly, not when imported by the cron function.
if (require.main === module) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env file');
    process.exit(1);
  }
  const dryRun = process.argv.includes('--dry-run');
  const backArg = process.argv.find((a) => a.startsWith('--back='));
  const back = backArg ? parseInt(backArg.split('=')[1], 10) : undefined;
  // A bare non-flag argument is treated as a single ufc_events id to score.
  const singleId = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;

  const opts = { dryRun };
  if (singleId) opts.eventIds = [singleId];
  else if (back != null) opts.back = back;

  scoreEvents(opts)
    .then((res) => console.log('Done.', res))
    .catch((err) => { console.error('Fatal error:', err); process.exit(1); });
}
