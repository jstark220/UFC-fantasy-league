// ============================================================================
// ingestFightResults.js
// Scrapes ufcstats.com fight detail pages and upserts fight results into
// the fight_results Supabase table.
//
// Usage:
//   node ingestFightResults.js <hex-event-id>   -- ingest a single event
//   node ingestFightResults.js --all             -- ingest all events with a
//                                                   ufcstats_id in the DB
//                                                   where event_date >= 2023-01-01
//
// Prerequisites:
//   1. Run the SQL migration (sql/2026-05-20_ufcstats_ids.sql) in Supabase
//   2. Run node ingestEvents.js to populate ufc_events with ufcstats_id values
//
// Notes:
//   - Performance of the Night (PotN) is NOT on ufcstats. The scraper sets
//     fighter_a_potn and fighter_b_potn to false. Commissioner sets them via
//     score-event.html after the event.
//   - A 150ms delay between HTTP requests avoids overwhelming ufcstats.
//   - Re-running is safe: uses ufcstats_fight_id as the upsert key.
//   - Unmatched fighter names are printed at the end for manual review.
// ============================================================================

require('dotenv').config();
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabaseClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Milliseconds to wait between HTTP requests (polite scraping)
const REQUEST_DELAY_MS = 150;

// ============================================================================
// NAME MATCHING
// ============================================================================
// ufcstats uses full display names with accents ("Jiří Procházka").
// Our DB has UFC slugs ("jiri-prochazka") and sometimes ufcstats_name once set.
// Strategy: normalize both sides, match, then persist the ufcstats display name
// so future runs skip the normalization step.

// Strip accents, lowercase, remove punctuation: "Jiří Procházka" -> "jiri prochazka"
function normalizeName(name) {
  if (!name) return '';
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')     // remove punctuation (apostrophes, hyphens)
    .replace(/\s+/g, ' ')
    .trim();
}

// Known edge cases where normalization still fails. Key: normalized ufcstats name.
// Value: exact fighters.ufc_id slug. Add more here when the script reports misses.
const NAME_OVERRIDES = {
  // Examples — add real ones as you discover them:
  // 'kyung ho kang':   'kyung-ho-kang',
  // 'cub swanson':     'cub-swanson',
};

// Build the fighter lookup tables from the DB at startup.
// Returns { byNormName: Map<normalizedName, {id, name}>, byUfcstatsName: Map<ufcstatsName, {id}> }
async function buildFighterLookup() {
  console.log('Loading fighters from DB...');

  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabaseClient
      .from('fighters')
      .select('id, name, ufcstats_name, current_rank, ufc_id, is_active')
      .range(from, from + PAGE - 1);
    if (error) throw new Error('Failed to load fighters: ' + error.message);
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  // Map exact ufcstats_name -> fighter id (fast path for subsequent runs)
  const byUfcstatsName = new Map();
  // Map normalized name -> { id, dbName, rank } (fallback + rank lookup)
  const byNormName = new Map();

  // Sort so canonical entries are processed LAST and win the Map.set() race.
  // Canonical = Octagon API entry (ufc_id without "ufcstats-" prefix).
  // This prevents the lookup from returning a "ufcstats-" duplicate when a
  // canonical version of the same fighter exists.
  const sorted = all.slice().sort((a, b) => {
    const aIsDupe = a.ufc_id && a.ufc_id.startsWith('ufcstats-') ? 1 : 0;
    const bIsDupe = b.ufc_id && b.ufc_id.startsWith('ufcstats-') ? 1 : 0;
    // Process dupes first (they go in the map first, then canonicals overwrite)
    if (aIsDupe !== bIsDupe) return bIsDupe - aIsDupe;
    // Among same-canonical-status, active fighters win over inactive
    return (a.is_active ? 1 : 0) - (b.is_active ? 1 : 0);
  });

  for (const f of sorted) {
    if (f.ufcstats_name) {
      byUfcstatsName.set(f.ufcstats_name, f.id);
    }
    byNormName.set(normalizeName(f.name), { id: f.id, dbName: f.name, rank: f.current_rank });
  }

  console.log(`  Loaded ${all.length} fighters (${byUfcstatsName.size} with ufcstats_name already set)\n`);
  return { byUfcstatsName, byNormName, fighters: all };
}

