// ============================================================================
// resetWaiverOrder.js
// Sets each league's waiver claim order (league_members.waiver_priority,
// 1 = first priority).
//
// Rule (per Jacob): the order begins as the INVERSE of the draft order, then
// resets each week to the INVERSE of standings (worst record claims first).
// Teams tied on the basis (same points; draft order has no ties) are ordered
// RANDOMLY, never by when a claim was placed. During a week the live claim
// processor still bumps a winner to the back (rolling); this weekly reset wipes
// that and re-seeds from standings.
//
//   - Has scored games  -> inverse standings (fewest total points = priority 1)
//   - No scored games   -> inverse draft order (last round-1 pick = priority 1)
//   - Not yet drafted    -> skipped
//
// SELF-GATING: each league stores the "basis" its current order reflects in
// leagues.waiver_order_basis ('draft' or 'event:<id>'). The reset only fires
// when the basis CHANGES (a new event scored), so running daily in the cron is
// safe — it won't wipe mid-week rolling. Use --force to re-seed regardless.
//
// Exports computeWaiverOrder() for reuse.
//
//   node resetWaiverOrder.js --dry-run            all drafted leagues, no writes
//   node resetWaiverOrder.js                       apply where the basis changed
//   node resetWaiverOrder.js --force               re-seed every drafted league
//   node resetWaiverOrder.js --league=<id> [...]   one league
//
// Requires a one-time migration:
//   ALTER TABLE leagues ADD COLUMN IF NOT EXISTS waiver_order_basis text;
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1);
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE   = process.argv.includes('--force');
const LEAGUE_ARG = (process.argv.find(a => a.startsWith('--league=')) || '').split('=')[1] || null;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// Order memberIds by a numeric basis (LOWER = higher priority); ties shuffled.
function orderByBasis(memberIds, basisOf) {
  const groups = {};
  for (const id of memberIds) { const k = basisOf(id); (groups[k] = groups[k] || []).push(id); }
  const out = [];
  for (const k of Object.keys(groups).map(Number).sort((a, b) => a - b)) out.push(...shuffle(groups[k]));
  return out;
}

// -> { order:[memberId...], basis:'standings'|'draft', basisKey:string } | null
async function computeWaiverOrder(leagueId, members) {
  const memberIds = members.map(m => m.id);

  // Inverse standings if any games have been scored.
  const { data: scores } = await supabase
    .from('scores').select('league_member_id, total_points, event_id, event:ufc_events(event_date)')
    .eq('league_id', leagueId);
  if (scores && scores.length) {
    const pts = {}; memberIds.forEach(id => { pts[id] = 0; });
    let latestId = null, latestDate = '';
    for (const s of scores) {
      pts[s.league_member_id] = (pts[s.league_member_id] || 0) + (s.total_points || 0);
      const d = s.event && s.event.event_date;
      if (d && d > latestDate) { latestDate = d; latestId = s.event_id; }
    }
    return { order: orderByBasis(memberIds, id => pts[id] || 0), basis: 'standings', basisKey: 'event:' + latestId };
  }

  // Otherwise inverse of the draft order (last round-1 pick claims first).
  const { data: picks } = await supabase
    .from('draft_picks').select('league_member_id, draft_pick').eq('league_id', leagueId).eq('draft_round', 1);
  if (picks && picks.length) {
    const pickOf = {}; for (const p of picks) pickOf[p.league_member_id] = p.draft_pick;
    return { order: orderByBasis(memberIds, id => (pickOf[id] != null ? -pickOf[id] : 1)), basis: 'draft', basisKey: 'draft' };
  }
  return null; // not drafted yet
}

(async () => {
  const sel = 'id, name, waiver_order_basis';
  let q = supabase.from('leagues').select(sel);
  q = LEAGUE_ARG ? q.eq('id', LEAGUE_ARG) : q.eq('draft_completed', true);
  const { data: leagues, error } = await q;
  if (error) {
    if (/waiver_order_basis/.test(error.message)) {
      console.error('Missing column. Run this once in the Supabase SQL editor:\n' +
        '  ALTER TABLE leagues ADD COLUMN IF NOT EXISTS waiver_order_basis text;');
      process.exit(1);
    }
    throw error;
  }

  console.log((DRY_RUN ? '[DRY-RUN] ' : '[APPLY] ') + (FORCE ? '[FORCE] ' : '') + 'waiver order — ' + leagues.length + ' league(s)\n');

  for (const lg of leagues) {
    const { data: members } = await supabase
      .from('league_members').select('id, team_name, waiver_priority').eq('league_id', lg.id);
    if (!members || !members.length) continue;

    const result = await computeWaiverOrder(lg.id, members);
    if (!result) { console.log('▸ ' + lg.name + ' — not drafted, skipped\n'); continue; }

    if (!FORCE && lg.waiver_order_basis === result.basisKey) {
      console.log('▸ ' + lg.name + ' — already current (' + result.basis + '), skipped\n');
      continue;
    }

    const nameOf = {}; for (const m of members) nameOf[m.id] = m.team_name;
    console.log('▸ ' + lg.name + '  (reset to: ' + (result.basis === 'standings' ? 'inverse standings' : 'inverse draft order') + ')');
    result.order.forEach((id, i) => console.log('   #' + (i + 1) + '  ' + (nameOf[id] || id)));

    if (!DRY_RUN) {
      for (let i = 0; i < result.order.length; i++) {
        const { error: e } = await supabase.from('league_members').update({ waiver_priority: i + 1 }).eq('id', result.order[i]);
        if (e) console.log('   ! ' + result.order[i] + ': ' + e.message);
      }
      const { error: me } = await supabase.from('leagues').update({ waiver_order_basis: result.basisKey }).eq('id', lg.id);
      if (me) console.log('   ! marker update: ' + me.message);
    }
    console.log('');
  }
  console.log(DRY_RUN ? 'Dry run — nothing changed.' : 'Done.');
})().catch(e => { console.error(e); process.exit(1); });

module.exports = { computeWaiverOrder };
