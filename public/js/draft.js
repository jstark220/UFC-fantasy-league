// ========================================================================
// DRAFT PAGE LOGIC
// Real-time snake draft room. All clients subscribe to Supabase Realtime
// to see picks as they happen. The active manager clicks a fighter to pick;
// all other clients watch the board update live.
// Depends on supabaseClient (supabase-config.js) and requireAuth (auth-guard.js).
// ========================================================================

// ========================================================================
// ROSTER SLOT DEFINITIONS
// These enum values must match the weight_class enum in the database exactly.
// ========================================================================
const MENS_DIVISIONS = [
  'flyweight', 'bantamweight', 'featherweight', 'lightweight',
  'welterweight', 'middleweight', 'light_heavyweight', 'heavyweight'
];
const WOMENS_DIVISIONS = ['strawweight', 'flyweight_w', 'bantamweight_w'];

// Human-readable labels for display in the fighter pool and roster panel
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

// ========================================================================
// MODULE-LEVEL STATE
// All rendering functions read from these variables rather than taking
// arguments, so any function can trigger a full re-render after a pick.
// ========================================================================
let user, leagueId, league, members, memberMap, myMemberId;
let allFighters, fighterMap;
let picks = [];
let divisionFilter = 'all';
let statusFilter   = 'all';
let sortBy         = 'rank';
let searchQuery = '';
let picking = false; // blocks a second pick while a request is in flight

// View All modal — independent filter / sort state so the modal can be
// browsed without disturbing the side panel's controls.
let viewAllSearch   = '';
let viewAllSort     = 'rank';
let viewAllDivision = 'all';
let viewAllStatus   = 'all';

// ========================================================================
// INIT
// Loads all required data in parallel, then renders and subscribes.
// ========================================================================
async function initDraft() {
  user = await requireAuth();
  if (!user) return;

  leagueId = new URLSearchParams(window.location.search).get('id');
  if (!leagueId) { window.location.href = 'dashboard.html'; return; }

  // Set back link before data arrives so it's ready immediately
  document.getElementById('leagueLink').href = 'league.html?id=' + leagueId;

  // Load all four data sets at the same time to minimise wait.
  // Picks come from `draft_picks` (immutable history), NOT from `rosters` —
  // rosters mutate after the draft ends (trades, drops) and would create
  // gaps on the board. See migrations/003_draft_picks.sql.
  const [leagueRes, membersRes, fightersRes, picksRes] = await Promise.all([
    supabaseClient
      .from('leagues')
      .select('id, name, draft_order, draft_started, draft_completed, roster_size, max_managers')
      .eq('id', leagueId)
      .single(),
    supabaseClient
      .from('league_members')
      .select('id, user_id, team_name')
      .eq('league_id', leagueId),
    supabaseClient
      .from('fighters')
      .select('id, name, primary_division, current_rank, is_champion, record_wins, record_losses, record_draws, photo_url')
      .order('is_champion', { ascending: false })
      .order('current_rank', { nullsFirst: false }),
    supabaseClient
      .from('draft_picks')
      .select('id, league_member_id, fighter_id, draft_pick, draft_round')
      .eq('league_id', leagueId)
      .order('draft_pick')
  ]);

  if (leagueRes.error || !leagueRes.data) {
    window.location.href = 'dashboard.html';
    return;
  }

  league   = leagueRes.data;
  members  = membersRes.data  || [];
  allFighters = fightersRes.data || [];
  picks    = picksRes.data    || [];

  // If the draft hasn't started yet, there's nothing to show here
  if (!league.draft_started) {
    window.location.href = 'league.html?id=' + leagueId;
    return;
  }

  // Build O(1) lookup maps so rendering doesn't need to scan arrays
  memberMap = {};
  members.forEach(function(m) { memberMap[m.id] = m; });

  fighterMap = {};
  allFighters.forEach(function(f) { fighterMap[f.id] = f; });

  // Identify the current user's league_member_id
  const myMember = members.find(function(m) { return m.user_id === user.id; });
  if (!myMember) { window.location.href = 'dashboard.html'; return; }
  myMemberId = myMember.id;

  // Populate the division filter dropdown before first render
  populateDivisionFilter();

  // Render all three panels
  renderAll();

  // Subscribe to live pick events
  subscribeToRealtime();

  // One delegated listener: any element with data-open-fighter opens the
  // fighter modal regardless of which renderer emitted it. Avoids re-wiring
  // after every realtime pick re-render.
  document.addEventListener('click', function(e) {
    var trigger = e.target.closest('[data-open-fighter]');
    if (!trigger) return;
    if (typeof showFighterModal === 'function') {
      showFighterModal(trigger.getAttribute('data-open-fighter'));
    }
  });

  // Delegated listener for the fighter-modal Draft button. The modal lives
  // outside our normal render tree, so per-render wiring won't catch it —
  // a delegated handler at document level does.
  document.addEventListener('click', function(e) {
    var trigger = e.target.closest('[data-draft-fighter]');
    if (!trigger) return;
    var fighter = fighterMap[trigger.getAttribute('data-draft-fighter')];
    if (!fighter) return;

    // Validate up front so we can give a clear message instead of a silent
    // no-op from inside makePick.
    if (!isMyTurn()) {
      alert("It's not your pick yet.");
      return;
    }
    if (!canPick(fighter, getMyPickFighters())) {
      alert('No valid roster slot for this fighter.');
      return;
    }
    makePick(fighter);
    if (typeof closeFighterModal === 'function') closeFighterModal();
  });

  // View All button — opens the fullscreen browse modal
  var viewAllBtn = document.getElementById('viewAllBtn');
  if (viewAllBtn) viewAllBtn.addEventListener('click', openViewAll);

  // Reveal the page now that everything is ready
  document.getElementById('pageContent').style.display = 'block';
}

