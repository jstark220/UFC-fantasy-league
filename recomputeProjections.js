// ============================================================================
// recomputeProjections.js
// Refreshes the fighter_projections table for every upcoming fight that has
// a row in fight_odds. Designed to run as the final step of
// fetchPolymarketOdds.js — every hourly Polymarket pull keeps projections in
// lockstep with live market movement.
//
// Per Jacob's call: projections only exist for fights with Polymarket odds.
// Fights without odds get no row in fighter_projections.
//
// Exports recomputeAllProjections(supabase) — supabase is the service-role
// client (write access to fighter_projections).
// ============================================================================

const Engine = require('./projectionEngine.js');

// Shared select column list — same fields the engine needs from past fights
// to compute base activity + finish distribution.
const FIGHT_HISTORY_COLS = `
  id, fighter_a_id, fighter_b_id, winner_id, outcome,
  end_round, end_time_seconds, card_position, title_type, is_title_defense,
  fighter_a_sig_strikes, fighter_a_takedowns, fighter_a_knockdowns, fighter_a_control_seconds,
  fighter_b_sig_strikes, fighter_b_takedowns, fighter_b_knockdowns, fighter_b_control_seconds,
  fighter_a_opponent_rank, fighter_b_opponent_rank,
  weight_class,
  event:ufc_events(id, event_date)
`;

// ---- Loaders ---------------------------------------------------------------

// Load every odds row plus its fight context. Restricted to upcoming events
// so we don't accidentally project a completed fight (which would be wrong
// — projections live alongside actuals, not on top of them).
async function loadFightsWithOdds(supabase) {
  const todayISO = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('fight_odds')
    .select(`
      fight_id, fighter_a_prob, fighter_b_prob,
      fight:fight_results!inner(
        id, fighter_a_id, fighter_b_id, weight_class, card_position,
        title_type, is_title_defense, outcome,
        event:ufc_events!inner(event_date)
      )
    `)
    .gte('fight.event.event_date', todayISO);
  if (error) throw new Error('loadFightsWithOdds failed: ' + error.message);

  // Filter out any rows where the join didn't materialize or the fight has
  // an outcome (already happened — shouldn't have odds, but be defensive).
  return (data || []).filter(r => r.fight && !r.fight.outcome);
}

// Per-fighter context needed for matchup math: current_rank, champ flags.
async function loadFighterContext(supabase, fighterIds) {
  if (fighterIds.length === 0) return {};
  const { data, error } = await supabase
    .from('fighters')
    .select('id, current_rank, is_champion, is_sub_champion, sub_title_type')
    .in('id', fighterIds);
  if (error) throw new Error('loadFighterContext failed: ' + error.message);
  const map = {};
  for (const f of (data || [])) map[f.id] = f;
  return map;
}

