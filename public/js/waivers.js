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
var ownedByMap        = {}; // fighter_id -> team_name for rostered fighters
var fighterPointsMap  = {}; // fighter_id -> { totalPts, recentPts, avgPts, fightCount }
var fighterNextFight  = {}; // fighter_id -> next-fight info from NextFight.loadNextFights
var fighterFightOdds  = {}; // fighter_id -> Polymarket odds info from FightOdds.loadFightOdds
var fighterProjections = {}; // fighter_id -> { projectedPoints, ... } from Projections.load
var upcomingEvents    = []; // list of upcoming UFC events used to populate the event filter
var myRoster          = [];
var myClaims          = [];
var pendingAllClaims  = [];
var leagueActivity    = []; // approved claims across the whole league, newest first
var claimingFighter   = null;

// Waiver-phase state — recomputed at every page load and refresh
var nextEvent       = null;          // ufc_events row used as the schedule anchor
var phaseInfo       = { phase: 'FA', closesAt: null, opensAt: null };
var rosterCap       = ROSTER_SIZE_BASE; // grows to ROSTER_SIZE_EXPANDED during the +3 event-week window
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
      .select('id, name, commissioner_id, draft_started, draft_completed, scoring_config')
      .eq('id', leagueId)
      .single(),
    supabaseClient
      .from('league_members')
      .select('id, user_id, team_name, waiver_priority, is_commissioner')
      .eq('league_id', leagueId),
    supabaseClient
      .from('fighters')
      .select('id, name, primary_division, current_rank, is_champion, is_sub_champion, sub_title_type, record_wins, record_losses, record_draws, photo_url, age, country')
      .eq('is_active', true)
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
    // Next non-completed event drives the phase schedule. We fetch a small
    // window rather than a single row because per-league overrides can
    // shift dates around — we re-pick the soonest effective event in JS
    // after merging overrides (see below).
    supabaseClient
      .from('ufc_events')
      .select('id, name, full_name, event_date, lineup_lock_time, is_completed')
      .eq('is_completed', false)
      .order('event_date', { ascending: true })
      .limit(8),
    // Drop history — used for rolling waivers and the auto-drop bookkeeping
    supabaseClient
      .from('roster_drops')
      .select('id, fighter_id, league_member_id, dropped_at, source')
      .eq('league_id', leagueId)
      .order('dropped_at', { ascending: false }),
  ]);

  var leagueRes   = results[0];
  var membersRes  = results[1];
  var fightersRes = results[2];
  var rostersRes  = results[3];
  var claimsRes   = results[4];
  var eventsRes   = results[5];
  var dropsRes    = results[6];

  if (leagueRes.error || !leagueRes.data) {
    window.location.href = 'dashboard.html';
    return;
  }

  league  = leagueRes.data;
  members = membersRes.data || [];

  myMember = members.find(function(m) { return m.user_id === user.id; });
  if (!myMember) { window.location.href = 'dashboard.html'; return; }
  myMemberId     = myMember.id;
  // True for primary OR co-commissioner — both get the manual "Process
  // waivers now" button and other commissioner-only controls on this page.
  isCommissioner = Commissioner.isCommissioner(league, members, user.id);

  allFighters = fightersRes.data || [];

  // Fetch ALL fight results with pagination (Supabase caps at 1000 rows by
  // default; the DB has 1800+ rows so a single query silently drops fights
  // and skews the per-fighter point averages).
  var allFightResults = await fetchAllFightResults();
  fighterPointsMap = buildFighterPointsMap(allFightResults, league.scoring_config);

  // Load next-fight info for every active fighter so each row can show
  // their next booked fight, and the new event filter dropdown can group
  // fighters by the event they're fighting at.
  var allFighterIds = allFighters.map(function(f) { return f.id; });
  if (typeof NextFight !== 'undefined') {
    fighterNextFight = await NextFight.loadNextFights(allFighterIds);
  }
  // Load Polymarket odds + projected points — same pattern. Lightweight
  // even for ~6000 fighters because the helpers filter to upcoming fights
  // server-side.
  if (typeof FightOdds !== 'undefined' || typeof Projections !== 'undefined') {
    var [odds, projections] = await Promise.all([
      typeof FightOdds   !== 'undefined' ? FightOdds.loadFightOdds(allFighterIds) : {},
      typeof Projections !== 'undefined' ? Projections.load(allFighterIds)        : {}
    ]);
    fighterFightOdds   = odds;
    fighterProjections = projections;
  }

  // Distinct upcoming events derived from the next-fight map. Sorted
  // soonest-first so the picker reads naturally.
  var seenEventIds = new Set();
  upcomingEvents = [];
  Object.values(fighterNextFight).forEach(function(nf) {
    if (!nf || !nf.event_id) return;
    if (seenEventIds.has(nf.event_id)) return;
    seenEventIds.add(nf.event_id);
    upcomingEvents.push({
      id:    nf.event_id,
      name:  nf.event_name,
      date:  nf.event_date,
      venue: nf.event_venue || null
    });
  });
  upcomingEvents.sort(function(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });

  var allRosters = rostersRes.data || [];
  var ownedIds   = new Set(allRosters.map(function(r) { return r.fighter_id; }));
  availableFighters = allFighters.filter(function(f) { return !ownedIds.has(f.id); });
  ownedByMap = buildOwnedByMap(allRosters, membersRes.data || []);

  var myRosterIds = allRosters
    .filter(function(r) { return r.league_member_id === myMemberId; })
    .map(function(r) { return r.fighter_id; });
  myRoster = allFighters.filter(function(f) { return myRosterIds.includes(f.id); });

  var allClaims  = claimsRes.data || [];
  myClaims         = allClaims.filter(function(c) { return c.league_member_id === myMemberId; });
  pendingAllClaims = allClaims.filter(function(c) { return c.status === 'pending'; });
  leagueActivity   = buildLeagueActivity(allClaims, dropsRes.data || [], rostersRes.data || []);

  // ---- Phase / cap / rolling-waiver state ----
  // Merge this league's overrides onto the upcoming-event window and pick
  // the soonest effective non-completed event. Phase math then uses the
  // override-adjusted date / lock time.
  var rawNextEvents      = eventsRes.data || [];
  var nextEventOverrides = await EventOverrides.fetchForLeague(supabaseClient, leagueId, rawNextEvents.map(function(e){return e.id;}));
  var nextEventsMerged   = EventOverrides.mergeAll(rawNextEvents, nextEventOverrides);
  nextEventsMerged.sort(function(a, b) { return String(a.event_date || '').localeCompare(String(b.event_date || '')); });
  nextEvent = nextEventsMerged[0] || null;
  recomputePhaseState(dropsRes.data || []);

  document.title = 'Free Agency - ' + league.name;
  document.getElementById('leagueName').textContent = league.name;

  LeagueNav.renderInto('headerActions', {
    leagueId: leagueId,
    memberId: myMemberId,
    active:   'freeAgency'
  });

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

  // Auto-open the claim/add modal if we arrived with ?claim=FIGHTER_ID.
  // This is how the league page's "Add" buttons in the Top Free Agents
  // panel hand off to the proper claim flow — the league page used to
  // do an inline insert that bypassed the rolling-waiver gate, which
  // let users re-add a fighter they had just dropped. Routing through
  // here ensures the same gating logic (claim window, rolling waiver,
  // roster construction) applies to every add.
  var claimParam = new URLSearchParams(window.location.search).get('claim');
  if (claimParam && allFighters.some(function(f) { return f.id === claimParam; })) {
    openClaimModal(claimParam);
  }
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
//   { mode: 'predraft' }                          — draft hasn't completed yet
//   { mode: 'claim', reason: 'window_pre',  closesAt } — Thu 3am → Fri 3am
//   { mode: 'claim', reason: 'window_post', closesAt } — Sun 3am → Tue 3am
//   { mode: 'claim', reason: 'rolling',     closesAt } — fighter just dropped, 48h hold
//   { mode: 'instant' }                           — open FA between windows
function decideAddMode(fighterId) {
  // Pre-draft: nothing can be added. The Add button stays disabled in the
  // UI; this case lets us short-circuit the rest of the logic and gives
  // the modal opener a clean signal to refuse opening.
  if (!league.draft_completed) {
    return { mode: 'predraft' };
  }
  if (phaseInfo.phase === 'WINDOW_PRE') {
    return { mode: 'claim', reason: 'window_pre',  closesAt: phaseInfo.closesAt };
  }
  if (phaseInfo.phase === 'WINDOW_POST') {
    return { mode: 'claim', reason: 'window_post', closesAt: phaseInfo.closesAt };
  }
  // FA phase — instant add for everyone EXCEPT fighters on the 48-hour
  // rolling waiver hold from a recent drop. This matches the standard
  // fantasy waiver pattern: claims during the Thu→Fri and Sun→Tue windows,
  // first-come-first-served free agency in between.
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
  // Pre-draft state takes precedence over the event-driven phase. Until the
  // draft completes, free agency is closed entirely — there's no roster
  // for fighters to be added to yet.
  if (!league.draft_completed) {
    variant = 'phase-banner--window';
    title   = 'Free agency closed';
    body    = 'Free agency opens once the draft completes. ' +
              'Until then, every fighter not yet drafted will go through ' +
              'waivers as a claim once the draft ends.';
  } else if (phaseInfo.phase === 'WINDOW_PRE') {
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
    // FA phase between the two waiver windows. Adds are instant, first-come
    // first-served. Fighters who were just dropped are still on a 48-hour
    // rolling hold (handled per-fighter by decideAddMode), but otherwise
    // anyone is fair game.
    variant = 'phase-banner--fa';
    title   = 'Free agency open';
    var nextOpen = phaseInfo.opensAt
      ? 'Next waiver window opens ' + formatEtDateTime(phaseInfo.opensAt) +
        ' (' + formatRelativeShort(phaseInfo.opensAt, now) + ')'
      : 'No upcoming waiver window scheduled';
    body = 'Adds are instant — first come, first served. ' +
           'Recently dropped fighters stay on a 48-hour waiver hold. ' +
           nextOpen + '. Roster cap is ' + rosterCap + '.';
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

    // Activity feed: claim won by this manager. Includes the dropped
    // fighter context so the headline reads "won X, dropping Y".
    if (typeof LeagueActivity !== 'undefined') {
      var addedFighter   = fighterMap[claim.fighter_to_add_id];
      var droppedFighter = claim.fighter_to_drop_id ? fighterMap[claim.fighter_to_drop_id] : null;
      LeagueActivity.logEvent(leagueId, LeagueActivity.KINDS.CLAIM_WON, {
        fighter_id:           claim.fighter_to_add_id,
        fighter_name:         addedFighter ? addedFighter.name : 'a fighter',
        dropped_fighter_id:   droppedFighter ? droppedFighter.id   : null,
        dropped_fighter_name: droppedFighter ? droppedFighter.name : null,
        priority:             claim.priority,
        via:                  'waiver'
      }, claim.league_member_id);
    }
  }
}

