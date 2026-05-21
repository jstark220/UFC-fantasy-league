// ============================================================================
// applyRankings.js — fetches live UFC rankings from the Octagon API and
// applies them to the fighters table. Replaces the old hardcoded RANKINGS
// object so title changes and ranking shuffles are picked up automatically.
//
// Run: node applyRankings.js
//
// Also run by the GitHub Actions workflow on a weekly schedule.
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

const RANKINGS_URL = 'https://api.octagon-api.com/rankings';

// Map Octagon API division IDs to our DB enum values.
// P4P entries are excluded (no matching division in our schema).
const DIVISION_MAP = {
  'flyweight':              'flyweight',
  'bantamweight':           'bantamweight',
  'featherweight':          'featherweight',
  'lightweight':            'lightweight',
  'welterweight':           'welterweight',
  'middleweight':           'middleweight',
  'light-heavyweight':      'light_heavyweight',
  'heavyweight':            'heavyweight',
  'womens-strawweight':     'strawweight',
  'womens-flyweight':       'flyweight_w',
  'womens-bantamweight':    'bantamweight_w',
};

// ============================================================================
// STEP 1: Reset all rankings so stale data doesn't linger after a title change
// or a fighter dropping out of the top 15.
// ============================================================================
async function resetRankings() {
  console.log('Clearing stale rankings...');
  const { error } = await supabase
    .from('fighters')
    .update({
      current_rank:    null,
      is_champion:     false,
      is_sub_champion: false,
      sub_title_type:  'none',
    })
    .not('id', 'is', null);

  if (error) {
    console.error('Error resetting rankings:', error.message);
    process.exit(1);
  }
  console.log('Reset complete.\n');
}

// ============================================================================
// STEP 2: Fetch live rankings from the Octagon API
// ============================================================================
async function fetchRankings() {
  console.log(`Fetching rankings from ${RANKINGS_URL}...`);
  const res = await fetch(RANKINGS_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UFC-fantasy-scraper/1.0)' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching rankings`);
  const data = await res.json();
  console.log(`Received ${data.length} ranking categories.\n`);
  return data;
}

// ============================================================================
// STEP 3: Apply one division's rankings to the DB
// ============================================================================
async function applyDivision(division) {
  const dbDivision = DIVISION_MAP[division.id];

  // Skip P4P and any categories not in our schema
  if (!dbDivision) return { updated: 0, notFound: [] };

  console.log(`\n${division.categoryName}`);
  let updated = 0;
  const notFound = [];

  // Apply champion
  if (division.champion && division.champion.id) {
    const slug = division.champion.id;
    const { data, error } = await supabase
      .from('fighters')
      .update({
        current_rank:    null,   // champions have no numeric rank
        is_champion:     true,
        is_sub_champion: false,
        sub_title_type:  'none',
      })
      .eq('ufc_id', slug)
      .select('name');

    if (error) {
      console.warn(`  Error updating champion ${slug}: ${error.message}`);
    } else if (data && data.length > 0) {
      console.log(`  [CHAMP]    ${data[0].name}`);
      updated++;
    } else {
      console.log(`  [CHAMP]    NOT FOUND: ${slug}`);
      notFound.push(slug);
    }
  }

  // Apply ranked fighters (index 0 = #1 contender, index 14 = #15)
  const fighters = division.fighters || [];
  for (let i = 0; i < fighters.length; i++) {
    const slug = fighters[i].id;
    const rank  = i + 1;

    const { data, error } = await supabase
      .from('fighters')
      .update({
        current_rank:    rank,
        is_champion:     false,
        is_sub_champion: false,
        sub_title_type:  'none',
      })
      .eq('ufc_id', slug)
      .select('name');

    if (error) {
      console.warn(`  Error updating #${rank} ${slug}: ${error.message}`);
    } else if (data && data.length > 0) {
      console.log(`  #${String(rank).padEnd(2)}         ${data[0].name}`);
      updated++;
    } else {
      console.log(`  #${String(rank).padEnd(2)}         NOT FOUND: ${slug}`);
      notFound.push(slug);
    }
  }

  return { updated, notFound };
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  await resetRankings();

  let rankings;
  try {
    rankings = await fetchRankings();
  } catch (err) {
    console.error('Failed to fetch rankings:', err.message);
    process.exit(1);
  }

  let totalUpdated  = 0;
  const allNotFound = [];

  for (const division of rankings) {
    const { updated, notFound } = await applyDivision(division);
    totalUpdated  += updated;
    allNotFound.push(...notFound);
  }

  console.log('\n============================================================');
  console.log('Done.');
  console.log(`  Updated:   ${totalUpdated} fighters`);
  console.log(`  Not found: ${allNotFound.length} fighters`);
  if (allNotFound.length > 0) {
    console.log('\nSlugs not matched in DB (may need ufc_id set):');
    allNotFound.forEach(slug => console.log(`  - ${slug}`));
  }
  console.log('============================================================');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