// Past completed fights for each fighter. Two paginated .in() queries (one
// per side) — keeps URL length down vs a single .or() across many UUIDs.
async function loadPastFightsByFighter(supabase, fighterIds) {
  const result = new Map();
  for (const id of fighterIds) result.set(id, []);
  if (fighterIds.length === 0) return result;
  const seen = new Set();

  async function fetchSide(column) {
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from('fight_results')
        .select(FIGHT_HISTORY_COLS)
        .in(column, fighterIds)
        .not('outcome', 'is', null)
        .range(from, from + PAGE - 1);
      if (error) throw new Error('loadPastFightsByFighter[' + column + '] failed: ' + error.message);
      if (!data || data.length === 0) break;
      for (const fight of data) {
        if (seen.has(fight.id)) continue;
        seen.add(fight.id);
        if (result.has(fight.fighter_a_id)) result.get(fight.fighter_a_id).push(fight);
        if (result.has(fight.fighter_b_id)) result.get(fight.fighter_b_id).push(fight);
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }
  await fetchSide('fighter_a_id');
  await fetchSide('fighter_b_id');
  return result;
}

// Every completed fight in a given set of divisions, projected into the
// (fight, fighterId) perspective rows the division aggregator expects.
async function loadDivisionPerspectives(supabase, divisions) {
  const result = new Map();
  for (const d of divisions) result.set(d, []);
  if (divisions.length === 0) return result;

  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('fight_results')
      .select(FIGHT_HISTORY_COLS)
      .in('weight_class', divisions)
      .not('outcome', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error('loadDivisionPerspectives failed: ' + error.message);
    if (!data || data.length === 0) break;
    for (const fight of data) {
      const arr = result.get(fight.weight_class);
      if (!arr) continue;
      arr.push({ fight, fighterId: fight.fighter_a_id });
      arr.push({ fight, fighterId: fight.fighter_b_id });
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return result;
}

// ---- Main ------------------------------------------------------------------

async function recomputeAllProjections(supabase) {
  const fightsWithOdds = await loadFightsWithOdds(supabase);
  if (fightsWithOdds.length === 0) {
    console.log('  No upcoming fights have odds — nothing to project.');
    return { upserted: 0 };
  }

  // Collect every unique fighter + division we need data for
  const fighterIds = Array.from(new Set(
    fightsWithOdds.flatMap(r => [r.fight.fighter_a_id, r.fight.fighter_b_id])
  ));
  const divisions = Array.from(new Set(
    fightsWithOdds.map(r => r.fight.weight_class).filter(Boolean)
  ));

  const [fighterCtx, pastByFighter, divisionPerspectives] = await Promise.all([
    loadFighterContext(supabase, fighterIds),
    loadPastFightsByFighter(supabase, fighterIds),
    loadDivisionPerspectives(supabase, divisions)
  ]);

  const divisionAgg = {};
  for (const d of divisions) {
    divisionAgg[d] = Engine.computeDivisionAggregate(divisionPerspectives.get(d) || []);
  }

  // Build projection rows (two per fight — one per side)
  const rows = [];
  for (const oddsRow of fightsWithOdds) {
    const fight = oddsRow.fight;
    for (const isA of [true, false]) {
      const fighterId = isA ? fight.fighter_a_id : fight.fighter_b_id;
      const opp       = fighterCtx[isA ? fight.fighter_b_id : fight.fighter_a_id];
      if (!opp) continue;

      const pWin = Number(isA ? oddsRow.fighter_a_prob : oddsRow.fighter_b_prob);
      if (isNaN(pWin)) continue;

      const personal = Engine.computeFighterHistory(pastByFighter.get(fighterId) || [], fighterId);
      const divAgg   = divisionAgg[fight.weight_class] || Engine.computeDivisionAggregate([]);
      const blended  = Engine.blendWithDivision(personal, divAgg);

      const proj = Engine.projectFighter(
        blended, fight, opp.current_rank, pWin, 'polymarket', personal.fightCount, null
      );

      rows.push({
        fighter_id:       fighterId,
        fight_id:         fight.id,
        projected_points: proj.projected_points,
        base_pts:         proj.base_pts,
        win_bonus_pts:    proj.win_bonus_pts,
        rank_bonus_pts:   proj.rank_bonus_pts,
        title_bonus_pts:  proj.title_bonus_pts,
        multiplier:       proj.multiplier,
        p_win_used:       proj.p_win_used,
        p_win_source:     proj.p_win_source,
        fights_sampled:   proj.fights_sampled,
        computed_at:      new Date().toISOString()
      });
    }
  }

  if (rows.length === 0) {
    console.log('  No projection rows to write (no valid odds).');
    return { upserted: 0 };
  }

  // Upsert in batches — the unique (fighter_id, fight_id) constraint lets
  // us treat every run as an idempotent replace.
  const BATCH = 200;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('fighter_projections')
      .upsert(slice, { onConflict: 'fighter_id,fight_id' });
    if (error) {
      console.warn('  Projection upsert failed:', error.message);
    } else {
      upserted += slice.length;
    }
  }
  return { upserted };
}

module.exports = { recomputeAllProjections };

// Allow standalone execution: `node recomputeProjections.js` runs the same
// path the Polymarket script triggers. Useful for one-off backfills and
// for testing without re-fetching Polymarket.
if (require.main === module) {
  require('dotenv').config();
  const { createClient } = require('@supabase/supabase-js');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  recomputeAllProjections(sb).then(r => {
    console.log('Done. Upserted ' + r.upserted + ' projection rows.');
  }).catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
