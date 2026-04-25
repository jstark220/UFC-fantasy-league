// ========================================================================
// WAIVERS PAGE
// Lets managers claim free-agent fighters and drop roster fighters.
// Commissioner sees a full claim queue and a "Process All Claims" button.
//
// URL param: ?id=LEAGUE_UUID
// Depends on: supabaseClient, requireAuth, showFighterModal (fighter-modal.js)
// ========================================================================

const DIVISION_LABELS = {
  strawweight:       "Women's Strawweight",
  flyweight_w:       "Women's Flyweight",
  bantamweight_w:    "Women's Bantamweight",
  flyweight:         "Men's Flyweight",
  bantamweight:      "Men's Bantamweight",
  featherweight:     "Men's Featherweight",
  lightweight:       "Men's Lightweight",
  welterweight:      "Men's Welterweight",
  middleweight:      "Men's Middleweight",
  light_heavyweight: "Men's Light Heavyweight",
  heavyweight:       "Men's Heavyweight"
};

// Module-level state
var user, leagueId, league, members, myMember, myMemberId, isCommissioner;
var allFighters       = [];
var availableFighters = [];
var myRoster          = [];
var myClaims          = [];
var pendingAllClaims  = [];
var leagueActivity    = []; // approved claims across the whole league, newest first
var claimingFighter   = null;

// Waiver-phase state — recomputed at every page load and refresh
var nextEvent       = null;          // ufc_events row used as the schedule anchor
var phaseInfo       = { phase: 'FA', closesAt: null, opensAt: null };
var rosterCap       = 20;            // 20 normal, 23 during +3 expansion (Thu→Sun event week)
var fighterDropMap  = {};            // { fighter_id: { dropped_at, league_member_id, source } } — most recent drop per fighter

// ========================================================================
// INIT
// ========================================================================
async function initWaivers() {
  user = await requireAuth();
  if (!user) return;

  leagueId = new URLSearchParams(window.location.search).get('id');
  if (!leagueId) { window.location.href = 'dashboard.html'; return; }

  document.getElementById('leagueLink').href = 'league.html?id=' + leagueId;

  var results = await Promise.all([
    supabaseClient
      .from('leagues')
      .select('id, name, commissioner_id, draft_started')
      .eq('id', leagueId)
      .single(),
    supabaseClient
      .from('league_members')
      .select('id, user_id, team_name, waiver_priority')
      .eq('league_id', leagueId),
    supabaseClient
      .from('fighters')
      .select('id, name, primary_division, current_rank, is_champion, record_wins, record_losses, record_draws, photo_url, date_of_birth')
      .order('name'),
    supabaseClient
      .from('rosters')
      .select('fighter_id, league_member_id, acquired_at, acquired_method')
      .eq('league_id', leagueId),
    supabaseClient
      .from('waiver_claims')
      .select('*')
      .eq('league_id', leagueId)
      .order('priority')
      .order('submitted_at'),
    // Next non-completed event drives the phase schedule
    supabaseClient
      .from('ufc_events')
      .select('id, name, full_name, event_date, lineup_lock_time, is_completed')
      .eq('is_completed', false)
      .order('event_date', { ascending: true })
      .limit(1),
    // Drop history — used for rolling waivers and the auto-drop bookkeeping
    supabaseClient
      .from('roster_drops')
      .select('id, fighter_id, league_member_id, dropped_at, source')
      .eq('league_id', leagueId)
      .order('dropped_at', { ascending: false })
  ]);

  var leagueRes  = results[0];
  var membersRes = results[1];
  var fightersRes = results[2];
  var rostersRes = results[3];
  var claimsRes  = results[4];
  var eventsRes  = results[5];
  var dropsRes   = results[6];

  if (leagueRes.error || !leagueRes.data) {
    window.location.href = 'dashboard.html';
    return;
  }

  league  = leagueRes.data;
  members = membersRes.data || [];

  myMember = members.find(function(m) { return m.user_id === user.id; });
  if (!myMember) { window.location.href = 'dashboard.html'; return; }
  myMemberId     = myMember.id;
  isCommissioner = league.commissioner_id === user.id;

  allFighters = fightersRes.data || [];

  var allRosters = rostersRes.data || [];
  var ownedIds   = new Set(allRosters.map(function(r) { return r.fighter_id; }));
  availableFighters = allFighters.filter(function(f) { return !ownedIds.has(f.id); });

  var myRosterIds = allRosters
    .filter(function(r) { return r.league_member_id === myMemberId; })
    .map(function(r) { return r.fighter_id; });
  myRoster = allFighters.filter(function(f) { return myRosterIds.includes(f.id); });

  var allClaims  = claimsRes.data || [];
  myClaims         = allClaims.filter(function(c) { return c.league_member_id === myMemberId; });
  pendingAllClaims = allClaims.filter(function(c) { return c.status === 'pending'; });
  leagueActivity   = buildLeagueActivity(allClaims, dropsRes.data || [], rostersRes.data || []);

  // ---- Phase / cap / rolling-waiver state ----
  nextEvent = (eventsRes.data && eventsRes.data[0]) || null;
  recomputePhaseState(dropsRes.data || []);

  document.title = 'Free Agency - ' + league.name;
  document.getElementById('leagueName').textContent = league.name;

  var nav = '<a href="standings.html?id=' + leagueId + '" class="btn-secondary">Standings</a>';
  nav    += '<a href="waivers.html?id='   + leagueId + '" class="btn-primary">Free Agency</a>';
  nav    += '<a href="trades.html?id='    + leagueId + '" class="btn-secondary">Trades</a>';
  nav    += '<a href="lineup.html?id='    + leagueId + '" class="btn-secondary">My Lineup</a>';
  document.getElementById('headerActions').innerHTML = nav;

  wireUpTabs();
  wireUpSearch();

  // Lazy processor: catch up on any cutoffs whose time has passed.
  // Runs before render so the UI reflects the freshest state.
  await runLazyProcessor();

  renderPhaseBanner();
  renderAvailableFighters();
  renderMyClaims();
  renderRosterActivity();

  if (isCommissioner) {
    document.getElementById('commissionerSection').style.display = 'block';
    renderProcessingQueue();
  }

  document.getElementById('pageContent').style.display = 'block';
}

// ========================================================================
// PHASE STATE
// Recompute the phase / cap / rolling-waiver derivation from the current
// drops snapshot. Called from init and refreshData.
// ========================================================================
function recomputePhaseState(drops) {
  var now = new Date();
  var eventDate = nextEvent ? nextEvent.event_date : null;
  phaseInfo  = getWaiverPhase(now, eventDate);
  rosterCap  = getRosterCap(now, eventDate);

  // Build a map of (fighter_id) → most recent drop row. `drops` arrives
  // sorted desc, so the first row we see for each fighter is the latest.
  fighterDropMap = {};
  drops.forEach(function(d) {
    if (!fighterDropMap[d.fighter_id]) fighterDropMap[d.fighter_id] = d;
  });
}

