// ============================================================================
// resetWaiverOrder.js
// Sets each league's waiver claim order (league_members.waiver_priority,
// 1 = first priority).
//
// Rule (per Jacob): the order begins as the INVERSE of the draft order, then
// resets each week to the INVERSE of standings (worst record claims first).
// Teams tied on the basis (same points; draft order has no ties) are ordered
// RANDOMLY, never by when a claim was placed.
//
//   - Has scored games  -> inverse standings (fewest total points = priority 1)
//   - No scored games   -> inverse draft order (last round-1 pick = priority 1)
//   - Not yet drafted    -> skipped (no basis to order by)
//
// Exports computeWaiverOrder() so the weekly automation can reuse it.
//
//   node resetWaiverOrder.js --dry-run            all drafted leagues, no writes
//   node resetWaiverOrder.js                       apply to all drafted leagues
//   node resetWaiverOrder.js --league=<id> [--dry-run]   one league
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1);
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const DRY_RUN = process.argv.includes('--dry-run');
const LEAGUE_ARG = (process.argv.find(a => a.startsWith('--league=')) || '').split('=')[1] || null;

// Fisher-Yates shuffle (random tiebreak).
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Given members + a basis map (memberId -> sortable number, LOWER = higher
// waiver priority) returns memberIds ordered, ties shuffled randomly.
function orderByBasis(memberIds, basisOf) {
  const groups = {};
  for (const id of memberIds) { const k = basisOf(id); (groups[k] = groups[k] || []).push(id); }
  const keys = Object.keys(groups).map(Number).sort((a, b) => a - b);
  const out = [];
  for (const k of keys) out.push(...shuffle(groups[k]));
  return out;
}

// Returns { order: [memberId...], basis: 'standings'|'draft' } or null if the
// league has no orderable basis yet (not drafted).
async function computeWaiverOrder(leagueId, members) {
  const memberIds = members.map(m => m.id);

  // Standings basis: total points per member (need at least one scored row).
  const { data: scores } = await supabase
    .from('scores').select('league_member_id, total_points').eq('league_id', leagueId);
  if (scores && scores.length) {
    const pts = {};
    for (const id of memberIds) pts[id] = 0;
    for (const s of scores) pts[s.league_member_id] = (pts[s.league_member_id] || 0) + (s.total_points || 0);
    // Inverse standings: fewest points first. basis = points (asc), ties random.
    return { order: orderByBasis(memberIds, id => pts[id] || 0), basis: 'standings' };
  }

  // Draft basis: round-1 pick order. Inverse = last pick gets priority 1.
  const { data: picks } = await supabase
    .from('draft_picks').select('league_member_id, draft_pick')
    .eq('league_id', leagueId).eq('draft_round', 1);
  if (picks && picks.length) {
    const pickOf = {};
    for (const p of picks) pickOf[p.league_member_id] = p.draft_pick;
    // Inverse: negate the pick number so the LAST pick sorts first. Members
    // with no round-1 pick (late joiners) sort to the very back, shuffled.
    const NO_PICK = 1; // highest basis -> back of the order
    return {
      order: orderByBasis(memberIds, id => (pickOf[id] != null ? -pickOf[id] : NO_PICK)),
      basis: 'draft',
    };
  }
  return null; // not drafted yet
}

(async () => {
  let leagues = [];
  if (LEAGUE_ARG) {
    const { data } = await supabase.from('leagues').select('id, name').eq('id', LEAGUE_ARG);
    leagues = data || [];
  } else {
    const { data } = await supabase.from('leagues').select('id, name').eq('draft_completed', true);
    leagues = data || [];
  }
  console.log((DRY_RUN ? '[DRY-RUN] ' : '[APPLY] ') + 'waiver order — ' + leagues.length + ' league(s)\n');

  for (const lg of leagues) {
    const { data: members } = await supabase
      .from('league_members').select('id, team_name, waiver_priority').eq('league_id', lg.id);
    if (!members || !members.length) continue;

    const result = await computeWaiverOrder(lg.id, members);
    if (!result) { console.log('▸ ' + lg.name + ' — not drafted, skipped\n'); continue; }

    const nameOf = {}; for (const m of members) nameOf[m.id] = m.team_name;
    console.log('▸ ' + lg.name + '  (order basis: ' + (result.basis === 'standings' ? 'inverse standings' : 'inverse draft order') + ')');
    const updates = [];
    result.order.forEach((id, i) => {
      const priority = i + 1;
      console.log('   #' + priority + '  ' + (nameOf[id] || id));
      updates.push({ id, priority });
    });

    if (!DRY_RUN) {
      for (const u of updates) {
        const { error } = await supabase.from('league_members').update({ waiver_priority: u.priority }).eq('id', u.id);
        if (error) console.log('   ! ' + u.id + ': ' + error.message);
      }
    }
    console.log('');
  }
  console.log(DRY_RUN ? 'Dry run — nothing changed.' : 'Done.');
})().catch(e => { console.error(e); process.exit(1); });

module.exports = { computeWaiverOrder };