async function rejectClaim(claim, reason) {
  var res = await supabaseClient.from('waiver_claims').update({
    status: 'rejected',
    rejection_reason: reason,
    processed_at: new Date().toISOString()
  }).eq('id', claim.id);

  // Activity feed: claim lost. We log only when the rejection reason is
  // contention with another claimant — losing because of cap/construction
  // is the manager's own configuration error and not interesting to the
  // wider league. Heuristic: rejection_reason starts with "Fighter already".
  if (typeof LeagueActivity !== 'undefined' && /^Fighter already/i.test(reason || '')) {
    var fighter = (allFighters || []).find(function(f) { return f.id === claim.fighter_to_add_id; });
    LeagueActivity.logEvent(leagueId, LeagueActivity.KINDS.CLAIM_LOST, {
      fighter_id:   claim.fighter_to_add_id,
      fighter_name: fighter ? fighter.name : 'a fighter',
      priority:     claim.priority,
      reason:       reason
    }, claim.league_member_id);
  }
  return res;
}

// ========================================================================
// AUTO-DROP — runs on/after Wed 3am ET. For each manager: if they've made
// fewer than 3 manual drops since the most recent cap-expansion (Thu 3am
// ET event week), drop their most-recently-added fighters until roster
// size is back to ROSTER_SIZE_BASE. Each forced drop is logged with source='auto'.
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
    if (roster.length <= ROSTER_SIZE_BASE) continue;    // already compliant

    // Drop most recently added until size = ROSTER_SIZE_BASE
    roster.sort(function(a, b) {
      return new Date(b.acquired_at || 0).getTime() - new Date(a.acquired_at || 0).getTime();
    });
    var toDrop = roster.slice(0, roster.length - ROSTER_SIZE_BASE);
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
// Build a map of fighter_id -> team_name so rostered fighters can show their owner.
function buildOwnedByMap(rosters, memberList) {
  var memberById = {};
  memberList.forEach(function(m) { memberById[m.id] = m.team_name || 'Unknown Team'; });
  var map = {};
  rosters.forEach(function(r) {
    map[r.fighter_id] = memberById[r.league_member_id] || 'Unknown Team';
  });
  return map;
}

