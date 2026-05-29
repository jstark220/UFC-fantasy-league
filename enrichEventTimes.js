// ============================================================================
// enrichEventTimes.js
// Fills in the ACTUAL start time of each upcoming UFC card from ESPN's MMA API.
//
// Why this exists:
//   ingestEvents.js scrapes ufcstats.com, which only publishes a DATE - no
//   times. So lineup_lock_time had to be set by hand per event, and cards in
//   far time zones (e.g. UFC Macau, which starts in the very early US morning)
//   were easy to get wrong. ESPN's MMA API publishes a start time for every
//   bout; the EARLIEST one is the first-prelim start - exactly when lineups
//   should lock. ESPN gives times in UTC, so the timezone "problem" is really
//   just an absolute instant we store as timestamptz and render locally.
//
// What it writes to ufc_events (matched by espn_event_id, else date + name):
//   - prelim_start_time : earliest bout time on the card (UTC). Always set.
//   - espn_event_id     : the matched ESPN id, so future runs match exactly.
//   - lineup_lock_time  : DEFAULTED to prelim_start_time, but only when it is
//                         currently null - a commissioner's manual lock is left
//                         alone (and flagged if it differs). Use --relock to
//                         force every matched lock to the prelim time.
//
// Run:
//   node enrichEventTimes.js                 enrich upcoming events
//   node enrichEventTimes.js --dry-run       show what would change, write nothing
//   node enrichEventTimes.js --relock        also overwrite lineup_lock_time = prelim
//   node enrichEventTimes.js --days=120       look this many days ahead (default 210)
//
// Safe to re-run anytime - it only writes when a value actually changes, so
// running it again on fight week picks up any schedule shifts.
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Safety check - service role key bypasses RLS and must never ship to a browser.
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env file');
  process.exit(1);
}

const supabaseClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ESPN's public (unofficial, no-key) MMA scoreboard. Accepts a single date
// (?dates=YYYYMMDD) or a range (?dates=YYYYMMDD-YYYYMMDD).
const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard';

// CLI flags
const DRY_RUN = process.argv.includes('--dry-run');
const RELOCK  = process.argv.includes('--relock');
const daysArg = process.argv.find(a => a.startsWith('--days='));
const LOOK_AHEAD_DAYS = daysArg ? parseInt(daysArg.split('=')[1], 10) : 210;

// ============================================================================
// DATE HELPERS
// ============================================================================

