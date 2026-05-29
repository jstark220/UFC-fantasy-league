// ============================================================================
// projectionSanityCheck.js
// Reads upcoming fights from the DB, runs the projection engine, and prints
// the breakdowns. Does NOT write to fighter_projections — this is meant for
// human eyeball review before we commit to the algorithm.
//
// Usage: node projectionSanityCheck.js
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const Engine = require('./projectionEngine.js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// --- DB helpers ------------------------------------------------------------

async function loadUpcomingFights() {
  const todayISO = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('fight_results')
    .select(`
      id, fighter_a_id, fighter_b_id, weight_class, card_position,
      title_type, is_title_defense,
      fighter_a_opponent_rank, fighter_b_opponent_rank,
      event:ufc_events!inner(id, name, event_date)
    `)
    .gte('event.event_date', todayISO)
    .is('outcome', null)
    .order('id', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function loadOdds(fightIds) {
  if (fightIds.length === 0) return {};
  const { data, error } = await supabase
    .from('fight_odds')
    .select('fight_id, fighter_a_prob, fighter_b_prob')
    .in('fight_id', fightIds);
  if (error) throw error;
  const map = {};
  for (const row of (data || [])) map[row.fight_id] = row;
  return map;
}

async function loadFighters(fighterIds) {
  if (fighterIds.length === 0) return {};
  const map = {};
  // Paginate (some events have lots of fighters, but typically <50)
  const { data, error } = await supabase
    .from('fighters')
    .select('id, name, primary_division, current_rank, is_champion, is_sub_champion')
    .in('id', fighterIds);
  if (error) throw error;
  for (const f of (data || [])) map[f.id] = f;
  return map;
}

// Load all completed fights for a set of fighters. Two paginated queries —
// one filtering by fighter_a_id, one by fighter_b_id — then merged. Avoids
// the huge URL length you get with .or() on many UUIDs.
async function loadPastFightsByFighter(fighterIds) {
  if (fighterIds.length === 0) return new Map();
  const result = new Map();
  for (const id of fighterIds) result.set(id, []);
  const seen = new Set();  // dedupe: fights where both sides are in fighterIds

  const SELECT_COLS = `
    id, fighter_a_id, fighter_b_id, winner_id, outcome,
    end_round, end_time_seconds, card_position, title_type, is_title_defense,
    fighter_a_sig_strikes, fighter_a_takedowns, fighter_a_knockdowns, fighter_a_control_seconds,
    fighter_b_sig_strikes, fighter_b_takedowns, fighter_b_knockdowns, fighter_b_control_seconds,
    fighter_a_opponent_rank, fighter_b_opponent_rank,
    weight_class,
    event:ufc_events(id, event_date)
  `;

  async function fetchSide(column) {
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from('fight_results')
        .select(SELECT_COLS)
        .in(column, fighterIds)
        .not('outcome', 'is', null)
        .range(from, from + PAGE - 1);
      if (error) throw error;
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

// Load every completed fight in a set of divisions to compute division
// aggregates. Returns Map<weight_class, array of {fight, fighterId}>.
async function loadDivisionPerspectives(divisions) {
  const result = new Map();
  for (const d of divisions) result.set(d, []);
  if (divisions.length === 0) return result;

  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('fight_results')
      .select(`
        id, fighter_a_id, fighter_b_id, winner_id, outcome,
        end_round, end_time_seconds, card_position, title_type, is_title_defense,
        fighter_a_sig_strikes, fighter_a_takedowns, fighter_a_knockdowns, fighter_a_control_seconds,
        fighter_b_sig_strikes, fighter_b_takedowns, fighter_b_knockdowns, fighter_b_control_seconds,
        fighter_a_opponent_rank, fighter_b_opponent_rank,
        weight_class
      `)
      .in('weight_class', divisions)
      .not('outcome', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw error;
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

// --- Main ------------------------------------------------------------------

async function main() {
  console.log('Loading upcoming fights...');
  const upcoming = await loadUpcomingFights();
  console.log('  ' + upcoming.length + ' upcoming fights\n');

  if (upcoming.length === 0) {
    console.log('Nothing to project.');
    return;
  }

  // Collect IDs
  const fighterIds = Array.from(new Set(
    upcoming.flatMap(f => [f.fighter_a_id, f.fighter_b_id])
  ));
  const fightIds   = upcoming.map(f => f.id);
  const divisions  = Array.from(new Set(upcoming.map(f => f.weight_class).filter(Boolean)));

  console.log('Loading odds, fighter rows, history, and division priors...');
  const [odds, fighters, pastByFighter, divisionPerspectives] = await Promise.all([
    loadOdds(fightIds),
    loadFighters(fighterIds),
    loadPastFightsByFighter(fighterIds),
    loadDivisionPerspectives(divisions)
  ]);

  // Compute division aggregates once
  const divisionAgg = {};
  for (const d of divisions) {
    divisionAgg[d] = Engine.computeDivisionAggregate(divisionPerspectives.get(d) || []);
  }

  // Group upcoming by event date so the output reads naturally
  upcoming.sort((a, b) => {
    if (a.event.event_date !== b.event.event_date) return a.event.event_date < b.event.event_date ? -1 : 1;
    // Within event: main_event last so the most interesting row prints last
    const order = { main_card: 0, co_main: 1, main_event: 2 };
    return (order[a.card_position] || 0) - (order[b.card_position] || 0);
  });

  let lastEvent = '';
  for (const fight of upcoming) {
    const eventLabel = fight.event.name + '  ·  ' + fight.event.event_date;
    if (eventLabel !== lastEvent) {
      console.log('\n============================================================');
      console.log(eventLabel);
      console.log('============================================================');
      lastEvent = eventLabel;
    }

    const a = fighters[fight.fighter_a_id];
    const b = fighters[fight.fighter_b_id];
    if (!a || !b) continue;

    const oddsRow = odds[fight.id] || null;

    // Build (and print) the projection for both fighters
    const cardLabel = (fight.card_position === 'main_event') ? ' [MAIN EVENT ×1.2]'
                   : (fight.card_position === 'co_main')     ? ' [CO-MAIN ×1.1]'
                   : '';
    console.log('\n  ' + a.name + ' vs ' + b.name + cardLabel);

    for (const fighterId of [fight.fighter_a_id, fight.fighter_b_id]) {
      const me        = fighters[fighterId];
      const opp       = fighterId === fight.fighter_a_id ? b : a;
      const myIsA     = fighterId === fight.fighter_a_id;
      const oppRank   = opp.current_rank;
      const division  = fight.weight_class;

      // P(win)
      let pWin, pWinSource;
      if (oddsRow && oddsRow.fighter_a_prob != null) {
        pWin       = myIsA ? Number(oddsRow.fighter_a_prob) : Number(oddsRow.fighter_b_prob);
        pWinSource = 'polymarket';
      } else {
        pWin       = Engine.heuristicPWin(me.current_rank, opp.current_rank, me.is_champion, opp.is_champion);
        pWinSource = 'rank_heuristic';
      }

      // History → blended
      const past     = pastByFighter.get(fighterId) || [];
      const personal = Engine.computeFighterHistory(past, fighterId);
      const divAgg   = divisionAgg[division] || Engine.computeDivisionAggregate([]);
      const blended  = Engine.blendWithDivision(personal, divAgg);

      const proj = Engine.projectFighter(
        blended, fight, oppRank, pWin, pWinSource, personal.fightCount, null
      );

      console.log('    ' + me.name.padEnd(28) +
                  ' proj=' + proj.projected_points.toFixed(1).padStart(5) +
                  '  (base=' + proj.base_pts.toFixed(1) +
                  ' + win=' + proj.win_bonus_pts.toFixed(1) +
                  ' + matchup=' + proj.rank_bonus_pts.toFixed(1) +
                  ') ×' + proj.multiplier +
                  '  P(win)=' + (proj.p_win_used * 100).toFixed(0) + '% [' + proj.p_win_source + ']' +
                  '  n=' + personal.fightCount);
    }
  }
  console.log('\n');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