// ========================================================================
// SNAKE DRAFT ALGORITHM
// Given a 1-indexed pick number, returns the round and the league_member_id
// of the manager whose turn it is.
// ========================================================================
function getPickInfo(pickNumber) {
  const n = league.draft_order.length;
  const round = Math.ceil(pickNumber / n);
  const posInRound = (pickNumber - 1) % n;
  // Odd rounds go left-to-right, even rounds reverse (snake)
  const index = round % 2 === 1 ? posInRound : n - 1 - posInRound;
  return {
    round: round,
    activeManagerId: league.draft_order[index]
  };
}

function getCurrentPickNum() {
  // Next pick number is always one more than picks made so far
  return picks.length + 1;
}

function getTotalPicks() {
  return league.draft_order.length * league.roster_size;
}

function isMyTurn() {
  if (!league.draft_started || league.draft_completed) return false;
  if (picks.length >= getTotalPicks()) return false;
  return getPickInfo(getCurrentPickNum()).activeManagerId === myMemberId;
}

// ========================================================================
// ROSTER SLOT VALIDATION
// Returns true if the fighter can legally be added to the manager's roster
// given the current picks. Enforces the v1.2 roster construction rules:
//   - 2 slots per men's weight class (8 divisions = 16 slots)
//   - 2 women's flex slots (any women's division)
//   - 2 any-division flex slots (for overflow from any category)
// ========================================================================
function canPick(fighter, currentPickFighters) {
  const isWoman = WOMENS_DIVISIONS.includes(fighter.primary_division);

  const menCounts = {};
  let womenCount = 0;

  currentPickFighters.forEach(function(f) {
    if (WOMENS_DIVISIONS.includes(f.primary_division)) {
      womenCount++;
    } else {
      menCounts[f.primary_division] = (menCounts[f.primary_division] || 0) + 1;
    }
  });

  // Tally how many fighters have already overflowed into any-division flex slots
  let flexUsed = Math.max(0, womenCount - 2); // women beyond the 2 women's flex slots
  MENS_DIVISIONS.forEach(function(div) {
    flexUsed += Math.max(0, (menCounts[div] || 0) - 2); // men beyond 2 per division
  });

  if (isWoman) {
    // Women go into women's flex (up to 2) or any-division flex (up to 2)
    return womenCount < 2 || flexUsed < 2;
  } else {
    // Men go into their division slot (up to 2) or any-division flex (up to 2)
    return (menCounts[fighter.primary_division] || 0) < 2 || flexUsed < 2;
  }
}