// Resolve a ufcstats display name to a fighter UUID, or auto-create the fighter
// in the DB if they don't exist (cut/retired fighters not in the Octagon API).
// divisionHint is the DB enum value from the fight's weight class (e.g. "lightweight").
// Never returns null — always returns a UUID.
async function resolveOrCreateFighter(rawName, divisionHint, lookup, pendingNameUpdates) {
  const trimmed = rawName.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;

  // Fast path: ufcstats_name was matched and cached in a previous run
  if (lookup.byUfcstatsName.has(trimmed)) {
    return lookup.byUfcstatsName.get(trimmed);
  }

  // Normalized lookup against all fighters currently in the DB
  const norm = normalizeName(trimmed);

  // Check manual overrides first
  if (NAME_OVERRIDES[norm]) {
    const overrideNorm = NAME_OVERRIDES[norm].replace(/-/g, ' ');
    const match = lookup.byNormName.get(overrideNorm);
    if (match) {
      lookup.byUfcstatsName.set(trimmed, match.id);
      pendingNameUpdates.push({ id: match.id, ufcstats_name: trimmed });
      return match.id;
    }
  }

  const match = lookup.byNormName.get(norm);
  if (match) {
    lookup.byUfcstatsName.set(trimmed, match.id);
    pendingNameUpdates.push({ id: match.id, ufcstats_name: trimmed });
    return match.id;
  }

  // Not found — auto-create as an inactive fighter so the fight result can be saved.
  // Uses "ufcstats-" prefix on ufc_id to distinguish from Octagon-sourced fighters.
  // Safe to re-run: upsert on ufc_id means re-runs just update the existing row.
  const ufc_id = 'ufcstats-' + norm.replace(/ /g, '-');
  const { data, error } = await supabaseClient
    .from('fighters')
    .upsert({
      name:               trimmed,
      ufcstats_name:      trimmed,
      ufc_id,
      primary_division:   divisionHint || 'heavyweight',
      is_active:          false,
      record_wins:        0,
      record_losses:      0,
      record_draws:       0,
      record_no_contests: 0,
      current_rank:       null,
      is_champion:        false,
      is_sub_champion:    false,
      sub_title_type:     'none',
    }, { onConflict: 'ufc_id' })
    .select('id')
    .single();

  if (error || !data) {
    console.warn(`  Could not auto-create fighter "${trimmed}": ${error?.message}`);
    return null;
  }

  // Add to in-memory lookup so subsequent fights in this run find them instantly
  lookup.byUfcstatsName.set(trimmed, data.id);
  lookup.byNormName.set(norm, { id: data.id, dbName: trimmed });
  console.log(`  Auto-created: "${trimmed}" (${divisionHint || 'unknown'})`);
  return data.id;
}

// ============================================================================
// UFCSTATS OUTCOME -> DB ENUM
// ============================================================================
const OUTCOME_MAP = {
  'KO/TKO':               'ko_tko',
  'TKO':                  'ko_tko',
  'KO':                   'ko_tko',
  'Submission':           'submission',
  'Decision - Unanimous': 'decision_u',
  'Decision - Split':     'decision_s',
  'Decision - Majority':  'decision_m',
  'DQ':                   'dq',
  'Disqualification':     'dq',
  'No Contest':           'no_contest',
  'Draw':                 'draw',
  'Could Not Continue':   'ko_tko', // treated as TKO
};

function mapOutcome(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (OUTCOME_MAP[trimmed]) return OUTCOME_MAP[trimmed];
  // Partial match fallback (handles "Decision - Unanimous" with extra whitespace, etc.)
  for (const [key, val] of Object.entries(OUTCOME_MAP)) {
    if (trimmed.includes(key)) return val;
  }
  console.warn(`  Unknown outcome: "${trimmed}"`);
  return null;
}

