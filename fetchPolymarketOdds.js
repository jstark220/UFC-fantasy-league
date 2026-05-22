// ============================================================================
// fetchPolymarketOdds.js
// Pulls active UFC markets from Polymarket's public Gamma API, finds the
// "winner" market for each upcoming fight, and stores implied probabilities
// in the fight_odds table.
//
// Polymarket structure (verified 2026-05-22):
//   GET /events?tag_slug=ufc&active=true&closed=false
//     → list of UFC events (one per fight, weirdly — each fight is its own
//       "event" with nested prop markets inside).
//   Each event has a 'markets' array. The winner market is identified by
//   its outcomes being the two fighter names (vs prop markets where the
//   outcomes are 'Yes'/'No' or 'Over'/'Under').
//
// Matching to our DB:
//   Fighter names are matched case-insensitive after stripping accents and
//   punctuation. Polymarket uses the same display names as the UFC, so this
//   is reliable for current fighters. New fighters not yet in our DB are
//   logged and skipped (they'll match on the next run after ingestFighters).
//
// Usage: node fetchPolymarketOdds.js
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { recomputeAllProjections } = require('./recomputeProjections.js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const POLYMARKET_BASE = 'https://gamma-api.polymarket.com';
const SOURCE = 'polymarket';

// ----- Helpers ---------------------------------------------------------------

// Match the normalization used by ingestFightResults so Polymarket names
// like "Sergei Pavlovich" cleanly hit our fighters table.
function normalizeName(s) {
  if (!s) return '';
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')      // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

// Public link to the market page on polymarket.com given a slug.
function marketUrlFromSlug(slug) {
  if (!slug) return null;
  return 'https://polymarket.com/event/' + slug;
}

// Parses outcomePrices (which Polymarket returns as either ["0.58","0.42"]
// or sometimes the JSON-encoded string '["0.58","0.42"]').
function parsePrices(raw) {
  if (Array.isArray(raw)) return raw.map(Number);
  if (typeof raw === 'string') {
    try { return JSON.parse(raw).map(Number); } catch { return null; }
  }
  return null;
}

function parseOutcomes(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return null;
}

// ----- Polymarket fetch ------------------------------------------------------

async function fetchUfcEvents() {
  // 200 covers active and recently-active markets; UFC has ~25 live at any
  // time, but `active=true` includes some recently-resolved ones too.
  const url = POLYMARKET_BASE + '/events?tag_slug=ufc&active=true&closed=false&limit=200';
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching Polymarket events');
  return res.json();
}

// For a Polymarket event, find the "winner" market — the one where outcomes
// are the two fighter names. Returns null if no winner market is present
// (prop-only events, e.g. "Will any fight end in the first round?").
function findWinnerMarket(event) {
  const markets = event.markets || [];
  for (const m of markets) {
    const outcomes = parseOutcomes(m.outcomes);
    if (!outcomes || outcomes.length !== 2) continue;
    // Yes/No, Over/Under, Round 1/Round 2/etc. are prop markets — skip.
    const yn = outcomes.map(o => String(o).toLowerCase());
    if (yn[0] === 'yes' || yn[0] === 'over' || yn[0] === 'no' || yn[0] === 'under') continue;
    if (/^round/i.test(outcomes[0]) || /^method/i.test(outcomes[0])) continue;
    // Accept this as the winner market — outcomes look like fighter names.
    return m;
  }
  return null;
}

// ----- DB matching -----------------------------------------------------------

// Build a Map<normalizedName, fighter_id> from the fighters table for
// fast lookup. Paginated since the table is ~6k rows.
async function loadFighterIndex() {
  const map = new Map();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('fighters')
      .select('id, name')
      .range(from, from + 999);
    if (error) throw new Error('Failed to load fighters: ' + error.message);
    for (const f of data) {
      if (f.name) map.set(normalizeName(f.name), f.id);
    }
    if (data.length < 1000) break;
    from += 1000;
  }
  return map;
}

// Find the fight_results row where fighter_a / fighter_b match the given
// pair of UUIDs (either order). Restricts to upcoming events so we don't
// accidentally overwrite odds on completed fights.
async function findFightResult(fighterAId, fighterBId) {
  const todayISO = new Date().toISOString().slice(0, 10);
  // Try (A as fighter_a, B as fighter_b)
  const { data: rowsA, error: errA } = await supabase
    .from('fight_results')
    .select('id, fighter_a_id, fighter_b_id, event:ufc_events!inner(event_date)')
    .eq('fighter_a_id', fighterAId)
    .eq('fighter_b_id', fighterBId)
    .gte('event.event_date', todayISO)
    .is('outcome', null)
    .limit(1);
  if (errA) throw errA;
  if (rowsA && rowsA.length > 0) return { row: rowsA[0], aIsFighterA: true };

  // Try (A as fighter_b, B as fighter_a)
  const { data: rowsB, error: errB } = await supabase
    .from('fight_results')
    .select('id, fighter_a_id, fighter_b_id, event:ufc_events!inner(event_date)')
    .eq('fighter_a_id', fighterBId)
    .eq('fighter_b_id', fighterAId)
    .gte('event.event_date', todayISO)
    .is('outcome', null)
    .limit(1);
  if (errB) throw errB;
  if (rowsB && rowsB.length > 0) return { row: rowsB[0], aIsFighterA: false };

  return null;
}

// ----- Main ------------------------------------------------------------------

async function main() {
  console.log('Loading fighter index from DB...');
  const fighterIdByName = await loadFighterIndex();
  console.log('  ' + fighterIdByName.size + ' fighters indexed.\n');

  console.log('Fetching UFC events from Polymarket...');
  const events = await fetchUfcEvents();
  console.log('  ' + events.length + ' UFC events returned.\n');

  let upserted = 0;
  let noWinnerMarket = 0;
  let unmatched = 0;
  let noFightInDb = 0;
  let errors = 0;
  const unmatchedNames = new Set();

  for (const event of events) {
    const winner = findWinnerMarket(event);
    if (!winner) { noWinnerMarket++; continue; }

    const outcomes = parseOutcomes(winner.outcomes);
    const prices   = parsePrices(winner.outcomePrices);
    const tokens   = parseOutcomes(winner.clobTokenIds);
    if (!outcomes || !prices || outcomes.length !== 2 || prices.length !== 2) continue;

    const [nameA, nameB]   = outcomes;
    const [probA, probB]   = prices;
    // CLOB token ids align with outcomes index — outcomes[0] ↔ clobTokenIds[0].
    // We orient them to our (fighter_a, fighter_b) ordering further down.
    const tokA = tokens && tokens[0] ? String(tokens[0]) : null;
    const tokB = tokens && tokens[1] ? String(tokens[1]) : null;

    const idA = fighterIdByName.get(normalizeName(nameA));
    const idB = fighterIdByName.get(normalizeName(nameB));
    if (!idA || !idB) {
      if (!idA) unmatchedNames.add(nameA);
      if (!idB) unmatchedNames.add(nameB);
      unmatched++;
      continue;
    }

    let match;
    try {
      match = await findFightResult(idA, idB);
    } catch (e) {
      console.warn('  Lookup failed for ' + nameA + ' vs ' + nameB + ': ' + e.message);
      errors++;
      continue;
    }
    if (!match) { noFightInDb++; continue; }

    // Orient probabilities and token ids to our (fighter_a, fighter_b) ordering
    const fighterAProb    = match.aIsFighterA ? probA : probB;
    const fighterBProb    = match.aIsFighterA ? probB : probA;
    const fighterAToken   = match.aIsFighterA ? tokA  : tokB;
    const fighterBToken   = match.aIsFighterA ? tokB  : tokA;

    const payload = {
      fight_id:           match.row.id,
      source:             SOURCE,
      fighter_a_prob:     fighterAProb,
      fighter_b_prob:     fighterBProb,
      fighter_a_token_id: fighterAToken,
      fighter_b_token_id: fighterBToken,
      market_id:          winner.conditionId || winner.id || null,
      market_url:         marketUrlFromSlug(event.slug),
      liquidity:          winner.liquidity ? Number(winner.liquidity) : null,
      volume_24h:         winner.volume24hr ? Number(winner.volume24hr) : null,
      fetched_at:         new Date().toISOString(),
    };

    const { error } = await supabase
      .from('fight_odds')
      .upsert(payload, { onConflict: 'fight_id,source' });
    if (error) {
      console.warn('  Upsert failed for ' + nameA + ' vs ' + nameB + ': ' + error.message);
      errors++;
    } else {
      console.log('  ' + nameA + ' (' + Math.round(probA * 100) + '%) vs ' + nameB + ' (' + Math.round(probB * 100) + '%)');
      upserted++;
    }
  }

  console.log('\n============================================================');
  console.log('Polymarket sync complete.');
  console.log('  Upserted:                  ' + upserted);
  console.log('  Events with no winner mkt: ' + noWinnerMarket);
  console.log('  Fighters unmatched in DB:  ' + unmatched);
  console.log('  No matching fight in DB:   ' + noFightInDb);
  if (errors > 0)  console.log('  Errors:                    ' + errors);
  if (unmatchedNames.size > 0) {
    console.log('\nUnmatched fighter names (run scrapeFighters.js if active):');
    [...unmatchedNames].sort().forEach(n => console.log('  - ' + n));
  }
  console.log('============================================================');

  // Refresh projections — projection rows are downstream of odds, so we
  // recompute every run. Cheap (~25 fights, batched DB queries) and keeps
  // the projected_points value in lockstep with whatever the market just
  // told us.
  console.log('\nRecomputing fighter_projections...');
  try {
    const r = await recomputeAllProjections(supabase);
    console.log('  Upserted: ' + r.upserted + ' projection rows.');
  } catch (e) {
    console.warn('  Projection refresh failed: ' + e.message);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