// ========================================================================
// MAKE A PICK
// Inserts the pick into the rosters table. The Realtime event fires and
// updates all connected clients including the picker's own screen.
// ========================================================================
async function makePick(fighter) {
  if (!isMyTurn() || picking) return;

  const myPickFighters = getMyPickFighters();
  if (!canPick(fighter, myPickFighters)) return;

  // Lock immediately to prevent double-pick while the INSERT is in flight
  picking = true;
  renderFighterPool();

  const pickNum = getCurrentPickNum();
  const { round } = getPickInfo(pickNum);

  const { error } = await supabaseClient
    .from('rosters')
    .insert({
      league_member_id: myMemberId,
      league_id:        leagueId,
      fighter_id:       fighter.id,
      acquired_method:  'draft',
      draft_round:      round,
      draft_pick:       pickNum
    });

  if (error) {
    // Most likely a race condition where another client picked the same slot
    console.error('Pick failed:', error.message);
    picking = false;
    // Re-fetch picks to sync with the actual DB state
    const { data: freshPicks } = await supabaseClient
      .from('rosters')
      .select('id, league_member_id, fighter_id, draft_pick, draft_round')
      .eq('league_id', leagueId)
      .order('draft_pick');
    if (freshPicks) picks = freshPicks;
    renderAll();
    return;
  }

  // Activity feed: draft_pick. Captures round + overall so the line reads
  // "Mike drafted Topuria (R3 · #21)". Best-effort — failures are logged
  // inside LeagueActivity, not surfaced to the drafter.
  if (typeof LeagueActivity !== 'undefined') {
    LeagueActivity.logEvent(leagueId, LeagueActivity.KINDS.DRAFT_PICK, {
      fighter_id:    fighter.id,
      fighter_name:  fighter.name,
      round:         round,
      pick_overall:  pickNum
    }, myMemberId);
  }
  // On success: Realtime fires handleNewPick, which re-renders everything
}

// ========================================================================
// REALTIME SUBSCRIPTION
// Listens for new rows inserted into the rosters table for this league.
// ========================================================================
function subscribeToRealtime() {
  // Listen on draft_picks (immutable record), not rosters. The trigger
  // sync_draft_pick_trigger inserts into draft_picks whenever a roster
  // row lands with draft metadata, so this fires once per pick.
  supabaseClient
    .channel('draft_room_' + leagueId)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'draft_picks',
      filter: 'league_id=eq.' + leagueId
    }, handleNewPick)
    .subscribe();
}

function handleNewPick(payload) {
  const newPick = payload.new;

  // Guard against duplicate events (Realtime can occasionally fire twice)
  if (picks.find(function(p) { return p.id === newPick.id; })) return;

  picks.push(newPick);
  // Keep sorted by pick number so getCurrentPickNum() stays correct
  picks.sort(function(a, b) { return a.draft_pick - b.draft_pick; });

  // Release the pick lock so the next manager can pick
  picking = false;

  renderAll();

  if (picks.length >= getTotalPicks()) {
    handleDraftComplete();
  }
}

// ========================================================================
// DRAFT COMPLETE
// ========================================================================
async function handleDraftComplete() {
  // Persist the completed flag so league.html shows the right state
  await supabaseClient
    .from('leagues')
    .update({ draft_completed: true })
    .eq('id', leagueId);

  league.draft_completed = true;
  renderHeader();
}

// ========================================================================
// RENDER ALL PANELS
// Called after every pick to keep all three panels in sync.
// ========================================================================
function renderAll() {
  renderHeader();
  renderFighterPool();
  renderDraftBoard();
  renderMyRoster();
  // If the View All modal is open, refresh it too so newly drafted fighters
  // disappear from its list in real time.
  if (document.getElementById('viewAllOverlay')) renderViewAllList();
}

// ========================================================================
// RENDER HEADER
// ========================================================================
function renderHeader() {
  const totalPicks    = getTotalPicks();
  const currentPickNum = getCurrentPickNum();
  const turnInfoEl    = document.getElementById('turnInfo');
  const pickCounterEl = document.getElementById('pickCounter');

  if (league.draft_completed || picks.length >= totalPicks) {
    turnInfoEl.innerHTML = '<span class="draft-status__complete">Draft Complete</span>';
    pickCounterEl.textContent = '';
    return;
  }

  const { round, activeManagerId } = getPickInfo(currentPickNum);
  const activeMember = memberMap[activeManagerId];
  const teamName = activeMember ? activeMember.team_name : '?';

  if (activeManagerId === myMemberId) {
    turnInfoEl.innerHTML = '<span class="draft-status__mine">Your pick</span> · Round ' + round;
  } else {
    turnInfoEl.innerHTML =
      '<span class="draft-status__team">' + escapeHtml(teamName) + '</span> is on the clock · Round ' + round;
  }

  pickCounterEl.textContent = 'Pick ' + currentPickNum + ' of ' + totalPicks;
}

