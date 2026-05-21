// ============================================================================
// scrapePhotos.js
// Fills in photo_url for active fighters that don't have one yet.
//
// Run: node scrapePhotos.js
//
// How it works:
//   1. Loads all active fighters from the DB that have no photo_url.
//   2. For each fighter, constructs a UFC.com athlete URL from their name:
//        "Jon Jones"  ->  https://www.ufc.com/athlete/jon-jones
//      (for fighters created via ufcstats the ufc_id is "ufcstats-jon-jones",
//      so we strip that prefix to get the slug; for Octagon API fighters the
//      ufc_id IS the slug already, e.g. "jon-jones")
//   3. Fetches the page and reads the og:image meta tag, which always points
//      to the official UFC.com fighter headshot CDN URL.
//   4. Writes the URL back to fighters.photo_url.
//
// Fighters with no UFC.com profile (very old retired fighters) will get a 404
// and are skipped gracefully.
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabaseClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Be polite: wait between requests so we don't get rate-limited by UFC.com.
const REQUEST_DELAY_MS = 300;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Convert a fighter name or ufc_id to the slug used in UFC.com URLs.
// "Jon Jones"           -> "jon-jones"
// "ufcstats-jon-jones"  -> "jon-jones"  (strip prefix)
// "jon-jones"           -> "jon-jones"  (already a slug)
function toAthleteSlug(fighter) {
  // If the ufc_id looks like a normal Octagon API slug (no "ufcstats-" prefix),
  // use it directly since it was sourced from UFC.com already.
  if (fighter.ufc_id && !fighter.ufc_id.startsWith('ufcstats-')) {
    return fighter.ufc_id;
  }

  // For ufcstats-created fighters, derive slug from the display name.
  const name = fighter.name || '';
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip accent marks
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')        // remove punctuation
    .trim()
    .replace(/\s+/g, '-');             // spaces to hyphens
}

// Fetch a UFC.com athlete page and return the og:image URL, or null on miss.
async function fetchPhotoUrl(slug) {
  const url = `https://www.ufc.com/athlete/${slug}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UFC-fantasy-bot/1.0)' },
    });
  } catch (err) {
    return null; // network error
  }

  if (!res.ok) return null; // 404 or other HTTP error

  const html = await res.text();

  // The og:image meta tag contains the fighter headshot CDN URL.
  // Example: <meta property="og:image" content="https://ufc.com/images/..." />
  const match = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i)
             || html.match(/<meta\s+content="([^"]+)"\s+property="og:image"/i);

  if (!match) return null;

  const imgUrl = match[1];

  // Skip generic UFC logo images (used on pages without a fighter-specific photo).
  if (imgUrl.includes('ufc-232x232') || imgUrl.includes('default') || imgUrl.includes('logo')) {
    return null;
  }

  return imgUrl;
}

async function main() {
  const start = Date.now();

  // Load all active fighters with no photo_url, paginated.
  console.log('Loading active fighters without photos...');
  const fighters = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabaseClient
      .from('fighters')
      .select('id, name, ufc_id')
      .eq('is_active', true)
      .is('photo_url', null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error('Failed to load fighters: ' + error.message);
    fighters.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`  ${fighters.length} active fighters need photos\n`);

  let found = 0;
  let missing = 0;

  for (let i = 0; i < fighters.length; i++) {
    const fighter = fighters[i];
    const slug = toAthleteSlug(fighter);

    await sleep(REQUEST_DELAY_MS);

    const photoUrl = await fetchPhotoUrl(slug);

    if (photoUrl) {
      const { error } = await supabaseClient
        .from('fighters')
        .update({ photo_url: photoUrl })
        .eq('id', fighter.id);

      if (error) {
        console.warn(`  DB update failed for ${fighter.name}: ${error.message}`);
      } else {
        found++;
        if (found % 20 === 0) {
          process.stdout.write(`  [${i + 1}/${fighters.length}] ${found} photos saved so far...\n`);
        }
      }
    } else {
      missing++;
    }
  }

  const elapsed = ((Date.now() - start) / 1000 / 60).toFixed(1);
  console.log(`\nDone in ${elapsed} minutes.`);
  console.log(`  Photos found and saved: ${found}`);
  console.log(`  No UFC.com page found:  ${missing}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
