// ========================================================================
// fight-night-store.test.js — plain-Node tests, no framework.
// Run: node tests/fight-night-store.test.js
// These prove the hub's merge rules BEFORE any UI exists. If this file
// fails, do not ship the hub.
// ========================================================================

const S = require('../public/js/fight-night-store.js');

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.error('FAIL  ' + name); }
}
function eventTypes(events) { return events.map((e) => e.type).join(','); }

const LEAGUE = 'league-1', EVENT = 'event-1';

function fight(id, order, outcome) {
  return { id: id, event_id: EVENT, fight_order: order, outcome: outcome || null, winner_id: null };
}
function score(member, fighter, pts) {
  return { league_id: LEAGUE, event_id: EVENT, league_member_id: member, fighter_id: fighter, total_points: pts };
}
function basePayload(extra) {
  return Object.assign({
    token: '2026-06-10T01:00:00Z',
    event: { id: EVENT, name: 'UFC 330' },
    league: { scoring_config: null },
    fights: [fight('f1', 12), fight('f2', 11), fight('f3', 1)],
    fighters: [],
    scores: [score('m1', 'x', 10), score('m1', 'y', 5), score('m2', 'z', 20)],
    starters: [],
    members: [{ id: 'm1', team_name: 'Alpha' }, { id: 'm2', team_name: 'Beta' }],
    pastTotals: { m1: 100, m2: 90 }
  }, extra || {});
}

// ---- 1. refetch applies wholesale -----------------------------------------
{
  let st = S.create(LEAGUE, EVENT);
  const r = S.apply(st, { type: 'refetch', payload: basePayload(), at: 1000 });
  st = r.state;
  assert(st.rev === 1 && st.token === '2026-06-10T01:00:00Z', 'refetch applies and bumps rev');
  assert(Object.keys(st.fights).length === 3, 'refetch indexes fights');
  assert(st.scores['m1|x'].total_points === 10, 'refetch indexes scores by member|fighter');
}

// ---- 2. out-of-order refetch (older token) is discarded ---------------------
{
  let st = S.create(LEAGUE, EVENT);
  st = S.apply(st, { type: 'refetch', payload: basePayload({ token: '2026-06-10T02:00:00Z' }) }).state;
  const before = st.rev;
  const r = S.apply(st, { type: 'refetch', payload: basePayload({ token: '2026-06-10T01:00:00Z', scores: [] }) });
  assert(r.state.rev === before, 'older-token refetch leaves state untouched');
  assert(eventTypes(r.events).includes('refetchDiscarded'), 'older-token refetch reports discard');
  assert(r.state.scores['m1|x'], 'scores survive the discarded refetch');
}

// ---- 3. null tokens never discard (pre-migration / preview events) ----------
{
  let st = S.create(LEAGUE, EVENT);
  st = S.apply(st, { type: 'refetch', payload: basePayload({ token: null }) }).state;
  const r = S.apply(st, { type: 'refetch', payload: basePayload({ token: null, scores: [score('m1', 'x', 99)] }) });
  assert(r.state.scores['m1|x'].total_points === 99, 'null-token refetch still applies');
}

// ---- 4. snapshot scope/version validation -----------------------------------
{
  let st = S.create(LEAGUE, EVENT);
  let snapState = S.apply(S.create(LEAGUE, EVENT), { type: 'refetch', payload: basePayload(), at: 500 }).state;
  const snap = S.serialize(snapState);

  const wrongEvent = S.apply(S.create(LEAGUE, 'event-OTHER'), { type: 'snapshot', snapshot: snap });
  assert(eventTypes(wrongEvent.events) === 'snapshotRejected', 'snapshot rejected for wrong event');

  const wrongVersion = S.apply(st, { type: 'snapshot', snapshot: Object.assign({}, snap, { v: 999 }) });
  assert(eventTypes(wrongVersion.events) === 'snapshotRejected', 'snapshot rejected for wrong schema version');

  const ok = S.apply(st, { type: 'snapshot', snapshot: snap });
  assert(ok.state.fetchedAt === 500 && Object.keys(ok.state.fights).length === 3, 'valid snapshot hydrates');

  // snapshot can never override live data
  let live = S.apply(S.create(LEAGUE, EVENT), { type: 'refetch', payload: basePayload(), at: 900 }).state;
  const overridden = S.apply(live, { type: 'snapshot', snapshot: snap });
  assert(eventTypes(overridden.events) === 'snapshotRejected', 'snapshot rejected once live data exists');
}

// ---- 5. score DELETE forces a refetch ----------------------------------------
{
  let st = S.apply(S.create(LEAGUE, EVENT), { type: 'refetch', payload: basePayload() }).state;
  const r = S.apply(st, { type: 'scoreChange', eventType: 'DELETE', row: null });
  assert(eventTypes(r.events) === 'needsRefetch', 'score DELETE emits needsRefetch');
  assert(r.state.rev === st.rev, 'score DELETE does not patch state');
}