// ========================================================================
// RENDER FIGHTER POOL
// ========================================================================
function renderFighterPool() {
  const pickedIds      = new Set(picks.map(function(p) { return p.fighter_id; }));
  const myTurn         = isMyTurn() && !picking;
  const myPickFighters = getMyPickFighters();

  // Start with all undrafted fighters
  let fighters = allFighters.filter(function(f) { return !pickedIds.has(f.id); });

  // Apply division filter
  if (divisionFilter !== 'all') {
    fighters = fighters.filter(function(f) { return f.primary_division === divisionFilter; });
  }

  // Apply status filter (undefeated / top tiers / unranked) — same rules as
  // the Free Agency page so the two surfaces feel consistent.
  if (statusFilter === 'undefeated') {
    fighters = fighters.filter(function(f) {
      return f.record_losses === 0 && (f.record_draws || 0) === 0;
    });
  } else if (statusFilter === 'top5') {
    fighters = fighters.filter(function(f) {
      return f.is_champion || (f.current_rank && f.current_rank <= 5);
    });
  } else if (statusFilter === 'top10') {
    fighters = fighters.filter(function(f) {
      return f.is_champion || (f.current_rank && f.current_rank <= 10);
    });
  } else if (statusFilter === 'unranked') {
    fighters = fighters.filter(function(f) {
      return !f.is_champion && !f.current_rank;
    });
  }

  // Apply name search
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    fighters = fighters.filter(function(f) { return f.name.toLowerCase().includes(q); });
  }

  // Sort a copy so the underlying allFighters array order stays stable
  fighters = fighters.slice().sort(function(a, b) {
    if (sortBy === 'rank') {
      var ra = a.is_champion ? 0 : (a.current_rank || 999);
      var rb = b.is_champion ? 0 : (b.current_rank || 999);
      return ra - rb;
    }
    if (sortBy === 'record') {
      // Most wins first, fewest losses as tiebreaker
      if (b.record_wins !== a.record_wins) return b.record_wins - a.record_wins;
      return a.record_losses - b.record_losses;
    }
    // 'points_year' and 'points_proj': data isn't tracked yet; fall back to rank
    var ra2 = a.is_champion ? 0 : (a.current_rank || 999);
    var rb2 = b.is_champion ? 0 : (b.current_rank || 999);
    return ra2 - rb2;
  });

  const poolEl = document.getElementById('fighterPool');

  if (fighters.length === 0) {
    poolEl.innerHTML = '<p class="draft-empty" style="padding: var(--space-4) 0">No fighters match your filters.</p>';
    return;
  }

  let html = '';

  fighters.forEach(function(f) {
    const valid       = myTurn && canPick(f, myPickFighters);
    const rankLabel   = f.is_champion ? 'C' : (f.current_rank ? '#' + f.current_rank : 'NR');
    const rankClass   = f.is_champion ? 'rank-champion' : (f.current_rank ? 'rank-ranked' : 'rank-unranked');
    const divLabel    = DIVISION_LABELS[f.primary_division] || f.primary_division;
    const record      = f.record_wins + '-' + f.record_losses + (f.record_draws ? '-' + f.record_draws : '');
    const photoHtml   = f.photo_url
      ? '<img class="lineup-roster-row__photo" src="' + escapeHtml(f.photo_url) + '" alt="' + escapeHtml(f.name) + '" onerror="this.style.display=\'none\'">'
      : '';

    let rowMods = ' draft-pool-row';
    let titleAttr = '';
    let pickBtn   = '';
    if (myTurn && valid) {
      rowMods += ' draft-pool-row--pickable';
      pickBtn  = '<button class="btn-secondary lineup-row-btn draft-pick-btn" data-fighter-id="' + f.id + '">Draft</button>';
    } else if (myTurn && !valid) {
      rowMods += ' draft-pool-row--invalid';
      titleAttr = ' title="No valid roster slot available for this fighter"';
      pickBtn   = '<button class="btn-secondary lineup-row-btn" disabled>No slot</button>';
    }

    html +=
      '<div class="lineup-roster-row' + rowMods + '"' + titleAttr + '>' +
        '<div class="lineup-roster-row__photo-wrap">' + photoHtml + '</div>' +
        '<span class="lineup-roster-row__rank ' + rankClass + '">' + escapeHtml(rankLabel) + '</span>' +
        '<div class="lineup-roster-row__info">' +
          '<button class="lineup-roster-row__name" data-open-fighter="' + f.id + '">' +
            escapeHtml(f.name) +
          '</button>' +
          '<span class="lineup-roster-row__division">' + escapeHtml(divLabel) + '</span>' +
        '</div>' +
        '<span class="lineup-roster-row__record">' + record + '</span>' +
        pickBtn +
      '</div>';
  });

  poolEl.innerHTML = html;

  // Wire pick buttons (only present when it's your turn AND the slot is legal)
  poolEl.querySelectorAll('.draft-pick-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const fighter = fighterMap[btn.getAttribute('data-fighter-id')];
      if (fighter) makePick(fighter);
    });
  });
}