// Build the unified league-wide activity feed shown on the Roster Activity
// tab. Combines three sources, deduplicates pairs, sorts newest first.
//
// Sources:
//   * `waiver_claims` rows with status='approved' — already structured as a
//     paired add/drop transaction.
//   * `rosters` rows with acquired_method='free_agent' — these are instant
//     FA adds. Some come paired with a same-team drop within a few seconds
//     (a swap); others are bare adds (manager had an open slot).
//   * `roster_drops` with source IN ('manual','auto') — manual or auto
//     drops not associated with a waiver claim (claim drops are already
//     covered by the waiver_claims source above, so source='claim' is
//     skipped here to avoid double-counting).
//
// Returns: list of { kind, occurredAt, memberId, addedFighterId, droppedFighterId }
//   kind ∈ {'waiver','fa_swap','fa_add','manual_drop','auto_drop'}
function buildLeagueActivity(claims, drops, rosterRows) {
  var items = [];
  var consumedDropIds = new Set();

  // 1. Approved waiver claims
  claims.filter(function(c) { return c.status === 'approved'; }).forEach(function(c) {
    items.push({
      kind: 'waiver',
      occurredAt: c.processed_at || c.submitted_at,
      memberId: c.league_member_id,
      addedFighterId: c.fighter_to_add_id,
      droppedFighterId: c.fighter_to_drop_id || null
    });
  });

  // 2. Free-agent adds — try to pair each with a same-team manual drop within
  //    5 seconds (the surrounding instant-add code does delete-then-insert).
  var faRows = rosterRows.filter(function(r) { return r.acquired_method === 'free_agent' && r.acquired_at; });
  faRows.forEach(function(r) {
    var t = new Date(r.acquired_at).getTime();
    var match = drops.find(function(d) {
      if (d.source !== 'manual')                       return false;
      if (d.league_member_id !== r.league_member_id)   return false;
      if (consumedDropIds.has(d.id))                   return false;
      return Math.abs(new Date(d.dropped_at).getTime() - t) < 5000;
    });
    if (match) {
      consumedDropIds.add(match.id);
      items.push({
        kind: 'fa_swap',
        occurredAt: r.acquired_at,
        memberId: r.league_member_id,
        addedFighterId: r.fighter_id,
        droppedFighterId: match.fighter_id
      });
    } else {
      items.push({
        kind: 'fa_add',
        occurredAt: r.acquired_at,
        memberId: r.league_member_id,
        addedFighterId: r.fighter_id,
        droppedFighterId: null
      });
    }
  });

  // 3. Drops not paired with anything above (standalone manual + auto)
  drops.forEach(function(d) {
    if (d.source !== 'manual' && d.source !== 'auto') return; // skip 'claim'
    if (consumedDropIds.has(d.id))                    return;
    items.push({
      kind: d.source === 'auto' ? 'auto_drop' : 'manual_drop',
      occurredAt: d.dropped_at,
      memberId: d.league_member_id,
      addedFighterId: null,
      droppedFighterId: d.fighter_id
    });
  });

  // Newest first
  items.sort(function(a, b) {
    return new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime();
  });

  return items;
}

// True iff the fighter is currently on rolling waivers (dropped within the
// last 48 hrs, i.e. not yet cleared at 3am ET on drop_date + 2 days).
function fighterOnRollingWaiver(fighterId) {
  var d = fighterDropMap[fighterId];
  if (!d) return false;
  return isOnRollingWaiver(new Date(d.dropped_at), new Date());
}

// When this fighter clears waivers (Date) — null if not on waivers.
function fighterRollingClearTime(fighterId) {
  var d = fighterDropMap[fighterId];
  if (!d) return null;
  return getRollingClearTime(new Date(d.dropped_at));
}

// Decides whether claiming this specific fighter requires going through
// the waiver flow vs. instant FA add. Returns a reason for display.
//   { mode: 'instant' }
//   { mode: 'claim', reason: 'window_pre' | 'window_post' | 'rolling', closesAt }
function decideAddMode(fighterId) {
  if (phaseInfo.phase === 'WINDOW_PRE') {
    return { mode: 'claim', reason: 'window_pre',  closesAt: phaseInfo.closesAt };
  }
  if (phaseInfo.phase === 'WINDOW_POST') {
    return { mode: 'claim', reason: 'window_post', closesAt: phaseInfo.closesAt };
  }
  // FA phase — only fighters on rolling waiver require a claim
  if (fighterOnRollingWaiver(fighterId)) {
    return { mode: 'claim', reason: 'rolling', closesAt: fighterRollingClearTime(fighterId) };
  }
  return { mode: 'instant' };
}

// ========================================================================
// PHASE BANNER
// Always-visible status strip explaining the current waiver mode and the
// time of the next cutoff. Runs after every refresh.
// ========================================================================
function renderPhaseBanner() {
  var el  = document.getElementById('phaseBanner');
  if (!el) return;
  var now = new Date();

  var title, body, variant;
  if (phaseInfo.phase === 'WINDOW_PRE') {
    variant = 'phase-banner--window';
    title   = 'Pre-event waivers open';
    body    = 'All adds are claims. Roster cap is ' + rosterCap + '. ' +
              'Claims process ' + formatEtDateTime(phaseInfo.closesAt) +
              ' (' + formatRelativeShort(phaseInfo.closesAt, now) + ').';
  } else if (phaseInfo.phase === 'WINDOW_POST') {
    variant = 'phase-banner--window';
    title   = 'Post-event waivers open';
    body    = 'All adds are claims. Roster cap is ' + rosterCap + '. ' +
              'Claims process ' + formatEtDateTime(phaseInfo.closesAt) +
              ' (' + formatRelativeShort(phaseInfo.closesAt, now) + ').';
  } else {
    variant = 'phase-banner--fa';
    title   = 'Free agency';
    var nextOpen = phaseInfo.opensAt
      ? 'Next waiver window opens ' + formatEtDateTime(phaseInfo.opensAt) +
        ' (' + formatRelativeShort(phaseInfo.opensAt, now) + ')'
      : 'No upcoming waiver window';
    body = 'Free agents can be added instantly. Recently dropped fighters ' +
           'still run on waivers for ~48 hours. ' + nextOpen + '. ' +
           'Roster cap is ' + rosterCap + '.';
  }

  el.className = 'phase-banner ' + variant;
  el.style.display = '';
  el.innerHTML =
    '<div class="phase-banner__title">' + escapeHtml(title) + '</div>' +
    '<div class="phase-banner__body">'  + escapeHtml(body)  + '</div>';
}

// ========================================================================
// LAZY PROCESSOR
// Catch-up pass that runs at every page load. For each pending claim we
// derive its trigger time:
//
//   - submitted during WINDOW_PRE  → process at preClose
//   - submitted during WINDOW_POST → process at postClose
//   - otherwise                    → process at the fighter's rolling
//                                    waiver clear time (3am ET on
//                                    drop_date + 2 days)
//
// Any claim whose trigger has already passed gets processed in priority
// order. Auto-drop runs alongside if Wed 3am ET has passed since the
// most recent event.
//
// All writes go through the existing supabase client, so RLS still
// applies. (For the MVP this means commissioners trigger processing
// implicitly by visiting the page; non-commissioners can submit/cancel
// claims but won't have permission to mark others' claims processed.)
// ========================================================================
async function runLazyProcessor() {
  if (!nextEvent) return;

  var now      = new Date();
  var cutoffs  = getEventCutoffs(nextEvent.event_date);
  var rosterMap = await loadFreshRosters();

  // ---- Step 1: window claims that have passed their close time ----
  var preClaimsToRun  = [];
  var postClaimsToRun = [];
  var rollingByFighter = {};   // fighter_id → [claim, ...]

  pendingAllClaims.forEach(function(c) {
    var t = new Date(c.submitted_at).getTime();
    if (t >= cutoffs.preOpen.getTime() && t < cutoffs.preClose.getTime()) {
      if (now.getTime() >= cutoffs.preClose.getTime()) preClaimsToRun.push(c);
    } else if (t >= cutoffs.postOpen.getTime() && t < cutoffs.postClose.getTime()) {
      if (now.getTime() >= cutoffs.postClose.getTime()) postClaimsToRun.push(c);
    } else {
      // Rolling: only run when the fighter's clear time has passed
      var d = fighterDropMap[c.fighter_to_add_id];
      if (!d) return; // shouldn't happen — claim with no drop in FA
      var clearTime = getRollingClearTime(new Date(d.dropped_at));
      if (now.getTime() >= clearTime.getTime()) {
        if (!rollingByFighter[c.fighter_to_add_id]) rollingByFighter[c.fighter_to_add_id] = [];
        rollingByFighter[c.fighter_to_add_id].push(c);
      }
    }
  });

  if (preClaimsToRun.length)  await processClaimBatch(preClaimsToRun,  rosterMap);
  if (postClaimsToRun.length) await processClaimBatch(postClaimsToRun, rosterMap);
  Object.keys(rollingByFighter).forEach(function(fid) {
    // Rolling claims for one fighter compete in priority order
    rollingByFighter[fid].sort(function(a, b) {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime();
    });
  });
  for (var fid in rollingByFighter) {
    await processClaimBatch(rollingByFighter[fid], rosterMap);
  }

  // ---- Step 2: Wednesday 3am ET auto-drop ----
  if (now.getTime() >= cutoffs.autoDrop.getTime()) {
    await runAutoDropIfNeeded(cutoffs);
  }

  // Refresh local state if anything was processed
  if (preClaimsToRun.length || postClaimsToRun.length || Object.keys(rollingByFighter).length) {
    await refreshData();
  }
}

