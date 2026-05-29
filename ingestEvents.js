// ============================================================================
// ingestEvents.js
// Seeds / refreshes the ufc_events table from ESPN's MMA API.
//
// (Was ufcstats.com, which now serves a JS bot-challenge to non-browser
// clients. ESPN answers plain requests and exposes the same schedule. See
// espnClient.js + sql/2026-05-29_espn_ids.sql.)
//
// What it sets:
//   - espn_event_id  (the new upsert/match key)
//   - full_name, name, event_date (US-Eastern calendar date), venue, city
//   - is_completed
//
// Duplicate-safety: each ESPN event is matched to an existing row by
// espn_event_id, else by date (+/-1 day) + name. We only INSERT when there's
// genuinely no match, so we never duplicate the 786 historical events already
// seeded from ufcstats. Existing rows keep their event_date (we don't shift
// dates that the lock/waiver logic depends on); we just attach espn_event_id
// and refresh is_completed.
//
// Run:
//   node ingestEvents.js                enrich/seed the default window
//   node ingestEvents.js --dry-run      show the plan, write nothing
//   node ingestEvents.js --days=300      look this many days ahead (default 240)
//   node ingestEvents.js --back=180      look this many days back  (default 120)
// ============================================================================

require('dotenv').config();
const espn = require('./espnClient');
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env file');
  process.exit(1);
}
const supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const DRY_RUN = process.argv.includes('--dry-run');
const daysArg = process.argv.find((a) => a.startsWith('--days='));
const backArg = process.argv.find((a) => a.startsWith('--back='));
const DAYS_AHEAD = daysArg ? parseInt(daysArg.split('=')[1], 10) : 240;
const DAYS_BACK = backArg ? parseInt(backArg.split('=')[1], 10) : 120;

// ----------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------

// "UFC 300: Pereira vs Hill" -> "UFC 300"; "UFC Fight Night: X vs Y" ->
// "UFC Fight Night"; no colon -> unchanged.
function shortenName(fullName) {
  if (!fullName) return '';
  const i = fullName.indexOf(':');
  return i > -1 ? fullName.slice(0, i).trim() : fullName.trim();
}

// US-Eastern calendar date (YYYY-MM-DD) for an ISO instant. ufcstats dated
// events by their US date (a Sat-night card is "Saturday" even though it runs
// into Sunday UTC), so we mirror that to stay consistent with existing rows.
function etDate(iso) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

// Whole-day difference between two YYYY-MM-DD strings.
function dayDiff(a, b) {
  return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
}

// --- name matching (tiebreaker; date is primary) ---
function normalizeName(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/ufc/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function eventNumber(s) { const m = normalizeName(s).match(/\b(\d{2,4})\b/); return m ? m[1] : null; }
function surnames(s) {
  const n = normalizeName(s); const i = n.indexOf(' vs ');
  if (i === -1) return new Set();
  return new Set(n.replace(' vs ', ' ').split(' ').filter((w) => w.length >= 3));
}
function nameScore(dbName, espnName) {
  const dn = eventNumber(dbName), en = eventNumber(espnName);
  if (dn && en) return dn === en ? 100 : -100;
  const a = surnames(dbName), b = surnames(espnName); let o = 0;
  a.forEach((w) => { if (b.has(w)) o++; });
  return o * 10;
}

// Find the existing ufc_events row an ESPN event corresponds to, or null.
function matchExisting(espnEvent, existing, byEspnId) {
  if (byEspnId.has(espnEvent.espnEventId)) return byEspnId.get(espnEvent.espnEventId);
  const d = etDate(espnEvent.date);
  const cands = existing
    .map((e) => ({ e, diff: e.event_date ? dayDiff(e.event_date, d) : 99 }))
    .filter((c) => Math.abs(c.diff) <= 1);
  if (cands.length === 0) return null;
  if (cands.length === 1) {
    return nameScore(cands[0].e.full_name || cands[0].e.name, espnEvent.name) < 0 ? null : cands[0].e;
  }
  const scored = cands
    .map((c) => ({ ...c, score: nameScore(c.e.full_name || c.e.name, espnEvent.name) }))
    .sort((x, y) => y.score - x.score);
  return scored[0].score > 0 ? scored[0].e : null;
}

// ----------------------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------------------
(async () => {
  console.log(`ingestEvents (ESPN)${DRY_RUN ? ' [DRY RUN]' : ''} - window -${DAYS_BACK}d .. +${DAYS_AHEAD}d\n`);
  const now = Date.now();
  const start = new Date(now - DAYS_BACK * 86400000);
  const end = new Date(now + DAYS_AHEAD * 86400000);

  const espnEvents = await espn.fetchEventsInRange(start, end);
  console.log(`ESPN returned ${espnEvents.length} events in window.`);

  const { data: existing, error } = await supabaseClient
    .from('ufc_events')
    .select('id, espn_event_id, ufcstats_id, name, full_name, event_date, is_completed');
  if (error) { console.error('Failed to load ufc_events:', error.message); process.exit(1); }
  const byEspnId = new Map(existing.filter((e) => e.espn_event_id).map((e) => [e.espn_event_id, e]));

  let updated = 0, inserted = 0, unchanged = 0;

  for (const ev of espnEvents) {
    const match = matchExisting(ev, existing, byEspnId);
    if (match) {
      // Attach espn_event_id + refresh is_completed; preserve event_date/name.
      const patch = {};
      if (match.espn_event_id !== ev.espnEventId) patch.espn_event_id = ev.espnEventId;
      if (match.is_completed !== ev.completed) patch.is_completed = ev.completed;
      if (!match.full_name && ev.name) { patch.full_name = ev.name; patch.name = shortenName(ev.name); }
      if (Object.keys(patch).length === 0) { unchanged++; continue; }
      updated++;
      console.log(`UPDATE  ${match.event_date}  ${match.full_name || match.name}  <- ${JSON.stringify(patch)}`);
      if (!DRY_RUN) {
        const r = await supabaseClient.from('ufc_events').update(patch).eq('id', match.id);
        if (r.error) console.log('   write failed: ' + r.error.message);
      }
    } else {
      const row = {
        espn_event_id: ev.espnEventId,
        full_name: ev.name,
        name: shortenName(ev.name),
        event_date: etDate(ev.date),
        venue: ev.venue,
        city: ev.city,
        is_completed: ev.completed,
      };
      inserted++;
      console.log(`INSERT  ${row.event_date}  ${row.full_name}  (${ev.city || ev.venue || '?'})`);
      if (!DRY_RUN) {
        const r = await supabaseClient.from('ufc_events').insert(row);
        if (r.error) console.log('   insert failed: ' + r.error.message);
      }
    }
  }

  console.log(`\nSummary: ${inserted} inserted, ${updated} updated, ${unchanged} unchanged.`);
  if (DRY_RUN) console.log('(dry run - nothing written)');
})().catch((err) => { console.error('Fatal error:', err); process.exit(1); });
