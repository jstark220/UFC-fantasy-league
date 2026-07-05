// ============================================================================
// migrateStartersNumberedTo2.js
// One-shot migration: flip every league's scoring_config.starters_numbered to
// 2, matching the new global default (starters used to be 3 for numbered
// PPVs, changed to 2 across the board starting with UFC 329).
//
// Rules (per the plan):
//   * Leagues where starters_numbered is EXPLICITLY 3, or MISSING/null → set to 2.
//   * Leagues where it's already 2                                     → no-op.
//   * Leagues where it's ANY OTHER value (1, 4, 5, …)                  → skip,
//     assume the commissioner set it deliberately and leave it alone.
//
// Idempotent — running twice is safe.
//
//   node migrateStartersNumberedTo2.js               DRY RUN (default, no writes)
//   node migrateStartersNumberedTo2.js --commit      actually update the rows
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const COMMIT = process.argv.includes('--commit');

(async () => {
  console.log(`migrateStartersNumberedTo2  ${COMMIT ? '' : '[DRY RUN]'}\n`);

  const { data: leagues, error } = await supabase
    .from('leagues')
    .select('id, name, scoring_config')
    .order('name');
  if (error) { console.error('Failed to load leagues:', error); process.exit(1); }
  if (!leagues || leagues.length === 0) { console.log('No leagues found.'); return; }

  let updateCount = 0, skipCount = 0, noopCount = 0;

  for (const league of leagues) {
    const cfg = league.scoring_config || {};
    const cur = cfg.starters_numbered;

    // Classify the current value.
    // (== null covers both null and undefined; a plain !== 2 would miss "0"
    // vs 2 comparisons if numeric coercion ever slipped in.)
    let action;
    if (cur == null || Number(cur) === 3)      action = 'update';
    else if (Number(cur) === 2)                action = 'noop';
    else                                        action = 'skip';

    const label = `${league.name.padEnd(40)}  starters_numbered=${cur == null ? '(unset)' : cur}`;

    if (action === 'update') {
      const nextCfg = Object.assign({}, cfg, { starters_numbered: 2 });
      console.log(`  UPDATE  ${label}  → 2`);
      updateCount++;
      if (COMMIT) {
        const r = await supabase
          .from('leagues')
          .update({ scoring_config: nextCfg })
          .eq('id', league.id);
        if (r.error) console.log(`          ! write failed: ${r.error.message}`);
      }
    } else if (action === 'noop') {
      console.log(`  ok      ${label}  (already 2)`);
      noopCount++;
    } else {
      console.log(`  SKIP    ${label}  (custom value — leaving alone)`);
      skipCount++;
    }
  }

  console.log(`\nDone. ${leagues.length} leagues total: ${updateCount} to update, ${noopCount} already at 2, ${skipCount} with custom values (skipped).`);
  if (!COMMIT && updateCount > 0) console.log('\n(dry run — re-run with --commit to apply.)');
})();
