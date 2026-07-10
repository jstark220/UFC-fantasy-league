// ============================================================================
// backfillEligibleDivisions.js
// Computes fighters.eligible_divisions from each fighter's UFC fight history.
//
// A fighter is eligible at a division if ANY of these hold:
//   1. It's their primary_division (always included — preserves the old
//      single-division behavior when a fighter has no multi-div history).
//   2. They've fought there in the last 1 year (even a single fight). This is
//      what catches fresh move-ups — e.g. Vinicius Oliveira, 5 recent BW fights
//      + a June 2026 FW debut, comes out eligible at BOTH.
//   3. They've fought there >= 2 times in the last 3 years (a longer-horizon
//      floor for genuine two-division fighters who fought less recently).
//
// Both completed and scheduled fights count (a booked upcoming bout at a new
// weight is a real signal; the fight-results prune removes cancelled bookings,
// so a weekly re-run self-heals). Women's divisions carry the _w suffix in
// weight_class, so eligibility never crosses genders.
//
// Idempotent. Only writes fighters whose computed set differs from what's
// stored, so re-runs are cheap.
//
//   node backfillEligibleDivisions.js               DRY RUN (default, no writes)
//   node backfillEligibleDivisions.js --commit      apply
//   node backfillEligibleDivisions.js --spot=Name   dry-run + verbose for matches
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const COMMIT   = process.argv.includes('--commit');
const spotArg  = process.argv.find((a) => a.startsWith('--spot='));
const SPOT     = spotArg ? spotArg.split('=')[1].toLowerCase() : null;

// Day-string cutoffs (event_date is a DATE, compared as YYYY-MM-DD strings).
const ONE_YEAR_CUTOFF   = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
const THREE_YEAR_CUTOFF = new Date(Date.now() - 3 * 365 * 86400000).toISOString().slice(0, 10);

// Page a select in 1000-row chunks (PostgREST caps rows/response).
async function fetchAll(table, columns, tweak) {
  const out = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    let q = supabase.from(table).select(columns).range(from, from + PAGE - 1);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} load failed: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// Stable ordering: primary_division first, then the rest alphabetically. Keeps
// diffs and UI labels deterministic.
function orderDivisions(set, primary) {
  const arr = Array.from(set);
  arr.sort();
  if (primary && arr.includes(primary)) {
    return [primary, ...arr.filter((d) => d !== primary)];
  }
  return arr;
}

function sameSet(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

(async () => {
  console.log(`backfillEligibleDivisions  ${COMMIT ? '' : '[DRY RUN]'}`);
  console.log(`  last-1yr cutoff:  ${ONE_YEAR_CUTOFF}`);
  console.log(`  last-3yr cutoff:  ${THREE_YEAR_CUTOFF}\n`);

  // 1. All fighters. Tolerate the column not existing yet (so a dry run works
  //    BEFORE the migration is applied) — fall back to selecting without it,
  //    which makes every fighter's stored value undefined => treated as a diff.
  let fighters;
  try {
    fighters = await fetchAll('fighters', 'id, name, primary_division, eligible_divisions');
  } catch (e) {
    if (/eligible_divisions/.test(e.message)) {
      console.log('(note: eligible_divisions column not present yet — reading without it.)');
      fighters = await fetchAll('fighters', 'id, name, primary_division');
    } else {
      throw e;
    }
  }
  console.log(`Loaded ${fighters.length} fighters.`);

  // 2. All fight rows joined to their event date. !inner drops orphans.
  const fights = await fetchAll(
    'fight_results',
    'fighter_a_id, fighter_b_id, weight_class, event:ufc_events!inner(event_date)'
  );
  console.log(`Loaded ${fights.length} fight rows.\n`);

  // 3. fighterId -> [{ wc, date }]. Each fight feeds BOTH corners.
  const byFighter = new Map();
  const push = (fid, wc, date) => {
    if (!fid || !wc || !date) return;
    if (!byFighter.has(fid)) byFighter.set(fid, []);
    byFighter.get(fid).push({ wc, date });
  };
  fights.forEach((fr) => {
    const date = fr.event && fr.event.event_date;
    push(fr.fighter_a_id, fr.weight_class, date);
    push(fr.fighter_b_id, fr.weight_class, date);
  });

  // 4. Compute each fighter's eligible set.
  const toWrite = [];
  let multiCount = 0;
  const spotMatches = [];

  for (const f of fighters) {
    const history = byFighter.get(f.id) || [];
    const lastYear = new Set();
    const threeYearCounts = {};
    history.forEach(({ wc, date }) => {
      if (date >= ONE_YEAR_CUTOFF) lastYear.add(wc);
      if (date >= THREE_YEAR_CUTOFF) threeYearCounts[wc] = (threeYearCounts[wc] || 0) + 1;
    });

    const eligible = new Set();
    if (f.primary_division) eligible.add(f.primary_division);       // rule 1
    lastYear.forEach((wc) => eligible.add(wc));                      // rule 2
    Object.keys(threeYearCounts).forEach((wc) => {                   // rule 3
      if (threeYearCounts[wc] >= 2) eligible.add(wc);
    });

    const ordered = orderDivisions(eligible, f.primary_division);
    if (ordered.length > 1) multiCount++;

    if (SPOT && f.name && f.name.toLowerCase().includes(SPOT)) {
      spotMatches.push({ f, ordered, lastYear: Array.from(lastYear), threeYearCounts });
    }

    // Only queue a write when the value actually changes.
    if (!sameSet(f.eligible_divisions, ordered) && ordered.length > 0) {
      toWrite.push({ id: f.id, name: f.name, eligible_divisions: ordered });
    }
  }

  // 5. Report.
  console.log(`Fighters eligible for 2+ divisions: ${multiCount}`);
  console.log(`Rows needing a write: ${toWrite.length}\n`);

  // Show a sample of the multi-division fighters so the result is auditable.
  const sampleMulti = toWrite.filter((w) => w.eligible_divisions.length > 1).slice(0, 25);
  if (sampleMulti.length) {
    console.log('Sample multi-division fighters:');
    sampleMulti.forEach((w) => console.log(`  ${w.name.padEnd(28)} ${w.eligible_divisions.join(' / ')}`));
    console.log('');
  }

  if (SPOT) {
    console.log(`Spot-check "${SPOT}":`);
    spotMatches.forEach(({ f, ordered, lastYear, threeYearCounts }) => {
      console.log(`  ${f.name}  [primary=${f.primary_division}]`);
      console.log(`     eligible → ${ordered.join(' / ')}`);
      console.log(`     last-1yr divisions: ${JSON.stringify(lastYear)}`);
      console.log(`     last-3yr counts:    ${JSON.stringify(threeYearCounts)}`);
    });
    console.log('');
  }

  if (!COMMIT) {
    console.log('(dry run — re-run with --commit to write.)');
    return;
  }

  // 6. Write, chunked with limited concurrency.
  console.log(`Writing ${toWrite.length} rows...`);
  let done = 0;
  const CONCURRENCY = 25;
  for (let i = 0; i < toWrite.length; i += CONCURRENCY) {
    const chunk = toWrite.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (w) => {
      const { error } = await supabase
        .from('fighters')
        .update({ eligible_divisions: w.eligible_divisions })
        .eq('id', w.id);
      if (error) console.log(`  ! ${w.name}: ${error.message}`);
    }));
    done += chunk.length;
    if (done % 500 < CONCURRENCY) console.log(`  ${done}/${toWrite.length}`);
  }
  console.log(`Done. Wrote ${toWrite.length} rows.`);
})();
