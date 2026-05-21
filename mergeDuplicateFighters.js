// ============================================================================
// mergeDuplicateFighters.js
// Finds fighters who exist twice in the DB — once with the canonical Octagon
// API slug (e.g. "sean-strickland") and once with the "ufcstats-" prefix from
// auto-creation in ingestFightResults.js / scrapeActiveFromEvents.js. Merges
// the duplicate into the canonical by re-pointing every foreign key, then
// deletes the duplicate.
//
// Why this matters:
//   When ingestFightResults.js processes a fight and looks up a fighter by
//   normalized name, it may pick either the canonical or the ufcstats- entry.
//   The ufcstats- entries often have wrong primary_division (since they were
//   created from a single fight's weight class) which then breaks champion
//   detection in recalculateChampions.js.
//
// Run modes:
//   node mergeDuplicateFighters.js --dry-run   show what would change
//   node mergeDuplicateFighters.js              apply merges + deletes
//
// Foreign keys updated: fight_results (fighter_a_id, fighter_b_id, winner_id),
//                       rosters (fighter_id),
//                       starter_selections (fighter_id),
//                       waiver_claims (fighter_to_add_id, fighter_to_drop_id),
//                       roster_drops (fighter_id)
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

const DRY_RUN = process.argv.includes('--dry-run');

// ============================================================================
// Find all duplicate pairs. Strategy:
//   1. Group fighters by name (case-insensitive)
//   2. For any group with 2+ fighters, designate the canonical one as the
//      entry whose ufc_id does NOT start with "ufcstats-" (i.e., the Octagon
//      API entry). The others are duplicates.
//   3. Handles both `ufcstats-X` paired with `X`, and reversed-name slugs
//      like `weili-zhang` paired with `ufcstats-zhang-weili`.
// ============================================================================
async function findDuplicatePairs() {
  let from = 0;
  const all  = [];
  while (true) {
    const { data, error } = await supabase
      .from('fighters')
      .select('id, name, ufc_id, primary_division, is_active')
      .range(from, from + 999);
    if (error) throw error;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  // Group by case-insensitive name
  const byName = {};
  for (const f of all) {
    if (!f.name) continue;
    const key = f.name.toLowerCase().trim();
    (byName[key] = byName[key] || []).push(f);
  }

  const pairs = [];
  for (const group of Object.values(byName)) {
    if (group.length < 2) continue;

    // Only merge when ONE entry has a clean Octagon API ufc_id (not the
    // "ufcstats-" auto-generated prefix and not null). Otherwise we can't
    // confidently say which entry is canonical, so we skip for manual review.
    const canonical = group.find(f => f.ufc_id && !f.ufc_id.startsWith('ufcstats-'));
    if (!canonical) continue;

    for (const f of group) {
      if (f.id === canonical.id) continue;
      pairs.push({ duplicate: f, canonical });
    }
  }
  return pairs;
}

// ============================================================================
// Re-point every foreign key referencing the duplicate to the canonical
// ============================================================================
async function repointReferences(dupeId, canonicalId) {
  const updates = [
    ['fight_results',       'fighter_a_id'],
    ['fight_results',       'fighter_b_id'],
    ['fight_results',       'winner_id'],
    ['rosters',             'fighter_id'],
    ['starter_selections',  'fighter_id'],
    ['waiver_claims',       'fighter_to_add_id'],
    ['waiver_claims',       'fighter_to_drop_id'],
    ['roster_drops',        'fighter_id'],
  ];

  let total = 0;
  for (const [table, col] of updates) {
    const { error, count } = await supabase
      .from(table)
      .update({ [col]: canonicalId }, { count: 'exact' })
      .eq(col, dupeId);
    if (error) {
      // Some tables may not exist on every install; warn but don't fail
      console.warn(`    ${table}.${col}: ${error.message}`);
      continue;
    }
    if (count > 0) {
      console.log(`    ${table}.${col}: ${count} row(s) re-pointed`);
      total += count;
    }
  }
  return total;
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log(DRY_RUN ? 'DRY RUN — no changes will be applied\n' : 'LIVE RUN — will merge and delete duplicates\n');

  const pairs = await findDuplicatePairs();
  console.log(`Found ${pairs.length} duplicate pairs.\n`);

  if (pairs.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // Show all pairs first so the user can sanity-check before live run
  pairs.forEach(({ canonical, duplicate }, i) => {
    console.log(`${String(i + 1).padStart(3)}. ${canonical.name}`);
    console.log(`     canonical: ufc_id=${canonical.ufc_id}, div=${canonical.primary_division}, active=${canonical.is_active}`);
    console.log(`     duplicate: ufc_id=${duplicate.ufc_id}, div=${duplicate.primary_division}, active=${duplicate.is_active}`);
  });

  if (DRY_RUN) {
    console.log('\n(dry run — no changes applied)');
    return;
  }

  console.log('\nMerging...\n');
  let mergedCount  = 0;
  let repointCount = 0;
  let deleteCount  = 0;
  let errorCount   = 0;

  for (const { canonical, duplicate } of pairs) {
    console.log(`Merging "${duplicate.name}" → "${canonical.name}"`);
    try {
      const moved = await repointReferences(duplicate.id, canonical.id);
      repointCount += moved;

      const { error: delErr } = await supabase
        .from('fighters')
        .delete()
        .eq('id', duplicate.id);
      if (delErr) {
        console.warn(`    delete failed: ${delErr.message}`);
        errorCount++;
      } else {
        deleteCount++;
      }
      mergedCount++;
    } catch (err) {
      console.warn(`    merge failed: ${err.message}`);
      errorCount++;
    }
  }

  console.log('\n============================================================');
  console.log(`Done. Merged ${mergedCount} pairs.`);
  console.log(`  Foreign keys re-pointed: ${repointCount}`);
  console.log(`  Duplicate rows deleted:  ${deleteCount}`);
  if (errorCount > 0) console.log(`  Errors: ${errorCount}`);
  console.log('============================================================');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