// A Date -> "YYYYMMDD" using UTC parts (ESPN's dates param is UTC-based).
function yyyymmdd(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

// Whole-day difference between a "YYYY-MM-DD" string and an ISO timestamp,
// both compared at UTC midnight. Used for the ±1-day match window: ufcstats
// lists the event-local date, which can be a day off from ESPN's UTC date for
// cards near the international date line (e.g. a midnight-UTC prelim start).
function dayDiff(dateStr, iso) {
  const a = Date.parse(dateStr + 'T00:00:00Z');
  const b = Date.parse(iso.slice(0, 10) + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

// ============================================================================
// NAME MATCHING (tiebreaker only - date is the primary key)
// ============================================================================

// Lowercase, drop accents/punctuation/"ufc", collapse spaces.
function normalizeName(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/ufc/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Numbered cards: pull the event number ("UFC 329" -> 329, "Freedom 250" -> 250).
function eventNumber(s) {
  const m = normalizeName(s).match(/\b(\d{2,4})\b/);
  return m ? m[1] : null;
}

// Fighter surnames from the "... : X vs Y" subtitle, used for Fight Nights
// that have no number. Returns a Set of lowercase tokens.
function surnames(s) {
  const norm = normalizeName(s);
  const idx = norm.indexOf(' vs ');
  if (idx === -1) return new Set();
  // Take everything around "vs" and keep word tokens >= 3 chars.
  return new Set(norm.replace(' vs ', ' ').split(' ').filter(w => w.length >= 3));
}

// Score how well an ESPN event name matches a DB event name. Higher is better;
// 0 means "no positive signal" (still acceptable if the date is unambiguous).
function nameScore(dbName, espnName) {
  const dbNum = eventNumber(dbName);
  const esNum = eventNumber(espnName);
  if (dbNum && esNum) return dbNum === esNum ? 100 : -100; // numbers must agree
  const a = surnames(dbName), b = surnames(espnName);
  let overlap = 0;
  a.forEach(w => { if (b.has(w)) overlap++; });
  return overlap * 10;
}

// ============================================================================
// FETCH ESPN EVENTS
// Pulls the schedule across [start, end] in <=90-day chunks (keeps each request
// small and dodges any range cap), de-dupes by ESPN id, and reduces each event
// to the fields we need - crucially prelimStart = the earliest bout time.
// ============================================================================
async function fetchEspnEvents(start, end) {
  const byId = new Map();
  const CHUNK_MS = 90 * 86400000;
  for (let t = start.getTime(); t <= end.getTime(); t += CHUNK_MS + 86400000) {
    const chunkStart = new Date(t);
    const chunkEnd   = new Date(Math.min(t + CHUNK_MS, end.getTime()));
    const url = `${ESPN_SCOREBOARD}?dates=${yyyymmdd(chunkStart)}-${yyyymmdd(chunkEnd)}`;
    let json;
    try {
      const res = await fetch(url);
      if (!res.ok) { console.warn(`  WARN: ESPN HTTP ${res.status} for ${url}`); continue; }
      json = await res.json();
    } catch (err) {
      console.warn(`  WARN: ESPN fetch failed (${err.message}) for ${url}`);
      continue;
    }
    (json.events || []).forEach(e => {
      const comps = e.competitions || [];
      // Earliest bout time on the card = first-prelim start. Fall back to the
      // event-level date (in practice ESPN sets event.date to this same value).
      const times = comps.map(c => c.date).filter(Boolean).sort();
      const prelimStart = times[0] || e.date;
      if (!prelimStart) return;
      byId.set(e.id, { id: e.id, name: e.name, date: e.date, prelimStart });
    });
  }
  return [...byId.values()];
}

// ============================================================================
// MATCH ONE DB EVENT TO AN ESPN EVENT
// ============================================================================
function matchEspnEvent(dbEvent, espnEvents, espnById) {
  // Fast path: we already stored the ESPN id on a previous run.
  if (dbEvent.espn_event_id && espnById.has(dbEvent.espn_event_id)) {
    return { espn: espnById.get(dbEvent.espn_event_id), how: 'espn_event_id', diff: null };
  }
  // Candidates within ±1 day of the DB event date.
  const candidates = espnEvents
    .map(e => ({ e, diff: dayDiff(dbEvent.event_date, e.date) }))
    .filter(c => Math.abs(c.diff) <= 1);

  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    // Unique card that weekend - accept even if the (possibly generic) name
    // gives no positive signal, but reject an outright number conflict.
    const c = candidates[0];
    if (nameScore(dbEvent.full_name || dbEvent.name, c.e.name) < 0) return null;
    return { espn: c.e, how: `date ${c.diff >= 0 ? '+' : ''}${c.diff}`, diff: c.diff };
  }
  // Multiple cards in the window (rare double-event weekend) - require a
  // positive name signal and take the best.
  const scored = candidates
    .map(c => ({ ...c, score: nameScore(dbEvent.full_name || dbEvent.name, c.e.name) }))
    .sort((x, y) => y.score - x.score);
  if (scored[0].score <= 0) return null; // ambiguous - skip rather than guess
  return { espn: scored[0].e, how: `date ${scored[0].diff >= 0 ? '+' : ''}${scored[0].diff} + name`, diff: scored[0].diff };
}

// ============================================================================
// LOAD UPCOMING DB EVENTS
// Tries to select prelim_start_time; if the column doesn't exist yet (migration
// not applied), retries without it and flags so a real run won't try to write.
// ============================================================================
async function loadUpcomingEvents(cutoffDate) {
  const base = 'id, name, full_name, event_date, lineup_lock_time, espn_event_id';
  let columnMissing = false;
  let res = await supabaseClient
    .from('ufc_events')
    .select(base + ', prelim_start_time')
    .gte('event_date', cutoffDate)
    .order('event_date', { ascending: true });
  if (res.error && /prelim_start_time/.test(res.error.message || '')) {
    columnMissing = true;
    res = await supabaseClient
      .from('ufc_events')
      .select(base)
      .gte('event_date', cutoffDate)
      .order('event_date', { ascending: true });
  }
  if (res.error) { console.error('ERROR loading ufc_events:', res.error.message); process.exit(1); }
  return { events: res.data || [], columnMissing };
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.log(`enrichEventTimes ${DRY_RUN ? '(DRY RUN) ' : ''}${RELOCK ? '(RELOCK) ' : ''}- looking ${LOOK_AHEAD_DAYS} days ahead\n`);

  const now = new Date();
  // DB cutoff: include yesterday so a card that just started/finished isn't lost.
  const cutoff = new Date(now.getTime() - 1 * 86400000).toISOString().slice(0, 10);
  // ESPN window: a few days back (covers date-line offset) through the look-ahead.
  const espnStart = new Date(now.getTime() - 3 * 86400000);
  const espnEnd   = new Date(now.getTime() + LOOK_AHEAD_DAYS * 86400000);

  const { events: dbEvents, columnMissing } = await loadUpcomingEvents(cutoff);
  if (columnMissing && !DRY_RUN) {
    console.error('ERROR: ufc_events.prelim_start_time does not exist yet.');
    console.error('Apply sql/2026-05-29_prelim_start_time.sql in the Supabase SQL editor first,');
    console.error('or run with --dry-run to preview without writing.');
    process.exit(1);
  }
  if (columnMissing) {
    console.log('NOTE: prelim_start_time column not present yet - previewing intended values.\n');
  }

  console.log(`Fetching ESPN schedule ${yyyymmdd(espnStart)} -> ${yyyymmdd(espnEnd)} ...`);
  const espnEvents = await fetchEspnEvents(espnStart, espnEnd);
  const espnById = new Map(espnEvents.map(e => [e.id, e]));
  console.log(`ESPN returned ${espnEvents.length} events. DB has ${dbEvents.length} upcoming events.\n`);

  let matched = 0, prelimChanged = 0, lockSet = 0, mismatches = 0, unmatched = 0;

  for (const ev of dbEvents) {
    const label = `${ev.event_date}  ${ev.full_name || ev.name}`;
    const m = matchEspnEvent(ev, espnEvents, espnById);
    if (!m) {
      unmatched++;
      console.log(`- ${label}\n    NO ESPN MATCH (no card within +/-1 day, or ambiguous) - skipped`);
      continue;
    }
    matched++;
    const prelim = new Date(m.espn.prelimStart).toISOString();
    const update = {};

    // prelim_start_time: always the factual earliest bout.
    const curPrelim = ev.prelim_start_time ? new Date(ev.prelim_start_time).toISOString() : null;
    if (curPrelim !== prelim) { update.prelim_start_time = prelim; prelimChanged++; }

    // espn_event_id: backfill so future runs match exactly.
    if (!ev.espn_event_id) update.espn_event_id = m.espn.id;

    // lineup_lock_time: default to prelim when unset, or force with --relock.
    const curLock = ev.lineup_lock_time ? new Date(ev.lineup_lock_time).toISOString() : null;
    let lockNote;
    if (!curLock) {
      update.lineup_lock_time = prelim; lockSet++;
      lockNote = `set -> ${prelim}`;
    } else if (RELOCK && curLock !== prelim) {
      update.lineup_lock_time = prelim; lockSet++;
      lockNote = `RELOCK ${curLock} -> ${prelim}`;
    } else if (curLock !== prelim) {
      mismatches++;
      lockNote = `KEPT manual ${curLock}  (differs from prelim ${prelim} - run --relock to sync)`;
    } else {
      lockNote = `already = prelim`;
    }

    console.log(`- ${label}`);
    console.log(`    matched ESPN ${m.espn.id} "${m.espn.name}" [${m.how}]`);
    console.log(`    prelim_start_time: ${curPrelim || '(none)'} -> ${prelim}`);
    console.log(`    lineup_lock_time : ${lockNote}`);

    if (!DRY_RUN && Object.keys(update).length > 0) {
      const { error } = await supabaseClient.from('ufc_events').update(update).eq('id', ev.id);
      if (error) console.log(`    WRITE FAILED: ${error.message}`);
    }
  }

  console.log(`\nSummary: ${matched} matched, ${prelimChanged} prelim times ${DRY_RUN ? 'to set' : 'set'}, ` +
    `${lockSet} locks ${DRY_RUN ? 'to default/relock' : 'defaulted/relocked'}, ` +
    `${mismatches} manual-lock mismatches flagged, ${unmatched} unmatched.`);
  if (DRY_RUN) console.log('(dry run - nothing was written)');
})();
