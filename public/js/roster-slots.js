// ========================================================================
// ROSTER SLOTS — shared multi-division slot-assignment engine
// ------------------------------------------------------------------------
// One correct implementation of "given these roster fighters, does a valid
// assignment into the division slots exist, and which slot does each land
// in?" Used by every surface that validates or displays roster construction
// (draft canPick, waivers checkRosterConstruction, the server waiver
// processor, and the roster/lineup slot displays) so the rules live in ONE
// place instead of 4+ hand-rolled copies.
//
// Slots (the v1.2 construction rules):
//   * 8 men's divisions, 1 slot each   -> slot key = the division key
//   * 1 Women's Flex, pooled across the 3 women's divisions -> 'womens_flex'
//   * N Any-Division Flex              -> 'any_flex'  (N from league config)
//
// MULTI-DIVISION: a fighter is eligible at every division in
// fighter.eligible_divisions (falls back to [primary_division] when the
// column is null/empty, so single-division behavior is unchanged). A fighter
// eligible at two men's divisions (e.g. Vinicius Oliveira BW/FE) can fill
// EITHER division slot, or an any-flex slot. Deciding whether everyone fits
// is therefore a bipartite matching problem, not a per-division count.
//
// OVERRIDES: fighter.slot_override pins a fighter to one slot:
//   * a men's division key -> that men's slot (manual multi-div choice)
//   * 'womens_flex'        -> the women's flex slot
//   * 'any_flex'           -> an any-flex slot (also the TERF expansion pin)
//   * null/undefined       -> auto-fit (any eligible slot)
// An override that isn't actually eligible is ignored (treated as auto) so a
// stale pin can never make a roster un-assignable.
//
// UMD: attaches to window.RosterSlots in the browser and module.exports in
// Node (same pattern as next-fight.js) so the server waiver processor can
// require the exact same engine.
// ========================================================================