// When does this pending claim process? Mirrors the categorization the
// lazy processor uses, but exposed for the My Claims UI.
function computeClaimProcessTime(claim) {
  if (!nextEvent) return null;
  var cutoffs = getEventCutoffs(nextEvent.event_date);
  var t = new Date(claim.submitted_at).getTime();
  if (t >= cutoffs.preOpen.getTime()  && t < cutoffs.preClose.getTime())  return cutoffs.preClose;
  if (t >= cutoffs.postOpen.getTime() && t < cutoffs.postClose.getTime()) return cutoffs.postClose;
  // Rolling: based on the fighter's most-recent drop
  var d = fighterDropMap[claim.fighter_to_add_id];
  if (d) return getRollingClearTime(new Date(d.dropped_at));
  return null;
}

// Returns a fresh map of league_member_id → list of fighter_ids on their roster.
// Used during processing because the in-memory `myRoster` only covers the user.
async function loadFreshRosters() {
  var res = await supabaseClient
    .from('rosters')
    .select('league_member_id, fighter_id, acquired_at')
    .eq('league_id', leagueId);
  if (res.error) return {};
  var byMember = {};
  (res.data || []).forEach(function(r) {
    if (!byMember[r.league_member_id]) byMember[r.league_member_id] = [];
    byMember[r.league_member_id].push(r);
  });
  return byMember;
}

// Process a list of pending claims (already in priority order). Mirrors
// the existing commissioner processWaivers() logic but works on a passed-
// in claim batch and roster snapshot.
async function processClaimBatch(claims, rosterMap) {
  var fighterMap = {};
  allFighters.forEach(function(f) { fighterMap[f.id] = f; });

  var claimedThisCycle = new Set();

  for (var i = 0; i < claims.length; i++) {
    var claim = claims[i];

    // Skip if already won by an earlier claim in this batch
    if (claimedThisCycle.has(claim.fighter_to_add_id)) {
      await rejectClaim(claim, 'Fighter already claimed by a higher-priority team this cycle.');
      continue;
    }

    // Already on someone's roster?
    var ownerEntries = [];
    Object.keys(rosterMap).forEach(function(memberId) {
      rosterMap[memberId].forEach(function(r) {
        if (r.fighter_id === claim.fighter_to_add_id) ownerEntries.push({ memberId: memberId, row: r });
      });
    });
    if (ownerEntries.length > 0) {
      await rejectClaim(claim, 'Fighter is already on a roster.');
      continue;
    }

    // Drop validity
    if (claim.fighter_to_drop_id) {
      var myEntries = rosterMap[claim.league_member_id] || [];
      var dropOnRoster = myEntries.some(function(r) { return r.fighter_id === claim.fighter_to_drop_id; });
      if (!dropOnRoster) {
        await rejectClaim(claim, 'The fighter you selected to drop is no longer on your roster.');
        continue;
      }
    }

    // Cap check uses the cap that applied AT THE CLAIM'S PROCESS TIME, not now.
    // Pre-event close (Fri 3am ET) is still inside the +3 expansion → 23.
    // Post-event close (Tue 3am ET) is after revert → 20.
    // Rolling clears can happen any time; use the cap at that moment.
    var memberRoster = rosterMap[claim.league_member_id] || [];
    var processAt    = computeClaimProcessTime(claim) || new Date();
    var capAtProcessTime = getRosterCap(processAt, nextEvent ? nextEvent.event_date : null);
    if (memberRoster.length >= capAtProcessTime && !claim.fighter_to_drop_id) {
      await rejectClaim(claim, 'At the ' + capAtProcessTime + '-fighter cap. Must specify a fighter to drop.');
      continue;
    }

    // Roster construction
    var projected = memberRoster
      .filter(function(r) { return r.fighter_id !== claim.fighter_to_drop_id; })
      .map(function(r) { return fighterMap[r.fighter_id]; })
      .filter(Boolean);
    if (fighterMap[claim.fighter_to_add_id]) projected.push(fighterMap[claim.fighter_to_add_id]);
    var constructionErr = checkRosterConstruction(projected);
    if (constructionErr) {
      await rejectClaim(claim, constructionErr);
      continue;
    }

    // Apply the swap
    var addRes = await supabaseClient.from('rosters').insert({
      league_id: leagueId,
      league_member_id: claim.league_member_id,
      fighter_id: claim.fighter_to_add_id,
      acquired_method: 'waiver'
    });
    if (addRes.error) {
      await rejectClaim(claim, 'Database error adding fighter: ' + addRes.error.message);
      continue;
    }

    if (claim.fighter_to_drop_id) {
      await supabaseClient.from('rosters').delete()
        .eq('league_id', leagueId)
        .eq('league_member_id', claim.league_member_id)
        .eq('fighter_id', claim.fighter_to_drop_id);
      await supabaseClient.from('roster_drops').insert({
        league_id: leagueId,
        league_member_id: claim.league_member_id,
        fighter_id: claim.fighter_to_drop_id,
        source: 'claim'
      });
      // Update local snapshot so subsequent claims in this batch see it
      rosterMap[claim.league_member_id] = (rosterMap[claim.league_member_id] || [])
        .filter(function(r) { return r.fighter_id !== claim.fighter_to_drop_id; });
    }

    rosterMap[claim.league_member_id] = (rosterMap[claim.league_member_id] || []).concat([
      { fighter_id: claim.fighter_to_add_id, league_member_id: claim.league_member_id, acquired_at: new Date().toISOString() }
    ]);

    await supabaseClient.from('waiver_claims').update({
      status: 'approved',
      processed_at: new Date().toISOString()
    }).eq('id', claim.id);

    claimedThisCycle.add(claim.fighter_to_add_id);
  }
}

async function rejectClaim(claim, reason) {
  return supabaseClient.from('waiver_claims').update({
    status: 'rejected',
    rejection_reason: reason,
    processed_at: new Date().toISOString()
  }).eq('id', claim.id);
}