// ========================================================================
// VIEW ALL MODAL
// Fullscreen overlay with the same search / sort / division / status
// controls as the side panel, but laid out as a multi-column grid so the
// user can see many more fighters at once. Independent control state so
// browsing here doesn't change the panel's filters.
// ========================================================================
function openViewAll() {
  // Build the division-filter options from the same constants the panel uses
  var divOptions = '<option value="all">All Divisions</option>';
  WOMENS_DIVISIONS.concat(MENS_DIVISIONS).forEach(function(d) {
    divOptions += '<option value="' + d + '">' + escapeHtml(DIVISION_LABELS[d]) + '</option>';
  });

  // Remove any stale instance
  var existing = document.getElementById('viewAllOverlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'viewAllOverlay';
  overlay.className = 'view-all-overlay';
  overlay.innerHTML =
    '<div class="view-all-modal" role="dialog" aria-modal="true" aria-labelledby="viewAllTitle">' +
      '<div class="view-all-modal__header">' +
        '<h2 class="view-all-modal__title" id="viewAllTitle">All Available Fighters</h2>' +
        '<button class="view-all-modal__close" id="viewAllClose" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="view-all-modal__controls">' +
        '<input type="text" id="viewAllSearchInput" class="waiver-search" placeholder="Search fighters...">' +
        '<select id="viewAllSortInput" class="waiver-filter">' +
          '<option value="rank">Sort: Rank</option>' +
          '<option value="record">Sort: Record</option>' +
          '<option value="points_year">Sort: Points (Year)</option>' +
          '<option value="points_proj">Sort: Projected Pts</option>' +
        '</select>' +
        '<select id="viewAllDivisionInput" class="waiver-filter">' + divOptions + '</select>' +
        '<select id="viewAllStatusInput" class="waiver-filter">' +
          '<option value="all">All Fighters</option>' +
          '<option value="undefeated">Undefeated</option>' +
          '<option value="top5">Top 5</option>' +
          '<option value="top10">Top 10</option>' +
          '<option value="unranked">Unranked</option>' +
        '</select>' +
      '</div>' +
      '<div class="view-all-modal__count" id="viewAllCount"></div>' +
      '<div class="view-all-modal__body" id="viewAllBody"></div>' +
    '</div>';

  document.body.appendChild(overlay);

  // Restore any previous selections (modal can be re-opened mid-session)
  document.getElementById('viewAllSearchInput').value   = viewAllSearch;
  document.getElementById('viewAllSortInput').value     = viewAllSort;
  document.getElementById('viewAllDivisionInput').value = viewAllDivision;
  document.getElementById('viewAllStatusInput').value   = viewAllStatus;

  // Wire close interactions
  document.getElementById('viewAllClose').addEventListener('click', closeViewAll);
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeViewAll();
  });
  document.addEventListener('keydown', _viewAllEscHandler);

  // Wire control changes
  document.getElementById('viewAllSearchInput').addEventListener('input', function() {
    viewAllSearch = this.value.trim();
    renderViewAllList();
  });
  document.getElementById('viewAllSortInput').addEventListener('change', function() {
    viewAllSort = this.value;
    renderViewAllList();
  });
  document.getElementById('viewAllDivisionInput').addEventListener('change', function() {
    viewAllDivision = this.value;
    renderViewAllList();
  });
  document.getElementById('viewAllStatusInput').addEventListener('change', function() {
    viewAllStatus = this.value;
    renderViewAllList();
  });

  renderViewAllList();
}

