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
let searchQuery = '';
let picking = false; // blocks a second pick while a request is in flight

// ========================================================================
// INIT
// Loads all required data in parallel, then renders and subscribes.
// ========================================================================
async function initDraft() {
  user = await requireAuth();
  if (!user) return;

  leagueId = new URLSearchParams(window.location.search).get('id');
  if (!leagueId) { window.location.href = 'my-leagues.html'; return; }

  // Set back link before data arrives so it's ready immediately
  document.getElementById('leagueLink').href = 'league.html?id=' + leagueId;

  // Load all four data sets at the same time to minimise wait
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
      .select('id, name, primary_division, current_rank, is_champion, record_wins, record_losses, record_draws')
      .order('is_champion', { ascending: false })
      .order('current_rank', { nullsFirst: false }),
    supabaseClient
      .from('rosters')
      .select('id, league_member_id, fighter_id, draft_pick, draft_round')
      .eq('league_id', leagueId)
      .order('draft_pick')
  ]);

  if (leagueRes.error || !leagueRes.data) {
    window.location.href = 'my-leagues.html';
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
  if (!myMember) { window.location.href = 'my-leagues.html'; return; }
  myMemberId = myMember.id;

  // Populate the division filter dropdown before first render
  populateDivisionFilter();

  // Render all three panels
  renderAll();

  // Subscribe to live pick events
  subscribeToRealtime();

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
  }
  // On success: Realtime fires handleNewPick, which re-renders everything
}

