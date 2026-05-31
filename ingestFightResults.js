// ============================================================================
// ingestFightResults.js
// Ingests fight results + per-fighter stats from ESPN's MMA API into
// fight_results. (Was ufcstats.com, now bot-walled — see espnClient.js.)
//
// ESPN exposes the same stats ufcstats did (sig strikes / takedowns /
// knockdowns / control time — verified identical), plus method, finishing
// round/time, bout order (matchNumber), weight class, and title status.
//
// DUPLICATE-SAFETY (the historical pain point):
//   * Fighters are resolved by espn_athlete_id, then by normalized name, and
//     only CREATED if genuinely new — the matched/created id is persisted to
//     fighters.espn_athlete_id so later runs join exactly (never re-fuzzy).
//   * Fights are reconciled against existing rows by espn_competition_id, then
//     by event_id + a shared fighter — so re-ingesting an event (or an
//     upcoming card whose rows were seeded earlier from ufcstats) UPDATES the
//     existing row instead of inserting a duplicate. This also repairs stale
//     matchups and fills fight_order on cards seeded before ESPN.
//
// Go-forward only: historical ufcstats-sourced rows are left as-is. We process
// events that have an espn_event_id (set by ingestEvents.js) within a window.
//
// Run:
//   node ingestFightResults.js                  recent + upcoming espn-linked events
//   node ingestFightResults.js <espn_event_id>  one event by ESPN id
//   node ingestFightResults.js --dry-run         show the plan, write nothing
//   node ingestFightResults.js --back=45         how many days back to include (default 21)
// ============================================================================

require('dotenv').config();
const espn = require('./espnClient');
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env file');
  process.exit(1);
}
const supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Run options. Defaults here; the CLI block at the bottom fills them from argv
// when run directly, and runIngest(opts) overrides them when imported (the
// Vercel cron function calls runIngest({ back: 2 })).
let DRY_RUN = false;
let DAYS_BACK = 21;
let singleEspnId = null;