function closeViewAll() {
  var overlay = document.getElementById('viewAllOverlay');
  if (overlay) overlay.remove();
  document.removeEventListener('keydown', _viewAllEscHandler);
}

function _viewAllEscHandler(e) {
  if (e.key === 'Escape') closeViewAll();
}

function renderViewAllList() {
  var body  = document.getElementById('viewAllBody');
  var count = document.getElementById('viewAllCount');
  if (!body) return;

  var pickedIds      = new Set(picks.map(function(p) { return p.fighter_id; }));
  var myTurn         = isMyTurn() && !picking;
  var myPickFighters = getMyPickFighters();

  // Same filter pipeline as renderFighterPool, but reading viewAll* state
  var fighters = allFighters.filter(function(f) { return !pickedIds.has(f.id); });

  if (viewAllDivision !== 'all') {
    fighters = fighters.filter(function(f) { return f.primary_division === viewAllDivision; });
  }

  if (viewAllStatus === 'undefeated') {
    fighters = fighters.filter(function(f) { return f.record_losses === 0 && (f.record_draws || 0) === 0; });
  } else if (viewAllStatus === 'top5') {
    fighters = fighters.filter(function(f) { return f.is_champion || (f.current_rank && f.current_rank <= 5); });
  } else if (viewAllStatus === 'top10') {
    fighters = fighters.filter(function(f) { return f.is_champion || (f.current_rank && f.current_rank <= 10); });
  } else if (viewAllStatus === 'unranked') {
    fighters = fighters.filter(function(f) { return !f.is_champion && !f.current_rank; });
  }

  if (viewAllSearch) {
    var q = viewAllSearch.toLowerCase();
    fighters = fighters.filter(function(f) { return f.name.toLowerCase().includes(q); });
  }

  fighters = fighters.slice().sort(function(a, b) {
    if (viewAllSort === 'rank') {
      var ra = a.is_champion ? 0 : (a.current_rank || 999);
      var rb = b.is_champion ? 0 : (b.current_rank || 999);
      return ra - rb;
    }
    if (viewAllSort === 'record') {
      if (b.record_wins !== a.record_wins) return b.record_wins - a.record_wins;
      return a.record_losses - b.record_losses;
    }
    var ra2 = a.is_champion ? 0 : (a.current_rank || 999);
    var rb2 = b.is_champion ? 0 : (b.current_rank || 999);
    return ra2 - rb2;
  });

  if (count) {
    count.textContent = fighters.length + ' fighter' + (fighters.length === 1 ? '' : 's');
  }

  if (fighters.length === 0) {
    body.innerHTML = '<p class="draft-empty" style="padding: var(--space-6) 0; grid-column: 1 / -1; text-align: center">No fighters match your filters.</p>';
    return;
  }

  var html = '';
  fighters.forEach(function(f) {
    var valid     = myTurn && canPick(f, myPickFighters);
    var rankLabel = f.is_champion ? 'C' : (f.current_rank ? '#' + f.current_rank : 'NR');
    var rankClass = f.is_champion ? 'rank-champion' : (f.current_rank ? 'rank-ranked' : 'rank-unranked');
    var divLabel  = DIVISION_LABELS[f.primary_division] || f.primary_division;
    var record    = f.record_wins + '-' + f.record_losses + (f.record_draws ? '-' + f.record_draws : '');
    var photoHtml = f.photo_url
      ? '<img class="lineup-roster-row__photo" src="' + escapeHtml(f.photo_url) + '" alt="' + escapeHtml(f.name) + '" onerror="this.style.display=\'none\'">'
      : '';

    var pickBtn = '';
    if (myTurn && valid) {
      pickBtn = '<button class="btn-secondary lineup-row-btn view-all-pick-btn" data-fighter-id="' + f.id + '">Draft</button>';
    } else if (myTurn && !valid) {
      pickBtn = '<button class="btn-secondary lineup-row-btn" disabled>No slot</button>';
    }

    html +=
      '<div class="lineup-roster-row">' +
        '<div class="lineup-roster-row__photo-wrap">' + photoHtml + '</div>' +
        '<span class="lineup-roster-row__rank ' + rankClass + '">' + rankLabel + '</span>' +
        '<div class="lineup-roster-row__info">' +
          '<button class="lineup-roster-row__name" data-open-fighter="' + f.id + '">' + escapeHtml(f.name) + '</button>' +
          '<span class="lineup-roster-row__division">' + escapeHtml(divLabel) + '</span>' +
        '</div>' +
        '<span class="lineup-roster-row__record">' + record + '</span>' +
        pickBtn +
      '</div>';
  });

  body.innerHTML = html;

  // Wire pick buttons. data-open-fighter is handled by the global delegated
  // listener attached at init time, so fighter modal opens still work.
  body.querySelectorAll('.view-all-pick-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var fighter = fighterMap[btn.getAttribute('data-fighter-id')];
      if (fighter) {
        makePick(fighter);
        // Close the modal so the user sees the live board update
        closeViewAll();
      }
    });
  });
}