// Fetch every completed fight_results row, paginating in 1000-row batches.
// Supabase's default 1000-row cap silently truncates larger result sets, which
// skews per-fighter averages when the DB has more rows than the cap.
async function fetchAllFightResults() {
  var FIGHT_COLS = 'fighter_a_id,fighter_b_id,outcome,winner_id,end_round,' +
    'end_time_seconds,title_type,is_title_defense,fight_of_the_night,card_position,' +
    'fighter_a_sig_strikes,fighter_a_takedowns,fighter_a_knockdowns,fighter_a_control_seconds,' +
    'fighter_a_opponent_rank,' +
    'fighter_b_sig_strikes,fighter_b_takedowns,fighter_b_knockdowns,fighter_b_control_seconds,' +
    'fighter_b_opponent_rank,' +
    'event:ufc_events(event_date)';

  var all  = [];
  var PAGE = 1000;
  var from = 0;
  while (true) {
    var res = await supabaseClient
      .from('fight_results')
      .select(FIGHT_COLS)
      .not('outcome', 'is', null)
      // Unique tiebreaker so paginated .range() windows stay stable across
      // queries — without a deterministic ORDER BY, multi-page fetches can
      // repeat or skip rows (here that would corrupt the waiver projections).
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (res.error || !res.data) break;
    all = all.concat(res.data);
    if (res.data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// Build a map of fighter_id -> scoring stats by running every fight_results row
// through the shared scoring engine. Also computes fantasy value composite scores.
// scoringConfig is the league's custom config (or null for v1.2 defaults).
// "Recent" means within the last 12 months of today.
function buildFighterPointsMap(fightResults, scoringConfig) {
  var map = {};
  var oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

  // Pass 1: collect raw fight scores per fighter.
  // No-contests are intentionally skipped — neither fighter "competed" in a
  // meaningful sense (eye pokes, illegal strikes, accidental DQs), so they
  // shouldn't drag down or inflate either fighter's fantasy value average.
  // The scoring engine still computes points if asked (point structure is
  // unchanged); we just don't include those fights in the FV aggregation.
  fightResults.forEach(function(fight) {
    if (fight.outcome === 'no_contest') return;

    var eventDate = fight.event && fight.event.event_date
      ? new Date(fight.event.event_date + 'T12:00:00') : null;
    var isRecent = eventDate && eventDate >= oneYearAgo;

    [true, false].forEach(function(isA) {
      var fighterId = isA ? fight.fighter_a_id : fight.fighter_b_id;
      if (!fighterId) return;

      var score = Scoring.computeFighterScore(fight, isA, scoringConfig);

      if (!map[fighterId]) {
        map[fighterId] = {
          totalPts: 0, recentPts: 0, fightCount: 0, recentFightCount: 0,
          _fights: []  // { score, date } kept temporarily for last-3 and consistency
        };
      }
      // Record outcome for streak detection later. Draws are treated as a
      // neutral event that resets both win and loss streaks.
      var isWin  = fight.winner_id === fighterId;
      var isDraw = fight.outcome === 'draw';
      var isLoss = !isWin && !isDraw && fight.winner_id != null;

      // Opponent rank at fight time (for strength-of-schedule). Champion /
      // interim / BMF holders have stored rank=null, but they ARE elite —
      // treat them as #1 for SoS purposes when the fight was a title fight.
      var oppRankPrefix = isA ? 'fighter_a_' : 'fighter_b_';
      var oppRank = fight[oppRankPrefix + 'opponent_rank'];
      if (oppRank == null && fight.title_type && fight.title_type !== 'none') {
        oppRank = 1;
      }

      map[fighterId].totalPts   += score.total;
      map[fighterId].fightCount += 1;
      map[fighterId]._fights.push({
        score: score.total, date: eventDate,
        isWin: isWin, isDraw: isDraw, isLoss: isLoss,
        oppRank: oppRank,
      });
      if (isRecent) {
        map[fighterId].recentPts        += score.total;
        map[fighterId].recentFightCount += 1;
      }
    });
  });

  // Pass 2: per-fighter averages and last-3 avg
  Object.keys(map).forEach(function(id) {
    var e = map[id];
    e.avgPts = e.fightCount > 0 ? e.totalPts / e.fightCount : 0;

    // Sort by date descending (most recent first) then take up to 3
    e._fights.sort(function(a, b) {
      return (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0);
    });
    var last3 = e._fights.slice(0, 3);
    e.last3Avg = last3.length > 0
      ? last3.reduce(function(s, f) { return s + f.score; }, 0) / last3.length
      : 0;
  });

  // Pass 3: league mean (avg of all fighters' raw averages) for Bayesian blend
  var ids = Object.keys(map);
  var leagueMean = ids.length > 0
    ? ids.reduce(function(s, id) { return s + map[id].avgPts; }, 0) / ids.length
    : 10;

  // Pass 4: compute fantasy value components
  // K=5 means a fighter needs ~5 fights before their average fully outweighs the mean.
  var K = 5;
  Object.keys(map).forEach(function(id) {
    var e = map[id];

    // Bayesian blended career average — pulls small samples toward league mean
    var blendedAvg = (e.fightCount * e.avgPts + K * leagueMean) / (e.fightCount + K);

    // Blend blended career (55%) with last-3 (45%), but scale last-3 weight down
    // when we have fewer than 3 fights (so a 1-fight fighter is still mostly career)
    var last3Weight  = 0.45 * Math.min(e.fightCount, 3) / 3;
    var careerWeight = 1 - last3Weight;
    var baseScore    = careerWeight * blendedAvg + last3Weight * e.last3Avg;

    // Activity: penalise fighters who haven't competed recently. Increased
    // the penalty from the original 0.75/0.9/1.0 because a fighter who hasn't
    // fought in over a year is barely a real fantasy asset.
    var actMult = e.recentFightCount === 0 ? 0.6
                : e.recentFightCount === 1 ? 0.85
                : 1.0;

    // Consistency: +0.4 per fight above the league mean, capped at +2.5.
    // Rewards fighters with a long track record of solid performances without
    // penalising a recent loss (one bad fight barely moves the count).
    var goodFights = e._fights.filter(function(f) { return f.score > leagueMean; }).length;
    var consistencyBonus = Math.min(goodFights * 0.4, 2.5);

    // Streak detection. _fights is sorted newest-first from Pass 2. Walk from
    // the most recent fight: count consecutive wins or consecutive losses.
    // Draws and missing data break the streak.
    var winStreak  = 0;
    var lossStreak = 0;
    for (var i = 0; i < e._fights.length; i++) {
      var f = e._fights[i];
      if (f.isWin) {
        if (lossStreak > 0) break;
        winStreak++;
      } else if (f.isLoss) {
        if (winStreak > 0) break;
        lossStreak++;
      } else {
        break;  // draw or missing — stop counting
      }
    }
    var streakBonus = 0;
    if      (winStreak  >= 3) streakBonus =  3;
    else if (winStreak  >= 2) streakBonus =  1.5;
    else if (lossStreak >= 2) streakBonus = -3;
    else if (lossStreak >= 1) streakBonus = -1;

    // Strength of schedule (SoS): opponent quality across the last 5 fights.
    // Validates the fighter's level — beating a top-5 fighter is more
    // meaningful than beating a #20, even if both produce similar per-fight
    // scores. Counts opponents regardless of win/loss (you still faced them).
    //
    // Per-opponent quality:
    //   Champion / #1: 1.0
    //   #2-5:          0.7
    //   #6-10:         0.4
    //   #11-15:        0.2
    //   Unranked:      0
    // SoS = average across last 5 fights; bonus = SoS * 4 (range 0 to +4).
    var sosFights = e._fights.slice(0, 5);
    var sosTotal  = 0;
    for (var k = 0; k < sosFights.length; k++) {
      var r = sosFights[k].oppRank;
      var q = r == null     ? 0
            : r <= 1        ? 1.0
            : r <= 5        ? 0.7
            : r <= 10       ? 0.4
            : r <= 15       ? 0.2
            :                 0;
      sosTotal += q;
    }
    var sosAvg = sosFights.length > 0 ? sosTotal / sosFights.length : 0;
    var sosBonus = Math.round(sosAvg * 4 * 10) / 10;

    // Round and store — rank bonus is applied in the sort comparator because
    // it requires the fighter object (not available inside this function)
    e.blendedAvg       = Math.round(blendedAvg       * 10) / 10;
    e.baseScore        = Math.round(baseScore         * 10) / 10;
    e.activityMult     = actMult;
    e.consistencyBonus = Math.round(consistencyBonus  * 10) / 10;
    e.streakBonus      = streakBonus;
    e.winStreak        = winStreak;
    e.lossStreak       = lossStreak;
    e.sosBonus         = sosBonus;
    e.sosAvg           = Math.round(sosAvg * 100) / 100;
    e.sosFightCount    = sosFights.length;

    // Store good-fight count for the breakdown modal
    e.goodFightCount = goodFights;

    // Clean up the temporary per-fight array
    delete e._fights;

    // Round the plain stats too
    e.totalPts  = Math.round(e.totalPts  * 10) / 10;
    e.recentPts = Math.round(e.recentPts * 10) / 10;
    e.avgPts    = Math.round(e.avgPts    * 10) / 10;
    e.last3Avg  = Math.round(e.last3Avg  * 10) / 10;
  });

  return map;
}

// Compute the fantasy value composite score for one fighter.
// Called during sort so we have the fighter object (for rank/champion data).
// baseScore and bonuses come from buildFighterPointsMap; rank bonus is applied here.
function computeFantasyValue(fighter) {
  var pts = fighterPointsMap[fighter.id];
  if (!pts || !pts.baseScore) return 0;

  // Elite-status bonus. Champions and top-ranked fighters get a meaningful
  // bump on top of their statistical baseScore so the FV ordering actually
  // reflects who's elite vs who's mid-pack.
  var rankBonus = fighter.is_champion                                     ? 10
                : (fighter.current_rank && fighter.current_rank <= 5)    ? 6
                : (fighter.current_rank && fighter.current_rank <= 10)   ? 3
                : (fighter.current_rank && fighter.current_rank <= 15)   ? 1
                : 0;

  return pts.baseScore * pts.activityMult
       + rankBonus
       + pts.consistencyBonus
       + (pts.streakBonus || 0)
       + (pts.sosBonus || 0);
}

// Open a modal showing the breakdown of one fighter's fantasy value score.
function showFvBreakdown(fighterId) {
  var fighter = allFighters.find(function(f) { return f.id === fighterId; });
  var pts     = fighterPointsMap[fighterId];
  if (!fighter || !pts) return;

  var existing = document.getElementById('fvBreakdownModal');
  if (existing) existing.remove();

  // Rank bonus and label — keep in sync with computeFantasyValue()
  var rankBonus, rankLabel;
  if (fighter.is_champion) {
    rankBonus = 10; rankLabel = 'Champion';
  } else if (fighter.current_rank && fighter.current_rank <= 5) {
    rankBonus = 6;  rankLabel = 'Top 5 (#' + fighter.current_rank + ')';
  } else if (fighter.current_rank && fighter.current_rank <= 10) {
    rankBonus = 3;  rankLabel = 'Top 10 (#' + fighter.current_rank + ')';
  } else if (fighter.current_rank && fighter.current_rank <= 15) {
    rankBonus = 1;  rankLabel = 'Top 15 (#' + fighter.current_rank + ')';
  } else {
    rankBonus = 0;  rankLabel = fighter.current_rank ? '#' + fighter.current_rank : 'Unranked';
  }

  // Streak label
  var streakBonus = pts.streakBonus || 0;
  var streakLabel;
  if      (pts.winStreak  >= 3) streakLabel = pts.winStreak  + '-fight win streak';
  else if (pts.winStreak  >= 2) streakLabel = pts.winStreak  + '-fight win streak';
  else if (pts.lossStreak >= 2) streakLabel = pts.lossStreak + '-fight losing skid';
  else if (pts.lossStreak >= 1) streakLabel = 'Coming off a loss';
  else                          streakLabel = 'No streak';

  var actLabel = pts.recentFightCount === 0 ? '0 fights last 12 months'
               : pts.recentFightCount === 1 ? '1 fight last 12 months'
               : pts.recentFightCount + ' fights last 12 months';
  var actMult  = pts.activityMult === 1.0 ? '1.00' : pts.activityMult.toFixed(2);

  var last3Count = Math.min(pts.fightCount, 3);
  var last3Label = last3Count < 3 ? 'Last ' + last3Count + ' fight' + (last3Count === 1 ? '' : 's') + ' avg'
                                  : 'Last 3 fights avg';

  var fv = computeFantasyValue(fighter);

  // A helper to build one row of the breakdown table
  function row(label, value, note, highlight) {
    var valueStr = typeof value === 'number' ? value.toFixed(1) : String(value);
    return '<div class="fv-breakdown-row' + (highlight ? ' fv-breakdown-row--total' : '') + '">' +
      '<span class="fv-breakdown-row__label">' + escapeHtml(label) + '</span>' +
      (note ? '<span class="fv-breakdown-row__note">' + escapeHtml(note) + '</span>' : '<span></span>') +
      '<span class="fv-breakdown-row__value">' + escapeHtml(valueStr) + '</span>' +
    '</div>';
  }

  var overlay = document.createElement('div');
  overlay.id = 'fvBreakdownModal';
  overlay.className = 'move-flex-modal-overlay';
  overlay.innerHTML =
    '<div class="move-flex-modal" role="dialog" aria-modal="true" style="max-width:420px">' +
      '<div class="move-flex-modal__header">' +
        '<p class="move-flex-modal__title">Fantasy Value Score</p>' +
        '<button class="move-flex-modal__close" id="closeFvBtn" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="move-flex-modal__body">' +
        '<p class="move-flex-fighter-name" style="margin-bottom:var(--space-4)">' +
          escapeHtml(fighter.name) +
        '</p>' +

        '<p class="fv-breakdown-section">Base score</p>' +
        '<div class="fv-breakdown-table">' +
          row('Career avg', pts.avgPts, pts.fightCount + ' fight' + (pts.fightCount === 1 ? '' : 's')) +
          row('Adjusted avg', pts.blendedAvg, 'Sample-size correction') +
          row(last3Label, pts.last3Avg, 'Recent form') +
          row('Base score', pts.baseScore, '55% adjusted avg + 45% recent') +
        '</div>' +

        '<p class="fv-breakdown-section" style="margin-top:var(--space-4)">Multipliers &amp; bonuses</p>' +
        '<div class="fv-breakdown-table">' +
          row('Activity', pts.baseScore * pts.activityMult, actLabel + '  ×' + actMult) +
          row('Consistency', '+' + pts.consistencyBonus.toFixed(1), pts.goodFightCount + ' above-avg fight' + (pts.goodFightCount === 1 ? '' : 's')) +
          row('Streak', (streakBonus >= 0 ? '+' : '') + streakBonus.toFixed(1), streakLabel) +
          row('SoS', '+' + (pts.sosBonus || 0).toFixed(1), 'Opp quality, last ' + pts.sosFightCount + ' fight' + (pts.sosFightCount === 1 ? '' : 's')) +
          row('Rank bonus', '+' + rankBonus, rankLabel) +
        '</div>' +

        '<div class="fv-breakdown-table" style="margin-top:var(--space-4)">' +
          row('Fantasy Value', fv, '', true) +
        '</div>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);
  document.getElementById('closeFvBtn').addEventListener('click', function() { overlay.remove(); });
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
  });
}

function wireUpSearch() {
  document.getElementById('fighterSearch').addEventListener('input', renderAvailableFighters);
  document.getElementById('divisionFilter').addEventListener('change', renderAvailableFighters);
  document.getElementById('statusFilter').addEventListener('change', renderAvailableFighters);
  document.getElementById('sortBy').addEventListener('change', renderAvailableFighters);
  document.getElementById('showAllToggle').addEventListener('change', renderAvailableFighters);

  // Populate the event filter from the upcomingEvents list we collected
  // during init, then wire it up just like the other filters. The date
  // goes on data-sub so the custom dropdown renders it as a muted second
  // column instead of inlined in the label.
  var eventSel = document.getElementById('eventFilter');
  if (eventSel) {
    upcomingEvents.forEach(function(ev) {
      var opt = document.createElement('option');
      opt.value = ev.id;
      var d = new Date(ev.date + 'T12:00:00');
      var dStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      opt.textContent = displayEventName(ev);
      opt.setAttribute('data-sub', dStr);
      eventSel.appendChild(opt);
    });
    // Now that the options exist, the custom dropdown's MutationObserver
    // won't re-fire (the <select> already in DOM). Call refresh() to
    // rebuild the menu against the new option list.
    if (typeof CustomDropdown !== 'undefined') CustomDropdown.refresh(eventSel);
    eventSel.addEventListener('change', renderAvailableFighters);
  }
}

// Display name for the event filter rows. Numbered PPVs ("UFC 329")
// show as-is; non-numbered Vegas cards label as "UFC APEX"; Washington
// is the one-off "UFC Freedom 250"; everything else becomes
// "UFC <City>" from the first chunk of venue. Matches the helpers of
// the same name in lineup.js and league.js.
function displayEventName(ev) {
  if (!ev) return '';
  if (/^UFC\s+\d+\b/i.test(ev.name || '')) return ev.name;
  if (ev.venue) {
    var venue = String(ev.venue);
    if (/las vegas/i.test(venue))  return 'UFC APEX';
    if (/washington/i.test(venue)) return 'UFC Freedom 250';
    var city = venue.split(',')[0].trim();
    if (city) return 'UFC ' + city;
  }
  return ev.name || '';
}

// ========================================================================
// RENDER AVAILABLE FIGHTERS
// ========================================================================
function renderAvailableFighters() {
  var query      = document.getElementById('fighterSearch').value.trim().toLowerCase();
  var division   = document.getElementById('divisionFilter').value;
  var status     = document.getElementById('statusFilter').value;
  var sortBy     = document.getElementById('sortBy').value;
  var showAll    = document.getElementById('showAllToggle').checked;
  var eventSelEl = document.getElementById('eventFilter');
  var eventId    = eventSelEl ? eventSelEl.value : 'all';

  // When showAll is on, search the full fighter list; otherwise only free agents.
  var sourceList = showAll ? allFighters : availableFighters;

  var filtered = sourceList.filter(function(f) {
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

    // Event filter — only show fighters whose next booked fight is at this
    // specific event. Fighters with no next fight at all are excluded.
    var matchesEvent = true;
    if (eventId && eventId !== 'all') {
      var nf = fighterNextFight[f.id];
      matchesEvent = !!(nf && nf.event_id === eventId);
    }

    return matchesName && matchesDiv && matchesStatus && matchesEvent;
  });

  // Sort a copy so the original array order is preserved for future renders.
  // Rank is used as a tiebreaker for all points-based sorts: champions first,
  // then ranked fighters, then unranked (rank 999).
  filtered = filtered.slice().sort(function(a, b) {
    var rankA = a.is_champion ? 0 : (a.current_rank || 999);
    var rankB = b.is_champion ? 0 : (b.current_rank || 999);

    if (sortBy === 'rank') {
      return rankA - rankB;
    }

    if (sortBy === 'fantasy_value') {
      var fva = computeFantasyValue(a);
      var fvb = computeFantasyValue(b);
      if (fvb !== fva) return fvb - fva;
      return rankA - rankB;
    }

    var ptsKey = sortBy === 'total_pts'  ? 'totalPts'
               : sortBy === 'recent_pts' ? 'recentPts'
               : 'avgPts'; // avg_pts

    var pa = fighterPointsMap[a.id] ? fighterPointsMap[a.id][ptsKey] : 0;
    var pb = fighterPointsMap[b.id] ? fighterPointsMap[b.id][ptsKey] : 0;

    // Higher points first; rank as tiebreaker
    if (pb !== pa) return pb - pa;
    return rankA - rankB;
  });

  var myPendingIds = new Set(
    myClaims
      .filter(function(c) { return c.status === 'pending'; })
      .map(function(c) { return c.fighter_to_add_id; })
  );

  var el = document.getElementById('availableContent');

  if (filtered.length === 0) {
    el.innerHTML = EmptyState.html({
      kind:  'search',
      title: 'No fighters match',
      body:  'Try clearing the division filter or adjusting your search.',
      compact: true
    });
    return;
  }

  var html = '';
  filtered.forEach(function(f, idx) {
    var rankLabel = f.is_champion ? 'C' : (f.current_rank ? '#' + f.current_rank : 'NR');
    var rankClass = f.is_champion ? 'rank-champion' : (f.current_rank ? 'rank-ranked' : 'rank-unranked');
    // Interim / BMF badge stacks below the main rank for sub-title holders
    var subBadge = '';
    if (f.is_sub_champion && f.sub_title_type === 'interim') {
      subBadge = '<span class="subrank-badge subrank-interim">INT</span>';
    } else if (f.is_sub_champion && f.sub_title_type === 'bmf') {
      subBadge = '<span class="subrank-badge subrank-bmf">BMF</span>';
    }
    var divLabel  = DIVISION_LABELS[f.primary_division] || f.primary_division;
    var record    = f.record_wins + '-' + f.record_losses + (f.record_draws ? '-' + f.record_draws : '');
    // Compose the sub-line under the fighter name: flag · division · age.
    // Each piece is optional — falls through cleanly if missing. The
    // consumer escapes the result, so we just build raw strings here.
    var flag = (typeof countryFlag === 'function') ? countryFlag(f.country) : '';
    var divParts = [];
    if (flag)          divParts.push(flag);
    if (divLabel)      divParts.push(divLabel);
    if (f.age != null) divParts.push('Age ' + f.age);
    var divLine = divParts.join(' · ');
    var addMode   = decideAddMode(f.id);

    // Right-side stat: show the sort-relevant metric inline on each row
    var pts      = fighterPointsMap[f.id];
    var statVal, statLabel, statFvId;
    if (sortBy === 'fantasy_value') {
      statVal   = pts ? computeFantasyValue(f).toFixed(1) : '—';
      statLabel = 'FV score';
      statFvId  = f.id;  // flag so we wrap in a clickable button
    } else if (sortBy === 'avg_pts') {
      statVal   = pts ? pts.avgPts.toFixed(1) : '—';
      statLabel = 'avg';
    } else if (sortBy === 'total_pts') {
      statVal   = pts ? pts.totalPts.toFixed(1) : '—';
      statLabel = 'total';
    } else if (sortBy === 'recent_pts') {
      statVal   = pts ? pts.recentPts.toFixed(1) : '—';
      statLabel = 'yr';
    } else {
      statVal   = record;
      statLabel = null;
    }
    var statInner = statLabel
      ? '<span style="font-size:var(--text-body);font-weight:700">' + escapeHtml(statVal) + '</span>' +
        '<span style="font-size:var(--text-caption);opacity:.55;margin-left:3px">' + escapeHtml(statLabel) + '</span>'
      : escapeHtml(statVal);
    var statHtml = statFvId
      ? '<button class="fv-score-btn" data-fv-fighter="' + escapeHtml(statFvId) + '" title="Click for score breakdown">' + statInner + '</button>'
      : statInner;

    // Rolling-waiver badge: shows above the row when this fighter is on
    // a 48hr hold, with the time it clears.
    var rollingNote = '';
    if (addMode.mode === 'claim' && addMode.reason === 'rolling') {
      rollingNote =
        '<span class="lineup-roster-row__matchup" style="color: var(--accent-gold)">' +
          'On waivers — clears ' + escapeHtml(formatEtDateTime(addMode.closesAt)) +
        '</span>';
    }

    // Next-fight note: small line showing this fighter's next booked bout.
    // Only rendered when the data is available (NextFight helper loaded
    // and the fighter has an upcoming fight). The Polymarket odds chip
    // sits inline at the end of the same line.
    var nextFightNote = '';
    var nf = fighterNextFight[f.id];
    if (nf && typeof NextFight !== 'undefined') {
      var oddsHtml = (typeof FightOdds !== 'undefined' && fighterFightOdds[f.id])
        ? FightOdds.inlineHtml(fighterFightOdds[f.id])
        : '';
      var projHtml = (typeof Projections !== 'undefined' && fighterProjections[f.id])
        ? Projections.pillHtml(fighterProjections[f.id], {
            fighterId:    f.id,
            fighterName:  f.name,
            opponentName: nf.opponent_name || '',
            eventName:    nf.event_name    || ''
          })
        : '';
      nextFightNote =
        '<span class="lineup-roster-row__matchup waiver-next-fight">' +
          'Fights ' + escapeHtml(NextFight.formatShort(nf)) +
          (oddsHtml ? ' ' + oddsHtml : '') +
          (projHtml ? ' ' + projHtml : '') +
        '</span>';
    }
    var photoHtml = f.photo_url
      ? '<img class="lineup-roster-row__photo" src="' + escapeHtml(f.photo_url) + '" alt="' + escapeHtml(f.name) + '" onerror="this.style.display=\'none\'">'
      : '';

    // Button / ownership label
    var btn;
    var ownerName = ownedByMap[f.id];
    if (ownerName) {
      // Fighter is rostered — show who owns them (no add button)
      btn = '<span class="lineup-roster-row__record" style="color: var(--text-tertiary); font-size: var(--text-caption);">On ' + escapeHtml(ownerName) + '</span>';
    } else if (addMode.mode === 'predraft') {
      btn = '<button class="btn-secondary lineup-row-btn" disabled ' +
              'title="Available after the draft completes">+ Add</button>';
    } else if (myPendingIds.has(f.id)) {
      btn = '<button class="btn-secondary lineup-row-btn" disabled>Claimed</button>';
    } else {
      var btnLabel = addMode.mode === 'instant' ? '+ Add' : '+ Claim';
      btn = '<button class="btn-secondary lineup-row-btn waiver-claim-btn" data-fighter-id="' + f.id + '">' +
              btnLabel +
            '</button>';
    }

    html +=
      '<div class="lineup-roster-row">' +
        '<span class="lineup-roster-row__pos">' + (idx + 1) + '</span>' +
        '<div class="lineup-roster-row__photo-wrap">' + photoHtml + '</div>' +
        '<span class="lineup-roster-row__rank ' + rankClass + '">' + rankLabel + subBadge + '</span>' +
        '<div class="lineup-roster-row__info">' +
          // Name line wraps name + inline rank suffix (rank shows on mobile
          // only; see .lineup-roster-row__rank-inline rules in components.css)
          '<span class="lineup-roster-row__name-line">' +
            '<button class="lineup-roster-row__name" data-open-fighter="' + f.id + '">' + escapeHtml(f.name) + '</button>' +
            '<span class="lineup-roster-row__rank-inline ' + rankClass + '" aria-hidden="true">' +
              '<span class="lineup-roster-row__rank-inline-divider">|</span>' +
              rankLabel +
            '</span>' +
          '</span>' +
          '<span class="lineup-roster-row__division">' + escapeHtml(divLine) + '</span>' +
          nextFightNote +
          rollingNote +
        '</div>' +
        '<span class="lineup-roster-row__record">' + statHtml + '</span>' +
        // Wrap the action button (or rostered-by label) in __actions so
        // the mobile grid layout places it cleanly at row 2 col 3 instead
        // of letting it auto-flow into an implicit row beneath the photo.
        '<div class="lineup-roster-row__actions">' + btn + '</div>' +
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

  el.querySelectorAll('.fv-score-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      showFvBreakdown(btn.getAttribute('data-fv-fighter'));
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
    el.innerHTML = EmptyState.html({
      kind:  'claims',
      title: 'No claims submitted',
      body:  'Submit a waiver claim from Available Fighters and your pending claims will appear here.'
    });
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
    el.innerHTML = EmptyState.html({
      kind:  'activity',
      title: 'No moves yet',
      body:  'Roster moves across the league show up here after waivers process.'
    });
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
    el.innerHTML = headerHtml + EmptyState.html({
      kind:    'claims',
      title:   'No pending claims',
      body:    'When managers submit waiver claims, they\'ll queue up here for you to process.',
      compact: true
    }) + '</div>';
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

  // Hard guard: if the draft hasn't completed, no adds are allowed at all.
  // The button is rendered as disabled, but this defends against direct
  // calls (e.g., the league-page Top Free Agents shortcut at line ~163).
  if (!league.draft_completed) {
    alert('Free agency opens once the draft completes.');
    return;
  }

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

  // Temp-spot opt-in: during the Thu→Sun event-week expansion, the user can
  // choose to place this fighter in one of the +3 temporary slots. Always
  // rendered for clarity — disabled (with a hint) when the window's closed
  // or all temp spots are already filled.
  // Numbered events get +3 expansion slots, Fight Nights get +2. Always
  // derive from the upcoming event so the checkbox copy and limits match
  // whatever's actually coming up.
  var expansionSlotsTotal = (typeof getEventBonusSize === 'function')
    ? getEventBonusSize(nextEvent, league && league.scoring_config)
    : (ROSTER_SIZE_EXPANDED - ROSTER_SIZE_BASE);
  var expansionSlotsUsed  = Math.max(0, myRoster.length - ROSTER_SIZE_BASE);
  var expansionSlotsOpen  = Math.max(0, expansionSlotsTotal - expansionSlotsUsed);
  var capExpandedNow      = typeof isCapExpanded === 'function'
    ? isCapExpanded(new Date(), nextEvent ? nextEvent.event_date : null)
    : false;
  var tempCheckboxEnabled = capExpandedNow && expansionSlotsOpen > 0;
  var tempCheckboxHint;
  if (!capExpandedNow) {
    tempCheckboxHint = 'Available Thu&ndash;Sun of event week only';
  } else if (expansionSlotsOpen === 0) {
    tempCheckboxHint = 'All ' + expansionSlotsTotal + ' temporary spots are filled';
  } else {
    tempCheckboxHint = expansionSlotsOpen + ' of ' + expansionSlotsTotal +
                       ' temporary spots open &middot; auto-drops Wed 3am ET';
  }
  var tempCheckboxHtml =
    '<label class="waiver-temp-spot' + (tempCheckboxEnabled ? '' : ' waiver-temp-spot--disabled') + '" ' +
           'for="useTempSpot">' +
      '<input type="checkbox" id="useTempSpot" ' + (tempCheckboxEnabled ? '' : 'disabled') + '>' +
      '<span class="waiver-temp-spot__label">' +
        '<span class="waiver-temp-spot__title">Use a temporary roster spot</span>' +
        '<span class="waiver-temp-spot__hint">' + tempCheckboxHint + '</span>' +
      '</span>' +
    '</label>';

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
        tempCheckboxHtml +
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
  var tempCheckbox = document.getElementById('useTempSpot');
  if (tempCheckbox) tempCheckbox.addEventListener('change', validateClaimModal);
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

  var dropSelect   = document.getElementById('dropSelect');
  var tempCheckbox = document.getElementById('useTempSpot');
  var warning      = document.getElementById('claimWarning');
  var submit       = document.getElementById('confirmClaimBtn');
  if (!dropSelect || !warning || !submit) return;

  var dropId        = dropSelect.value || null;
  var useExpansion  = !!(tempCheckbox && !tempCheckbox.disabled && tempCheckbox.checked);
  // If the user opts into a temp spot, both the total cap and the flex
  // capacity expand for the duration of the +3 window.
  var effectiveCap  = useExpansion
    ? ((typeof getRosterCapExpandedForEvent === 'function')
        ? getRosterCapExpandedForEvent(nextEvent, league && league.scoring_config)
        : ROSTER_SIZE_EXPANDED)
    : ROSTER_SIZE_BASE;
  var atCap         = myRoster.length >= effectiveCap;

  // Build the projected roster after the swap
  var projectedRoster = myRoster
    .filter(function(f) { return !dropId || f.id !== dropId; })
    .concat([claimingFighter]);

  var message  = '';
  var blocking = false;

  if (atCap && !dropId) {
    // Advisory: you must drop someone. Crimson because Submit is blocked.
    message  = 'You are at the ' + effectiveCap + '-fighter cap. Select a fighter to drop.';
    blocking = true;
  } else {
    var constructionErr = checkRosterConstruction(projectedRoster, { useExpansion: useExpansion, event: nextEvent });
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

  var dropId        = document.getElementById('dropSelect').value || null;
  var tempCheckbox  = document.getElementById('useTempSpot');
  var useExpansion  = !!(tempCheckbox && !tempCheckbox.disabled && tempCheckbox.checked);
  var effectiveCap  = useExpansion
    ? ((typeof getRosterCapExpandedForEvent === 'function')
        ? getRosterCapExpandedForEvent(nextEvent, league && league.scoring_config)
        : ROSTER_SIZE_EXPANDED)
    : ROSTER_SIZE_BASE;
  var atCap         = myRoster.length >= effectiveCap;

  if (atCap && !dropId) {
    alert('You are at the ' + effectiveCap + '-fighter cap. Please select a fighter to drop.');
    return;
  }

  // Roster-construction check: simulate the swap and see if it still fits the slot rules
  var projectedRoster = myRoster
    .filter(function(f) { return !dropId || f.id !== dropId; })
    .concat([claimingFighter]);
  var constructionErr = checkRosterConstruction(projectedRoster, { useExpansion: useExpansion, event: nextEvent });
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

  var dropId        = document.getElementById('dropSelect').value || null;
  var tempCheckbox  = document.getElementById('useTempSpot');
  var useExpansion  = !!(tempCheckbox && !tempCheckbox.disabled && tempCheckbox.checked);
  var effectiveCap  = useExpansion
    ? ((typeof getRosterCapExpandedForEvent === 'function')
        ? getRosterCapExpandedForEvent(nextEvent, league && league.scoring_config)
        : ROSTER_SIZE_EXPANDED)
    : ROSTER_SIZE_BASE;
  var atCap         = myRoster.length >= effectiveCap;

  if (atCap && !dropId) {
    alert('You are at the ' + effectiveCap + '-fighter cap. Please select a fighter to drop.');
    return;
  }

  // Construction check on the projected roster
  var projectedRoster = myRoster
    .filter(function(f) { return !dropId || f.id !== dropId; })
    .concat([claimingFighter]);
  var constructionErr = checkRosterConstruction(projectedRoster, { useExpansion: useExpansion, event: nextEvent });
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

    // Activity feed: log the drop. Look up the fighter name from the
    // user's current roster so we can show "dropped X" in the feed.
    if (typeof LeagueActivity !== 'undefined') {
      var droppedFighter = (myRoster || []).find(function(f) { return f.id === dropId; });
      LeagueActivity.logEvent(leagueId, LeagueActivity.KINDS.DROP, {
        fighter_id:   dropId,
        fighter_name: droppedFighter ? droppedFighter.name : 'a fighter',
        source:       'manual'
      }, myMemberId);
    }
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

  // Activity feed: free-agent adds are reported as a "won" claim with
  // priority null so the line still reads cleanly in the unified feed.
  // (We don't model "instant_add" as its own kind to avoid an extra
  // entry-type per surface.)
  if (typeof LeagueActivity !== 'undefined') {
    LeagueActivity.logEvent(leagueId, LeagueActivity.KINDS.CLAIM_WON, {
      fighter_id:   claimingFighter.id,
      fighter_name: claimingFighter.name,
      via:          'instant_add'
    }, myMemberId);
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
      // Activity feed: lost claim due to higher-priority contention.
      if (typeof LeagueActivity !== 'undefined') {
        var lostFighter = (allFighters || []).find(function(f) { return f.id === claim.fighter_to_add_id; });
        LeagueActivity.logEvent(leagueId, LeagueActivity.KINDS.CLAIM_LOST, {
          fighter_id:   claim.fighter_to_add_id,
          fighter_name: lostFighter ? lostFighter.name : 'a fighter',
          priority:     claim.priority,
          reason:       'Higher-priority team won the claim this cycle.'
        }, claim.league_member_id);
      }
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

    if (memberRosterSize >= ROSTER_SIZE_BASE && !claim.fighter_to_drop_id) {
      await supabaseClient.from('waiver_claims').update({
        status: 'rejected',
        rejection_reason: 'At the ' + ROSTER_SIZE_BASE + '-fighter cap. Must specify a fighter to drop.',
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

    // Activity feed: claim_won. Mirrors the auto-batch path above.
    if (typeof LeagueActivity !== 'undefined') {
      var addedFighter   = fighterMapForCheck[claim.fighter_to_add_id];
      var droppedFighter = claim.fighter_to_drop_id ? fighterMapForCheck[claim.fighter_to_drop_id] : null;
      LeagueActivity.logEvent(leagueId, LeagueActivity.KINDS.CLAIM_WON, {
        fighter_id:           claim.fighter_to_add_id,
        fighter_name:         addedFighter ? addedFighter.name : 'a fighter',
        dropped_fighter_id:   droppedFighter ? droppedFighter.id   : null,
        dropped_fighter_name: droppedFighter ? droppedFighter.name : null,
        priority:             claim.priority,
        via:                  'waiver'
      }, claim.league_member_id);
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
    supabaseClient.from('league_members').select('id, user_id, team_name, waiver_priority, is_commissioner').eq('league_id', leagueId),
    supabaseClient.from('roster_drops').select('id, fighter_id, league_member_id, dropped_at, source').eq('league_id', leagueId).order('dropped_at', { ascending: false })
  ]);

  members  = results[2].data || [];
  myMember = members.find(function(m) { return m.user_id === user.id; });

  var allRosters = results[0].data || [];
  var ownedIds   = new Set(allRosters.map(function(r) { return r.fighter_id; }));
  availableFighters = allFighters.filter(function(f) { return !ownedIds.has(f.id); });
  ownedByMap = buildOwnedByMap(allRosters, members);

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
// Current roster rules (single source of truth: ROSTER_* constants in
// waiver-phase.js):
//   * 1 fighter per MEN'S weight class — 8 divisions
//   * 1 Women's Flex slot (any of the 3 women's divisions)
//   * 6 fighters in the Any-Division Flex bucket (any weight class)
//   * Total cap = 15 (base) or 17–18 during the event-week expansion
//
// Construction works by spillover:
//   * Each men's division holds up to ROSTER_SLOTS_PER_DIVISION; overflow → any-flex
//   * Women's divisions share a single Women's Flex slot; overflow → any-flex
//   * Any-flex demand must stay within ROSTER_FLEX_SLOTS (+ event-week bonus)
// Returns null when fighters fit, otherwise a user-facing error message.

// Optional opts.useExpansion = true loosens the limits to the event-week
// expansion caps. The expansion size depends on the upcoming event:
// numbered PPVs get +3, Fight Nights get +2. Pass opts.event (the next
// ufc_events row) so the caller's view of the cap matches reality;
// without it we fall back to the +3 numbered-event default.
function checkRosterConstruction(fighters, opts) {
  opts = opts || {};
  var bonus = (opts.useExpansion && typeof getEventBonusSize === 'function')
    ? getEventBonusSize(opts.event, league && league.scoring_config)
    : (opts.useExpansion ? (ROSTER_SIZE_EXPANDED - ROSTER_SIZE_BASE) : 0);
  // Any-flex cap + total cap both follow the commissioner's roster_size
  // (via getAnyFlexSlots) rather than the v1.2 baseline. Event-week
  // expansion adds the same +bonus to both.
  var baseAnyFlex = typeof getAnyFlexSlots === 'function' ? getAnyFlexSlots(league) : ROSTER_FLEX_SLOTS;
  var baseTotal   = (league && typeof league.roster_size === 'number') ? league.roster_size : ROSTER_SIZE_BASE;
  var flexLimit   = baseAnyFlex + bonus;
  var totalLimit  = baseTotal   + bonus;

  if (fighters.length > totalLimit) {
    return 'Roster cannot exceed ' + totalLimit + ' fighters' +
           (opts.useExpansion ? ' even during the event-week expansion.' : '.');
  }

  // Count fighters per division, plus a separate tally of women's fighters
  // across all three women's divisions (they share the Women's Flex slot).
  var counts = {};
  var womensTotal = 0;
  fighters.forEach(function(f) {
    counts[f.primary_division] = (counts[f.primary_division] || 0) + 1;
    if (WOMENS_DIVISIONS_KEYS.indexOf(f.primary_division) !== -1) {
      womensTotal++;
    }
  });

  var anyFlexNeeded     = 0;
  var overFullDivisions = [];

  // Men's divisions — each capped at ROSTER_SLOTS_PER_DIVISION (1)
  Object.keys(counts).forEach(function(div) {
    if (WOMENS_DIVISIONS_KEYS.indexOf(div) !== -1) return;  // women's pooled separately
    var overflow = Math.max(0, counts[div] - ROSTER_SLOTS_PER_DIVISION);
    if (overflow > 0) {
      anyFlexNeeded += overflow;
      overFullDivisions.push(DIVISION_LABELS[div] || div);
    }
  });

  // Women's pool — anything beyond ROSTER_WOMENS_FLEX_SLOTS (1) spills over
  var womensOverflow = Math.max(0, womensTotal - ROSTER_WOMENS_FLEX_SLOTS);
  if (womensOverflow > 0) {
    anyFlexNeeded += womensOverflow;
    overFullDivisions.push("Women's Flex");
  }

  if (anyFlexNeeded > flexLimit) {
    var why = 'too many fighters in ' + overFullDivisions.join(', ');
    return 'This claim won\'t fit your roster — ' + why +
           '. The Any-Division Flex bucket only holds ' + flexLimit +
           '. Pick a different fighter to drop.';
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
