// ============================================================================
// SERVER-SIDE WAIVER PROCESSOR  (service role — bypasses RLS)
//
// Why this exists: waiver processing used to run only in the commissioner's
// browser (the page-load "lazy processor" / "Process All Claims" button).
// That meant (a) if no commissioner loaded the page after a cutoff, claims
// never ran, and (b) a NON-commissioner's browser could only write its own
// claims (RLS), so it would process just that manager's claims out of the
// proper round-robin. This script runs the SAME rolling round-robin from the
// server with the service role, so it can touch every team and never depends
// on a browser being open. Wire it into the cron to run at each cutoff.
//
// Usage:
//   node scripts/processWaivers.js                 # DRY RUN (default, no writes)
//   node scripts/processWaivers.js --commit        # actually process
//   node scripts/processWaivers.js --league=<uuid> # restrict to one league
//
// Rules (match public/js/waivers.js exactly):
//   - Process only claims whose trigger time has passed (pre-window claims at
//     Fri 3am ET, post-window at Tue 3am ET, rolling at the fighter's clear
//     time). Cutoffs are 3am ET, anchored on the soonest non-completed event.
//   - Rolling round-robin by LIVE waiver_priority: one successful add per team
//     per round; a team drops to the back only on a SUCCESS; failed claims are
//     free and fall through to the team's next preference.
//   - Cap + roster-construction use the event-week EXPANSION when the claim's
//     process time falls inside the Thu-3am..Sun-3am window (the bug that was
//     rejecting no-drop adds at the base cap is fixed here).
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const COMMIT   = process.argv.includes('--commit');
const LEAGUErg = process.argv.find(a => a.startsWith('--league='));
const ONLY_LG  = LEAGUErg ? LEAGUErg.split('=')[1] : null;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ---- constants (mirror waiver-phase.js) ----
const ROSTER_SIZE_BASE        = 15;
const ROSTER_SLOTS_PER_DIVISION = 1;
const ROSTER_WOMENS_FLEX_SLOTS  = 1;
const MENS_DIVISION_COUNT       = 8;
const WOMENS_DIVISIONS_KEYS = ['strawweight', 'flyweight_w', 'bantamweight_w'];

function isNumbered(ev) { return /^UFC\s+\d+\b/i.test(String((ev && (ev.name || ev.full_name)) || '').trim()); }
function eventBonus(ev, cfg) {
  cfg = cfg || {};
  if (isNumbered(ev)) return cfg.starters_numbered != null ? Number(cfg.starters_numbered) : 3;
  return cfg.starters_fight_night != null ? Number(cfg.starters_fight_night) : 2;
}

// ---- ET 3am-on-a-day helper (DST-aware via Intl) ----
function etParts(d) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
  const p = {}; f.formatToParts(d).forEach(x => p[x.type] = x.value);
  return { y: +p.year, mo: +p.month, d: +p.day, h: +(p.hour === '24' ? '0' : p.hour) };
}
// UTC ms for 03:00 ET on the calendar day that is (event day + dayDelta).
function et3amOnEventDelta(eventDateStr, dayDelta) {
  const [ey, em, ed] = eventDateStr.split('-').map(Number);
  const anchor = new Date(Date.UTC(ey, em - 1, ed, 12)); // noon UTC on event day, safe for ±days
  anchor.setUTCDate(anchor.getUTCDate() + dayDelta);
  const y = anchor.getUTCFullYear(), m = anchor.getUTCMonth() + 1, d = anchor.getUTCDate();
  for (const off of [4, 5]) {                  // try EDT(-4) then EST(-5)
    const ms = Date.UTC(y, m - 1, d, 3 + off, 0);
    const p = etParts(new Date(ms));
    if (p.y === y && p.mo === m && p.d === d && p.h === 3) return ms;
  }
  return Date.UTC(y, m - 1, d, 7, 0);          // fallback EDT
}
function cutoffs(eventDateStr, lockTime) {
  const sun3am = et3amOnEventDelta(eventDateStr, +1);   // legacy Sun 3am ET
  // postOpen = prelims start (event lineup_lock_time) instead of Sun 3am ET, so
  // live-event adds become priority claims; fall back to Sun 3am with no lock.
  let postOpen = sun3am;
  if (lockTime) { const ms = new Date(lockTime).getTime(); if (!Number.isNaN(ms)) postOpen = ms; }
  return {
    preOpen:  et3amOnEventDelta(eventDateStr, -2),  // Thu 3am ET
    preClose: et3amOnEventDelta(eventDateStr, -1),  // Fri 3am ET
    postOpen: postOpen,                             // prelims start (lock), else Sun 3am ET
    postClose:et3amOnEventDelta(eventDateStr, +3),  // Tue 3am ET
    capExpand:et3amOnEventDelta(eventDateStr, -2),  // Thu 3am ET
    capRevert:sun3am,                               // Sun 3am ET (cap revert stays here)
  };
}
function rollingClear(droppedAtMs) {
  // 3am ET on (drop day + 2). Compute via the same ET helper using the drop's ET date.
  const p = etParts(new Date(droppedAtMs));
  const ds = `${p.y}-${String(p.mo).padStart(2,'0')}-${String(p.d).padStart(2,'0')}`;
  return et3amOnEventDelta(ds, 2);
}