function normalizeName(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ----------------------------------------------------------------------------
// FIGHTER RESOLUTION (espn_athlete_id -> name -> create-if-new)
// ----------------------------------------------------------------------------
const byEspnId = new Map();   // espn_athlete_id -> fighter row
const byName = new Map();      // normalizeName(name) -> fighter row
const byId = new Map();        // fighter id -> fighter row (for division fallback)
const byLastFirst = new Map(); // "lastname|firstInitial" -> fighter row OR 'AMBIGUOUS'
const pendingIdWrites = [];    // { id, espn_athlete_id } to persist after matching
let createdCount = 0;

// Key for the spelling-variant fallback: last token + first initial. Catches
// "Bernardo Sopaj" vs the DB's misspelled "Benardo Sopaj". Only trusted when
// it's unique in the roster (collisions are marked AMBIGUOUS and not used).
function lastFirstKey(name) {
  const parts = normalizeName(name).split(' ').filter(Boolean);
  if (parts.length < 2) return null;
  return parts[parts.length - 1] + '|' + parts[0][0];
}

async function loadFighters() {
  let from = 0; const PAGE = 1000;
  while (true) {
    const res = await supabaseClient
      .from('fighters')
      // current_rank feeds fighter_*_opponent_rank below, which the scoring
      // engine turns into the top-5/10/15 "beat a ranked opponent" bonus.
      .select('id, name, espn_athlete_id, ufc_id, primary_division, current_rank')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (res.error || !res.data) break;
    res.data.forEach((f) => {
      byId.set(f.id, f);
      if (f.espn_athlete_id) byEspnId.set(f.espn_athlete_id, f);
      const n = normalizeName(f.name);
      if (n && !byName.has(n)) byName.set(n, f);
      const k = lastFirstKey(f.name);
      if (k) byLastFirst.set(k, byLastFirst.has(k) ? 'AMBIGUOUS' : f);
    });
    if (res.data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`Loaded ${byName.size} fighters (${byEspnId.size} already espn-linked).`);
}

// ESPN seeds unannounced future bouts with placeholder athletes ("TBA",
// "Opponent TBA"). Never treat those as real fighters.
function isPlaceholderName(name) {
  return !name || !name.trim() || /\btba\b/i.test(name) || /opponent\s+tba/i.test(name);
}

// Returns the DB fighter id for an ESPN competitor, creating a row only when
// the athlete matches nothing we have. Returns null for placeholders, dry-run
// new fighters, or when we can't determine a division to create with.
async function resolveFighter(competitor, weightClass) {
  if (!competitor || !competitor.name) return null;
  if (isPlaceholderName(competitor.name)) return null; // bout not finalized yet
  if (competitor.espnAthleteId && byEspnId.has(competitor.espnAthleteId)) {
    return byEspnId.get(competitor.espnAthleteId).id;
  }
  const norm = normalizeName(competitor.name);
  // Exact normalized name, then the unambiguous lastname+initial fallback.
  let m = byName.get(norm);
  if (!m) {
    const k = lastFirstKey(competitor.name);
    const cand = k ? byLastFirst.get(k) : null;
    if (cand && cand !== 'AMBIGUOUS') {
      m = cand;
      console.log(`   ~ matched "${competitor.name}" -> existing "${m.name}" (spelling variant)`);
    }
  }
  if (m) {
    // Persist the espn id onto the existing fighter for exact future joins.
    if (competitor.espnAthleteId && !m.espn_athlete_id) {
      m.espn_athlete_id = competitor.espnAthleteId;
      byEspnId.set(competitor.espnAthleteId, m);
      byName.set(norm, m);
      pendingIdWrites.push({ id: m.id, espn_athlete_id: competitor.espnAthleteId });
    }
    return m.id;
  }
  // Genuinely new fighter (not in our Octagon-sourced roster yet). fighters
  // requires a primary_division (NOT NULL); use the bout's weight class. If we
  // can't determine one (catchweight), skip rather than guess a division.
  if (!weightClass) {
    console.log(`   ? unmatched, no division to create from: ${competitor.name}`);
    return null;
  }
  createdCount++;
  console.log(`   + NEW fighter: ${competitor.name} (espn ${competitor.espnAthleteId}, ${competitor.flag || '?'}, ${weightClass})`);
  if (DRY_RUN) return null;
  const row = {
    ufc_id: 'espn-' + competitor.espnAthleteId,
    espn_athlete_id: competitor.espnAthleteId,
    name: competitor.name,
    country: competitor.flag || null,
    is_active: true,
    primary_division: weightClass,
  };
  const res = await supabaseClient.from('fighters').insert(row).select('id').single();
  if (res.error) { console.log('     create failed: ' + res.error.message); return null; }
  const created = { id: res.data.id, name: competitor.name, espn_athlete_id: competitor.espnAthleteId, primary_division: weightClass };
  byEspnId.set(competitor.espnAthleteId, created);
  byName.set(norm, created);
  byId.set(res.data.id, created);
  return res.data.id;
}

async function persistPendingIds() {
  if (DRY_RUN || pendingIdWrites.length === 0) return;
  for (const w of pendingIdWrites) {
    await supabaseClient.from('fighters').update({ espn_athlete_id: w.espn_athlete_id }).eq('id', w.id);
  }
  console.log(`Linked ${pendingIdWrites.length} existing fighters to their ESPN id.`);
}

// ----------------------------------------------------------------------------
// PROCESS ONE EVENT
// ----------------------------------------------------------------------------
async function processEvent(dbEvent) {
  console.log(`\nProcessing: ${dbEvent.full_name || dbEvent.name} (espn ${dbEvent.espn_event_id})`);
  const data = await espn.fetchEventFights(dbEvent.espn_event_id);
  if (!data || !data.fights.length) { console.log('  No fights from ESPN. Skipping.'); return; }

  // Existing rows for this event, to reconcile against (avoid duplicates).
  const ex = await supabaseClient
    .from('fight_results')
    .select('id, fighter_a_id, fighter_b_id, espn_competition_id, fighter_a_opponent_rank, fighter_b_opponent_rank')
    .eq('event_id', dbEvent.id);
  const existing = ex.data || [];

  let upd = 0, ins = 0;
  for (const f of data.fights) {
    const aId = await resolveFighter(f.competitors[0], f.weightClass);
    const bId = await resolveFighter(f.competitors[1], f.weightClass);
    if (!aId || !bId) { console.log(`  ! could not resolve both fighters for bout ${f.matchNumber}; skipping`); continue; }
    const winner = f.competitors.find((c) => c.isWinner);
    const winnerId = winner ? (winner === f.competitors[0] ? aId : bId) : null;

    // weight_class is NOT NULL. ESPN returns null for catch-weight bouts, so
    // fall back to a fighter's home division rather than dropping the bout.
    const weightClass = f.weightClass
      || (byId.get(aId) && byId.get(aId).primary_division)
      || (byId.get(bId) && byId.get(bId).primary_division)
      || null;

    // Opponent rank for the scoring engine's "beat a ranked fighter" bonus.
    // A's opponent is B and vice-versa, so each side stores the OTHER fighter's
    // current divisional rank (null = unranked/champion; the scorer infers the
    // champion case from title context). Captured here at ingest time and then
    // frozen on later runs (see the UPDATE path) so scores never drift when
    // rankings shift after the fight.
    const aRank = (byId.get(aId) && byId.get(aId).current_rank != null) ? byId.get(aId).current_rank : null;
    const bRank = (byId.get(bId) && byId.get(bId).current_rank != null) ? byId.get(bId).current_rank : null;

    const payload = {
      event_id: dbEvent.id,
      espn_competition_id: f.espnCompetitionId,
      fighter_a_id: aId,
      fighter_b_id: bId,
      winner_id: winnerId,
      outcome: f.method,
      end_round: f.endRound,
      end_time_seconds: f.endTimeSeconds,
      card_position: f.cardPosition,
      fight_order: f.fightOrder,
      weight_class: weightClass,
      title_type: f.titleType,
      fighter_a_opponent_rank: bRank,
      fighter_b_opponent_rank: aRank,
      fighter_a_sig_strikes: f.competitors[0].sigStrikes,
      fighter_a_takedowns: f.competitors[0].takedowns,
      fighter_a_knockdowns: f.competitors[0].knockdowns,
      fighter_a_control_seconds: f.competitors[0].controlSeconds,
      fighter_b_sig_strikes: f.competitors[1].sigStrikes,
      fighter_b_takedowns: f.competitors[1].takedowns,
      fighter_b_knockdowns: f.competitors[1].knockdowns,
      fighter_b_control_seconds: f.competitors[1].controlSeconds,
    };

    // Reconcile: existing by espn_competition_id, else by shared fighter.
    const match = existing.find((r) => r.espn_competition_id === f.espnCompetitionId)
      || existing.find((r) => [r.fighter_a_id, r.fighter_b_id].includes(aId)
        || [r.fighter_a_id, r.fighter_b_id].includes(bId));

    const label = `${f.fightOrder}. ${f.competitors[0].name} vs ${f.competitors[1].name}` +
      ` [${f.cardPosition}${f.titleType !== 'none' ? '/' + f.titleType : ''}]` +
      (f.completed ? ` ${f.method} R${f.endRound}` : ' (scheduled)');

    if (match) {
      // Never overwrite an existing row's weight_class with null.
      if (payload.weight_class == null) delete payload.weight_class;
      // Freeze opponent rank at first capture: only fill it when the existing
      // row hasn't got one yet. Preserves both fight-night ranks and any value
      // the commissioner set by hand, and stops re-ingests from drifting scores.
      if (match.fighter_a_opponent_rank != null) delete payload.fighter_a_opponent_rank;
      if (match.fighter_b_opponent_rank != null) delete payload.fighter_b_opponent_rank;
      upd++;
      console.log(`  UPDATE ${label}`);
      if (!DRY_RUN) {
        const r = await supabaseClient.from('fight_results').update(payload).eq('id', match.id);
        if (r.error) console.log('     write failed: ' + r.error.message);
      }
    } else {
      if (payload.weight_class == null) { console.log(`  ! skip INSERT (no weight class): ${label}`); continue; }
      ins++;
      console.log(`  INSERT ${label}`);
      if (!DRY_RUN) {
        const r = await supabaseClient.from('fight_results').insert(payload);
        if (r.error) console.log('     insert failed: ' + r.error.message);
      }
    }
  }
  console.log(`  -> ${upd} updated, ${ins} inserted`);
}

// ----------------------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------------------
async function runIngest(opts = {}) {
  // Apply caller options (CLI passes none and uses the argv-set module vars;
  // the Vercel function passes { back } / { singleEspnId }).
  if (opts.back != null)         DAYS_BACK = opts.back;
  if (opts.singleEspnId != null) singleEspnId = opts.singleEspnId;
  if (opts.dryRun != null)       DRY_RUN = !!opts.dryRun;

  // Reset module-level state. Serverless containers reuse the loaded module
  // across invocations, so stale fighter maps / counters would leak between
  // runs without this.
  byEspnId.clear(); byName.clear(); byId.clear(); byLastFirst.clear();
  pendingIdWrites.length = 0;
  createdCount = 0;

  console.log(`ingestFightResults (ESPN)${DRY_RUN ? ' [DRY RUN]' : ''}\n`);
  await loadFighters();

  let events;
  if (singleEspnId) {
    const r = await supabaseClient.from('ufc_events')
      .select('id, name, full_name, espn_event_id').eq('espn_event_id', singleEspnId);
    events = r.data || [];
    if (!events.length) throw new Error('No ufc_events row with espn_event_id ' + singleEspnId + ' (run ingestEvents.js first).');
  } else {
    const cutoff = new Date(Date.now() - DAYS_BACK * 86400000).toISOString().slice(0, 10);
    const r = await supabaseClient.from('ufc_events')
      .select('id, name, full_name, espn_event_id, event_date')
      .not('espn_event_id', 'is', null)
      .gte('event_date', cutoff)
      .order('event_date', { ascending: true });
    if (r.error) throw new Error('Failed to load events: ' + r.error.message);
    events = r.data || [];
  }
  console.log(`Events to process: ${events.length}`);

  for (const ev of events) await processEvent(ev);
  await persistPendingIds();

  console.log(`\nDone.${createdCount ? ' Created ' + createdCount + ' new fighters.' : ''}`);
  if (DRY_RUN) console.log('(dry run - nothing written)');
  return { eventsProcessed: events.length, createdFighters: createdCount };
}

module.exports = { runIngest };

// CLI entry — only when run directly (node ingestFightResults.js ...), not when
// imported by the Vercel cron function.
if (require.main === module) {
  DRY_RUN = process.argv.includes('--dry-run');
  const backArg = process.argv.find((a) => a.startsWith('--back='));
  if (backArg) DAYS_BACK = parseInt(backArg.split('=')[1], 10);
  singleEspnId = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;
  runIngest().catch((err) => { console.error('Fatal error:', err); process.exit(1); });
}
