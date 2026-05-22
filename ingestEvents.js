// ============================================================================
// ingestEvents.js
// Scrapes the ufcstats.com event lists (completed + upcoming) and upserts
// all events into the ufc_events Supabase table.
//
// Run: node ingestEvents.js
//
// What it sets:
//   - ufcstats_id (hex from URL, used as upsert key)
//   - full_name   (as scraped, e.g. "UFC 300: Pereira vs Hill")
//   - name        (shortened, e.g. "UFC 300")
//   - event_date  (YYYY-MM-DD)
//   - venue       (location string from ufcstats)
//
// What it does NOT set:
//   - lineup_lock_time  (commissioner sets this manually per event)
// ============================================================================

require('dotenv').config();
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

// Safety check
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env file');
  process.exit(1);
}

const supabaseClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const COMPLETED_URL = 'http://ufcstats.com/statistics/events/completed?page=all';
const UPCOMING_URL  = 'http://ufcstats.com/statistics/events/upcoming';

// ============================================================================
// HELPERS
// ============================================================================

// Pulls the 16-char hex ID out of a ufcstats event URL.
// e.g. "http://ufcstats.com/event-details/1fada8a5f77f5555" -> "1fada8a5f77f5555"
function extractHexId(href) {
  if (!href) return null;
  const match = href.match(/event-details\/([a-f0-9]+)/i);
  return match ? match[1] : null;
}

// "UFC Fight Night: Holloway vs Allen" -> "UFC Fight Night"
// "UFC 300: Pereira vs Hill"            -> "UFC 300"
// "UFC Fight Night"                     -> "UFC Fight Night" (no colon, unchanged)
function shortenName(fullName) {
  if (!fullName) return '';
  const colonIdx = fullName.indexOf(':');
  return colonIdx > -1 ? fullName.slice(0, colonIdx).trim() : fullName.trim();
}

// Parse the date string ufcstats uses: "May. 03, 2025" or "May 03, 2025"
// Returns "YYYY-MM-DD" string or null if unparseable.
function parseDate(str) {
  if (!str) return null;
  // Strip trailing period from abbreviated month ("May." -> "May")
  const cleaned = str.trim().replace(/\b(\w{3})\./g, '$1');
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) {
    console.warn(`  Could not parse date: "${str}"`);
    return null;
  }
  // getTime() uses UTC midnight when given "Month DD, YYYY" strings in V8
  return d.toISOString().slice(0, 10);
}

// ============================================================================
// SCRAPE ONE PAGE (completed or upcoming)
// Returns an array of event objects ready for upsert.
// ============================================================================
async function scrapePage(url, label) {
  console.log(`Fetching ${label} events from: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const events = [];

  // Find every link that points to an event-details page.
  // This is more robust than relying on exact table class names.
  $('a[href*="/event-details/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const ufcstats_id = extractHexId(href);
    if (!ufcstats_id) return; // skip malformed hrefs

    const full_name = $(el).text().trim();
    if (!full_name) return; // skip empty link text (icon links etc.)

    // Walk up to the containing <tr> and grab data
    const $row = $(el).closest('tr');

    // Date lives in <span class="b-statistics__date"> inside the first cell
    // (same cell as the event name link — not a separate column).
    const rawDate = $row.find('.b-statistics__date').text().trim();
    // Location is in the second cell (index 1)
    const venue = $row.find('td').eq(1).text().trim() || null;

    events.push({
      ufcstats_id,
      full_name,
      name: shortenName(full_name),
      event_date: parseDate(rawDate),
      venue,
      // ufcstats lists events on two separate pages — "completed" vs
      // "upcoming". Mark them accordingly so the waiver-phase logic
      // (which anchors to the next non-completed event) doesn't end up
      // hunting back through 30 years of history.
      is_completed: label === 'completed',
    });
  });

  console.log(`  Found ${events.length} events on ${label} page`);
  return events;
}

// ============================================================================
// UPSERT EVENTS INTO SUPABASE
// ============================================================================
async function upsertEvents(events) {
  if (events.length === 0) {
    console.log('No events to upsert.');
    return;
  }

  // Batch in groups of 100 to stay well under request size limits
  const BATCH = 100;
  let upserted = 0;
  let failed = 0;

  for (let i = 0; i < events.length; i += BATCH) {
    const batch = events.slice(i, i + BATCH);
    const { error } = await supabaseClient
      .from('ufc_events')
      .upsert(batch, { onConflict: 'ufcstats_id' });

    if (error) {
      console.error(`  Batch ${Math.floor(i / BATCH) + 1} FAILED: ${error.message}`);
      failed += batch.length;
    } else {
      upserted += batch.length;
      console.log(`  Upserted ${batch.length} events (total so far: ${upserted})`);
    }
  }

  console.log(`\nDone. Upserted: ${upserted}  Failed: ${failed}`);
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  const start = Date.now();

  // Scrape both pages and merge (de-duplicate by ufcstats_id using a Map)
  const [completed, upcoming] = await Promise.all([
    scrapePage(COMPLETED_URL, 'completed'),
    scrapePage(UPCOMING_URL, 'upcoming'),
  ]);

  const byId = new Map();
  for (const ev of [...completed, ...upcoming]) {
    byId.set(ev.ufcstats_id, ev);
  }
  const all = Array.from(byId.values());
  console.log(`\nTotal unique events: ${all.length}`);

  await upsertEvents(all);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nTotal time: ${elapsed}s`);
  console.log('Next step: run "node ingestFightResults.js --all" to seed fight results (2023+)');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