// ---- 6. token poll triggers refetch only when token moves --------------------
{
  let st = S.apply(S.create(LEAGUE, EVENT), { type: 'refetch', payload: basePayload({ token: '2026-06-10T01:00:00Z' }) }).state;
  const same = S.apply(st, { type: 'tokenPoll', token: '2026-06-10T01:00:00Z' });
  assert(same.events.length === 0, 'same token: no refetch');
  const newer = S.apply(st, { type: 'tokenPoll', token: '2026-06-10T01:02:00Z' });
  assert(eventTypes(newer.events) === 'needsRefetch', 'newer token: needsRefetch');
}

// ---- 7. live fight-final fires once, never replays ----------------------------
{
  let st = S.apply(S.create(LEAGUE, EVENT), { type: 'refetch', payload: basePayload() }).state;
  const r1 = S.apply(st, { type: 'fightChange', row: fight('f1', 12, 'ko') });
  assert(eventTypes(r1.events).includes('fightFinal'), 'outcome null->set emits fightFinal');
  assert(r1.events.find((e) => e.type === 'fightFinal').via === 'live', 'realtime final is via:live');
  const r2 = S.apply(r1.state, { type: 'fightChange', row: fight('f1', 12, 'ko') });
  assert(!eventTypes(r2.events).includes('fightFinal'), 'same final never re-fires');
}

// ---- 8. refetch-discovered finals are via:hydration ----------------------------
{
  let st = S.apply(S.create(LEAGUE, EVENT), { type: 'refetch', payload: basePayload() }).state;
  const r = S.apply(st, { type: 'refetch', payload: basePayload({ token: '2026-06-10T03:00:00Z', fights: [fight('f1', 12, 'ko'), fight('f2', 11), fight('f3', 1)] }) });
  const fin = r.events.find((e) => e.type === 'fightFinal');
  assert(fin && fin.via === 'hydration', 'refetch-discovered final is via:hydration');
  // and a snapshot round-trip preserves the seen set
  const snap = S.serialize(r.state);
  const re = S.apply(S.create(LEAGUE, EVENT), { type: 'snapshot', snapshot: snap });
  assert(!re.events.some((e) => e.type === 'fightFinal'), 'seen finals never replay after snapshot restore');
}

// ---- 9. run order: prelims (high fight_order) first, main event last ----------
{
  let st = S.apply(S.create(LEAGUE, EVENT), { type: 'refetch', payload: basePayload() }).state;
  const order = S.runOrder(st).map((f) => f.id);
  assert(order.join(',') === 'f1,f2,f3', 'run order sorts fight_order descending');
  assert(S.currentFight(st).id === 'f1', 'current fight = next in run order');
  assert(S.upNextFight(st).id === 'f2', 'up next = the one after');
  // f1 finishes -> current advances
  st = S.apply(st, { type: 'fightChange', row: fight('f1', 12, 'ko') }).state;
  assert(S.currentFight(st).id === 'f2' && S.upNextFight(st).id === 'f3', 'current advances when a fight ends');
}

// ---- 10. race math: event mode, season mode, tie-aware ranks -------------------
{
  let st = S.apply(S.create(LEAGUE, EVENT), { type: 'refetch', payload: basePayload() }).state;
  const ev = S.raceRows(st, 'event');
  assert(ev[0].member.id === 'm2' && ev[0].eventPts === 20 && ev[0].rank === 1, 'event mode ranks by tonight');
  assert(ev[1].member.id === 'm1' && ev[1].eventPts === 15, 'event points sum per member');
  const season = S.raceRows(st, 'season');
  assert(season[0].member.id === 'm1' && season[0].seasonTotal === 115, 'season mode includes live points');
  // tie: give m2 15 event points too -> shared rank in event mode
  st = S.apply(st, { type: 'scoreChange', eventType: 'UPDATE', row: score('m2', 'z', 15) }).state;
  const tied = S.raceRows(st, 'event');
  assert(tied[0].rank === 1 && tied[1].rank === 1, 'tied event points share rank 1');
}

// ---- 11. phase machine ----------------------------------------------------------
{
  const base = { lockMs: 1000, untilMs: 5000, totalFights: 3, decidedFights: 0 };
  assert(S.phaseOf(base, 500) === 'PREVIEW', 'before lock: PREVIEW');
  assert(S.phaseOf(base, 1500) === 'LIVE', 'after lock: LIVE');
  assert(S.phaseOf(Object.assign({}, base, { decidedFights: 3 }), 2000) === 'FINAL', 'all fights decided: FINAL');
  assert(S.phaseOf(base, 6000) === 'FINAL', 'past currentUntil: FINAL');
  assert(S.phaseOf({ lockMs: null, untilMs: null, totalFights: 3, decidedFights: 0 }, 0) === 'PREVIEW', 'no lock + nothing decided: PREVIEW');
}

// ---- 12. realtime patch for an unknown fight forces refetch ---------------------
{
  let st = S.apply(S.create(LEAGUE, EVENT), { type: 'refetch', payload: basePayload() }).state;
  const r = S.apply(st, { type: 'fightChange', row: fight('f-new', 13) });
  assert(eventTypes(r.events) === 'needsRefetch', 'unknown fight id triggers refetch (late addition to card)');
  const other = S.apply(st, { type: 'fightChange', row: { id: 'zz', event_id: 'other-event', outcome: 'ko' } });
  assert(other.events.length === 0 && other.state.rev === st.rev, 'other-event payloads are ignored');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
