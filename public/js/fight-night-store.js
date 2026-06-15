// ========================================================================
// FIGHT NIGHT STORE — the hub's single source of truth
//
// Dependency-free on purpose: no DOM, no Supabase, no globals. Runs in the
// browser (window.FightNightStore) AND in plain Node (module.exports) so
// the merge rules are provable with `node tests/fight-night-store.test.js`
// before any UI exists. Every data path (initial fetch, realtime payloads,
// the 60s token poll, the localStorage snapshot) feeds this store through
// apply(); every DOM region renders FROM the store. Nothing else touches
// the DOM. (This is the P0.2 lesson: ad-hoc data paths reconciling in the
// DOM is how boards stop updating.)
//
// Merge rules (the whole point of this file):
//   1. A refetch is authoritative and replaces event data WHOLESALE —
//      unless its token (ufc_events.last_scored_at) is strictly older
//      than what we already hold (an out-of-order response). Null tokens
//      compare as "not newer and not older": they never discard data.
//   2. Realtime payloads only PATCH between refetches. A scores DELETE
//      can't be patched safely (no payload body guarantee), so it emits
//      needsRefetch instead.
//   3. A snapshot only seeds an EMPTY store, and only if it matches the
//      schema version, league, and event.
//   4. Moments (toasts / animations) fire only for transitions the store
//      observed live; finals discovered via refetch/snapshot are reported
//      with via:'hydration' so the UI can stay silent. seenFinalFightIds
//      persists in the snapshot so reopening the page never replays.
//
// apply(state, action) -> { state, events }   (pure; state is replaced,
// never mutated, and state.rev increments on every accepted change)
// ========================================================================

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.FightNightStore = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  var SCHEMA_VERSION = 1;

  // ---- construction ------------------------------------------------------

  function create(leagueId, eventId) {
    return {
      v: SCHEMA_VERSION,
      rev: 0,
      leagueId: leagueId,
      eventId: eventId,
      token: null,          // ufc_events.last_scored_at at last accepted refetch
      fetchedAt: 0,         // epoch ms of last accepted refetch (drives "updated Xs ago")
      event: null,          // ufc_events row (override-merged)
      league: null,         // { scoring_config, name, ... }
      fights: {},           // fightId -> fight_results row
      fighters: {},         // fighterId -> fighters row
      scores: {},           // `${memberId}|${fighterId}` -> scores row
      starters: [],         // starter_selections rows for this event (all members)
      members: [],          // league_members rows
      pastTotals: {},       // memberId -> season points EXCLUDING this event (static)
      seenFinalFightIds: {} // fightId -> true (moment replay guard)
    };
  }

  function tokenNewer(a, b) {
    // Is token `a` strictly newer than `b`? Nulls are never newer.
    if (a == null || b == null) return false;
    return String(a) > String(b);
  }

  // ---- the reducer ---------------------------------------------------------

  function apply(state, action) {
    switch (action.type) {

      case 'snapshot': {
        var snap = action.snapshot;
        if (!snap || snap.v !== SCHEMA_VERSION) {
          return { state: state, events: [{ type: 'snapshotRejected', reason: 'version' }] };
        }
        if (snap.leagueId !== state.leagueId || snap.eventId !== state.eventId) {
          return { state: state, events: [{ type: 'snapshotRejected', reason: 'scope' }] };
        }
        if (state.fetchedAt > 0) {
          // Live data already loaded — a snapshot can never override it.
          return { state: state, events: [{ type: 'snapshotRejected', reason: 'stale' }] };
        }
        var next = clone(state);
        next.token = snap.token != null ? snap.token : null;
        next.fetchedAt = snap.fetchedAt || 0;
        next.event = snap.event || null;
        next.league = snap.league || null;
        next.fights = snap.fights || {};
        next.fighters = snap.fighters || {};
        next.scores = snap.scores || {};
        next.starters = snap.starters || [];
        next.members = snap.members || [];
        next.pastTotals = snap.pastTotals || {};
        next.seenFinalFightIds = snap.seenFinalFightIds || {};
        next.rev++;
        // Snapshot-discovered finals are seen-but-silent by construction:
        // they were persisted into seenFinalFightIds by the session that
        // observed them. Any final NOT in the seen set gets reported as
        // hydration so the UI updates without fanfare.
        var events = [{ type: 'hydrated', from: 'snapshot' }];
        markNewFinals(next, events, 'hydration');
        return { state: next, events: events };
      }

      case 'refetch': {
        var p = action.payload || {};
        // Out-of-order guard: discard only when PROVABLY stale.
        if (tokenNewer(state.token, p.token)) {
          return { state: state, events: [{ type: 'refetchDiscarded', reason: 'older-token' }] };
        }
        var next2 = clone(state);
        next2.token = p.token != null ? p.token : state.token;
        next2.fetchedAt = action.at || Date.now();
        if (p.event !== undefined) next2.event = p.event;
        if (p.league !== undefined) next2.league = p.league;
        if (p.fights !== undefined) next2.fights = indexBy(p.fights, 'id');
        if (p.fighters !== undefined) next2.fighters = indexBy(p.fighters, 'id');
        if (p.scores !== undefined) next2.scores = indexScores(p.scores);
        if (p.starters !== undefined) next2.starters = p.starters;
        if (p.members !== undefined) next2.members = p.members;
        if (p.pastTotals !== undefined) next2.pastTotals = p.pastTotals;
        next2.rev++;
        var events2 = [{ type: 'dataChanged', via: 'refetch' }];
        markNewFinals(next2, events2, action.liveObserved ? 'live' : 'hydration');
        return { state: next2, events: events2 };
      }

      case 'fightChange': {
        var row = action.row;
        if (!row || row.event_id !== state.eventId || !state.fights[row.id]) {
          // Unknown fight (or another event's) — a full refetch will pick it up.
          if (row && row.event_id === state.eventId && !state.fights[row.id]) {
            return { state: state, events: [{ type: 'needsRefetch', reason: 'unknown-fight' }] };
          }
          return { state: state, events: [] };
        }
        var prev = state.fights[row.id];
        var next3 = clone(state);
        next3.fights = assign({}, state.fights);
        next3.fights[row.id] = row;
        next3.rev++;
        var events3 = [{ type: 'dataChanged', via: 'realtime' }];
        if (!prev.outcome && row.outcome && !next3.seenFinalFightIds[row.id]) {
          next3.seenFinalFightIds = assign({}, next3.seenFinalFightIds);
          next3.seenFinalFightIds[row.id] = true;
          events3.push({ type: 'fightFinal', fightId: row.id, via: 'live' });
        }
        return { state: next3, events: events3 };
      }

      case 'scoreChange': {
        if (action.eventType === 'DELETE') {
          // Stale-row cleanup in scoreEvents.js deletes rows; realtime DELETE
          // payloads aren't guaranteed to carry the full old row, so the only
          // safe move is a wholesale refetch (merge rule #2).
          return { state: state, events: [{ type: 'needsRefetch', reason: 'score-delete' }] };
        }
        var srow = action.row;
        if (!srow || srow.event_id !== state.eventId || srow.league_id !== state.leagueId) {
          return { state: state, events: [] };
        }
        var key = srow.league_member_id + '|' + srow.fighter_id;
        var next4 = clone(state);
        next4.scores = assign({}, state.scores);
        next4.scores[key] = srow;
        next4.rev++;
        return { state: next4, events: [{ type: 'dataChanged', via: 'realtime' }] };
      }

      case 'tokenPoll': {
        if (tokenNewer(action.token, state.token)) {
          return { state: state, events: [{ type: 'needsRefetch', reason: 'token-moved' }] };
        }
        return { state: state, events: [] };
      }

      default:
        return { state: state, events: [] };
    }
  }

  // Report finals not yet in the seen set, marking them seen.
  function markNewFinals(state, events, via) {
    var changedSeen = false;
    for (var id in state.fights) {
      if (state.fights[id].outcome && !state.seenFinalFightIds[id]) {
        if (!changedSeen) { state.seenFinalFightIds = assign({}, state.seenFinalFightIds); changedSeen = true; }
        state.seenFinalFightIds[id] = true;
        events.push({ type: 'fightFinal', fightId: id, via: via });
      }
    }
  }

  // ---- snapshot (localStorage round-trip) -----------------------------------

  function serialize(state) {
    return {
      v: state.v,
      savedAt: Date.now(),
      leagueId: state.leagueId,
      eventId: state.eventId,
      token: state.token,
      fetchedAt: state.fetchedAt,
      event: state.event,
      league: state.league,
      fights: state.fights,
      fighters: state.fighters,
      scores: state.scores,
      starters: state.starters,
      members: state.members,
      pastTotals: state.pastTotals,
      seenFinalFightIds: state.seenFinalFightIds
    };
  }

  // ---- derived views (pure functions over state) -----------------------------

  // Fights run prelims-first: HIGHEST fight_order fights first, main event
  // (fight_order 1) last. Null fight_order sorts to the very end of the night.
  function runOrder(state) {
    var list = [];
    for (var id in state.fights) list.push(state.fights[id]);
    list.sort(function (a, b) {
      var ao = a.fight_order != null ? a.fight_order : -1;
      var bo = b.fight_order != null ? b.fight_order : -1;
      return bo - ao;
    });
    return list;
  }

  function currentFight(state) {
    var undecided = runOrder(state).filter(function (f) { return !f.outcome; });
    return undecided.length ? undecided[0] : null;
  }

  function upNextFight(state) {
    var undecided = runOrder(state).filter(function (f) { return !f.outcome; });
    return undecided.length > 1 ? undecided[1] : null;
  }

  // The bout that just happened — the decided fight immediately before the
  // current one. runOrder is chronological (descending fight_order), so the
  // fight directly above the first undecided one is the most recent final.
  function previousFight(state) {
    var order = runOrder(state);
    for (var i = 0; i < order.length; i++) {
      if (!order[i].outcome) {
        // order[i] is the current (live) fight; the one before it just ended.
        return (i > 0 && order[i - 1].outcome) ? order[i - 1] : null;
      }
    }
    // No undecided fights left (card complete): the last bout chronologically.
    return order.length ? order[order.length - 1] : null;
  }

  function decidedCount(state) {
    var n = 0;
    for (var id in state.fights) if (state.fights[id].outcome) n++;
    return n;
  }

  function fightCount(state) {
    var n = 0;
    for (var id in state.fights) { void id; n++; }
    return n;
  }

  // Live event points per member (sum of their scores rows for this event).
  function eventPointsByMember(state) {
    var totals = {};
    state.members.forEach(function (m) { totals[m.id] = 0; });
    for (var key in state.scores) {
      var row = state.scores[key];
      var mid = row.league_member_id;
      totals[mid] = (totals[mid] || 0) + (row.total_points || 0);
    }
    return totals;
  }

  // Race rows: ranked by event points (mode 'event') or season total
  // including tonight (mode 'season'). Tie-break: team name, like standings.
  function raceRows(state, mode) {
    var eventPts = eventPointsByMember(state);
    var rows = state.members.map(function (m) {
      var ev = eventPts[m.id] || 0;
      var season = (state.pastTotals[m.id] || 0) + ev;
      return { member: m, eventPts: ev, seasonTotal: season };
    });
    rows.sort(function (a, b) {
      var d = (mode === 'season') ? (b.seasonTotal - a.seasonTotal) : (b.eventPts - a.eventPts);
      return d !== 0 ? d : String(a.member.team_name).localeCompare(String(b.member.team_name));
    });
    // Tie-aware ranks (tied managers share a rank number, like standings.js)
    var ranks = [];
    rows.forEach(function (r, idx) {
      if (idx === 0) { ranks.push(1); return; }
      var prev = rows[idx - 1];
      var same = (mode === 'season')
        ? r.seasonTotal === prev.seasonTotal
        : r.eventPts === prev.eventPts;
      ranks.push(same ? ranks[idx - 1] : idx + 1);
    });
    rows.forEach(function (r, idx) { r.rank = ranks[idx]; });
    return rows;
  }

  // The page state machine. All time inputs are computed by the caller
  // (lock time via lineup rules, currentUntil via waiver-phase helpers,
  // `now` via the server-corrected clock) so this stays pure and testable.
  function phaseOf(input, now) {
    var lockMs = input.lockMs, untilMs = input.untilMs;
    var total = input.totalFights || 0, decided = input.decidedFights || 0;
    if (lockMs != null && now < lockMs) return 'PREVIEW';
    if (untilMs != null && now >= untilMs) return 'FINAL';
    if (total > 0 && decided >= total) return 'FINAL';
    if (lockMs == null) return total > 0 && decided > 0 ? 'LIVE' : 'PREVIEW';
    return 'LIVE';
  }

  // ---- small utils -----------------------------------------------------------

  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      for (var k in src) target[k] = src[k];
    }
    return target;
  }

  function clone(state) { return assign({}, state); }

  function indexBy(list, key) {
    var map = {};
    (list || []).forEach(function (item) { map[item[key]] = item; });
    return map;
  }

  function indexScores(list) {
    var map = {};
    (list || []).forEach(function (row) {
      map[row.league_member_id + '|' + row.fighter_id] = row;
    });
    return map;
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    create: create,
    apply: apply,
    serialize: serialize,
    runOrder: runOrder,
    currentFight: currentFight,
    upNextFight: upNextFight,
    previousFight: previousFight,
    decidedCount: decidedCount,
    fightCount: fightCount,
    eventPointsByMember: eventPointsByMember,
    raceRows: raceRows,
    phaseOf: phaseOf
  };
});
