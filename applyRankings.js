// ============================================================================
// applyRankings.js — scrapes ufc.com/rankings (the authoritative source) and
// applies champion + ranking data to the fighters table.
//
// Why UFC.com instead of the Octagon API:
//   The Octagon API rankings can lag months behind reality on title changes.
//   UFC.com is updated immediately after every event. Scraping it directly
//   eliminates the lag and removes the need for fight-history fallbacks.
//
// What it sets per fighter:
//   - is_champion        (true for the division's champion, false otherwise)
//   - current_rank       (1-15 for ranked contenders, null for unranked/champ)
//   - is_sub_champion +  (true with sub_title_type='interim' if UFC.com tags
//     sub_title_type        them as interim — currently UFC.com doesn't mark
//                           interim separately, so this stays false for now)
//
// Run: node applyRankings.js
// Also runs in the GitHub Actions weekly pipeline.
// ============================================================================

require('dotenv').config();
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const UFC_RANKINGS_URL = 'https://www.ufc.com/rankings';

// Map UFC.com division header text to our DB enum value.
// P4P sections are excluded (no matching division in our schema).
const DIVISION_MAP = {
  'flyweight':                  'flyweight',
  'bantamweight':               'bantamweight',
  'featherweight':              'featherweight',
  'lightweight':                'lightweight',
  'welterweight':               'welterweight',
  'middleweight':               'middleweight',
  'light heavyweight':          'light_heavyweight',
  'heavyweight':                'heavyweight',
  "women's strawweight":        'strawweight',
  "women's flyweight":          'flyweight_w',
  "women's bantamweight":       'bantamweight_w',
};