// roster-construction check (mirrors checkRosterConstruction with expansion)
function constructionError(divList, league, ev, useExpansion, currentSize) {
  const cfg = league.scoring_config || {};
  const baseTotal = typeof league.roster_size === 'number' ? league.roster_size : ROSTER_SIZE_BASE;
  // Expanded limits also apply when the roster ALREADY holds temp/+window
  // fighters above base (they auto-drop Wed) — so a net-neutral swap (drop+add)
  // isn't bounced at the base cap by a temp fighter that legitimately sits above it.
  const useExp = useExpansion || ((currentSize || 0) > baseTotal);
  const bonus = useExp ? eventBonus(ev, cfg) : 0;
  const baseAnyFlex = Math.max(0, baseTotal - (MENS_DIVISION_COUNT * ROSTER_SLOTS_PER_DIVISION + ROSTER_WOMENS_FLEX_SLOTS));
  const totalLimit = baseTotal + bonus;
  const flexLimit  = baseAnyFlex + bonus;

  if (divList.length > totalLimit) return `Roster cannot exceed ${totalLimit} fighters` + (useExpansion ? ' even during the event-week expansion.' : '.');

  const counts = {}; let womens = 0;
  divList.forEach(dv => { counts[dv] = (counts[dv] || 0) + 1; if (WOMENS_DIVISIONS_KEYS.includes(dv)) womens++; });
  let anyFlexNeeded = 0;
  Object.keys(counts).forEach(dv => {
    if (WOMENS_DIVISIONS_KEYS.includes(dv)) return;
    anyFlexNeeded += Math.max(0, counts[dv] - ROSTER_SLOTS_PER_DIVISION);
  });
  anyFlexNeeded += Math.max(0, womens - ROSTER_WOMENS_FLEX_SLOTS);
  if (anyFlexNeeded > flexLimit) return `Any-Flex bucket (${flexLimit}) overflow.`;
  return null;
}

const log = (...a) => console.log(...a);