// ============================================================================
// WEIGHT CLASS -> DB ENUM
// ============================================================================
const WEIGHT_CLASS_MAP = {
  "Heavyweight":              "heavyweight",
  "Light Heavyweight":        "light_heavyweight",
  "Middleweight":             "middleweight",
  "Welterweight":             "welterweight",
  "Lightweight":              "lightweight",
  "Featherweight":            "featherweight",
  "Bantamweight":             "bantamweight",
  "Flyweight":                "flyweight",
  "Women's Strawweight":      "strawweight",
  "Women's Flyweight":        "flyweight_w",
  "Women's Bantamweight":     "bantamweight_w",
  "Women's Featherweight":    "featherweight", // rare; same enum value as men's
  "Catch Weight":             null,            // no enum; skip or store null
  "Open Weight":              null,
};

function mapWeightClass(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  // Remove "Bout" suffix if present: "Lightweight Bout" -> "Lightweight"
  const cleaned = trimmed.replace(/\s*bout$/i, '').trim();
  if (WEIGHT_CLASS_MAP.hasOwnProperty(cleaned)) return WEIGHT_CLASS_MAP[cleaned];
  // Try partial match for safety
  for (const [key, val] of Object.entries(WEIGHT_CLASS_MAP)) {
    if (key && cleaned.includes(key)) return val;
  }
  console.warn(`  Unknown weight class: "${raw}"`);
  return null;
}

// ============================================================================
// CARD POSITION FROM FIGHT INDEX
// ============================================================================
// ufcstats lists fights in card order: index 0 = main event.
// The DB card_position enum only has three values: main_event, co_main, main_card.
// All prelim / early-prelim fights use main_card (1.0x multiplier, same as main card).
function cardPositionFromIndex(idx) {
  if (idx === 0) return 'main_event';
  if (idx === 1) return 'co_main';
  return 'main_card';
}

// ============================================================================
// TIME HELPERS
// ============================================================================

// Convert "M:SS" (time within a round) -> integer seconds. "4:45" -> 285.
function parseRoundTime(str) {
  if (!str) return null;
  const parts = str.trim().split(':');
  if (parts.length !== 2) return null;
  const mins = parseInt(parts[0], 10);
  const secs = parseInt(parts[1], 10);
  if (isNaN(mins) || isNaN(secs)) return null;
  return mins * 60 + secs;
}

// ============================================================================
// HTTP HELPERS
// ============================================================================