(function (root) {
  'use strict';

  // Canonical division groupings. Kept here so the engine is self-contained;
  // callers may pass their own via config.mensDivisions / config.womensKeys
  // but these defaults match the app-wide constants.
  var MENS_DIVISIONS = [
    'flyweight', 'bantamweight', 'featherweight', 'lightweight',
    'welterweight', 'middleweight', 'light_heavyweight', 'heavyweight'
  ];
  var WOMENS_KEYS = ['strawweight', 'flyweight_w', 'bantamweight_w'];

  // Safe accessor: the set of divisions a fighter may be slotted at. Always
  // returns a non-empty array when the fighter has any division info, so
  // callers never have to special-case the null column during rollout.
  function eligibleDivisionsOf(fighter) {
    if (!fighter) return [];
    var elig = fighter.eligible_divisions;
    if (Array.isArray(elig) && elig.length > 0) {
      return elig.filter(Boolean);
    }
    return fighter.primary_division ? [fighter.primary_division] : [];
  }

  // Build the ordered list of candidate slot *types* for a fighter (before
  // expanding to unit-slots). Order matters only for which valid assignment
  // we surface for display — we bias toward the fighter's primary division so
  // auto-fit shows the "expected" home slot when it's free. Legality is
  // order-independent (max matching).
  function candidateSlotsFor(fighter, womensKeys, mensSet) {
    var over = fighter.slot_override;
    var elig = eligibleDivisionsOf(fighter);
    var eligSet = {};
    elig.forEach(function (d) { eligSet[d] = true; });

    // Is the fighter eligible for the women's pool at all?
    var womensEligible = elig.some(function (d) { return womensKeys.indexOf(d) !== -1; });

    // Honor a valid override by restricting to exactly that slot.
    if (over) {
      if (over === 'any_flex') return ['any_flex'];
      if (over === 'womens_flex') {
        if (womensEligible) return ['womens_flex'];
        // stale/invalid -> fall through to auto
      } else if (mensSet[over] && eligSet[over]) {
        return [over];
      } else if (womensKeys.indexOf(over) !== -1 && eligSet[over]) {
        return ['womens_flex'];
      }
      // Any other override value is stale/ineligible -> ignore, auto-fit.
    }

    // Auto-fit: primary division first (nicer default display), then the
    // other eligible men's divisions, then the women's pool, then flex.
    var slots = [];
    var primary = fighter.primary_division;
    if (primary && mensSet[primary] && eligSet[primary]) slots.push(primary);
    elig.forEach(function (d) {
      if (mensSet[d] && d !== primary && slots.indexOf(d) === -1) slots.push(d);
    });
    if (womensEligible && slots.indexOf('womens_flex') === -1) slots.push('womens_flex');
    slots.push('any_flex');
    return slots;
  }

  // Core: compute a valid slot assignment for the whole roster, or report
  // that none exists. Returns:
  //   { ok, byFighter: {id: slotKey}, bySlot: {slotKey: [id..]}, unassigned: [id..] }
  // ok === (unassigned.length === 0). When !ok the roster can't be legally
  // constructed at these slot caps (too many in some division group / over
  // the flex cap / over total size).
  //
  // config: {
  //   anyFlexCap:      number  (required — league's any-flex slot count)
  //   womensFlexSlots: number  (default 1)
  //   slotsPerDivision:number  (default 1)
  //   mensDivisions:   string[] (default MENS_DIVISIONS)
  //   womensKeys:      string[] (default WOMENS_KEYS)
  // }
  function computeAssignment(fighters, config) {
    config = config || {};
    var mens = config.mensDivisions || MENS_DIVISIONS;
    var womensKeys = config.womensKeys || WOMENS_KEYS;
    var perDiv = config.slotsPerDivision != null ? config.slotsPerDivision : 1;
    var womensFlex = config.womensFlexSlots != null ? config.womensFlexSlots : 1;
    var anyFlexCap = config.anyFlexCap != null ? config.anyFlexCap : 0;

    var mensSet = {};
    mens.forEach(function (d) { mensSet[d] = true; });

    // Expand slot types into individual unit-slots. Each unit holds exactly
    // one fighter; a "type" (division key / 'womens_flex' / 'any_flex') is
    // what a fighter's candidate list references. Standard bipartite matching
    // over unit-slots is simplest and correct at this scale (<= ~17 units).
    var units = [];   // { type }
    mens.forEach(function (d) {
      for (var i = 0; i < perDiv; i++) units.push({ type: d });
    });
    for (var w = 0; w < womensFlex; w++) units.push({ type: 'womens_flex' });
    for (var a = 0; a < anyFlexCap; a++) units.push({ type: 'any_flex' });

    // Index units by the type they accept, for quick candidate lookup.
    var unitsByType = {};
    units.forEach(function (u, idx) {
      (unitsByType[u.type] = unitsByType[u.type] || []).push(idx);
    });

    // Order fighters most-constrained-first (pinned, then fewest candidate
    // slot types) so the greedy augmenting search resolves tight rosters and
    // gives a stable result.
    var order = fighters.map(function (f, i) {
      return { f: f, i: i, cand: candidateSlotsFor(f, womensKeys, mensSet) };
    });
    order.sort(function (a, b) {
      var ap = a.f.slot_override ? 0 : 1, bp = b.f.slot_override ? 0 : 1;
      if (ap !== bp) return ap - bp;
      if (a.cand.length !== b.cand.length) return a.cand.length - b.cand.length;
      return a.i - b.i;
    });

    var unitOwner = new Array(units.length).fill(null); // unit idx -> fighter id
    var byFighter = {};
    var unassigned = [];

    // Kuhn's augmenting path: try to seat one fighter, bumping already-seated
    // fighters to alternative units when that frees a seat.
    function trySeat(entry, visited) {
      var candTypes = entry.cand;
      for (var t = 0; t < candTypes.length; t++) {
        var pool = unitsByType[candTypes[t]] || [];
        for (var k = 0; k < pool.length; k++) {
          var u = pool[k];
          if (visited[u]) continue;
          visited[u] = true;
          if (unitOwner[u] === null || trySeat(ownerEntry[unitOwner[u]], visited)) {
            unitOwner[u] = entry.f.__rsId;
            byFighter[entry.f.__rsId] = units[u].type;
            entry.__unit = u;
            return true;
          }
        }
      }
      return false;
    }

    // Stamp a stable internal id on each fighter (id, else index) and keep a
    // back-reference so augmenting can re-seat the current owner of a unit.
    var ownerEntry = {};
    order.forEach(function (entry, idx) {
      entry.f.__rsId = (entry.f.id != null ? entry.f.id : ('__idx_' + entry.i));
      ownerEntry[entry.f.__rsId] = entry;
    });

    // Pass 1 — greedy, NO displacement: each fighter (most-constrained first)
    // takes the first FREE unit in its own preference order. This yields the
    // intuitive display assignment: a fighter with few options keeps his home
    // slot and flexible fighters slide to their alternates, rather than the
    // augmenting search bumping a pure fighter out to flex just to hand a
    // multi-div fighter his primary. Legality doesn't depend on this pass;
    // pass 2 recovers a full (maximum) matching for anyone left over.
    var leftover = [];
    order.forEach(function (entry) {
      var seatedFree = false;
      for (var t = 0; t < entry.cand.length && !seatedFree; t++) {
        var pool = unitsByType[entry.cand[t]] || [];
        for (var k = 0; k < pool.length; k++) {
          if (unitOwner[pool[k]] === null) {
            unitOwner[pool[k]] = entry.f.__rsId;
            byFighter[entry.f.__rsId] = entry.cand[t];
            entry.__unit = pool[k];
            seatedFree = true;
            break;
          }
        }
      }
      if (!seatedFree) leftover.push(entry);
    });

    // Pass 2 — augmenting paths (with displacement) for anyone greedy couldn't
    // seat. Starting from the greedy matching and augmenting the rest still
    // reaches a maximum matching, so feasibility is preserved.
    leftover.forEach(function (entry) {
      var seated = trySeat(entry, new Array(units.length).fill(false));
      if (!seated) unassigned.push(entry.f.__rsId);
    });

    // Build bySlot from the final ownership.
    var bySlot = {};
    units.forEach(function (u, idx) {
      if (unitOwner[idx] != null) {
        (bySlot[u.type] = bySlot[u.type] || []).push(unitOwner[idx]);
      }
    });

    // Clean up the temporary stamps so we don't leak internal state onto the
    // caller's fighter objects.
    order.forEach(function (entry) { try { delete entry.f.__rsId; } catch (e) {} });

    return {
      ok: unassigned.length === 0,
      byFighter: byFighter,
      bySlot: bySlot,
      unassigned: unassigned
    };
  }

  // Convenience: can `candidate` be legally ADDED to a roster that already
  // holds `current` fighters? (The core question for draft canPick / waiver
  // add validation.) Returns true iff an assignment exists for current+candidate.
  function canAdd(candidate, current, config) {
    var all = current.concat([candidate]);
    return computeAssignment(all, config).ok;
  }

  root.RosterSlots = {
    MENS_DIVISIONS: MENS_DIVISIONS,
    WOMENS_KEYS: WOMENS_KEYS,
    eligibleDivisionsOf: eligibleDivisionsOf,
    candidateSlotsFor: candidateSlotsFor,
    computeAssignment: computeAssignment,
    canAdd: canAdd
  };
})(typeof window !== 'undefined' ? window : this);
