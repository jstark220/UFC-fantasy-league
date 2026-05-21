// ============================================================================
// scrapeActiveFromEvents.js
// Scans ufcstats event pages to find fighters not yet in the DB or marked
// is_active=false, and marks them active. Handles two cases:
//
//   1. UPCOMING events: fighters on announced cards who have no ufcstats
//      profile yet (so scrapeFighters.js missed them) but are clearly active.
//
//   2. RECENT PAST events (last RECENT_MONTHS months): fighters who appeared
//      in fight results and were auto-created by ingestFightResults.js with
//      is_active=false (because that script conservatively marks new entries
//      inactive). Any fighter who competed recently should be in the free
//      agent pool.
//
// Usage:
//   node scrapeActiveFromEvents.js
//
// Safe to re-run: already-active fighters are skipped without a DB write.
// Does NOT deactivate any fighters (that's scrapeFighters.js territory).
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

// How far back to look in completed events for fighters to (re-)activate.
// 12 months catches everyone who has fought in the past year.
const RECENT_MONTHS = 12;

// Polite scraping delay
const REQUEST_DELAY_MS = 200;

// ============================================================================
// HELPERS
// ============================================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchHtml(url) {
  await sleep(REQUEST_DELAY_MS);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UFC-fantasy-scraper/1.0)' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// Strip accents, lowercase, remove punctuation so "Jiří Procházka" == "jiri prochazka"
function normalizeName(name) {
  if (!name) return '';
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Map the weight class text from ufcstats event pages (e.g., "Bantamweight")
// to the DB enum value (e.g., "bantamweight"). Returns null for catch weight / open
// weight bouts, which are skipped.
const WEIGHT_CLASS_MAP = {
  'Heavyweight':           'heavyweight',
  'Light Heavyweight':     'light_heavyweight',
  'Middleweight':          'middleweight',
  'Welterweight':          'welterweight',
  'Lightweight':           'lightweight',
  'Featherweight':         'featherweight',
  'Bantamweight':          'bantamweight',
  'Flyweight':             'flyweight',
  "Women's Strawweight":   'strawweight',
  "Women's Flyweight":     'flyweight_w',
  "Women's Bantamweight":  'bantamweight_w',
  "Women's Featherweight": 'featherweight',
  'Catch Weight':          null,
  'Open Weight':           null,
};

function mapWeightClass(raw) {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/\s*bout$/i, '').trim();
  if (Object.prototype.hasOwnProperty.call(WEIGHT_CLASS_MAP, cleaned)) {
    return WEIGHT_CLASS_MAP[cleaned];
  }
  // Partial match fallback for label variants
  for (const [key, val] of Object.entries(WEIGHT_CLASS_MAP)) {
    if (key && cleaned.includes(key)) return val;
  }
  return null;
}

// ============================================================================
// LOAD FIGHTER LOOKUP
// Returns Map<normalizedName, { id, is_active }>
// Used to check whether a fighter is already in the DB and whether they need
// to be activated. Paginated to handle the full ~6k fighter table.
// ============================================================================
async function loadFighterLookup() {
  console.log('Loading fighters from DB...');
  const lookup = new Map();
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabaseClient
      .from('fighters')
      .select('id, name, ufc_id, is_active')
      .range(from, from + PAGE - 1);
    if (error) {
      console.error('DB error loading fighters:', error.message);
      process.exit(1);
    }
    for (const f of data) {
      lookup.set(normalizeName(f.name), { id: f.id, is_active: f.is_active, ufc_id: f.ufc_id });
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`  Loaded ${lookup.size} fighters.`);
  return lookup;
}

// ============================================================================
// SCRAPE EVENT LIST PAGE
// Fetches either the upcoming or completed events index and returns an array
// of { ufcstatsId, name, date } objects. For upcoming events, date is null.
// For completed events, date is a JS Date parsed from the page.
// ============================================================================
async function scrapeEventListPage(url, isUpcoming) {
  let html;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    console.error(`Failed to fetch event list ${url}: ${err.message}`);
    return [];
  }

  const $ = cheerio.load(html);
  const events = [];

  // Both the upcoming and completed pages share the same row structure.
  // td[0] contains the event name link AND (on the completed page) a
  // <span class="b-statistics__date"> with the date. td[1] is the location.
  $('tr.b-statistics__table-row').each((_, row) => {
    const $row = $(row);
    const $td0 = $row.find('td').eq(0);

    // Event name link
    const $link = $td0.find('a');
    const href  = $link.attr('href') || '';
    const name  = $link.text().trim();

    const hexMatch = href.match(/event-details\/([a-f0-9]+)/i);
    if (!hexMatch || !name) return; // skip header / empty rows

    // Date lives in a <span class="b-statistics__date"> inside the same cell
    let date = null;
    if (!isUpcoming) {
      const dateStr = $td0.find('span.b-statistics__date').text().trim();
      if (dateStr) {
        const parsed = new Date(dateStr);
        if (!isNaN(parsed.getTime())) date = parsed;
      }
    }

    events.push({ ufcstatsId: hexMatch[1], name, date });
  });

  return events;
}

