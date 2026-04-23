// ============================================================================
// updatePhotos.js
// Backfills the img_url and ufc_id columns in the fighters table by
// matching fighter names against the Octagon API.
//
// BEFORE RUNNING: execute this SQL in the Supabase SQL editor:
//   ALTER TABLE fighters ADD COLUMN IF NOT EXISTS img_url TEXT;
//
// Run from terminal: node updatePhotos.js
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env file');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const OCTAGON_API_URL = 'https://api.octagon-api.com/fighters';

// ============================================================================
// NORMALIZE NAME
// Strips diacritics (accents), lowercases, and trims so that:
//   "Jiří Procházka " → "jiri prochazka"
//   "Jiri Prochazka"  → "jiri prochazka"
// This lets us match despite encoding differences between the two data sources.
// ============================================================================
function normalizeName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .normalize('NFD')                    // decompose accented chars into base + combining mark
    .replace(/[̀-ͯ]/g, '')     // strip the combining diacritic marks
    .toLowerCase()
    .trim();
}

// ============================================================================
// STEP 1: Fetch all fighters from Octagon API and build a lookup map
// Key: normalized name → Value: { slug, imgUrl }
// ============================================================================
async function buildOctagonMap() {
  console.log('Fetching all fighters from Octagon API...');
  const response = await fetch(OCTAGON_API_URL);
  if (!response.ok) {
    throw new Error(`Octagon API returned ${response.status}`);
  }
  const data = await response.json();

  const map = {};
  let photoCount = 0;
  for (const [slug, fighter] of Object.entries(data)) {
    if (!fighter.name) continue;
    const key = normalizeName(fighter.name);
    map[key] = {
      slug,
      imgUrl: fighter.imgUrl || null,
    };
    if (fighter.imgUrl) photoCount++;
  }

  console.log(`  Loaded ${Object.keys(map).length} fighters (${photoCount} have photos)\n`);
  return map;
}

// ============================================================================
// STEP 2: Fetch all fighters from the database (id, name, ufc_id, img_url)
// ============================================================================
async function getDbFighters() {
  console.log('Fetching fighters from database...');
  const { data, error } = await supabase
    .from('fighters')
    .select('id, name, ufc_id, img_url');

  if (error) {
    throw new Error(`Database error: ${error.message}`);
  }

  console.log(`  Found ${data.length} fighters in database\n`);
  return data;
}

// ============================================================================
// STEP 3: Match each DB fighter to the Octagon API and update ufc_id + img_url
// ============================================================================
async function backfill(octagonMap, dbFighters) {
  console.log('Matching and updating fighters...\n');

  let updated    = 0;
  let noMatch    = 0;
  let noPhoto    = 0;
  const missed   = [];

  for (const fighter of dbFighters) {
    const key = normalizeName(fighter.name);
    const octagon = octagonMap[key];

    if (!octagon) {
      noMatch++;
      missed.push(fighter.name);
      continue;
    }

    if (!octagon.imgUrl) {
      noPhoto++;
      // Still update ufc_id even if there's no photo
    }

    const { error } = await supabase
      .from('fighters')
      .update({ ufc_id: octagon.slug, img_url: octagon.imgUrl })
      .eq('id', fighter.id);

    if (error) {
      // The most common error here is "column img_url does not exist" — remind user to run the SQL
      if (error.message && error.message.includes('img_url')) {
        console.error('\nERROR: img_url column does not exist.');
        console.error('Run this SQL in the Supabase SQL editor first:');
        console.error('  ALTER TABLE fighters ADD COLUMN IF NOT EXISTS img_url TEXT;\n');
        process.exit(1);
      }
      console.error(`  Error updating "${fighter.name}": ${error.message}`);
    } else {
      updated++;
      const photoTag = octagon.imgUrl ? '+ photo' : 'no photo';
      console.log(`  [${photoTag.padEnd(8)}] ${fighter.name}  →  ${octagon.slug}`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Updated:   ${updated} fighters`);
  console.log(`  No photo:  ${noPhoto} fighters (ufc_id still saved, photo blank)`);
  console.log(`  No match:  ${noMatch} fighters (name not found in Octagon API)`);

  if (missed.length > 0) {
    console.log(`\nFighters not matched (may need manual slug mapping):`);
    missed.forEach(name => console.log(`  - ${name}`));
  }
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  const start = Date.now();

  const octagonMap = await buildOctagonMap();
  const dbFighters = await getDbFighters();
  await backfill(octagonMap, dbFighters);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);
  console.log('\nNext: refresh index.html to see champion photos.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