// ============================================================================
// STEP 1: Fetch UFC.com rankings HTML
// ============================================================================
async function fetchRankingsHtml() {
  console.log(`Fetching ${UFC_RANKINGS_URL}...`);
  const res = await fetch(UFC_RANKINGS_URL, {
    headers: {
      // Realistic browser headers — UFC.com serves a Cloudflare-like challenge
      // if the User-Agent looks like a bot.
      'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9',
      'Accept-Language': 'en-US,en;q=0.9',
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching rankings`);
  return res.text();
}

// ============================================================================
// STEP 2: Parse the HTML into a structured ranking list
//
// UFC.com structure per division:
//   <div class="view-grouping">
//     <div class="view-grouping-header">Flyweight</div>
//     <div class="view-grouping-content">
//       <div class="rankings--athlete--champion">
//         <a href="/athlete/joshua-van">Joshua Van</a>
//       </div>
//       <a href="/athlete/alexandre-pantoja">Alexandre Pantoja</a>  ← #1
//       <a href="/athlete/manel-kape">Manel Kape</a>                ← #2
//       ... up to 15 contenders
//     </div>
//   </div>
// ============================================================================
function parseRankings(html) {
  const $ = cheerio.load(html);
  const divisions = [];

  $('.view-grouping').each((_, group) => {
    const $group  = $(group);
    const heading = $group.find('.view-grouping-header').first().text().trim();

    // Map header text to our division enum; skip P4P and unrecognized headers
    const key = heading.toLowerCase()
      .replace(/&#039;/g, "'")   // HTML-decode lingering &#039; if cheerio missed it
      .replace(/[’‘]/g, "'")  // normalize curly apostrophes
      .replace(/\s+/g, ' ')
      .trim();

    const dbDivision = DIVISION_MAP[key];
    if (!dbDivision) return;

    // Champion is the first athlete link inside the grouping content
    const $content = $group.find('.view-grouping-content').first();
    const athleteLinks = $content.find('a[href*="/athlete/"]').toArray();
    if (athleteLinks.length === 0) return;

    // First entry is the champion. Subsequent entries are ranked 1-15.
    const champLink = athleteLinks[0];
    const champSlug = ($(champLink).attr('href') || '').replace(/^.*\/athlete\//, '');
    const champName = $(champLink).text().trim();

    const contenders = [];
    for (let i = 1; i < athleteLinks.length; i++) {
      const link = athleteLinks[i];
      const slug = ($(link).attr('href') || '').replace(/^.*\/athlete\//, '');
      const name = $(link).text().trim();
      if (slug && name) contenders.push({ slug, name, rank: i });  // rank = i (1-indexed)
    }

    divisions.push({
      heading,
      dbDivision,
      champion:   { slug: champSlug, name: champName },
      contenders,
    });
  });

  return divisions;
}

// ============================================================================
// STEP 3: Reset all rankings so stale data doesn't linger
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
// STEP 4: Apply parsed rankings to the DB. Tries to match each fighter by:
//   1. ufc_id slug from UFC.com (matches our existing slugs in most cases)
//   2. Name fallback for slug mismatches (e.g., Octagon's "weili-zhang" vs
//      UFC.com's "zhang-weili")
// ============================================================================
async function applyRankings(divisions) {
  // Build a name → fighter lookup for the fallback path
  console.log('Loading fighter directory for name fallback...');
  let from = 0;
  const all = [];
  while (true) {
    const { data, error } = await supabase
      .from('fighters')
      .select('id, name, ufc_id, primary_division')
      .range(from, from + 999);
    if (error) { console.error(error.message); process.exit(1); }
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  const byUfcId = new Map();
  const byName  = new Map();
  for (const f of all) {
    if (f.ufc_id) byUfcId.set(f.ufc_id, f);
    if (f.name)   byName.set(f.name.toLowerCase().trim(), f);
  }
  console.log(`  Loaded ${all.length} fighters.\n`);

  // Try ufc_id slug, then fall back to name match
  function findFighter(slug, name) {
    return byUfcId.get(slug)
        || byName.get((name || '').toLowerCase().trim())
        || null;
  }

  let updated  = 0;
  let notFound = [];

  // Champions get applied unconditionally — also update their primary_division
  // to match the belt they hold (e.g. Makhachev moved up from lightweight to
  // welterweight and now holds the welterweight belt).
  //
  // Ranked contenders are ONLY applied when the UFC.com section matches the
  // fighter's primary_division. This prevents Max Holloway (primary=lightweight)
  // from having his lightweight rank overwritten when he also appears in the
  // featherweight section, and vice versa for cross-listed fighters.
  for (const div of divisions) {
    console.log(`\n${div.heading} (${div.dbDivision})`);

    // Champion
    const champ = findFighter(div.champion.slug, div.champion.name);
    if (champ) {
      const { error } = await supabase
        .from('fighters')
        .update({
          current_rank:     null,
          is_champion:      true,
          is_sub_champion:  false,
          sub_title_type:   'none',
          primary_division: div.dbDivision,   // sync division to the belt they hold
        })
        .eq('id', champ.id);
      if (error) console.warn(`  Error updating ${champ.name}: ${error.message}`);
      else { console.log(`  [CHAMP]    ${champ.name}`); updated++; }
    } else {
      notFound.push(`${div.heading}: champion ${div.champion.name} (${div.champion.slug})`);
      console.log(`  [CHAMP]    NOT FOUND: ${div.champion.name} (${div.champion.slug})`);
    }

    // Contenders. UFC.com is the source of truth — if they list a fighter in
    // a division different from our stored primary_division, the fighter has
    // moved (e.g. Max Holloway moving from featherweight to lightweight).
    // Sync both rank AND primary_division so the rankings stay coherent.
    //
    // If a fighter is cross-listed in multiple sections (some fighters get
    // ranked in two divisions on UFC.com), the LAST section processed wins.
    // UFC.com lists alphabetically, so a fighter active in lightweight will
    // tend to end up there since "lightweight" sorts after "featherweight".
    for (const c of div.contenders) {
      const f = findFighter(c.slug, c.name);
      if (!f) {
        notFound.push(`${div.heading} #${c.rank}: ${c.name} (${c.slug})`);
        console.log(`  #${String(c.rank).padEnd(2)}        NOT FOUND: ${c.name} (${c.slug})`);
        continue;
      }
      const update = {
        current_rank:    c.rank,
        is_champion:     false,
        is_sub_champion: false,
        sub_title_type:  'none',
      };
      // Only update primary_division if it actually changed — keeps writes minimal
      const divisionNote = f.primary_division !== div.dbDivision
        ? `  (moved from ${f.primary_division} → ${div.dbDivision})`
        : '';
      if (f.primary_division !== div.dbDivision) {
        update.primary_division = div.dbDivision;
      }
      const { error } = await supabase
        .from('fighters')
        .update(update)
        .eq('id', f.id);
      if (error) console.warn(`  Error updating ${f.name}: ${error.message}`);
      else { console.log(`  #${String(c.rank).padEnd(2)}        ${f.name}${divisionNote}`); updated++; }
    }
  }

  console.log('\n============================================================');
  console.log(`Done. Updated ${updated} fighters.`);
  if (notFound.length > 0) {
    console.log(`\n${notFound.length} fighters not matched to DB entries:`);
    notFound.forEach(s => console.log(`  - ${s}`));
    console.log('\nThese are usually fighters new to UFC who haven\'t been ingested yet.');
    console.log('They\'ll be picked up after the next fetchFighters.js / ingestFightResults.js run.');
  }
  console.log('============================================================');
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  const html = await fetchRankingsHtml();
  const divisions = parseRankings(html);

  if (divisions.length === 0) {
    console.error('ERROR: No divisions parsed from UFC.com. Selectors may be stale.');
    process.exit(1);
  }
  console.log(`Parsed ${divisions.length} divisions.\n`);

  await resetRankings();
  await applyRankings(divisions);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