// Polite fetch with delay and retry on transient errors
async function fetchHtml(url) {
  await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

// ============================================================================
// SCRAPE ONE FIGHT DETAIL PAGE
// Returns { nameA, nameB, winnerName, statsA, statsB, method, round, endTimeSecs,
//           isTitleFight, weightClassRaw }
// or null on parse failure.
// ============================================================================
async function scrapeFightDetail(fightUrl) {
  let html;
  try {
    html = await fetchHtml(fightUrl);
  } catch (err) {
    console.warn(`  Failed to fetch fight detail ${fightUrl}: ${err.message}`);
    return null;
  }

  const $ = cheerio.load(html);

  // ---- Winner detection ----
  // Each fighter has a <div class="b-fight-details__person"> wrapper.
  // Inside is a <i class="b-fight-details__person-status"> with "W", "L", or "D".
  const persons = $('.b-fight-details__person');
  if (persons.length < 2) {
    console.warn(`  Could not find fighter persons in ${fightUrl}`);
    return null;
  }

  const statusA = $(persons.eq(0)).find('.b-fight-details__person-status').text().trim();
  const statusB = $(persons.eq(1)).find('.b-fight-details__person-status').text().trim();

  // Fighter names are in <p class="b-fight-details__person-name">
  // The name spans two lines separated by a <br> — join them.
  function personName($el) {
    const nameEl = $el.find('.b-fight-details__person-name a');
    // Clone and replace <br> with space before getting text
    const clone = nameEl.clone();
    clone.find('br').replaceWith(' ');
    return clone.text().trim().replace(/\s+/g, ' ');
  }

  const nameA = personName(persons.eq(0));
  const nameB = personName(persons.eq(1));

  // The fighter with status "W" is the winner; "D" means draw; "" means NC
  let winnerName = null;
  let outcomeOverride = null; // set when we can infer outcome from status
  if (statusA === 'W')      winnerName = nameA;
  else if (statusB === 'W') winnerName = nameB;
  else if (statusA === 'D' || statusB === 'D') outcomeOverride = 'draw';
  // If both statuses are empty it's likely a NC — detected via method text below

  // ---- Fight details (method, round, time) ----
  // These are labeled fields: <i class="b-fight-details__label">Method:</i>
  function getDetailField(labelPrefix) {
    let value = '';
    $('.b-fight-details__label, .b-fight-details__text-item_style_margin').each((_, el) => {
      const labelText = $(el).text().trim();
      if (labelText.startsWith(labelPrefix)) {
        // The value is in the next sibling element
        value = $(el).next().text().trim();
        if (!value) {
          // Sometimes it's the next text node within the same parent <p>
          value = $(el).parent().clone().children().remove().end().text().trim();
        }
      }
    });
    return value;
  }

  // Fallback: scan all <i> tags for labels
  function getDetailFieldFallback(labelPrefix) {
    let value = '';
    $('i').each((_, el) => {
      if ($(el).text().trim().startsWith(labelPrefix)) {
        // Value is either next sibling span or the text after the <i> in the parent
        const nextText = $(el).next('i, span, p').text().trim()
                      || $(el).parent().text().replace($(el).text(), '').trim();
        value = nextText;
        return false; // break each loop
      }
    });
    return value;
  }

  let methodRaw = getDetailField('Method:') || getDetailFieldFallback('Method:');
  const roundRaw = getDetailField('Round:') || getDetailFieldFallback('Round:');
  const timeRaw  = getDetailField('Time:')  || getDetailFieldFallback('Time:');

  // ufcstats puts method details in parentheses: "KO/TKO (Punches)" — strip the detail
  methodRaw = methodRaw.replace(/\s*\(.*\)$/, '').trim();

  const round = parseInt(roundRaw, 10) || null;
  const endTimeSecs = parseRoundTime(timeRaw);

  // Detect "No Contest" from method if we didn't catch it via status
  if (methodRaw.toLowerCase().includes('no contest') || methodRaw.toLowerCase().includes('nc')) {
    outcomeOverride = 'no_contest';
  }

  // ---- Title fight detection ----
  // Weight class is in .b-fight-details__fight-title. Title fight detection is
  // now done on the event page (belt.png) and passed in via the stub object —
  // the fight detail page shows perf/fight icons too which broke the old img check.
  const $title = $('.b-fight-details__fight-title');
  const titleText = $title.text().trim().replace(/\s+/g, ' ');
  const weightClassRaw = titleText.replace(/title bout/i, '').replace(/\s+/g, ' ').trim();

  // ---- Stats from totals table ----
  // ufcstats uses ONE tbody row per fight (not one per fighter).
  // Each stat cell contains two <p> tags: p.eq(0) = fighter A, p.eq(1) = fighter B.
  // Columns: Fighter(0) | KD(1) | Sig.Str.(2) | Sig.Str.%(3) | Total Str.(4)
  //          TD(5) | TD%(6) | Sub Att(7) | Rev(8) | Ctrl(9)
  //
  // IMPORTANT: The page has two kinds of tables:
  //   - Overall totals table: no CSS classes (1 row = entire fight)
  //   - Per-round breakdown: class "b-fight-details__table js-fight-table" (1 row per round)
  // We must select the classless table. Using .not('.js-fight-table') excludes the
  // per-round tables and gives us the first (overall) totals table.
  const $totalsRow = $('table').not('.js-fight-table').first().find('tbody tr').first();
  const $cells = $totalsRow.find('td');

  function parseStats(pIdx) {
    // Each stat cell: p.eq(pIdx) gives either fighter A (0) or fighter B (1)
    function cellText(colIdx) {
      return $cells.eq(colIdx).find('p').eq(pIdx).text().trim();
    }
    function parseLanded(str) {
      // Sig strikes / TDs come as "X of Y" — take the landed count (X)
      return parseInt(str.split(' of ')[0], 10) || 0;
    }
    return {
      knockdowns:       parseInt(cellText(1), 10) || 0,
      sig_strikes:      parseLanded(cellText(2)),
      takedowns:        parseLanded(cellText(5)),
      control_seconds:  parseRoundTime(cellText(9)) || 0,
    };
  }

  const hasStats = $cells.length >= 10;
  const statsA = hasStats ? parseStats(0) : null;
  const statsB = hasStats ? parseStats(1) : null;

  if (!hasStats) {
    console.warn(`  Could not parse stats in ${fightUrl} (only ${$cells.length} cells found)`);
  }

  return {
    nameA,
    nameB,
    winnerName,
    outcomeOverride,
    statsA: statsA || { knockdowns: 0, sig_strikes: 0, takedowns: 0, control_seconds: 0 },
    statsB: statsB || { knockdowns: 0, sig_strikes: 0, takedowns: 0, control_seconds: 0 },
    methodRaw,
    round,
    endTimeSecs,
    weightClassRaw,
  };
}

// ============================================================================
// SCRAPE ONE EVENT DETAIL PAGE
// Returns an array of fight objects:
//   { fightUrl, fighterNames: [nameA, nameB], weightClassRaw, methodRaw, round, timeRaw, fightIndex }
// ============================================================================
async function scrapeEventFightList(eventId) {
  const url = `http://ufcstats.com/event-details/${eventId}`;
  let html;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    console.warn(`  Failed to fetch event page ${eventId}: ${err.message}`);
    return [];
  }

  const $ = cheerio.load(html);
  const fights = [];

  // Each fight row has a data-link attribute pointing to the fight detail URL.
  // This is more reliable than column-position parsing.
  $('tr[data-link*="/fight-details/"]').each((idx, row) => {
    const $row = $(row);
    const fightUrl = $row.attr('data-link') || '';
    const fightHexMatch = fightUrl.match(/fight-details\/([a-f0-9]+)/i);
    if (!fightHexMatch) return;

    // Fighter names: two <a> links inside the second <td>
    const $nameCells = $row.find('td').eq(1).find('a');
    const nameA = $nameCells.eq(0).text().trim();
    const nameB = $nameCells.eq(1).text().trim();

    // Bonus icons live in the weight-class cell (col 6).
    // belt.png = title fight, fight.png = Fight of the Night, perf.png = Perf of the Night
    const imgSrcs = $row.find('img').map((_, img) => $(img).attr('src') || '').get();
    const hasIcon = (name) => imgSrcs.some(src => src.includes(name));

    fights.push({
      fightUrl: fightUrl.startsWith('http') ? fightUrl : 'http://ufcstats.com' + fightUrl,
      ufcstatsFightId: fightHexMatch[1],
      nameA,
      nameB,
      fightIndex: idx,
      isTitleFight:    hasIcon('belt.png'),
      fightOfTheNight: hasIcon('fight.png'),
      hasPotN:         hasIcon('perf.png'),  // which fighter won it is not available; commissioner sets via score-event.html
    });
  });

  return fights;
}