(async () => {
  log(`\n=== WAIVER PROCESSOR ${COMMIT ? '(COMMIT — WILL WRITE)' : '(DRY RUN — no writes)'} ===`);
  log('now:', new Date().toISOString(), '\n');

  // The waiver-anchor event drives the cutoffs. After a card, the JUST-COMPLETED
  // event stays the anchor until its post-window closes (Tue 3am ET) — NOT the
  // next upcoming event. Anchoring only on the soonest non-completed event
  // orphaned the just-finished card's post-window claims (they never processed).
  // Fetch a window (recent past + upcoming) and pick in JS. Overrides not applied.
  const windowFrom = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  const { data: evs } = await supabase.from('ufc_events')
    .select('id, name, full_name, event_date, is_completed, lineup_lock_time')
    .gte('event_date', windowFrom)
    .order('event_date', { ascending: true }).limit(8);
  if (!evs || !evs.length) { log('No events in window; nothing to anchor cutoffs on.'); return; }
  const nowMs = Date.now();
  // Most recent event whose POST window is open: postOpen (prelim lock) <= now < postClose (Tue 3am).
  const postActive = evs
    .map((e) => ({ e, c: cutoffs(e.event_date, e.lineup_lock_time) }))
    .filter((x) => nowMs >= x.c.postOpen && nowMs < x.c.postClose)
    .sort((a, b) => String(b.e.event_date).localeCompare(String(a.e.event_date)));
  const ev = postActive.length
    ? postActive[0].e
    : (evs.filter((e) => !e.is_completed).sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)))[0] || evs[evs.length - 1]);
  const cut = cutoffs(ev.event_date, ev.lineup_lock_time);
  log(`event: ${ev.name} (${ev.event_date})  preClose=${new Date(cut.preClose).toISOString()}  postClose=${new Date(cut.postClose).toISOString()}\n`);

  // Which leagues to process.
  let lgQuery = supabase.from('leagues').select('id, name, roster_size, scoring_config');
  if (ONLY_LG) lgQuery = lgQuery.eq('id', ONLY_LG);
  const { data: leagues } = await lgQuery;

  const now = Date.now();
  let grandApproved = 0;

  for (const league of leagues) {
    const { data: pend } = await supabase.from('waiver_claims')
      .select('id, league_member_id, fighter_to_add_id, fighter_to_drop_id, priority, status, submitted_at, claim_order')
      .eq('league_id', league.id).eq('status', 'pending');
    if (!pend || pend.length === 0) continue;

    const { data: members } = await supabase.from('league_members')
      .select('id, team_name, waiver_priority').eq('league_id', league.id);
    const { data: rosters } = await supabase.from('rosters')
      .select('league_member_id, fighter_id').eq('league_id', league.id);
    const { data: drops } = await supabase.from('roster_drops')
      .select('fighter_id, dropped_at').eq('league_id', league.id).order('dropped_at', { ascending: false });
    const lastDrop = {};
    (drops || []).forEach(d => { if (!lastDrop[d.fighter_id]) lastDrop[d.fighter_id] = new Date(d.dropped_at).getTime(); });

    // fighter divisions/names for everyone rostered or claimed
    const needF = [...new Set([
      ...rosters.map(r => r.fighter_id),
      ...pend.flatMap(c => [c.fighter_to_add_id, c.fighter_to_drop_id]).filter(Boolean),
    ])];
    const { data: fs } = await supabase.from('fighters').select('id, name, primary_division').in('id', needF);
    const fInfo = Object.fromEntries((fs || []).map(f => [f.id, f]));
    const mN = Object.fromEntries(members.map(m => [m.id, m.team_name]));

    // roster snapshot: memberId -> [fighter_id]
    const rosterMap = {};
    rosters.forEach(r => { (rosterMap[r.league_member_id] = rosterMap[r.league_member_id] || []).push(r.fighter_id); });

    // due claims only, tagged with their process time
    const due = [];
    for (const c of pend) {
      const t = new Date(c.submitted_at).getTime();
      let processAt = null;
      if (t >= cut.preOpen && t < cut.preClose)        processAt = cut.preClose;
      else if (t >= cut.postOpen && t < cut.postClose) processAt = cut.postClose;
      else if (lastDrop[c.fighter_to_add_id])          processAt = rollingClear(lastDrop[c.fighter_to_add_id]);
      if (processAt != null && now >= processAt) { c._processAt = processAt; due.push(c); }
    }
    if (due.length === 0) continue;

    log(`\n--- League: ${league.name} (${league.id}) — ${due.length} due claim(s) ---`);

    // group by team in preference order
    const byTeam = {}; const ptr = {};
    due.forEach(c => { (byTeam[c.league_member_id] = byTeam[c.league_member_id] || []).push(c); ptr[c.league_member_id] = 0; });
    Object.keys(byTeam).forEach(mid => byTeam[mid].sort((a, b) => {
      const ao = a.claim_order == null ? Infinity : a.claim_order, bo = b.claim_order == null ? Infinity : b.claim_order;
      if (ao !== bo) return ao - bo;
      return new Date(a.submitted_at) - new Date(b.submitted_at);
    }));

    // live priority
    const live = {}; let gMax = 0;
    members.forEach(m => { const p = m.waiver_priority == null ? 9999 : m.waiver_priority; live[m.id] = p; if (p < 9999 && p > gMax) gMax = p; });
    Object.keys(byTeam).forEach(mid => { if (live[mid] == null) live[mid] = 9999; });

    const claimed = new Set();       // fighters won this run
    const winners = {};              // memberId -> new priority
    let nextBack = gMax;
    const actions = [];              // {type, claim, reason}

    while (true) {
      let pick = null;
      Object.keys(byTeam).forEach(mid => {
        if (ptr[mid] >= byTeam[mid].length) return;
        if (pick === null || live[mid] < live[pick]) pick = mid;
      });
      if (pick === null) break;

      let won = false;
      while (ptr[pick] < byTeam[pick].length && !won) {
        const c = byTeam[pick][ptr[pick]]; ptr[pick]++;
        const add = c.fighter_to_add_id, drop = c.fighter_to_drop_id;
        const roster = rosterMap[pick] || [];
        const useExp = c._processAt >= cut.capExpand && c._processAt < cut.capRevert;
        const cap = (typeof league.roster_size === 'number' ? league.roster_size : ROSTER_SIZE_BASE) + (useExp ? eventBonus(ev, league.scoring_config) : 0);

        let reason = null;
        if (claimed.has(add)) reason = 'Fighter already claimed by a higher-priority team this cycle.';
        else if (Object.values(rosterMap).some(arr => arr.includes(add))) reason = 'Fighter is already on a roster.';
        else if (drop && !roster.includes(drop)) reason = 'The fighter you selected to drop is no longer on your roster.';
        else if (roster.length >= cap && !drop) reason = `At the ${cap}-fighter cap. Must specify a fighter to drop.`;
        else {
          const projected = roster.filter(fid => fid !== drop).map(fid => fInfo[fid] && fInfo[fid].primary_division).filter(Boolean);
          if (fInfo[add]) projected.push(fInfo[add].primary_division);
          reason = constructionError(projected, league, ev, useExp, roster.length);
        }

        if (reason) { actions.push({ type: 'reject', c, reason }); continue; }

        // success
        if (drop) rosterMap[pick] = roster.filter(fid => fid !== drop);
        rosterMap[pick] = (rosterMap[pick] || []).concat([add]);
        claimed.add(add);
        won = true;
        actions.push({ type: 'approve', c });
      }
      if (won) { nextBack++; live[pick] = nextBack; winners[pick] = nextBack; }
    }

    // report
    actions.forEach(a => {
      const team = mN[a.c.league_member_id];
      const add = fInfo[a.c.fighter_to_add_id] ? fInfo[a.c.fighter_to_add_id].name : a.c.fighter_to_add_id;
      const drop = a.c.fighter_to_drop_id ? (fInfo[a.c.fighter_to_drop_id] ? fInfo[a.c.fighter_to_drop_id].name : a.c.fighter_to_drop_id) : null;
      if (a.type === 'approve') log(`  ✅ ${team}  ADD ${add}${drop ? '  DROP ' + drop : ''}`);
      else                      log(`  ❌ ${team}  ${add}  (${a.reason})`);
    });
    Object.keys(winners).forEach(mid => log(`  ⤵︎ ${mN[mid]} → waiver line #${winners[mid]} (back of line)`));

    if (COMMIT) {
      for (const a of actions) {
        if (a.type === 'approve') {
          await supabase.from('rosters').insert({ league_id: league.id, league_member_id: a.c.league_member_id, fighter_id: a.c.fighter_to_add_id, acquired_method: 'waiver' });
          if (a.c.fighter_to_drop_id) {
            await supabase.from('rosters').delete().eq('league_id', league.id).eq('league_member_id', a.c.league_member_id).eq('fighter_id', a.c.fighter_to_drop_id);
            await supabase.from('roster_drops').insert({ league_id: league.id, league_member_id: a.c.league_member_id, fighter_id: a.c.fighter_to_drop_id, source: 'claim' });
          }
          await supabase.from('waiver_claims').update({ status: 'approved', processed_at: new Date().toISOString() }).eq('id', a.c.id);
          grandApproved++;
        } else {
          await supabase.from('waiver_claims').update({ status: 'rejected', rejection_reason: a.reason, processed_at: new Date().toISOString() }).eq('id', a.c.id);
        }
      }
      for (const mid of Object.keys(winners)) {
        await supabase.from('league_members').update({ waiver_priority: winners[mid] }).eq('id', mid);
      }
    }
  }

  log(`\n=== ${COMMIT ? 'COMMITTED. Approved ' + grandApproved + ' claim(s).' : 'DRY RUN complete. Re-run with --commit to apply.'} ===\n`);
})();
