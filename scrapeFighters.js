// ============================================================================
// scrapeFighters.js
// Scrapes the complete fighter list from ufcstats.com (all 26 letters) and:
//   1. Updates W/L/D records for fighters already in the DB
//   2. Creates new fighters found on ufcstats that aren't in the DB yet
//   3. Marks fighters as is_active=true if they have a fight result in our DB
//      from 2022 onward
//
// Run: node scrapeFighters.js
//
// Why this is needed:
//   The Octagon API only returns ~174 ranked/champion fighters. ufcstats has
//   everyone who has ever competed in the UFC (3,000+). The ingestFightResults
//   script auto-creates fighters from 2023+ events, but those entries have
//   record 0-0-0. This script fills in the real records and marks recent
//   fighters as active.
//
// Notes on division inference for new fighters:
//   ufcstats fighter list shows weight in lbs, not men's/women's division.
//   - 115 lbs is always women's strawweight (no men's strawweight in UFC).
//   - 145/135/125 could be men's or women's. Since auto-created women fighters
//     from the ingest already exist in the DB with correct divisions, this
//     script will UPDATE them (not re-create). New fighters at those weights
//     get men's division as a default; run ingestFightResults to correct any
//     edge cases.
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

const REQUEST_DELAY_MS = 100;

// ============================================================================
// HELPERS
// ============================================================================

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

// ufcstats stores weight as "155 lbs." — parse to division enum.
// Defaults to men's for ambiguous weights (145/135/125); women's fighters from
// 2023+ events are already in the DB from auto-create with correct division.
const WEIGHT_TO_DIVISION = {
  265: 'heavyweight',
  205: 'light_heavyweight',
  185: 'middleweight',
  170: 'welterweight',
  155: 'lightweight',
  145: 'featherweight',
  135: 'bantamweight',
  125: 'flyweight',
  115: 'strawweight',    // women's only in the UFC
};

function parseDivisionFromWeight(weightStr) {
  if (!weightStr) return null;
  const lbs = parseInt(weightStr.replace(/[^0-9]/g, ''), 10);
  return WEIGHT_TO_DIVISION[lbs] || null;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================================
// LOAD EXISTING FIGHTERS FROM DB
// ============================================================================
async function loadFighterLookup() {
  console.log('Loading fighters from DB...');

  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabaseClient
      .from('fighters')
      .select('id, name, ufcstats_name, primary_division')
      .range(from, from + PAGE - 1);
    if (error) throw new Error('Failed to load fighters: ' + error.message);
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const byUfcstatsName = new Map();  // exact ufcstats_name → id
  const byNormName = new Map();      // normalized name → id

  for (const f of all) {
    if (f.ufcstats_name) byUfcstatsName.set(f.ufcstats_name, f.id);
    byNormName.set(normalizeName(f.name), f.id);
  }

  console.log(`  Loaded ${all.length} fighters\n`);
  return { byUfcstatsName, byNormName };
}

// ============================================================================
// LOAD FIGHTER IDs WITH RECENT FIGHT RESULTS (2022+)
// These should be marked is_active=true.
// ============================================================================
async function loadRecentlyActiveFighterIds() {
  // Find all fighter_a_id and fighter_b_id values from fights since 2022-01-01.
  // Paginate because fight_results can exceed Supabase's 1000-row default limit.
  const ids = new Set();
  const PAGE = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabaseClient
      .from('fight_results')
      .select('fighter_a_id, fighter_b_id, event:ufc_events(event_date)')
      .gte('event.event_date', '2022-01-01')
      .range(from, from + PAGE - 1);

    if (error) {
      console.warn('Could not load recent fight results:', error.message);
      break;
    }

    for (const row of data || []) {
      if (row.fighter_a_id) ids.add(row.fighter_a_id);
      if (row.fighter_b_id) ids.add(row.fighter_b_id);
    }

    if ((data || []).length < PAGE) break;
    from += PAGE;
  }

  console.log(`  ${ids.size} fighters have fight results since 2022\n`);
  return ids;
}

