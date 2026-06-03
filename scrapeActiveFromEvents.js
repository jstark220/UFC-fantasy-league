// ============================================================================
// scrapeActiveFromEvents.js
// Marks fighters who appear on recent/upcoming UFC cards as is_active=true, so
// they show up in the free-agent pool. Source is ESPN (was ufcstats, now
// bot-walled — see espnClient.js).
//
// Only ACTIVATES existing fighters (matched by name, then unambiguous
// last-name+initial). It never creates fighters and never deactivates anyone —
// fighter creation/roster is owned by fetchFighters.js (Octagon API).
// Placeholder "TBA" entries on unannounced bouts are ignored.
//
// Run:
//   node scrapeActiveFromEvents.js              activate from the default window
//   node scrapeActiveFromEvents.js --dry-run     show what would change
//   node scrapeActiveFromEvents.js --back=365     how many days back to scan (default 365)
// ============================================================================

require('dotenv').config();
const espn = require('./espnClient');
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env file');
  process.exit(1);
}
const supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const DRY_RUN = process.argv.includes('--dry-run');
const backArg = process.argv.find((a) => a.startsWith('--back='));
const DAYS_BACK = backArg ? parseInt(backArg.split('=')[1], 10) : 365;
const DAYS_AHEAD = 150;

// Fold non-decomposing letters (esp. ł: "Błachowicz" ≠ "Blachowicz") so name
// matching doesn't silently miss — same key as ingestFightResults.js.
function normalizeName(s) {
  return (s || '')
    .replace(/[łŁ]/g, 'l').replace(/[øØ]/g, 'o').replace(/[đĐð]/g, 'd')
    .replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/þ/g, 'th')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function lastFirstKey(name) {
  const p = normalizeName(name).split(' ').filter(Boolean);
  return p.length < 2 ? null : p[p.length - 1] + '|' + p[0][0];
}
// Word-order-insensitive key so reversed names ("Stirling Navajo") still match.
function tokenKey(name) {
  const p = normalizeName(name).split(' ').filter(Boolean).sort();
  return p.length ? p.join(' ') : null;
}
function isPlaceholder(name) {
  return !name || !name.trim() || /\btba\b/i.test(name) || /opponent\s+tba/i.test(name);
}

(async () => {
  console.log(`scrapeActiveFromEvents (ESPN)${DRY_RUN ? ' [DRY RUN]' : ''} - scanning -${DAYS_BACK}d .. +${DAYS_AHEAD}d\n`);

  // 1. Gather every athlete name on cards in the window.
  const events = await espn.fetchEventsInRange(
    new Date(Date.now() - DAYS_BACK * 86400000),
    new Date(Date.now() + DAYS_AHEAD * 86400000),
  );
  const names = new Set();
  events.forEach((e) => e.bouts.forEach((b) => b.names.forEach((n) => { if (!isPlaceholder(n)) names.add(n); })));
  console.log(`Found ${names.size} distinct fighters across ${events.length} cards.`);

  // 2. Load fighters into match maps.
  const byName = new Map(); const byLastFirst = new Map(); const byTokenKey = new Map();
  let from = 0; const PAGE = 1000;
  while (true) {
    const res = await supabaseClient.from('fighters').select('id, name, is_active')
      .order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (res.error || !res.data) break;
    res.data.forEach((f) => {
      const n = normalizeName(f.name); if (n && !byName.has(n)) byName.set(n, f);
      const tk = tokenKey(f.name); if (tk) byTokenKey.set(tk, byTokenKey.has(tk) ? 'AMBIGUOUS' : f);
      const k = lastFirstKey(f.name); if (k) byLastFirst.set(k, byLastFirst.has(k) ? 'AMBIGUOUS' : f);
    });
    if (res.data.length < PAGE) break;
    from += PAGE;
  }

  // 3. Activate any matched fighter who is currently inactive.
  let activated = 0, unmatched = 0;
  for (const name of names) {
    let m = byName.get(normalizeName(name));
    if (!m) { const c = byTokenKey.get(tokenKey(name)); if (c && c !== 'AMBIGUOUS') m = c; }
    if (!m) { const c = byLastFirst.get(lastFirstKey(name)); if (c && c !== 'AMBIGUOUS') m = c; }
    if (!m) { unmatched++; continue; }
    if (m.is_active) continue;
    activated++;
    console.log(`  activate: ${m.name}`);
    if (!DRY_RUN) {
      const r = await supabaseClient.from('fighters').update({ is_active: true }).eq('id', m.id);
      if (r.error) console.log('     write failed: ' + r.error.message);
    }
    m.is_active = true;
  }

  console.log(`\nSummary: ${activated} activated, ${unmatched} card fighters not in roster (added later by fetchFighters).`);
  if (DRY_RUN) console.log('(dry run - nothing written)');
})().catch((err) => { console.error('Fatal error:', err); process.exit(1); });
