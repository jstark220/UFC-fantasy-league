// ============================================================================
// fetchFighterPhotos.js
// Fetches every fighter's UFC profile page, extracts the full-body athlete
// photo URL, and stores it in fighters.photo_url.
//
// Prereq: run this SQL in the Supabase dashboard first:
//   ALTER TABLE fighters ADD COLUMN IF NOT EXISTS photo_url TEXT;
//
// Run: node fetchFighterPhotos.js
//
// The script processes fighters in batches of 10 with a short delay between
// each request so we don't hammer UFC's servers. Expect it to take ~5 minutes
// for all 233 fighters.
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

// Mimic a real browser so UFC's CDN doesn't reject the request
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
};

// Milliseconds to wait between individual requests
const DELAY_MS = 300;

// ============================================================================
// EXTRACT PHOTO URL
// The UFC athlete page embeds the full-body image as an <img> with a src
// pointing to the athlete_bio_full_body image style. We pull it out with a
// simple regex so we don't need an HTML parser dependency.
// ============================================================================
function extractPhotoUrl(html) {
  // Match the first occurrence of the athlete_bio_full_body image src
  const match = html.match(/src="(https:\/\/ufc\.com\/images\/styles\/athlete_bio_full_body[^"]+)"/);
  return match ? match[1] : null;
}

// ============================================================================
// FETCH ONE FIGHTER'S PHOTO URL
// Returns the image URL string, or null if the page 404s or has no photo.
// ============================================================================
async function fetchPhotoUrl(ufcId) {
  const url = 'https://www.ufc.com/athlete/' + ufcId;
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return null;
    const html = await res.text();
    return extractPhotoUrl(html);
  } catch {
    return null;
  }
}

// ============================================================================
// SLEEP HELPER
// ============================================================================
function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  // Load all fighters that don't have a photo_url yet
  const { data: fighters, error } = await supabase
    .from('fighters')
    .select('id, name, ufc_id')
    .is('photo_url', null)
    .not('ufc_id', 'is', null)
    .order('name');

  if (error) {
    console.error('Failed to load fighters:', error.message);
    process.exit(1);
  }

  console.log('Fighters to process:', fighters.length, '\n');

  let found = 0;
  let missing = 0;

  for (let i = 0; i < fighters.length; i++) {
    const fighter = fighters[i];
    const progress = '[' + (i + 1) + '/' + fighters.length + ']';

    const photoUrl = await fetchPhotoUrl(fighter.ufc_id);

    if (photoUrl) {
      const { error: updateError } = await supabase
        .from('fighters')
        .update({ photo_url: photoUrl })
        .eq('id', fighter.id);

      if (updateError) {
        console.log(progress, 'ERROR saving', fighter.name + ':', updateError.message);
      } else {
        console.log(progress, 'OK  ', fighter.name);
        found++;
      }
    } else {
      console.log(progress, 'MISS', fighter.name, '(no photo found at /athlete/' + fighter.ufc_id + ')');
      missing++;
    }

    // Polite delay between requests
    if (i < fighters.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  console.log('\n--- Done ---');
  console.log('Photos found and saved:', found);
  console.log('No photo found:        ', missing);
}

main();