// ========================================================================
// RENDER DRAFT BOARD
// Grid with rounds as rows and managers as columns. Each cell shows the
// fighter picked at that slot. Snake reversal is reflected in the grid.
// ========================================================================
function renderDraftBoard() {
  const n            = league.draft_order.length;
  const totalRounds  = league.roster_size;
  const totalPicks   = getTotalPicks();
  const currentPickNum = getCurrentPickNum();

  // Pre-build a pick_number -> fighter_id map. Cells render the fighter's
  // name (looked up via fighterMap) and expose data-open-fighter so the
  // delegated click handler opens the fighter modal.
  const pickMap = {};
  picks.forEach(function(p) {
    pickMap[p.draft_pick] = p.fighter_id;
  });

  let html = '<div class="standings-card draft-board"><table class="standings-table draft-board__table"><thead><tr>';
  html += '<th class="standings-th standings-th--rank">Rd</th>';

  league.draft_order.forEach(function(memberId) {
    const member = memberMap[memberId];
    const isMe   = memberId === myMemberId;
    html += '<th class="standings-th' + (isMe ? ' draft-board__col-mine' : '') + '">';
    html += escapeHtml(member ? member.team_name : '?');
    html += '</th>';
  });
  html += '</tr></thead><tbody>';

  for (let round = 1; round <= totalRounds; round++) {
    html += '<tr class="standings-row"><td class="draft-board__round">' + round + '</td>';

    for (let managerIdx = 0; managerIdx < n; managerIdx++) {
      // Map (round, managerIdx) to the absolute pick number.
      // Odd rounds read left-to-right; even rounds read right-to-left.
      const pickNum = round % 2 === 1
        ? (round - 1) * n + managerIdx + 1
        : (round - 1) * n + (n - managerIdx);

      const memberId  = league.draft_order[managerIdx];
      const isMe      = memberId === myMemberId;
      const isCurrent = pickNum === currentPickNum && picks.length < totalPicks;

      let cellClass = 'draft-board__cell';
      if (isMe)     cellClass += ' draft-board__cell--mine';
      if (pickMap[pickNum]) cellClass += ' draft-board__cell--made';
      else if (isCurrent)   cellClass += ' draft-board__cell--current';
      else                  cellClass += ' draft-board__cell--empty';

      html += '<td class="' + cellClass + '">';
      if (pickMap[pickNum]) {
        var fighter = fighterMap[pickMap[pickNum]];
        var name    = fighter ? fighter.name : '?';
        html +=
          '<button class="draft-board__pick-name" data-open-fighter="' + pickMap[pickNum] + '">' +
            escapeHtml(name) +
          '</button>';
      } else if (isCurrent) {
        html += '<span class="draft-board__on-clock">On the clock</span>';
      }
      html += '</td>';
    }
    html += '</tr>';
  }

  html += '</tbody></table></div>';
  document.getElementById('draftBoard').innerHTML = html;
}