// ========================================================================
// REALTIME SUBSCRIPTION
// Listens for new rows inserted into the rosters table for this league.
// ========================================================================
function subscribeToRealtime() {
  supabaseClient
    .channel('draft_room_' + leagueId)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'rosters',
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
    turnInfoEl.innerHTML = '<span class="turn-complete">Draft Complete!</span>';
    pickCounterEl.textContent = '';
    return;
  }

  const { round, activeManagerId } = getPickInfo(currentPickNum);
  const activeMember = memberMap[activeManagerId];
  const teamName = activeMember ? activeMember.team_name : '?';

  if (activeManagerId === myMemberId) {
    turnInfoEl.innerHTML = '<span class="turn-mine">Your pick!</span>  Round ' + round;
  } else {
    turnInfoEl.textContent = escapeHtml(teamName) + "'s pick  —  Round " + round;
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

  // Apply name search
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    fighters = fighters.filter(function(f) { return f.name.toLowerCase().includes(q); });
  }

  const poolEl = document.getElementById('fighterPool');

  if (fighters.length === 0) {
    poolEl.innerHTML = '<p class="draft-empty">No fighters match your filters.</p>';
    return;
  }

  let html = '<table class="fighter-pool-table"><thead><tr>';
  html += '<th>Rnk</th><th>Name</th><th>Division</th><th>Rec</th>';
  html += '</tr></thead><tbody>';

  fighters.forEach(function(f) {
    const valid       = myTurn && canPick(f, myPickFighters);
    const rankDisplay = f.is_champion ? 'C' : (f.current_rank ? '#' + f.current_rank : '-');
    const divLabel    = DIVISION_LABELS[f.primary_division] || f.primary_division;
    const record      = f.record_wins + '-' + f.record_losses + '-' + f.record_draws;

    let rowClass, titleAttr = '';
    if (myTurn && valid) {
      rowClass = 'row-pickable';
    } else if (myTurn && !valid) {
      rowClass = 'row-invalid';
      titleAttr = ' title="No valid roster slot available for this fighter"';
    } else {
      rowClass = 'row-watching';
    }

    // Only add the data attribute on rows the user can actually click
    const dataAttr = (myTurn && valid) ? ' data-fighter-id="' + f.id + '"' : '';

    html += '<tr class="' + rowClass + '"' + dataAttr + titleAttr + '>';
    html += '<td>' + escapeHtml(rankDisplay) + '</td>';
    html += '<td>' + escapeHtml(f.name) + '</td>';
    html += '<td>' + escapeHtml(divLabel) + '</td>';
    html += '<td>' + record + '</td>';
    html += '</tr>';
  });

  html += '</tbody></table>';
  poolEl.innerHTML = html;

  // Wire click handlers only when it is the user's turn
  if (myTurn) {
    poolEl.querySelectorAll('tr[data-fighter-id]').forEach(function(row) {
      row.addEventListener('click', function() {
        const fighter = fighterMap[row.getAttribute('data-fighter-id')];
        if (fighter) makePick(fighter);
      });
    });
  }
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

  // Pre-build a pick_number -> fighter name map for fast cell lookup
  const pickMap = {};
  picks.forEach(function(p) {
    const fighter = fighterMap[p.fighter_id];
    pickMap[p.draft_pick] = fighter ? fighter.name : '?';
  });

  let html = '<div class="board-scroll"><table class="draft-board-table"><thead><tr>';
  html += '<th class="round-label-th">Rd</th>';

  league.draft_order.forEach(function(memberId) {
    const member = memberMap[memberId];
    const isMe   = memberId === myMemberId;
    html += '<th' + (isMe ? ' class="col-mine"' : '') + '>';
    html += escapeHtml(member ? member.team_name : '?');
    html += '</th>';
  });
  html += '</tr></thead><tbody>';

  for (let round = 1; round <= totalRounds; round++) {
    html += '<tr><td class="round-num">' + round + '</td>';

    for (let managerIdx = 0; managerIdx < n; managerIdx++) {
      // Map (round, managerIdx) to the absolute pick number.
      // Odd rounds read left-to-right; even rounds read right-to-left.
      const pickNum = round % 2 === 1
        ? (round - 1) * n + managerIdx + 1
        : (round - 1) * n + (n - managerIdx);

      const memberId  = league.draft_order[managerIdx];
      const isMe      = memberId === myMemberId;
      const isCurrent = pickNum === currentPickNum && picks.length < totalPicks;
      const colClass  = isMe ? ' col-mine' : '';

      if (pickMap[pickNum]) {
        html += '<td class="pick-made' + colClass + '">' + escapeHtml(pickMap[pickNum]) + '</td>';
      } else if (isCurrent) {
        html += '<td class="pick-current' + colClass + '">&#9658;</td>';
      } else {
        html += '<td class="pick-empty' + colClass + '"></td>';
      }
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

  let html = '<div class="slot-grid">';

  MENS_DIVISIONS.forEach(function(div) {
    html += '<div class="slot-row">';
    html += '<span class="slot-label">' + escapeHtml(DIVISION_LABELS[div]) + '</span>';
    html += '<span class="slot-pips">' + renderPips(Math.min(menCounts[div], 2), 2) + '</span>';
    html += '</div>';
  });

  html += '<div class="slot-row">';
  html += '<span class="slot-label">Women\'s Flex</span>';
  html += '<span class="slot-pips">' + renderPips(Math.min(womenCount, 2), 2) + '</span>';
  html += '</div>';

  html += '<div class="slot-row">';
  html += '<span class="slot-label">Any-Div Flex</span>';
  html += '<span class="slot-pips">' + renderPips(flexUsed, 2) + '</span>';
  html += '</div>';

  html += '</div>';

  // List of drafted fighters in pick order
  html += '<div class="my-picks-list">';
  if (myPickFighters.length === 0) {
    html += '<p class="draft-empty">No picks yet.</p>';
  } else {
    myPickFighters.forEach(function(f) {
      html += '<div class="my-pick-row">';
      html += '<span class="my-pick-name">' + escapeHtml(f.name) + '</span>';
      html += '<span class="my-pick-div">' + escapeHtml(DIVISION_LABELS[f.primary_division] || f.primary_division) + '</span>';
      html += '</div>';
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
