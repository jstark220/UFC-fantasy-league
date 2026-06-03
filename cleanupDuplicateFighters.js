// ============================================================================
// cleanupDuplicateFighters.js
// Comprehensive duplicate-fighter cleanup. Supersedes mergeDuplicateFighters.js
// for the cases it missed: diacritic variants (Błachowicz≠Blachowicz), reversed
// word order ("Stirling Navajo"), and hyphen/space variants ("Cortes-Acosta").
//
// For each duplicate group (matched by a diacritic-, punctuation- and
// word-order-insensitive key):
//   1. Pick the SURVIVOR by score — rostered > clean Octagon ufc_id > has
//      country > ranked > active+photo > most fights. (So whichever copy a
//      manager actually drafted is always kept; its split-off data is poured
//      into it, never the reverse.)
//   2. Re-point EVERY fighter foreign key from each duplicate onto the survivor
//      (the old script missed scores / draft_picks / draft_queue / projections).
//   3. Backfill only EMPTY survivor fields from the duplicates (never overwrite).
//   4. Delete the duplicates.
//
// SAFETY GUARD: if a group has 2+ rows with a clean Octagon ufc_id, it might be
// two *different* real people with the same name — skip it and FLAG for manual
// review rather than risk a bad merge.
//
//   node cleanupDuplicateFighters.js --dry-run   plan only, no writes
//   node cleanupDuplicateFighters.js             apply
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1);
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const DRY_RUN = process.argv.includes('--dry-run');

const FK = [
  ['fight_results','fighter_a_id'],['fight_results','fighter_b_id'],['fight_results','winner_id'],
  ['rosters','fighter_id'],['starter_selections','fighter_id'],['roster_drops','fighter_id'],
  ['waiver_claims','fighter_to_add_id'],['waiver_claims','fighter_to_drop_id'],
  ['draft_picks','fighter_id'],['draft_queue','fighter_id'],['scores','fighter_id'],['fighter_projections','fighter_id'],
];
const cleanOctagon = f => !!(f.ufc_id && !f.ufc_id.startsWith('ufcstats-'));
function norm(s){return (s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/ł/g,'l').replace(/Ł/g,'l').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();}
const tokenKey = s => norm(s).split(' ').sort().join(' ');
// orderCol MUST be a stable/unique column or paginated fetches of >1000-row
// tables silently drop/duplicate rows (Postgres re-orders ties across pages).
// Defaults to 'id'; pass null for the few id-less tables (all are <1000 rows).
async function fetchAll(t,c,orderCol='id'){let f=0;const a=[];while(true){let q=supabase.from(t).select(c);if(orderCol)q=q.order(orderCol,{ascending:true});const{data,error}=await q.range(f,f+999);if(error)throw error;a.push(...data);if(data.length<1000)break;f+=1000;}return a;}