// ============================================================================
// PROCESS ONE EVENT
// Fetches event fights, scrapes each fight detail, resolves names, upserts.
// ============================================================================
async function processEvent(dbEvent, lookup, pendingNameUpdates) {
  console.log(`\nProcessing: ${dbEvent.full_name || dbEvent.name} (${dbEvent.ufcstats_id})`);

  const fightStubs = await scrapeEventFightList(dbEvent.ufcstats_id);
  if (fightStubs.length === 0) {
    console.log('  No fights found on event page. Skipping.');
    return;
  }

  console.log(`  Found ${fightStubs.length} fights`);

  const rowsToUpsert = [];

  for (const stub of fightStubs) {
    const detail = await scrapeFightDetail(stub.fightUrl);
    if (!detail) continue;

    // Map weight class first — needed as division hint for auto-created fighters
    const weight_class = mapWeightClass(detail.weightClassRaw);
    if (!weight_class) {
      console.warn(`  Skipping fight (unmapped weight class "${detail.weightClassRaw}"): ${detail.nameA} vs ${detail.nameB}`);
      continue;
    }

    // Resolve names to UUIDs, auto-creating fighters not in the DB (cut/retired)
    const nameA = detail.nameA || stub.nameA;
    const nameB = detail.nameB || stub.nameB;
    const fighterAId = await resolveOrCreateFighter(nameA, weight_class, lookup, pendingNameUpdates);
    const fighterBId = await resolveOrCreateFighter(nameB, weight_class, lookup, pendingNameUpdates);

    // Only null if the DB insert itself failed (very unlikely)
    if (!fighterAId || !fighterBId) {
      console.warn(`  Skipping fight: DB error resolving "${nameA}" vs "${nameB}"`);
      continue;
    }

    // Determine outcome
    let outcome = detail.outcomeOverride || mapOutcome(detail.methodRaw);

    // Determine winner UUID
    let winnerId = null;
    if (detail.winnerName) {
      const normWinner = normalizeName(detail.winnerName);
      if (normWinner === normalizeName(nameA)) winnerId = fighterAId;
      else if (normWinner === normalizeName(nameB)) winnerId = fighterBId;
    }

    // No-contest detection: if the method looked decisive (KO/TKO/sub/dec/DQ)
    // but ufcstats couldn't surface a winner, the fight was almost certainly
    // ruled a no-contest after the fact (e.g., Aspinall vs Gane at UFC 321 —
    // accidental eye poke that ufcstats still records as "KO/TKO"). Override
    // the outcome so scoring and display treat it correctly.
    const DECISIVE_OUTCOMES = ['ko_tko', 'submission', 'decision_u', 'decision_s', 'decision_m', 'dq'];
    if (DECISIVE_OUTCOMES.includes(outcome) && winnerId == null) {
      outcome = 'no_contest';
    }

    // Title type: belt.png confirms it's a title fight. The fight title text
    // (now in detail.weightClassRaw, which strips "Title Bout") lets us
    // distinguish interim and BMF from a divisional title.
    // is_title_defense cannot be detected from ufcstats — commissioner sets it.
    let title_type = 'none';
    if (stub.isTitleFight) {
      const rawLower = detail.weightClassRaw.toLowerCase();
      if (rawLower.includes('bmf') || rawLower.includes('baddest mother')) {
        title_type = 'bmf';
      } else if (rawLower.includes('interim')) {
        title_type = 'interim';
      } else {
        title_type = 'divisional';
      }
    }

    // Opponent rank: look up each fighter's CURRENT rank in the lookup table.
    // This is accurate for recent events but approximate for historical ones
    // since ranks change over time. Commissioner can correct via score-event.html.
    const fighterAEntry = lookup.byNormName.get(normalizeName(nameA));
    const fighterBEntry = lookup.byNormName.get(normalizeName(nameB));
    const opponentRankA = fighterBEntry?.rank ?? null; // B is A's opponent
    const opponentRankB = fighterAEntry?.rank ?? null; // A is B's opponent

    rowsToUpsert.push({
      ufcstats_fight_id:         stub.ufcstatsFightId,
      event_id:                  dbEvent.id,
      fighter_a_id:              fighterAId,
      fighter_b_id:              fighterBId,
      weight_class,
      card_position:             cardPositionFromIndex(stub.fightIndex),
      title_type,
      is_title_defense:          false,        // commissioner sets manually
      fight_of_the_night:        stub.fightOfTheNight,
      outcome,
      winner_id:                 winnerId,
      end_round:                 detail.round,
      end_time_seconds:          detail.endTimeSecs,
      fighter_a_sig_strikes:     detail.statsA.sig_strikes,
      fighter_a_takedowns:       detail.statsA.takedowns,
      fighter_a_knockdowns:      detail.statsA.knockdowns,
      fighter_a_control_seconds: detail.statsA.control_seconds,
      fighter_a_opponent_rank:   opponentRankA,
      fighter_a_potn:            false,        // PotN winner not determinable per-fighter from ufcstats; commissioner sets
      fighter_b_sig_strikes:     detail.statsB.sig_strikes,
      fighter_b_takedowns:       detail.statsB.takedowns,
      fighter_b_knockdowns:      detail.statsB.knockdowns,
      fighter_b_control_seconds: detail.statsB.control_seconds,
      fighter_b_opponent_rank:   opponentRankB,
      fighter_b_potn:            false,
    });
  }

  if (rowsToUpsert.length === 0) {
    console.log('  No rows to upsert for this event.');
    return;
  }

  const { error } = await supabaseClient
    .from('fight_results')
    .upsert(rowsToUpsert, { onConflict: 'ufcstats_fight_id' });

  if (error) {
    console.error(`  Upsert FAILED: ${error.message}`);
  } else {
    console.log(`  Upserted ${rowsToUpsert.length} fight results`);
  }
}

