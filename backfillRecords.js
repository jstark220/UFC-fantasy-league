// ============================================================================
// backfillRecords.js
// Populates fighters.record_wins / record_losses / record_draws from ESPN's
// athlete "overall" record. Many fighters were added by the event pipeline
// (because they fought) but never went through the roster fetch that sets a
// record, so they show 0-0 in the UI even though they have real fights. This
// fills/refreshes the record straight from ESPN, keyed by espn_athlete_id.
//
// Run:
//   node backfillRecords.js              dry run — log changes, write nothing
//   node backfillRecords.js --commit     apply the updates
//   node backfillRecords.js --missing    only fighters currently showing 0-0
//                                         (fast; the daily fix for new signees)
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const COMMIT  = process.argv.includes('--commit');
const MISSING = process.argv.includes('--missing');

function getJson(url) {
  return new Promise((resolve) => {
    https.get(url, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ESPN "overall" pro record for an athlete id -> { wins, losses, draws } | null.
// The athlete's records collection lists several rows (overall, by method, by
// title, ...); we want type 'total' / name 'overall'. Stats carry the numbers.
async function espnRecord(athleteId) {
  const url = `https://sports.core.api.espn.com/v2/sports/mma/athletes/${athleteId}/records?lang=en&region=us`;
  const j = await getJson(url);
  if (!j || !Array.isArray(j.items)) return null;
  const overall = j.items.find((it) => it.type === 'total' || it.name === 'overall') || j.items[0];
  if (!overall || !Array.isArray(overall.stats)) return null;
  const stat = (n) => {
    const s = overall.stats.find((x) => x.name === n);
    return s ? Math.round(s.value) : null;
  };
  const wins = stat('wins'), losses = stat('losses'), draws = stat('draws');
  if (wins == null && losses == null) return null; // no usable record
  return { wins: wins || 0, losses: losses || 0, draws: draws || 0 };
}

(async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('ERROR: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  console.log(`=== RECORD BACKFILL ${COMMIT ? '(COMMIT — writes)' : '(DRY RUN — no writes)'}${MISSING ? '  [missing-only]' : ''} ===`);

  // Active fighters with an ESPN athlete id (paginated past the 1000-row cap).
  let from = 0;
  let all = [];
  while (true) {
    let q = supabase
      .from('fighters')
      .select('id, name, espn_athlete_id, record_wins, record_losses, record_draws')
      .eq('is_active', true)
      .not('espn_athlete_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (MISSING) q = q.eq('record_wins', 0).eq('record_losses', 0);
    const { data, error } = await q;
    if (error) { console.error('load error:', error.message); process.exit(1); }
    all = all.concat(data || []);
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  console.log(`fighters to check: ${all.length}\n`);

  let changed = 0, updated = 0, skipped = 0;
  for (const f of all) {
    const rec = await espnRecord(f.espn_athlete_id);
    await sleep(40); // be gentle with the ESPN core API
    if (!rec) { skipped++; continue; }
    if (rec.wins === f.record_wins && rec.losses === f.record_losses && rec.draws === f.record_draws) continue;
    changed++;
    console.log(`  ${f.name}: ${f.record_wins}-${f.record_losses}-${f.record_draws}  ->  ${rec.wins}-${rec.losses}-${rec.draws}`);
    if (COMMIT) {
      const { error } = await supabase
        .from('fighters')
        .update({ record_wins: rec.wins, record_losses: rec.losses, record_draws: rec.draws })
        .eq('id', f.id);
      if (error) console.error(`    ! update failed: ${error.message}`); else updated++;
    }
  }

  console.log(`\n${COMMIT ? 'Updated' : 'Would update'} ${COMMIT ? updated : changed} fighter(s); skipped ${skipped} (no ESPN record).`);
})();