(async () => {
  const fighters = await fetchAll('fighters','id,name,ufc_id,primary_division,current_rank,is_champion,is_active,photo_url,country,record_wins,record_losses,record_draws');
  const fightCount = {}, rosterCount = {}, refMoves = {};
  for (const [table,col] of FK) {
    const rows = await fetchAll(table, col, table === 'draft_queue' ? null : 'id');
    const tally = {};
    for (const r of rows) { const v = r[col]; if (v) tally[v] = (tally[v]||0)+1; }
    for (const [id,n] of Object.entries(tally)) {
      (refMoves[id] = refMoves[id] || []).push({ table, col, n });
      if (table === 'fight_results') fightCount[id] = (fightCount[id]||0)+n;
      if (table === 'rosters')       rosterCount[id] = (rosterCount[id]||0)+n;
    }
  }
  const tradesText = JSON.stringify(await fetchAll('trades','id,trade_details'));
  const score = f => {
    let s = 0;
    if ((rosterCount[f.id]||0) > 0) s += 100000;
    if (cleanOctagon(f)) s += 10000;
    if (f.country) s += 2000;
    if (f.current_rank != null) s += 1000;
    if (f.is_active && f.photo_url) s += 500;
    if (f.photo_url) s += 100;
    s += (fightCount[f.id]||0) * 10;
    if (f.ufc_id && f.ufc_id.startsWith('ufcstats-')) s -= 50;
    return s;
  };

  const groups = {};
  for (const f of fighters) if (f.name) (groups[tokenKey(f.name)] = groups[tokenKey(f.name)] || []).push(f);

  const merges = [], plainDeletes = [], flagged = [], backfills = [], tradeWarns = [];
  for (const g of Object.values(groups)) {
    if (g.length < 2) continue;
    if (g.filter(cleanOctagon).length >= 2) { flagged.push(g); continue; }
    const survivor = g.slice().sort((a,b) => score(b) - score(a))[0];
    const absorbed = g.filter(f => f.id !== survivor.id);

    const patch = {};
    for (const a of absorbed) {
      const moves = refMoves[a.id] || [];
      (moves.length ? merges : plainDeletes).push({ survivor, a, moves });
      if (tradesText.includes(a.id)) tradeWarns.push(a);
      for (const k of ['photo_url','country','current_rank','primary_division','record_wins','record_losses','record_draws']) {
        if ((survivor[k] == null || survivor[k] === '') && patch[k] == null && a[k] != null && a[k] !== '') patch[k] = a[k];
      }
      if (!survivor.ufc_id && !patch.ufc_id && cleanOctagon(a)) patch.ufc_id = a.ufc_id;
    }
    if (Object.keys(patch).length) backfills.push({ survivor, patch });
  }

  console.log((DRY_RUN ? '[DRY-RUN] ' : '[APPLY] ') + 'duplicate cleanup\n');
  console.log('Total fighters           :', fighters.length);
  console.log('Duplicate groups          :', Object.values(groups).filter(g => g.length > 1).length);
  console.log('Data-carrier merges       :', merges.length, '(refs re-pointed onto survivor)');
  console.log('FK-free duplicate deletes :', plainDeletes.length);
  console.log('Survivor backfills        :', backfills.length);
  console.log('Groups FLAGGED (2+ Octagon ids — skipped):', flagged.length);
  console.log('Rows referenced in trades.trade_details   :', tradeWarns.length, '\n');

  console.log('--- data-carrier merges (the ones that move fight history etc.) ---');
  for (const m of merges) {
    console.log('  KEEP', m.survivor.name, '(' + (m.survivor.ufc_id||'null') + ')  ← ',
      m.a.name, '(' + (m.a.ufc_id||'null') + '):', m.moves.map(x => `${x.table}.${x.col}×${x.n}`).join(', '));
  }
  if (flagged.length) {
    console.log('\n--- FLAGGED for manual review (NOT merged) ---');
    for (const g of flagged) console.log('  ' + g.map(f => `${f.name}[${f.ufc_id}]`).join('  vs  '));
  }
  if (tradeWarns.length) {
    console.log('\n--- referenced in trades (review trade_details) ---');
    for (const a of tradeWarns) console.log('  ' + a.name + ' ' + a.id);
  }

  if (DRY_RUN) { console.log('\nDry run — nothing changed.'); return; }

  // APPLY ------------------------------------------------------------------
  console.log('\nApplying...');
  for (const m of merges) {
    for (const mv of m.moves) {
      const { error } = await supabase.from(mv.table).update({ [mv.col]: m.survivor.id }).eq(mv.col, m.a.id);
      if (!error) continue;
      // Unique-constraint conflict: the survivor already holds the canonical
      // row (e.g. a projection/score for the same fight), so the duplicate's
      // copy is redundant — drop it instead of re-pointing. (Projections/scores
      // are recomputed downstream; rosters never conflict here.)
      if (error.code === '23505') {
        const { error: delErr } = await supabase.from(mv.table).delete().eq(mv.col, m.a.id);
        console.log(delErr
          ? `  ! ${mv.table}.${mv.col} (${m.a.name}) drop-dup failed: ${delErr.message}`
          : `  (dropped redundant ${mv.table}.${mv.col} for ${m.a.name})`);
      } else {
        console.log(`  ! ${mv.table}.${mv.col} (${m.a.name}): ${error.message}`);
      }
    }
  }
  for (const b of backfills) {
    const { error } = await supabase.from('fighters').update(b.patch).eq('id', b.survivor.id);
    if (error) console.log(`  ! backfill ${b.survivor.name}: ${error.message}`);
  }
  const delIds = [...merges, ...plainDeletes].map(x => x.a.id);
  let deleted = 0;
  for (let i = 0; i < delIds.length; i += 200) {
    const chunk = delIds.slice(i, i + 200);
    const { error } = await supabase.from('fighters').delete().in('id', chunk);
    if (!error) { deleted += chunk.length; continue; }
    // A chunk delete is atomic, so one still-referenced row blocks the whole
    // batch. Fall back to row-by-row so the innocent rows still get deleted
    // and any genuinely-stuck row is named.
    for (const id of chunk) {
      const { error: e1 } = await supabase.from('fighters').delete().eq('id', id);
      if (e1) console.log(`  ! could not delete ${id}: ${e1.message}`);
      else deleted++;
    }
  }
  console.log(`Done. Re-pointed ${merges.length} fighter(s), deleted ${deleted} duplicate row(s).`);
})().catch(e => { console.error(e); process.exit(1); });