// ========================================================================
// RENDER MY ROSTER
// Slot progress indicators (pip dots) + list of drafted fighters.
// ========================================================================
function renderMyRoster() {
  const myPickFighters = getMyPickFighters();

  // Tally picks by slot category
  const menCounts = {};
  MENS_DIVISIONS.forEach(function(d) { menCounts[d] = 0; });
  let womenCount = 0;

  myPickFighters.forEach(function(f) {
    if (WOMENS_DIVISIONS.includes(f.primary_division)) {
      womenCount++;
    } else if (menCounts[f.primary_division] !== undefined) {
      menCounts[f.primary_division]++;
    }
  });

  // Overflow into any-division flex
  let menOverflow = 0;
  MENS_DIVISIONS.forEach(function(div) {
    menOverflow += Math.max(0, menCounts[div] - 2);
  });
  const flexUsed = menOverflow + Math.max(0, womenCount - 2);

  document.getElementById('myPickCount').textContent = myPickFighters.length;

  let html = '<div class="draft-slots">';

  MENS_DIVISIONS.forEach(function(div) {
    html += '<div class="draft-slots__row">';
    html += '<span class="draft-slots__label">' + escapeHtml(DIVISION_LABELS[div]) + '</span>';
    html += '<span class="draft-slots__pips">' + renderPips(Math.min(menCounts[div], 2), 2) + '</span>';
    html += '</div>';
  });

  html += '<div class="draft-slots__row">';
  html += '<span class="draft-slots__label">Women\'s Flex</span>';
  html += '<span class="draft-slots__pips">' + renderPips(Math.min(womenCount, 2), 2) + '</span>';
  html += '</div>';

  html += '<div class="draft-slots__row">';
  html += '<span class="draft-slots__label">Any-Division Flex</span>';
  html += '<span class="draft-slots__pips">' + renderPips(flexUsed, 2) + '</span>';
  html += '</div>';

  html += '</div>';

  // Drafted fighters in pick order — uses the lineup-roster-row look but compact
  html += '<div class="draft-my-picks">';
  if (myPickFighters.length === 0) {
    html += '<p class="draft-empty" style="padding: var(--space-4) 0">No picks yet.</p>';
  } else {
    myPickFighters.forEach(function(f, idx) {
      const rankLabel = f.is_champion ? 'C' : (f.current_rank ? '#' + f.current_rank : 'NR');
      const rankClass = f.is_champion ? 'rank-champion' : (f.current_rank ? 'rank-ranked' : 'rank-unranked');
      const divLabel  = DIVISION_LABELS[f.primary_division] || f.primary_division;
      const photoHtml = f.photo_url
        ? '<img class="lineup-roster-row__photo" src="' + escapeHtml(f.photo_url) + '" alt="' + escapeHtml(f.name) + '" onerror="this.style.display=\'none\'">'
        : '';
      html +=
        '<div class="lineup-roster-row draft-my-pick">' +
          '<span class="draft-my-pick__num">' + (idx + 1) + '</span>' +
          '<div class="lineup-roster-row__photo-wrap">' + photoHtml + '</div>' +
          '<span class="lineup-roster-row__rank ' + rankClass + '">' + rankLabel + '</span>' +
          '<div class="lineup-roster-row__info">' +
            '<button class="lineup-roster-row__name" data-open-fighter="' + f.id + '">' +
              escapeHtml(f.name) +
            '</button>' +
            '<span class="lineup-roster-row__division">' + escapeHtml(divLabel) + '</span>' +
          '</div>' +
        '</div>';
    });
  }
  html += '</div>';

  document.getElementById('myRoster').innerHTML = html;
}

// Returns the fighter objects for the current user's picks, in pick order
function getMyPickFighters() {
  return picks
    .filter(function(p) { return p.league_member_id === myMemberId; })
    .map(function(p) { return fighterMap[p.fighter_id]; })
    .filter(Boolean);
}

// Renders filled/empty dot indicators for a given slot category
function renderPips(filled, total) {
  let html = '';
  for (let i = 0; i < total; i++) {
    html += '<span class="pip ' + (i < filled ? 'pip-filled' : 'pip-empty') + '"></span>';
  }
  return html;
}

// ========================================================================
// POPULATE DIVISION FILTER DROPDOWN
// ========================================================================
function populateDivisionFilter() {
  const select = document.getElementById('divisionFilter');

  // Women's divisions first, then men's
  WOMENS_DIVISIONS.concat(MENS_DIVISIONS).forEach(function(div) {
    const opt = document.createElement('option');
    opt.value = div;
    opt.textContent = DIVISION_LABELS[div];
    select.appendChild(opt);
  });

  select.addEventListener('change', function() {
    divisionFilter = this.value;
    renderFighterPool();
  });

  document.getElementById('fighterSearch').addEventListener('input', function() {
    searchQuery = this.value.trim();
    renderFighterPool();
  });

  document.getElementById('statusFilter').addEventListener('change', function() {
    statusFilter = this.value;
    renderFighterPool();
  });

  document.getElementById('sortBy').addEventListener('change', function() {
    sortBy = this.value;
    renderFighterPool();
  });
}

// ========================================================================
// HELPERS
// ========================================================================
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

initDraft();