// ============================================================================
// SCRAPE FIGHTERS FROM ONE EVENT PAGE
// Returns an array of { name, weightClass } objects.
// Upcoming events use the same HTML layout as completed events — fight rows
// have data-link to the fight-details URL, fighters are in td[1], and the
// weight class is in td[6].
// ============================================================================
async function scrapeEventFighters(ufcstatsId, eventName) {
  const url = `http://ufcstats.com/event-details/${ufcstatsId}`;
  let html;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    console.warn(`  Skipping ${eventName}: ${err.message}`);
    return [];
  }

  const $ = cheerio.load(html);
  const fighters = [];

  $('tr[data-link*="/fight-details/"]').each((_, row) => {
    const $row = $(row);

    // td[1]: two <a> links with fighter names
    const $nameCells = $row.find('td').eq(1).find('a');
    const nameA = $nameCells.eq(0).text().trim();
    const nameB = $nameCells.eq(1).text().trim();

    // td[6]: weight class label
    const weightClassRaw = $row.find('td').eq(6).text().trim();
    const weightClass    = mapWeightClass(weightClassRaw);

    if (nameA) fighters.push({ name: nameA, weightClass });
    if (nameB) fighters.push({ name: nameB, weightClass });
  });

  return fighters;
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  const lookup = await loadFighterLookup();

  // --- Step 1: upcoming events ---
  console.log('\nFetching upcoming events...');
  const upcoming = await scrapeEventListPage(
    'http://ufcstats.com/statistics/events/upcoming',
    true
  );
  console.log(`  Found ${upcoming.length} upcoming events.`);

  // --- Step 2: recent completed events ---
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - RECENT_MONTHS);
  console.log(`\nFetching completed events since ${cutoff.toDateString()}...`);

  const allCompleted = await scrapeEventListPage(
    'http://ufcstats.com/statistics/events/completed?page=all',
    false
  );
  // Keep only events within the recent window (undated entries are excluded)
  const recentCompleted = allCompleted.filter(e => e.date && e.date >= cutoff);
  console.log(`  Found ${recentCompleted.length} recent completed events (of ${allCompleted.length} total).`);

  // --- Step 3: process all events ---
  const allEvents = [...upcoming, ...recentCompleted];
  console.log(`\nProcessing ${allEvents.length} events total...`);

  let created   = 0;
  let activated = 0;
  let skipped   = 0;
  let errors    = 0;

  for (const event of allEvents) {
    console.log(`\n${event.name}`);

    const fighters = await scrapeEventFighters(event.ufcstatsId, event.name);
    if (fighters.length === 0) {
      console.log('  No fighters found (card may not be announced yet).');
      continue;
    }

    for (const { name, weightClass } of fighters) {
      const norm     = normalizeName(name);
      const existing = lookup.get(norm);

      if (existing && existing.is_active) {
        // Already active — nothing to do
        skipped++;
        continue;
      }

      if (existing && !existing.is_active) {
        // Fighter is in the DB but marked inactive — flip them active
        const { error } = await supabaseClient
          .from('fighters')
          .update({ is_active: true })
          .eq('id', existing.id);

        if (error) {
          console.warn(`  Error activating "${name}": ${error.message}`);
          errors++;
        } else {
          console.log(`  Activated: "${name}"`);
          // Update lookup so we don't attempt this again for the same fighter
          existing.is_active = true;
          activated++;
        }
        continue;
      }

      // Fighter not in DB at all — create a minimal active stub.
      // Uses the same "ufcstats-" ufc_id prefix convention as ingestFightResults.js
      // so that script can later upsert full stats without creating a duplicate.
      if (!weightClass) {
        // Catch weight / open weight bouts — skip, no valid division to assign
        console.warn(`  Skipping "${name}" (no mappable weight class)`);
        continue;
      }

      const ufc_id = 'ufcstats-' + norm.replace(/ /g, '-');
      const { data, error } = await supabaseClient
        .from('fighters')
        .upsert({
          name,
          ufcstats_name:      name,
          ufc_id,
          primary_division:   weightClass,
          is_active:          true,
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
        console.warn(`  Error creating "${name}": ${error?.message}`);
        errors++;
      } else {
        console.log(`  Created: "${name}" (${weightClass})`);
        // Add to in-memory lookup so the same fighter on another event is skipped
        lookup.set(norm, { id: data.id, is_active: true, ufc_id });
        created++;
      }
    }
  }

  console.log('\n============================================================');
  console.log(`Done.`);
  console.log(`  Created (new fighters):   ${created}`);
  console.log(`  Activated (was inactive): ${activated}`);
  console.log(`  Already active (skipped): ${skipped}`);
  if (errors > 0) console.log(`  Errors:                   ${errors}`);
  console.log('============================================================');
  console.log('\nNext step: run node scrapePhotos.js to fetch photos for any newly created fighters.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
