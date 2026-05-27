// ============================================================================
// backfillTitleDefenses.js
//
// Retroactively corrects is_title_defense on every title fight in
// fight_results by walking them in chronological order and tracking
// who held each belt over time. The per-fight in-script detection in
// ingestFightResults.js reads champion state at script-run time, so
// historical backfills there can be wrong. This script is point-in-
// time accurate because it replays the belt state from scratch.
//
// Mirrors the belt-tracking logic in recalculateChampions.js (same
// chronological replay, same divisional/interim/bmf state machine,
// same divisionOfFight resolver) so the two scripts agree on belt
// ownership at every point in history.
//
// Usage:
//   node backfillTitleDefenses.js              dry run — print proposed changes
//   node backfillTitleDefenses.js --apply      write the corrections to DB
//
// Safe to run repeatedly — only writes rows whose is_title_defense
// value actually differs from the recomputed truth.
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const APPLY = process.argv.includes('--apply');

// All UFC main divisions. Catch-weight bouts, openweight, and Road to UFC
// tournament finals are NOT in this list — their winners do not hold UFC titles.
const DIVISIONS = [
  'flyweight', 'bantamweight', 'featherweight', 'lightweight',
  'welterweight', 'middleweight', 'light_heavyweight', 'heavyweight',
  'strawweight', 'flyweight_w', 'bantamweight_w',
];

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log(APPLY ? 'APPLY MODE — will write corrections to DB\n'
                    : 'DRY RUN — no DB writes (pass --apply to commit)\n');

  // ---- Load fighters so we can look up primary_division per id ----
  console.log('Loading fighters...');
  const fightersById = {};
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('fighters')
      .select('id, name, primary_division')
      .range(from, from + 999);
    if (error) { console.error('DB error:', error.message); process.exit(1); }
    for (const f of data) fightersById[f.id] = f;
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`  Loaded ${Object.keys(fightersById).length} fighters.`);

  // ---- Load all title fights chronologically ----
  // We need title_type !== 'none' (to know it's a title fight) and we sort
  // by event_date ascending so the belt state evolves correctly as we walk.
  console.log('\nLoading title fights...');
  const { data: rawTitleFights, error: tfError } = await supabase
    .from('fight_results')
    .select(`
      id,
      title_type,
      outcome,
      winner_id,
      fighter_a_id,
      fighter_b_id,
      is_title_defense,
      card_position,
      event:ufc_events(event_date, name)
    `)
    .neq('title_type', 'none')
    .order('event(event_date)', { ascending: true });

  if (tfError) { console.error('DB error:', tfError.message); process.exit(1); }

  // Filter divisional title fights to main_event/co_main only — same rule
  // as recalculateChampions.js, since Road to UFC tournament finals can be
  // mis-flagged as divisional title fights by the belt-icon detector but
  // always appear lower on the card.
  const titleFights = (rawTitleFights || []).filter(f => {
    if (f.title_type === 'divisional') {
      return f.card_position === 'main_event' || f.card_position === 'co_main';
    }
    return true;  // bmf / interim allowed anywhere on the card
  });
  console.log(`  Loaded ${titleFights.length} title fights to replay.`);

  // ---- Replay belt state in chronological order ----
  // Champion at each point in time, keyed by division. Updated AFTER each
  // title fight is processed (so the fight itself looks up the holder
  // BEFORE its own outcome is applied).
  const champ   = {}; // division -> fighter id (divisional)
  const interim = {}; // division -> fighter id (interim)
  const bmf     = {}; // division -> fighter id (BMF)

  // Same fight-division resolver as recalculateChampions.js.
  function divisionOfFight(a, b, winnerId) {
    if (a.primary_division === b.primary_division) return a.primary_division;
    for (const div of Object.keys(champ)) {
      if (champ[div] === a.id || champ[div] === b.id) return div;
    }
    const loserId = winnerId === a.id ? b.id : a.id;
    const loser = fightersById[loserId];
    return loser ? loser.primary_division : null;
  }

  const updates = []; // { id, oldValue, newValue, desc, defenseHolder, division }
  const skipped = []; // diagnostic — title fights we couldn't resolve

  for (const fight of titleFights) {
    const winner = fightersById[fight.winner_id];
    const a      = fightersById[fight.fighter_a_id];
    const b      = fightersById[fight.fighter_b_id];

    // Skip if any fighter is missing from the DB (rare — usually means a
    // newly-discovered fighter that the event scraper hasn't auto-created
    // yet). Or if there's no decisive winner (draw / NC).
    if (!winner || !a || !b) {
      skipped.push({ fight, reason: !winner ? 'no winner' : 'fighter missing' });
      continue;
    }

    const division = divisionOfFight(a, b, fight.winner_id);
    if (!division || !DIVISIONS.includes(division)) {
      skipped.push({ fight, reason: 'unresolved division: ' + (division || 'null') });
      continue;
    }

    // Look up who held the matching belt going in (pre-fight state).
    let preFightHolder = null;
    if (fight.title_type === 'divisional') preFightHolder = champ[division];
    else if (fight.title_type === 'interim') preFightHolder = interim[division];
    else if (fight.title_type === 'bmf')     preFightHolder = bmf[division];

    // Defense = winner held the matching belt going into the fight.
    const correctIsDefense = preFightHolder === fight.winner_id;

    if (fight.is_title_defense !== correctIsDefense) {
      const holderName = preFightHolder && fightersById[preFightHolder]
        ? fightersById[preFightHolder].name
        : '(vacant)';
      updates.push({
        id: fight.id,
        oldValue: fight.is_title_defense,
        newValue: correctIsDefense,
        desc: `${fight.event?.event_date || '????-??-??'}  ${fight.event?.name || 'unknown event'}  [${fight.title_type}/${division}]  winner=${winner.name}  pre-fight holder=${holderName}`
      });
    }

    // Apply this fight's outcome to belt state for future fights.
    if (fight.title_type === 'divisional') {
      champ[division] = fight.winner_id;
      // A divisional title fight unifies/vacates the interim in this division.
      delete interim[division];
    } else if (fight.title_type === 'interim') {
      interim[division] = fight.winner_id;
    } else if (fight.title_type === 'bmf') {
      bmf[division] = fight.winner_id;
    }
  }

  // ---- Report ----
  console.log('\n============================================================');
  console.log(`PROPOSED CORRECTIONS — ${updates.length} fights`);
  console.log('============================================================');
  if (updates.length === 0) {
    console.log('Everything is already correct. No updates needed.');
  } else {
    for (const u of updates) {
      const flip = `${String(u.oldValue).padStart(5)} -> ${String(u.newValue).padEnd(5)}`;
      console.log(`  ${flip}  ${u.desc}`);
    }
  }

  if (skipped.length > 0) {
    console.log(`\n${skipped.length} title fights skipped (unresolvable):`);
    for (const s of skipped.slice(0, 20)) {
      const fight = s.fight;
      console.log(`  [${s.reason}] ${fight.event?.event_date || '?'} ${fight.event?.name || '?'} (${fight.title_type})`);
    }
    if (skipped.length > 20) console.log(`  ...and ${skipped.length - 20} more`);
  }

  // ---- Apply (if requested) ----
  if (!APPLY) {
    console.log('\n(dry run — pass --apply to write these changes to fight_results)');
    return;
  }

  if (updates.length === 0) return;

  console.log('\nApplying updates...');
  let written = 0;
  for (const u of updates) {
    const { error } = await supabase
      .from('fight_results')
      .update({ is_title_defense: u.newValue })
      .eq('id', u.id);
    if (error) {
      console.warn(`  FAILED ${u.id}: ${error.message}`);
    } else {
      written++;
    }
  }
  console.log(`\nDone. ${written}/${updates.length} rows updated.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
