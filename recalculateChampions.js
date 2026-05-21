// ============================================================================
// recalculateChampions.js
// Determines the current UFC champion (and interim/BMF holders) of each
// division by replaying actual title fight results in chronological order.
//
// Run modes:
//   node recalculateChampions.js                  apply ALL champion updates
//   node recalculateChampions.js --interim-only   apply ONLY interim/BMF
//                                                 (leaves is_champion alone —
//                                                 UFC.com handles those)
//   node recalculateChampions.js --dry-run         show changes without applying
//
// Why two modes:
//   UFC.com/rankings is the authoritative source for divisional champions
//   (set by applyRankings.js). But UFC.com doesn't list interim/BMF holders
//   separately. So in normal operation we want UFC.com to win for divisional
//   champs, but fight history to win for interim/BMF. The --interim-only
//   flag enforces this split, used by both the weekly and live workflows.
//
//   Full mode (no flag) is kept for one-off data fixes and the special case
//   where you trust fight history over UFC.com for everything.
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

const DRY_RUN       = process.argv.includes('--dry-run');
const INTERIM_ONLY  = process.argv.includes('--interim-only');

// All UFC main divisions. Catch-weight bouts, openweight, and Road to UFC
// tournament finals are NOT in this list — their winners do not become UFC champs.
const DIVISIONS = [
  'flyweight', 'bantamweight', 'featherweight', 'lightweight',
  'welterweight', 'middleweight', 'light_heavyweight', 'heavyweight',
  'strawweight', 'flyweight_w', 'bantamweight_w',
];

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  const modeLabel = DRY_RUN     ? 'DRY RUN — no DB writes'
                  : INTERIM_ONLY ? 'INTERIM-ONLY — will update is_sub_champion only'
                  :                'FULL — will update is_champion and is_sub_champion';
  console.log(modeLabel + '\n');

  // Load all fighters for division lookup
  console.log('Loading fighters...');
  const fightersById = {};
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('fighters')
      .select('id, name, primary_division, is_champion, is_sub_champion, sub_title_type, ufc_id')
      .range(from, from + 999);
    if (error) { console.error('DB error:', error.message); process.exit(1); }
    for (const f of data) fightersById[f.id] = f;
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`  Loaded ${Object.keys(fightersById).length} fighters.`);

  // Load all title fights from fight_results, OLDEST first so we can
  // replay championship state chronologically.
  //
  // We load ALL card positions here, then filter divisional fights to
  // main_event/co_main only — Road to UFC tournament finals get incorrectly
  // flagged as divisional title fights by the belt.png icon detection, but
  // they always appear as main-card or prelim fights, not as the headliner.
  //
  // BMF and interim title fights are kept regardless of card position. They're
  // rare enough that we trust the title_type detection, AND legitimate ones
  // sometimes appear lower on the card (e.g. Holloway vs Gaethje BMF at
  // UFC 300 was the 3rd fight from the top, not the main event).
  console.log('\nLoading title fights...');
  const { data: rawTitleFights, error: tfError } = await supabase
    .from('fight_results')
    .select(`
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
    .not('winner_id', 'is', null)
    .order('event(event_date)', { ascending: true });

  // Filter divisional title fights to main_event/co_main only.
  const titleFights = (rawTitleFights || []).filter(f => {
    if (f.title_type === 'divisional') {
      return f.card_position === 'main_event' || f.card_position === 'co_main';
    }
    return true;  // BMF / interim allowed at any position
  });

  if (tfError) { console.error('DB error:', tfError.message); process.exit(1); }
  console.log(`  Loaded ${titleFights.length} completed title fights.`);

  // Replay title fights chronologically, tracking who holds each belt.
  // We can't always trust either fighter's primary_division — a champion who
  // moved up to challenge another belt (e.g. Makhachev moving from lightweight
  // to welterweight) still has their old division stored. Instead we determine
  // the fight's division by:
  //   1. Both fighters share a primary_division → use it
  //   2. One of them is the current champion of some division → that's the belt
  //   3. The loser is the more established fighter — fall back to their division
  const newChamps  = {};     // division → fighter id (divisional champ)
  const newInterim = {};     // division → fighter id (interim champ)
  const newBmf     = {};     // division → fighter id (BMF champ)

  function divisionOfFight(a, b, winnerId) {
    if (a.primary_division === b.primary_division) return a.primary_division;

    // Is either fighter currently the divisional champ somewhere?
    for (const div of Object.keys(newChamps)) {
      if (newChamps[div] === a.id || newChamps[div] === b.id) return div;
    }

    // Last resort: loser's division (the loser is usually the established
    // champion of the belt being contested, or the home-division fighter)
    const loserId = winnerId === a.id ? b.id : a.id;
    const loser = fightersById[loserId];
    return loser ? loser.primary_division : null;
  }

  for (const fight of titleFights) {
    const winner = fightersById[fight.winner_id];
    const a      = fightersById[fight.fighter_a_id];
    const b      = fightersById[fight.fighter_b_id];
    if (!winner || !a || !b) continue;

    const division = divisionOfFight(a, b, fight.winner_id);
    if (!division || !DIVISIONS.includes(division)) continue;

    // Update the appropriate belt slot
    if (fight.title_type === 'divisional') {
      newChamps[division] = winner.id;
      // A divisional title fight resolves any interim title in this division:
      //   - If the interim holder wins, the interim merges into divisional
      //   - If they lose, the interim is vacated
      // Either way, no one holds interim after this point.
      delete newInterim[division];
    } else if (fight.title_type === 'interim') {
      newInterim[division] = winner.id;
    } else if (fight.title_type === 'bmf') {
      newBmf[division] = winner.id;
    }
  }

  // ----------------- Report findings -----------------
  console.log('\n============================================================');
  console.log('DIVISIONAL CHAMPIONS (from fight history)');
  console.log('============================================================');
  const updates = [];   // [{ id, before, after }]
  const clears  = [];   // fighter ids who need is_champion flipped to false

  for (const division of DIVISIONS) {
    const newChampId = newChamps[division];
    if (!newChampId) {
      console.log(`  ${division.padEnd(20)} (no title fight found)`);
      continue;
    }
    const newChamp = fightersById[newChampId];
    const currentChampInDb = Object.values(fightersById).find(f =>
      f.primary_division === division && f.is_champion
    );

    const statusMark = currentChampInDb && currentChampInDb.id === newChampId ? '✓ unchanged' :
                       currentChampInDb ? `✗ CHANGE: was ${currentChampInDb.name}` :
                       '+ NEW champ';
    console.log(`  ${division.padEnd(20)} ${newChamp.name.padEnd(28)} ${statusMark}`);

    if (!currentChampInDb || currentChampInDb.id !== newChampId) {
      updates.push({ id: newChampId, makeChamp: true });
      if (currentChampInDb) clears.push(currentChampInDb.id);
    }
  }

  // Also clear any other fighter currently flagged is_champion who is NOT
  // the new champ of their division (safety: handles cases where the API or
  // a previous run set is_champion incorrectly).
  Object.values(fightersById).forEach(f => {
    if (f.is_champion) {
      const correctChamp = newChamps[f.primary_division];
      if (correctChamp !== f.id && !clears.includes(f.id)) {
        clears.push(f.id);
      }
    }
  });

  // Interim and BMF reporting
  if (Object.keys(newInterim).length > 0 || Object.values(fightersById).some(f => f.is_sub_champion)) {
    console.log('\nINTERIM / BMF holders');
    for (const division of DIVISIONS) {
      if (newInterim[division]) {
        const f = fightersById[newInterim[division]];
        console.log(`  [INTERIM] ${division.padEnd(20)} ${f.name}`);
      }
      if (newBmf[division]) {
        const f = fightersById[newBmf[division]];
        console.log(`  [BMF]     ${division.padEnd(20)} ${f.name}`);
      }
    }
  }

  console.log('\n============================================================');
  console.log(`Summary: ${updates.length} new champs, ${clears.length} demotions`);
  console.log('============================================================');

  if (DRY_RUN) {
    console.log('\n(dry run — no changes applied)');
    return;
  }

  // ----------------- Apply updates -----------------
  console.log('\nApplying updates...');
  let written = 0;

  if (!INTERIM_ONLY) {
    // First, demote everyone who shouldn't be champion. Also re-rank them as
    // #1 in their division — the Octagon API typically omits a fighter from
    // contender rankings while they're listed as champion in the API, so when
    // we demote them they end up with current_rank=null. Slot them at #1
    // since they're the deposed champion / top contender for the rematch.
    for (const id of clears) {
      const fighter = fightersById[id];
      const update = { is_champion: false };
      if (fighter && fighter.current_rank == null) {
        update.current_rank = 1;
      }
      const { error } = await supabase
        .from('fighters')
        .update(update)
        .eq('id', id);
      if (error) console.warn(`  Error demoting ${id}: ${error.message}`);
      else written++;
    }

    // Then promote the new champs
    for (const { id } of updates) {
      const { error } = await supabase
        .from('fighters')
        .update({
          is_champion:    true,
          current_rank:   null,    // champions have no numeric rank
        })
        .eq('id', id);
      if (error) console.warn(`  Error promoting ${id}: ${error.message}`);
      else written++;
    }
  } else {
    console.log('  (--interim-only: skipping divisional champion updates)');
  }

  // Clear is_sub_champion (interim/BMF) for anyone whose interim title
  // was unified or vacated. Also set is_sub_champion=true for current holders.
  console.log('\nUpdating interim/BMF holders...');
  const allCurrentInterim = new Set([
    ...Object.values(newInterim),
    ...Object.values(newBmf),
  ]);
  // Clear stale sub-champion flags
  for (const f of Object.values(fightersById)) {
    if (f.is_sub_champion && !allCurrentInterim.has(f.id)) {
      const { error } = await supabase
        .from('fighters')
        .update({ is_sub_champion: false, sub_title_type: 'none' })
        .eq('id', f.id);
      if (error) console.warn(`  Error clearing interim ${f.id}: ${error.message}`);
      else { written++; console.log(`  Cleared interim/BMF for ${f.name}`); }
    }
  }
  // Set current interim holders. Skip if the fighter is currently the
  // divisional champion (per UFC.com) — they can't be both, and UFC.com wins
  // in that case (e.g., interim holder gets promoted to undisputed when the
  // divisional champ retires without a fight, like Aspinall).
  for (const [division, id] of Object.entries(newInterim)) {
    const f = fightersById[id];
    if (f && f.is_champion) {
      console.log(`  Skipping interim for ${f.name} (already divisional champion)`);
      continue;
    }
    const { error } = await supabase
      .from('fighters')
      .update({ is_sub_champion: true, sub_title_type: 'interim' })
      .eq('id', id);
    if (error) console.warn(`  Error setting interim ${id}: ${error.message}`);
    else written++;
  }
  for (const [division, id] of Object.entries(newBmf)) {
    const f = fightersById[id];
    if (f && f.is_champion) {
      console.log(`  Skipping BMF for ${f.name} (already divisional champion)`);
      continue;
    }
    const { error } = await supabase
      .from('fighters')
      .update({ is_sub_champion: true, sub_title_type: 'bmf' })
      .eq('id', id);
    if (error) console.warn(`  Error setting BMF ${id}: ${error.message}`);
    else written++;
  }

  console.log(`Done. ${written} fighter rows updated.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