// ============================================================================
// SCRAPE FIGHTERS FOR ONE LETTER
// Returns array of { fullName, wins, losses, draws, division }
// ============================================================================
async function scrapeLetterPage(char) {
  await sleep(REQUEST_DELAY_MS);
  const url = `http://ufcstats.com/statistics/fighters?char=${char}&page=all`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const fighters = [];

  // ufcstats fighter rows: each data row has a link to /fighter-details/.
  // Deduplicate by href since each fighter's cells all link to the same profile.
  const seenHrefs = new Set();

  $('a[href*="/fighter-details/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || seenHrefs.has(href)) return;
    seenHrefs.add(href);

    const $row = $(el).closest('tr');
    const cells = $row.find('td');
    if (cells.length < 10) return; // skip header or malformed rows

    // Columns: FirstName(0) | LastName(1) | Nickname(2) | Height(3) | Weight(4)
    //          Reach(5) | Stance(6) | Wins(7) | Losses(8) | Draws(9) | Belt(10)
    const firstName = cells.eq(0).text().trim();
    const lastName  = cells.eq(1).text().trim();
    const weight    = cells.eq(4).text().trim();
    const wins      = parseInt(cells.eq(7).text().trim(), 10) || 0;
    const losses    = parseInt(cells.eq(8).text().trim(), 10) || 0;
    const draws     = parseInt(cells.eq(9).text().trim(), 10) || 0;

    if (!firstName && !lastName) return;
    const fullName = (firstName + ' ' + lastName).trim();

    fighters.push({
      fullName,
      wins,
      losses,
      draws,
      division: parseDivisionFromWeight(weight),
    });
  });

  return fighters;
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  const start = Date.now();

  const lookup = await loadFighterLookup();
  const recentlyActiveIds = await loadRecentlyActiveFighterIds();

  // Collect all updates and creates across all letters
  const updates = [];        // { id, wins, losses, draws }
  const creates = [];        // new fighters not in DB
  const pendingNorms = new Set(); // norms for fighters queued in creates (not yet in DB)

  const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');

  for (const char of letters) {
    process.stdout.write(`Scraping letter ${char.toUpperCase()}...`);
    let fighters;
    try {
      fighters = await scrapeLetterPage(char);
    } catch (err) {
      console.log(` FAILED: ${err.message}`);
      continue;
    }
    console.log(` ${fighters.length} fighters`);

    for (const f of fighters) {
      const norm = normalizeName(f.fullName);

      // Skip fighters already queued for creation this run
      if (pendingNorms.has(norm)) continue;

      // Fast path: exact ufcstats_name match, then normalized name
      const existingId = lookup.byUfcstatsName.get(f.fullName)
                      || lookup.byNormName.get(norm);

      if (existingId) {
        updates.push({ id: existingId, record_wins: f.wins, record_losses: f.losses, record_draws: f.draws });
        // Cache ufcstats_name if not already set
        if (!lookup.byUfcstatsName.has(f.fullName)) {
          lookup.byUfcstatsName.set(f.fullName, existingId);
          updates[updates.length - 1].ufcstats_name = f.fullName;
        }
      } else {
        // Not in DB — create if we can infer a division
        if (!f.division) continue; // skip catch-weight fighters
        const ufc_id = 'ufcstats-' + norm.replace(/ /g, '-');
        creates.push({
          name:               f.fullName,
          ufcstats_name:      f.fullName,
          ufc_id,
          primary_division:   f.division,
          is_active:          false,
          record_wins:        f.wins,
          record_losses:      f.losses,
          record_draws:       f.draws,
          record_no_contests: 0,
          current_rank:       null,
          is_champion:        false,
          is_sub_champion:    false,
          sub_title_type:     'none',
        });
        // Track pending so duplicates within the same run don't re-create
        pendingNorms.add(norm);
      }
    }
  }

  console.log(`\nScraping done. ${updates.length} updates, ${creates.length} new fighters to create.`);

  // ---- Apply record updates in batches ----
  console.log('\nApplying record updates...');
  let updatedCount = 0;
  const UPDATE_BATCH = 50;
  for (let i = 0; i < updates.length; i += UPDATE_BATCH) {
    const batch = updates.slice(i, i + UPDATE_BATCH);
    for (const u of batch) {
      const fields = { record_wins: u.record_wins, record_losses: u.record_losses, record_draws: u.record_draws };
      if (u.ufcstats_name) fields.ufcstats_name = u.ufcstats_name;
      const { error } = await supabaseClient.from('fighters').update(fields).eq('id', u.id);
      if (error) console.warn(`  Update failed for ${u.id}: ${error.message}`);
      else updatedCount++;
    }
    if ((i / UPDATE_BATCH) % 10 === 0) process.stdout.write('.');
  }
  console.log(`\n  Updated ${updatedCount} fighters`);

  // ---- Create new fighters in batches ----
  if (creates.length > 0) {
    console.log('\nCreating new fighters...');
    let createdCount = 0;
    const CREATE_BATCH = 100;
    for (let i = 0; i < creates.length; i += CREATE_BATCH) {
      const batch = creates.slice(i, i + CREATE_BATCH);
      const { error } = await supabaseClient
        .from('fighters')
        .upsert(batch, { onConflict: 'ufc_id' });
      if (error) console.warn(`  Create batch failed: ${error.message}`);
      else createdCount += batch.length;
    }
    console.log(`  Created ${createdCount} fighters`);
  }

  // ---- Mark recently active fighters ----
  // Reload the DB to pick up any newly created fighters, then mark is_active
  // for all fighters who appear in fight_results from 2022+.
  if (recentlyActiveIds.size > 0) {
    console.log('\nMarking recently active fighters...');
    const ids = [...recentlyActiveIds];
    // Supabase .in() has a max of ~300 items per call; chunk it
    const CHUNK = 200;
    let markedCount = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const { error } = await supabaseClient
        .from('fighters')
        .update({ is_active: true })
        .in('id', chunk);
      if (error) console.warn(`  is_active update failed: ${error.message}`);
      else markedCount += chunk.length;
    }
    console.log(`  Marked ${markedCount} fighters as is_active=true`);
  }

  // Final count
  const { count } = await supabaseClient.from('fighters').select('*', { count: 'exact', head: true });
  const { count: activeCount } = await supabaseClient.from('fighters').select('*', { count: 'exact', head: true }).eq('is_active', true);
  console.log(`\nFinal fighter count: ${count} total, ${activeCount} active`);

  const elapsed = ((Date.now() - start) / 1000 / 60).toFixed(1);
  console.log(`Total time: ${elapsed} minutes`);
  console.log('\nNext step: run "node applyRankings.js" to re-apply champion/ranking flags');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