// ============================================================================
// PERSIST ufcstats_name BACK TO fighters TABLE
// After processing all events, write the matched ufcstats display names so
// future runs use the fast exact-match path instead of the normalized lookup.
// ============================================================================
async function persistNameUpdates(pendingNameUpdates) {
  if (pendingNameUpdates.length === 0) return;
  console.log(`\nPersisting ${pendingNameUpdates.length} ufcstats_name updates to fighters table...`);

  // De-duplicate: one update per fighter id
  const byId = new Map();
  for (const u of pendingNameUpdates) byId.set(u.id, u);
  const deduped = Array.from(byId.values());

  const BATCH = 50;
  for (let i = 0; i < deduped.length; i += BATCH) {
    const batch = deduped.slice(i, i + BATCH);
    // Individual updates are simplest here — upsert on primary key
    for (const { id, ufcstats_name } of batch) {
      const { error } = await supabaseClient
        .from('fighters')
        .update({ ufcstats_name })
        .eq('id', id);
      if (error) console.warn(`  Failed to update ufcstats_name for ${id}: ${error.message}`);
    }
  }
  console.log('  Done.');
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  const args     = process.argv.slice(2);
  const runAll   = args[0] === '--all';
  // --recent: scrape only events from the last 3 days (used by the live-update
  // workflow that runs every 5 minutes during UFC event windows).
  const runRecent = args[0] === '--recent';
  const singleId  = (!runAll && !runRecent) ? args[0] : null;

  if (!runAll && !runRecent && !singleId) {
    console.error('Usage: node ingestFightResults.js <event-hex-id>');
    console.error('       node ingestFightResults.js --all');
    console.error('       node ingestFightResults.js --recent  (last 3 days)');
    process.exit(1);
  }

  const start = Date.now();
  const lookup = await buildFighterLookup();
  const pendingNameUpdates = []; // ufcstats_name writes to persist after processing

  if (singleId) {
    // Single event: look it up in the DB to get the event UUID and full name
    const { data, error } = await supabaseClient
      .from('ufc_events')
      .select('id, name, full_name, ufcstats_id')
      .eq('ufcstats_id', singleId)
      .single();

    if (error || !data) {
      console.error(`Event with ufcstats_id "${singleId}" not found in DB.`);
      console.error('Run "node ingestEvents.js" first to populate the events table.');
      process.exit(1);
    }

    await processEvent(data, lookup, pendingNameUpdates);

  } else {
    // Build event date window. --all = 2023+ ; --recent = last 3 days.
    const since = runRecent
      ? new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      : '2023-01-01';

    const { data: events, error } = await supabaseClient
      .from('ufc_events')
      .select('id, name, full_name, ufcstats_id, event_date')
      .not('ufcstats_id', 'is', null)
      .gte('event_date', since)
      .order('event_date', { ascending: true });

    if (error) throw new Error('Failed to load events: ' + error.message);

    console.log(`Found ${events.length} events since ${since} to process`);

    for (const ev of events) {
      await processEvent(ev, lookup, pendingNameUpdates);
    }
  }

  // Write ufcstats_name back to fighters table for fighters already in the DB
  await persistNameUpdates(pendingNameUpdates);

  const elapsed = ((Date.now() - start) / 1000 / 60).toFixed(1);
  console.log(`\nTotal time: ${elapsed} minutes`);
  console.log('\nNext step: open score-event.html to set PotN and is_title_defense for any title fights (belt wins = false, belt defenses = true). BMF and interim type are now auto-detected.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