// ========================================================================
// AUTO-DROP — runs on/after Wed 3am ET. For each manager: if they've made
// fewer than 3 manual drops since the most recent cap-expansion (Thu 3am
// ET event week), drop their most-recently-added fighters until roster
// size <= 20. Each forced drop is logged with source='auto'.
//
// Idempotent: skipped for any manager who already has source='auto' drops
// recorded since this cycle's autoDrop time.
// ========================================================================
async function runAutoDropIfNeeded(cutoffs) {
  var rosterMap = await loadFreshRosters();
  var dropsRes  = await supabaseClient
    .from('roster_drops')
    .select('league_member_id, source, dropped_at')
    .eq('league_id', leagueId)
    .gte('dropped_at', cutoffs.capExpand.toISOString());
  var drops = dropsRes.data || [];

  // Per-manager tally: # manual drops since cap expansion, # auto drops since this cycle's autoDrop time
  var manualSince = {};
  var autoSince   = {};
  drops.forEach(function(d) {
    var t = new Date(d.dropped_at).getTime();
    if (d.source === 'manual' && t >= cutoffs.capExpand.getTime()) {
      manualSince[d.league_member_id] = (manualSince[d.league_member_id] || 0) + 1;
    }
    if (d.source === 'auto' && t >= cutoffs.autoDrop.getTime()) {
      autoSince[d.league_member_id] = (autoSince[d.league_member_id] || 0) + 1;
    }
  });

  for (var i = 0; i < members.length; i++) {
    var m = members[i];
    if (autoSince[m.id]) continue;                      // already auto-dropped this cycle
    if ((manualSince[m.id] || 0) >= 3) continue;        // dropped enough manually
    var roster = rosterMap[m.id] || [];
    if (roster.length <= 20) continue;                  // already compliant

    // Drop most recently added until size = 20
    roster.sort(function(a, b) {
      return new Date(b.acquired_at || 0).getTime() - new Date(a.acquired_at || 0).getTime();
    });
    var toDrop = roster.slice(0, roster.length - 20);
    for (var j = 0; j < toDrop.length; j++) {
      await supabaseClient.from('rosters').delete()
        .eq('league_id', leagueId)
        .eq('league_member_id', m.id)
        .eq('fighter_id', toDrop[j].fighter_id);
      await supabaseClient.from('roster_drops').insert({
        league_id: leagueId,
        league_member_id: m.id,
        fighter_id: toDrop[j].fighter_id,
        source: 'auto'
      });
    }
  }
}

// ========================================================================
// TABS
// ========================================================================
function wireUpTabs() {
  document.querySelector('.waiver-tabs').addEventListener('click', function(e) {
    var btn = e.target.closest('.waiver-tab');
    if (!btn) return;

    document.querySelectorAll('.waiver-tab').forEach(function(b) {
      b.classList.toggle('waiver-tab--active', b === btn);
    });

    var tab = btn.getAttribute('data-tab');
    document.getElementById('availableSection').style.display  = tab === 'available' ? '' : 'none';
    document.getElementById('myClaimsSection').style.display   = tab === 'my-claims' ? '' : 'none';
    document.getElementById('activitySection').style.display   = tab === 'activity'  ? '' : 'none';
  });
}

// ========================================================================
// SEARCH / FILTER
// ========================================================================
function wireUpSearch() {
  document.getElementById('fighterSearch').addEventListener('input', renderAvailableFighters);
  document.getElementById('divisionFilter').addEventListener('change', renderAvailableFighters);
  document.getElementById('statusFilter').addEventListener('change', renderAvailableFighters);
  document.getElementById('sortBy').addEventListener('change', renderAvailableFighters);
}

// ========================================================================
// RENDER AVAILABLE FIGHTERS
// ========================================================================
function renderAvailableFighters() {
  var query    = document.getElementById('fighterSearch').value.trim().toLowerCase();
  var division = document.getElementById('divisionFilter').value;
  var status   = document.getElementById('statusFilter').value;
  var sortBy   = document.getElementById('sortBy').value;

  var filtered = availableFighters.filter(function(f) {
    var matchesName = !query || f.name.toLowerCase().includes(query);
    var matchesDiv  = division === 'all' || f.primary_division === division;

    // Status / rank-tier filter
    var matchesStatus = true;
    if (status === 'undefeated') {
      matchesStatus = f.record_losses === 0 && (f.record_draws || 0) === 0;
    } else if (status === 'top5') {
      // Champions count as top 5
      matchesStatus = f.is_champion || (f.current_rank && f.current_rank <= 5);
    } else if (status === 'top10') {
      matchesStatus = f.is_champion || (f.current_rank && f.current_rank <= 10);
    } else if (status === 'unranked') {
      matchesStatus = !f.is_champion && !f.current_rank;
    }

    return matchesName && matchesDiv && matchesStatus;
  });

  // Sort a copy so the original array order is preserved for future renders
  filtered = filtered.slice().sort(function(a, b) {
    if (sortBy === 'rank') {
      // Champions first (rank 0), then ranked 1-15, then unranked (rank 999)
      var ra = a.is_champion ? 0 : (a.current_rank || 999);
      var rb = b.is_champion ? 0 : (b.current_rank || 999);
      return ra - rb;
    }
    if (sortBy === 'record') {
      // Most wins first, fewest losses as tiebreaker
      if (b.record_wins !== a.record_wins) return b.record_wins - a.record_wins;
      return a.record_losses - b.record_losses;
    }
    // 'points_year' and 'points_proj': data not yet available, fall back to rank order
    var ra2 = a.is_champion ? 0 : (a.current_rank || 999);
    var rb2 = b.is_champion ? 0 : (b.current_rank || 999);
    return ra2 - rb2;
  });

  var myPendingIds = new Set(
    myClaims
      .filter(function(c) { return c.status === 'pending'; })
      .map(function(c) { return c.fighter_to_add_id; })
  );

  var el = document.getElementById('availableContent');

  if (filtered.length === 0) {
    el.innerHTML = '<p class="draft-empty" style="padding: var(--space-4) 0">No available fighters match your search.</p>';
    return;
  }

  var html = '';
  filtered.forEach(function(f) {
    var rankLabel = f.is_champion ? 'C' : (f.current_rank ? '#' + f.current_rank : 'NR');
    var rankClass = f.is_champion ? 'rank-champion' : (f.current_rank ? 'rank-ranked' : 'rank-unranked');
    var divLabel  = DIVISION_LABELS[f.primary_division] || f.primary_division;
    var record    = f.record_wins + '-' + f.record_losses + (f.record_draws ? '-' + f.record_draws : '');
    var age       = ageFromDob(f.date_of_birth);
    var ageLabel  = age != null ? 'Age ' + age : 'Age [age]';
    var divLine   = divLabel + ' · ' + ageLabel;
    var addMode   = decideAddMode(f.id);

    // Rolling-waiver badge: shows above the row when this fighter is on
    // a 48hr hold, with the time it clears.
    var rollingNote = '';
    if (addMode.mode === 'claim' && addMode.reason === 'rolling') {
      rollingNote =
        '<span class="lineup-roster-row__matchup" style="color: var(--accent-gold)">' +
          'On waivers — clears ' + escapeHtml(formatEtDateTime(addMode.closesAt)) +
        '</span>';
    }
    var photoHtml = f.photo_url
      ? '<img class="lineup-roster-row__photo" src="' + escapeHtml(f.photo_url) + '" alt="' + escapeHtml(f.name) + '" onerror="this.style.display=\'none\'">'
      : '';

    var btnLabel = addMode.mode === 'instant' ? '+ Add' : '+ Claim';
    var btn = myPendingIds.has(f.id)
      ? '<button class="btn-secondary lineup-row-btn" disabled>Claimed</button>'
      : '<button class="btn-secondary lineup-row-btn waiver-claim-btn" data-fighter-id="' + f.id + '">' +
          btnLabel +
        '</button>';

    html +=
      '<div class="lineup-roster-row">' +
        '<div class="lineup-roster-row__photo-wrap">' + photoHtml + '</div>' +
        '<span class="lineup-roster-row__rank ' + rankClass + '">' + rankLabel + '</span>' +
        '<div class="lineup-roster-row__info">' +
          '<button class="lineup-roster-row__name" data-open-fighter="' + f.id + '">' + escapeHtml(f.name) + '</button>' +
          '<span class="lineup-roster-row__division">' + escapeHtml(divLine) + '</span>' +
          rollingNote +
        '</div>' +
        '<span class="lineup-roster-row__record">' + record + '</span>' +
        btn +
      '</div>';
  });

  el.innerHTML = html;

  el.querySelectorAll('.waiver-claim-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      openClaimModal(btn.getAttribute('data-fighter-id'));
    });
  });

  el.querySelectorAll('[data-open-fighter]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      showFighterModal(btn.getAttribute('data-open-fighter'));
    });
  });
}

// ========================================================================
// RENDER MY CLAIMS
// ========================================================================
function renderMyClaims() {
  var el = document.getElementById('myClaimsContent');

  var pending = myClaims.filter(function(c) { return c.status === 'pending'; });
  var past    = myClaims.filter(function(c) { return c.status !== 'pending'; });

  // Update the tab count badge
  var countEl = document.getElementById('claimCount');
  if (pending.length > 0) {
    countEl.textContent = pending.length;
    countEl.style.display = '';
  } else {
    countEl.style.display = 'none';
  }

  if (myClaims.length === 0) {
    el.innerHTML = '<p class="draft-empty" style="padding: var(--space-4) 0">No waiver claims yet. Go to "Available Fighters" to submit one.</p>';
    return;
  }

  var fighterMap = {};
  allFighters.forEach(function(f) { fighterMap[f.id] = f; });

  var html = '';

  if (pending.length > 0) {
    html += '<p class="section-label" style="margin-bottom: var(--space-4)">Pending <span class="section-label__count">(' + pending.length + ')</span></p>';

    pending.forEach(function(c) {
      var addFighter  = fighterMap[c.fighter_to_add_id];
      var dropFighter = c.fighter_to_drop_id ? fighterMap[c.fighter_to_drop_id] : null;
      var addDiv      = addFighter  ? (DIVISION_LABELS[addFighter.primary_division]  || addFighter.primary_division)  : '';
      var dropDiv     = dropFighter ? (DIVISION_LABELS[dropFighter.primary_division] || dropFighter.primary_division) : '';
      var processAt   = computeClaimProcessTime(c);
      var processLabel = processAt
        ? 'Processes ' + formatEtDateTime(processAt) + ' (' + formatRelativeShort(processAt, new Date()) + ')'
        : 'Awaiting process time';

      html +=
        '<div class="waiver-pending-card">' +
          '<div class="waiver-pending-card__sides">' +
            '<div class="waiver-pending-card__add">' +
              '<span class="waiver-pending-card__label">Claiming</span>' +
              '<span class="waiver-pending-card__fighter">' + escapeHtml(addFighter ? addFighter.name : '?') + '</span>' +
              '<span class="waiver-pending-card__div">' + escapeHtml(addDiv) + '</span>' +
            '</div>' +
            '<span class="waiver-pending-card__arrow">&rarr;</span>' +
            '<div class="waiver-pending-card__drop' + (dropFighter ? '' : ' waiver-pending-card__drop--empty') + '">' +
              '<span class="waiver-pending-card__label">Dropping</span>' +
              '<span class="waiver-pending-card__fighter">' + escapeHtml(dropFighter ? dropFighter.name : 'No drop') + '</span>' +
              (dropDiv ? '<span class="waiver-pending-card__div">' + escapeHtml(dropDiv) + '</span>' : '') +
            '</div>' +
          '</div>' +
          '<div class="waiver-pending-card__meta">' +
            '<span>Priority #' + escapeHtml(String(c.priority)) + '</span>' +
            '<span>' + escapeHtml(processLabel) + '</span>' +
            '<button class="btn-ghost" data-cancel-id="' + c.id + '">Cancel</button>' +
          '</div>' +
        '</div>';
    });
  }

  if (past.length > 0) {
    html += '<p class="section-label" style="margin-top: var(--space-8); margin-bottom: var(--space-4)">Past Claims</p>';
    html += '<div class="standings-card"><table class="standings-table"><thead><tr>' +
              '<th class="standings-th standings-th--team">Claimed</th>' +
              '<th class="standings-th standings-th--team">Dropped</th>' +
              '<th class="standings-th standings-th--pts">Status</th>' +
              '<th class="standings-th standings-th--team">Reason</th>' +
            '</tr></thead><tbody>';

    past.forEach(function(c) {
      var addFighter  = fighterMap[c.fighter_to_add_id];
      var dropFighter = c.fighter_to_drop_id ? fighterMap[c.fighter_to_drop_id] : null;
      var badgeClass  = c.status === 'approved' ? 'badge-approved' :
                        c.status === 'rejected'  ? 'badge-rejected' : 'badge-cancelled';

      html += '<tr class="standings-row">' +
        '<td class="standings-team-cell">' + escapeHtml(addFighter ? addFighter.name : '?') + '</td>' +
        '<td class="standings-team-cell">' + escapeHtml(dropFighter ? dropFighter.name : '—') + '</td>' +
        '<td class="standings-pts-cell"><span class="waiver-status-badge ' + badgeClass + '">' + escapeHtml(c.status) + '</span></td>' +
        '<td class="standings-team-cell" style="color: var(--text-tertiary); font-size: var(--text-caption)">' + escapeHtml(c.rejection_reason || '—') + '</td>' +
      '</tr>';
    });

    html += '</tbody></table></div>';
  }

  el.innerHTML = html;

  el.querySelectorAll('[data-cancel-id]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      cancelClaim(btn.getAttribute('data-cancel-id'));
    });
  });
}

// ========================================================================
// RENDER ROSTER ACTIVITY (LEAGUE-WIDE APPROVED CLAIMS)
// Public log of every successful add/drop in this league. Read-only.
// ========================================================================
function renderRosterActivity() {
  var el = document.getElementById('activityContent');

  if (leagueActivity.length === 0) {
    el.innerHTML = '<p class="draft-empty" style="padding: var(--space-4) 0">' +
      'No approved roster moves yet. They will appear here after waivers process.' +
      '</p>';
    return;
  }

  var fighterMap = {};
  allFighters.forEach(function(f) { fighterMap[f.id] = f; });

  var memberMap = {};
  members.forEach(function(m) { memberMap[m.id] = m; });

  // Subtle kind tag so users can tell waiver claims, FA adds, and auto drops apart
  var kindLabel = {
    waiver:      'Waiver',
    fa_swap:     'Free agent',
    fa_add:      'Free agent',
    manual_drop: 'Drop',
    auto_drop:   'Auto-drop'
  };

  var rows = leagueActivity.map(function(it) {
    var member      = memberMap[it.memberId];
    var addFighter  = it.addedFighterId   ? fighterMap[it.addedFighterId]   : null;
    var dropFighter = it.droppedFighterId ? fighterMap[it.droppedFighterId] : null;
    var dateStr     = it.occurredAt
      ? new Date(it.occurredAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '—';
    var teamLabel   = member
      ? (member.id === myMemberId ? member.team_name + ' (you)' : member.team_name)
      : '?';

    var addCell = addFighter
      ? '<span style="color: #4ade80">+ ' + escapeHtml(addFighter.name) + '</span>'
      : '<span style="color: var(--text-tertiary)">—</span>';
    var dropCell = dropFighter
      ? '<span style="color: var(--accent-crimson)">− ' + escapeHtml(dropFighter.name) + '</span>'
      : '<span style="color: var(--text-tertiary)">—</span>';

    return '<tr class="standings-row">' +
      '<td class="standings-pts-cell" style="text-align:left; padding-left: var(--space-4); color: var(--text-tertiary)">' +
        escapeHtml(dateStr) + '</td>' +
      '<td class="standings-team-cell">' + escapeHtml(teamLabel) + '</td>' +
      '<td class="standings-team-cell">' + addCell + '</td>' +
      '<td class="standings-team-cell">' + dropCell + '</td>' +
      '<td class="standings-team-cell" style="color: var(--text-tertiary); font-size: var(--text-caption)">' +
        escapeHtml(kindLabel[it.kind] || it.kind) +
      '</td>' +
    '</tr>';
  }).join('');

  el.innerHTML =
    '<p class="section-label" style="margin-bottom: var(--space-4)">League Activity ' +
      '<span class="section-label__count">(' + leagueActivity.length + ')</span>' +
    '</p>' +
    '<div class="standings-card"><table class="standings-table"><thead><tr>' +
      '<th class="standings-th standings-th--rank">Date</th>' +
      '<th class="standings-th standings-th--team">Team</th>' +
      '<th class="standings-th standings-th--team">Added</th>' +
      '<th class="standings-th standings-th--team">Dropped</th>' +
      '<th class="standings-th standings-th--team">Type</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

// ========================================================================
// RENDER PROCESSING QUEUE (COMMISSIONER)
// ========================================================================
function renderProcessingQueue() {
  var el = document.getElementById('commissionerSection');

  var headerHtml =
    '<div class="waiver-commissioner">' +
      '<div class="waiver-commissioner__header">' +
        '<p class="section-label">Waiver Queue ' +
          '<span class="section-label__count">(' + pendingAllClaims.length + ' pending)</span>' +
        '</p>' +
        '<button class="btn-primary" id="processBtn">Process All Claims</button>' +
      '</div>';

  if (pendingAllClaims.length === 0) {
    el.innerHTML = headerHtml + '<p class="draft-empty" style="padding: var(--space-4) 0">No pending claims to process.</p></div>';
    document.getElementById('processBtn').addEventListener('click', processWaivers);
    return;
  }

  var fighterMap = {};
  allFighters.forEach(function(f) { fighterMap[f.id] = f; });

  var memberMap = {};
  members.forEach(function(m) { memberMap[m.id] = m; });

  var rows = pendingAllClaims.map(function(c) {
    var member      = memberMap[c.league_member_id];
    var addFighter  = fighterMap[c.fighter_to_add_id];
    var dropFighter = c.fighter_to_drop_id ? fighterMap[c.fighter_to_drop_id] : null;
    var submitted   = c.submitted_at ? new Date(c.submitted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '-';

    return '<tr class="standings-row">' +
      '<td class="standings-pts-cell" style="text-align:left; padding-left: var(--space-4)">#' + escapeHtml(String(c.priority)) + '</td>' +
      '<td class="standings-team-cell">' + escapeHtml(member ? member.team_name : '?') + '</td>' +
      '<td class="standings-team-cell">' + escapeHtml(addFighter ? addFighter.name : '?') + '</td>' +
      '<td class="standings-team-cell">' + escapeHtml(dropFighter ? dropFighter.name : '—') + '</td>' +
      '<td class="standings-pts-cell" style="color: var(--text-tertiary)">' + escapeHtml(submitted) + '</td>' +
    '</tr>';
  }).join('');

  el.innerHTML = headerHtml +
    '<div class="standings-card"><table class="standings-table"><thead><tr>' +
      '<th class="standings-th standings-th--rank">Pri</th>' +
      '<th class="standings-th standings-th--team">Team</th>' +
      '<th class="standings-th standings-th--team">Claiming</th>' +
      '<th class="standings-th standings-th--team">Dropping</th>' +
      '<th class="standings-th standings-th--pts">Submitted</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '</div>';

  document.getElementById('processBtn').addEventListener('click', processWaivers);
}

// ========================================================================
// CLAIM MODAL
// ========================================================================
function openClaimModal(fighterId) {
  claimingFighter = allFighters.find(function(f) { return f.id === fighterId; });
  if (!claimingFighter) return;

  var existing = document.getElementById('claimModal');
  if (existing) existing.remove();

  var addMode  = decideAddMode(fighterId);
  var atCap    = myRoster.length >= rosterCap;
  var divLabel = DIVISION_LABELS[claimingFighter.primary_division] || claimingFighter.primary_division;
  var rankStr  = claimingFighter.is_champion ? 'Champion'
               : claimingFighter.current_rank ? '#' + claimingFighter.current_rank
               : 'Unranked';

  // Modal title + processing-time strip vary by mode
  var titleText, processStrip, confirmText;
  if (addMode.mode === 'instant') {
    titleText    = 'Add Free Agent';
    processStrip = '<p class="waiver-modal-mode-strip waiver-modal-mode-strip--fa">' +
                     'Free agency is open — this fighter will be added to your roster immediately.' +
                   '</p>';
    confirmText  = 'Add Fighter';
  } else {
    titleText    = 'Submit Waiver Claim';
    var reasonText;
    if (addMode.reason === 'rolling') {
      reasonText = 'This fighter was recently dropped and is on rolling waivers.';
    } else if (addMode.reason === 'window_pre') {
      reasonText = 'Pre-event waivers are open. All adds queue as claims.';
    } else {
      reasonText = 'Post-event waivers are open. All adds queue as claims.';
    }
    processStrip = '<p class="waiver-modal-mode-strip waiver-modal-mode-strip--claim">' +
                     escapeHtml(reasonText) + '<br>' +
                     '<strong>Claims process ' + escapeHtml(formatEtDateTime(addMode.closesAt)) + '</strong> ' +
                     '(' + escapeHtml(formatRelativeShort(addMode.closesAt, new Date())) + ').' +
                   '</p>';
    confirmText  = 'Submit Claim';
  }

  var dropOptions = '<option value="">— No drop —</option>';
  myRoster.slice().sort(function(a, b) { return a.name.localeCompare(b.name); }).forEach(function(f) {
    var d = DIVISION_LABELS[f.primary_division] || f.primary_division;
    dropOptions += '<option value="' + f.id + '">' + escapeHtml(f.name) + ' (' + escapeHtml(d) + ')</option>';
  });

  var dropLabel = atCap
    ? 'Drop (required — you are at the ' + rosterCap + '-fighter cap)'
    : 'Drop (optional)';

  var overlay = document.createElement('div');
  overlay.id = 'claimModal';
  overlay.className = 'move-flex-modal-overlay';
  overlay.dataset.addMode = addMode.mode;
  overlay.innerHTML =
    '<div class="move-flex-modal" role="dialog" aria-modal="true">' +
      '<div class="move-flex-modal__header">' +
        '<p class="move-flex-modal__title">' + escapeHtml(titleText) + '</p>' +
        '<button class="move-flex-modal__close" id="closeClaimBtn" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="move-flex-modal__body">' +
        '<p class="move-flex-fighter-name">' +
          escapeHtml(claimingFighter.name) +
          '<span class="move-flex-fighter-div">' + escapeHtml(rankStr) + ' &middot; ' + escapeHtml(divLabel) + '</span>' +
        '</p>' +
        processStrip +
        '<div class="waiver-modal-field">' +
          '<label class="waiver-modal-label">' + escapeHtml(dropLabel) + '</label>' +
          '<select class="waiver-filter" id="dropSelect" style="width:100%">' + dropOptions + '</select>' +
        '</div>' +
        // Live validation slot — populated by validateClaimModal() on every change
        '<p class="waiver-cap-warning" id="claimWarning" style="display:none"></p>' +
        '<div class="move-flex-modal__actions">' +
          '<button class="btn-ghost" id="cancelClaimBtn">Cancel</button>' +
          '<button class="btn-primary" id="confirmClaimBtn">' + escapeHtml(confirmText) + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  document.getElementById('confirmClaimBtn').addEventListener('click', function() {
    if (addMode.mode === 'instant') submitInstantAdd();
    else                            submitClaim();
  });
  document.getElementById('cancelClaimBtn').addEventListener('click', closeClaimModal);
  document.getElementById('closeClaimBtn').addEventListener('click', closeClaimModal);
  document.getElementById('dropSelect').addEventListener('change', validateClaimModal);
  overlay.addEventListener('click', function(e) { if (e.target === overlay) closeClaimModal(); });
  document.addEventListener('keydown', _claimEscHandler);

  // Run once so the cap-required state shows up before the user touches anything
  validateClaimModal();
}

// ========================================================================
// LIVE VALIDATION — runs on modal open and on every drop-selection change.
// Shows a contextual warning (gold for advisory, crimson for blocking) and
// disables the Submit button when the projected roster would be invalid.
// ========================================================================
function validateClaimModal() {
  if (!claimingFighter) return;

  var dropSelect = document.getElementById('dropSelect');
  var warning    = document.getElementById('claimWarning');
  var submit     = document.getElementById('confirmClaimBtn');
  if (!dropSelect || !warning || !submit) return;

  var dropId = dropSelect.value || null;
  var atCap  = myRoster.length >= rosterCap;

  // Build the projected roster after the swap
  var projectedRoster = myRoster
    .filter(function(f) { return !dropId || f.id !== dropId; })
    .concat([claimingFighter]);

  var message  = '';
  var blocking = false;

  if (atCap && !dropId) {
    // Advisory: you must drop someone. Crimson because Submit is blocked.
    message  = 'You are at the ' + rosterCap + '-fighter cap. Select a fighter to drop.';
    blocking = true;
  } else {
    var constructionErr = checkRosterConstruction(projectedRoster);
    if (constructionErr) {
      message  = constructionErr;
      blocking = true;
    }
  }

  if (message) {
    warning.textContent = message;
    warning.style.display = '';
    // Toggle the error variant: crimson for blocking, gold (default) otherwise
    warning.classList.toggle('waiver-cap-warning--error', blocking);
  } else {
    warning.style.display = 'none';
    warning.classList.remove('waiver-cap-warning--error');
  }

  submit.disabled = blocking;
}

function closeClaimModal() {
  var modal = document.getElementById('claimModal');
  if (modal) modal.remove();
  claimingFighter = null;
  document.removeEventListener('keydown', _claimEscHandler);
}

function _claimEscHandler(e) {
  if (e.key === 'Escape') closeClaimModal();
}

// ========================================================================
// SUBMIT CLAIM
// ========================================================================
async function submitClaim() {
  if (!claimingFighter) return;

  var dropId = document.getElementById('dropSelect').value || null;
  var atCap  = myRoster.length >= rosterCap;

  if (atCap && !dropId) {
    alert('You are at the ' + rosterCap + '-fighter cap. Please select a fighter to drop.');
    return;
  }

  // Roster-construction check: simulate the swap and see if it still fits the slot rules
  var projectedRoster = myRoster
    .filter(function(f) { return !dropId || f.id !== dropId; })
    .concat([claimingFighter]);
  var constructionErr = checkRosterConstruction(projectedRoster);
  if (constructionErr) {
    alert(constructionErr);
    return;
  }

  var btn = document.getElementById('confirmClaimBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  var { error } = await supabaseClient
    .from('waiver_claims')
    .insert({
      league_id:          leagueId,
      league_member_id:   myMemberId,
      fighter_to_add_id:  claimingFighter.id,
      fighter_to_drop_id: dropId,
      priority:           myMember.waiver_priority,
      status:             'pending',
      submitted_at:       new Date().toISOString()
    });

  if (error) {
    btn.disabled = false;
    btn.textContent = 'Submit Claim';
    alert('Error submitting claim: ' + error.message);
    return;
  }

  closeClaimModal();
  await refreshData();
}

// ========================================================================
// SUBMIT INSTANT ADD (Free agency mode)
// Performs the same drop-then-add swap directly against `rosters`, with no
// claim row. The drop is logged to roster_drops with source='manual' so
// the rolling 48hr waiver kicks in for that fighter immediately.
// ========================================================================
async function submitInstantAdd() {
  if (!claimingFighter) return;

  var dropId = document.getElementById('dropSelect').value || null;
  var atCap  = myRoster.length >= rosterCap;

  if (atCap && !dropId) {
    alert('You are at the ' + rosterCap + '-fighter cap. Please select a fighter to drop.');
    return;
  }

  // Construction check on the projected roster
  var projectedRoster = myRoster
    .filter(function(f) { return !dropId || f.id !== dropId; })
    .concat([claimingFighter]);
  var constructionErr = checkRosterConstruction(projectedRoster);
  if (constructionErr) {
    alert(constructionErr);
    return;
  }

  var btn = document.getElementById('confirmClaimBtn');
  btn.disabled = true;
  btn.textContent = 'Adding...';

  // Drop first (if any)
  if (dropId) {
    var delRes = await supabaseClient.from('rosters').delete()
      .eq('league_id', leagueId)
      .eq('league_member_id', myMemberId)
      .eq('fighter_id', dropId);
    if (delRes.error) {
      btn.disabled = false;
      btn.textContent = 'Add Fighter';
      alert('Error dropping fighter: ' + delRes.error.message);
      return;
    }
    var dropLogRes = await supabaseClient.from('roster_drops').insert({
      league_id: leagueId,
      league_member_id: myMemberId,
      fighter_id: dropId,
      source: 'manual'
    });
    // Drop log failure is non-fatal — the add still proceeds
    if (dropLogRes.error) console.warn('roster_drops insert failed:', dropLogRes.error);
  }

  var addRes = await supabaseClient.from('rosters').insert({
    league_id: leagueId,
    league_member_id: myMemberId,
    fighter_id: claimingFighter.id,
    acquired_method: 'free_agent'
  });
  if (addRes.error) {
    btn.disabled = false;
    btn.textContent = 'Add Fighter';
    alert('Error adding fighter: ' + addRes.error.message);
    return;
  }

  closeClaimModal();
  await refreshData();
}

// ========================================================================
// CANCEL CLAIM
// ========================================================================
async function cancelClaim(claimId) {
  if (!confirm('Cancel this waiver claim?')) return;

  var { error } = await supabaseClient
    .from('waiver_claims')
    .update({ status: 'cancelled' })
    .eq('id', claimId)
    .eq('league_member_id', myMemberId);

  if (error) {
    alert('Error cancelling claim: ' + error.message);
    return;
  }

  await refreshData();
}

// ========================================================================
// PROCESS WAIVERS (COMMISSIONER)
// ========================================================================
async function processWaivers() {
  if (!isCommissioner) return;

  if (pendingAllClaims.length === 0) {
    alert('No pending claims to process.');
    return;
  }

  if (!confirm('Process all ' + pendingAllClaims.length + ' pending claim(s)? This will update rosters immediately.')) return;

  var btn = document.getElementById('processBtn');
  btn.disabled = true;
  btn.textContent = 'Processing...';

  var { data: freshRosters, error: rosterErr } = await supabaseClient
    .from('rosters')
    .select('id, fighter_id, league_member_id')
    .eq('league_id', leagueId);

  if (rosterErr) {
    alert('Error loading roster data: ' + rosterErr.message);
    btn.disabled = false;
    btn.textContent = 'Process All Claims';
    return;
  }

  var claimedThisCycle  = new Set();
  var approvedMemberIds = [];

  for (var i = 0; i < pendingAllClaims.length; i++) {
    var claim = pendingAllClaims[i];

    if (claimedThisCycle.has(claim.fighter_to_add_id)) {
      await supabaseClient.from('waiver_claims').update({
        status: 'rejected',
        rejection_reason: 'Fighter already claimed by a higher-priority team this cycle.',
        processed_at: new Date().toISOString()
      }).eq('id', claim.id);
      continue;
    }

    var fighterOwned = freshRosters.some(function(r) { return r.fighter_id === claim.fighter_to_add_id; });
    if (fighterOwned) {
      await supabaseClient.from('waiver_claims').update({
        status: 'rejected',
        rejection_reason: 'Fighter is already on a roster.',
        processed_at: new Date().toISOString()
      }).eq('id', claim.id);
      continue;
    }

    if (claim.fighter_to_drop_id) {
      var dropOnRoster = freshRosters.some(function(r) {
        return r.fighter_id === claim.fighter_to_drop_id && r.league_member_id === claim.league_member_id;
      });
      if (!dropOnRoster) {
        await supabaseClient.from('waiver_claims').update({
          status: 'rejected',
          rejection_reason: 'The fighter you selected to drop is no longer on your roster.',
          processed_at: new Date().toISOString()
        }).eq('id', claim.id);
        continue;
      }
    }

    var memberRosterSize = freshRosters.filter(function(r) {
      return r.league_member_id === claim.league_member_id;
    }).length;

    if (memberRosterSize >= 20 && !claim.fighter_to_drop_id) {
      await supabaseClient.from('waiver_claims').update({
        status: 'rejected',
        rejection_reason: 'At the 20-fighter cap. Must specify a fighter to drop.',
        processed_at: new Date().toISOString()
      }).eq('id', claim.id);
      continue;
    }

    // Roster-construction check: simulate the swap on the freshest roster snapshot
    // and reject if the result violates the per-division / flex limits.
    var fighterMapForCheck = {};
    allFighters.forEach(function(f) { fighterMapForCheck[f.id] = f; });
    var projectedFighters = freshRosters
      .filter(function(r) {
        return r.league_member_id === claim.league_member_id &&
               r.fighter_id        !== claim.fighter_to_drop_id;
      })
      .map(function(r) { return fighterMapForCheck[r.fighter_id]; })
      .filter(Boolean);
    if (fighterMapForCheck[claim.fighter_to_add_id]) {
      projectedFighters.push(fighterMapForCheck[claim.fighter_to_add_id]);
    }

    var constructionErr = checkRosterConstruction(projectedFighters);
    if (constructionErr) {
      await supabaseClient.from('waiver_claims').update({
        status: 'rejected',
        rejection_reason: constructionErr,
        processed_at: new Date().toISOString()
      }).eq('id', claim.id);
      continue;
    }

    var { error: addErr } = await supabaseClient.from('rosters').insert({
      league_id:        leagueId,
      league_member_id: claim.league_member_id,
      fighter_id:       claim.fighter_to_add_id
    });

    if (addErr) {
      await supabaseClient.from('waiver_claims').update({
        status: 'rejected',
        rejection_reason: 'Database error adding fighter: ' + addErr.message,
        processed_at: new Date().toISOString()
      }).eq('id', claim.id);
      continue;
    }

    if (claim.fighter_to_drop_id) {
      await supabaseClient.from('rosters').delete()
        .eq('league_id', leagueId)
        .eq('league_member_id', claim.league_member_id)
        .eq('fighter_id', claim.fighter_to_drop_id);

      freshRosters = freshRosters.filter(function(r) {
        return !(r.fighter_id === claim.fighter_to_drop_id && r.league_member_id === claim.league_member_id);
      });
    }

    freshRosters.push({ fighter_id: claim.fighter_to_add_id, league_member_id: claim.league_member_id });

    await supabaseClient.from('waiver_claims').update({
      status: 'approved',
      processed_at: new Date().toISOString()
    }).eq('id', claim.id);

    claimedThisCycle.add(claim.fighter_to_add_id);
    if (!approvedMemberIds.includes(claim.league_member_id)) {
      approvedMemberIds.push(claim.league_member_id);
    }
  }

  // Approved claimants move to the back of the priority queue
  var maxPriority  = Math.max.apply(null, members.map(function(m) { return m.waiver_priority || 0; }));
  var nextPriority = maxPriority + 1;
  for (var j = 0; j < approvedMemberIds.length; j++) {
    await supabaseClient.from('league_members')
      .update({ waiver_priority: nextPriority })
      .eq('id', approvedMemberIds[j]);
    nextPriority++;
  }

  btn.disabled = false;
  btn.textContent = 'Process All Claims';
  alert('Waivers processed. ' + claimedThisCycle.size + ' claim(s) approved.');
  await refreshData();
}

// ========================================================================
// REFRESH DATA
// ========================================================================
async function refreshData() {
  var results = await Promise.all([
    supabaseClient.from('rosters').select('fighter_id, league_member_id, acquired_at, acquired_method').eq('league_id', leagueId),
    supabaseClient.from('waiver_claims').select('*').eq('league_id', leagueId).order('priority').order('submitted_at'),
    supabaseClient.from('league_members').select('id, user_id, team_name, waiver_priority').eq('league_id', leagueId),
    supabaseClient.from('roster_drops').select('id, fighter_id, league_member_id, dropped_at, source').eq('league_id', leagueId).order('dropped_at', { ascending: false })
  ]);

  members  = results[2].data || [];
  myMember = members.find(function(m) { return m.user_id === user.id; });

  var allRosters = results[0].data || [];
  var ownedIds   = new Set(allRosters.map(function(r) { return r.fighter_id; }));
  availableFighters = allFighters.filter(function(f) { return !ownedIds.has(f.id); });

  var myRosterIds = allRosters
    .filter(function(r) { return r.league_member_id === myMemberId; })
    .map(function(r) { return r.fighter_id; });
  myRoster = allFighters.filter(function(f) { return myRosterIds.includes(f.id); });

  var allClaims    = results[1].data || [];
  myClaims         = allClaims.filter(function(c) { return c.league_member_id === myMemberId; });
  pendingAllClaims = allClaims.filter(function(c) { return c.status === 'pending'; });
  leagueActivity   = buildLeagueActivity(allClaims, results[3].data || [], results[0].data || []);

  recomputePhaseState(results[3].data || []);

  renderPhaseBanner();
  renderAvailableFighters();
  renderMyClaims();
  renderRosterActivity();
  if (isCommissioner) renderProcessingQueue();
}

// ========================================================================
// ROSTER CONSTRUCTION VALIDATION
// ========================================================================
// Roster construction (per league rules):
//   * Up to 2 fighters per men's division
//   * Up to 2 women in the "women's flex" bucket (any women's division)
//   * Up to 2 in the "any-division flex" bucket (any fighter, used for overflow)
// Returns null if `fighters` fits, otherwise a user-facing error message.
var WAIVER_WOMENS_DIVISIONS = ['strawweight', 'flyweight_w', 'bantamweight_w'];

function checkRosterConstruction(fighters) {
  if (fighters.length > 20) return 'Roster cannot exceed 20 fighters.';

  // Tally fighters per division
  var counts = {};
  fighters.forEach(function(f) {
    counts[f.primary_division] = (counts[f.primary_division] || 0) + 1;
  });

  // Each men's division above 2 spills into the any-flex bucket;
  // women above 2 (across all women's divisions) also spill into any-flex.
  var anyFlexNeeded = 0;
  var womenTotal    = 0;
  var overFullMens  = []; // collect division labels that already have 2

  Object.keys(counts).forEach(function(div) {
    if (WAIVER_WOMENS_DIVISIONS.indexOf(div) !== -1) {
      womenTotal += counts[div];
    } else {
      var overflow = Math.max(0, counts[div] - 2);
      anyFlexNeeded += overflow;
      if (overflow > 0) overFullMens.push(DIVISION_LABELS[div] || div);
    }
  });

  var womenOverflow = Math.max(0, womenTotal - 2);
  anyFlexNeeded += womenOverflow;

  if (anyFlexNeeded > 2) {
    var why;
    if (overFullMens.length > 0 && womenOverflow > 0) {
      why = 'too many ' + overFullMens.join(', ') + ' fighters and too many women';
    } else if (overFullMens.length > 0) {
      why = 'too many fighters in ' + overFullMens.join(', ');
    } else {
      why = 'too many women (limit is 2 in the women\'s flex slot)';
    }
    return 'This claim won\'t fit your roster — ' + why +
           '. The any-division flex bucket only holds 2. Pick a different fighter to drop.';
  }
  return null;
}

// ========================================================================
// HELPERS
// ========================================================================
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  var div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

// Compute age in whole years from a YYYY-MM-DD birth date string.
// Returns null when DOB is missing or unparseable so callers can hide the field.
function ageFromDob(dob) {
  if (!dob) return null;
  var birth = new Date(dob);
  if (isNaN(birth.getTime())) return null;
  var today = new Date();
  var age   = today.getFullYear() - birth.getFullYear();
  // Subtract one if the birthday hasn't occurred yet this year
  var m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

initWaivers();
