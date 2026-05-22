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
// All 11 weight classes in display order — every one gets its own slot
// under the current construction rules.
const ALL_DRAFT_DIVISIONS = MENS_DIVISIONS.concat(WOMENS_DIVISIONS);

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

// CSS custom-property names for each division's accent color. Defined in
// tokens.css. Looked up at render time and applied as an inline style on
// the row so we don't have to fan out 11 selectors in the stylesheet.
const DIVISION_COLOR_VAR = {
  strawweight:        '--div-strawweight',
  flyweight_w:        '--div-flyweight-w',
  bantamweight_w:     '--div-bantamweight-w',
  flyweight:          '--div-flyweight',
  bantamweight:       '--div-bantamweight',
  featherweight:      '--div-featherweight',
  lightweight:        '--div-lightweight',
  welterweight:       '--div-welterweight',
  middleweight:       '--div-middleweight',
  light_heavyweight:  '--div-light_heavyweight',
  heavyweight:        '--div-heavyweight'
};

// Returns the var(--div-…) reference for a fighter's primary_division.
// Falls back to a neutral border color so unknown divisions never break the row.
function divisionColor(primaryDivision) {
  const cssVar = DIVISION_COLOR_VAR[primaryDivision];
  return cssVar ? 'var(' + cssVar + ')' : 'var(--border-strong)';
}

// ========================================================================
// TEAM ACCENT COLORS
// Up to 8 managers per league, each gets a deterministic palette slot
// (tokens.css var(--team-1) through var(--team-8)). Assignment is by
// position in league.draft_order so it stays stable across re-renders.
// ========================================================================
function teamColor(memberId) {
  if (!league || !league.draft_order) return 'var(--border-strong)';
  const idx = league.draft_order.indexOf(memberId);
  if (idx < 0) return 'var(--border-strong)';
  // 1-indexed to match the token names; modulo so 9th+ wrap (shouldn't happen
  // at 8-manager cap, but defensive).
  return 'var(--team-' + ((idx % 8) + 1) + ')';
}

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
let pickTimerInterval = null; // setInterval handle for the countdown

// Personal pre-draft queue — array of { fighter_id, position } sorted by
// position ascending. Auto-cleaned by a Postgres trigger when a fighter
// is drafted; we mirror that with a realtime subscription so the local
// state stays in sync without a manual refetch.
let queue = [];

// Pick-clock fallback anchor. Set to Date.now() whenever a new pick lands
// (locally via makePick or remotely via handleNewPick). Used as a backup
// when the latest pick's server-side created_at isn't available — e.g. the
// draft_picks schema doesn't have a created_at column, or the realtime
// payload arrived without one. Without this, the timer would freeze on
// the previous anchor and never reset between picks.
let pickClockResetAt = null;

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
      .select('id, name, draft_order, draft_started, draft_completed, draft_started_at, draft_scheduled_at, draft_paused_at, commissioner_id, roster_size, max_managers, pick_timer_seconds')
      .eq('id', leagueId)
      .single(),
    supabaseClient
      .from('league_members')
      .select('id, user_id, team_name, is_commissioner')
      .eq('league_id', leagueId),
    supabaseClient
      .from('fighters')
      .select('id, name, primary_division, current_rank, is_champion, is_sub_champion, sub_title_type, record_wins, record_losses, record_draws, photo_url')
      .order('is_champion', { ascending: false })
      .order('current_rank', { nullsFirst: false }),
    supabaseClient
      .from('draft_picks')
      .select('*')
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

  // Build the member-id lookup map up front; the lobby and live-draft views
  // both need it (lobby uses it to label the draft order list).
  memberMap = {};
  members.forEach(function(m) { memberMap[m.id] = m; });

  // Verify the current user is a member of this league before showing
  // anything (lobby or live). RLS on league_members already gates this on
  // the server, but the client check gives a cleaner UX (redirect vs error).
  const myMember = members.find(function(m) { return m.user_id === user.id; });
  if (!myMember) { window.location.href = 'dashboard.html'; return; }
  myMemberId = myMember.id;

  // No live draft AND no schedule → nothing to render here, bounce back.
  if (!league.draft_started && !league.draft_scheduled_at) {
    window.location.href = 'league.html?id=' + leagueId;
    return;
  }

  // Both pre-draft (scheduled) and live-draft states share the same panels:
  // the fighter pool, the draft board (with empty slots pre-draft), and the
  // user's queue + roster. The only differences are (a) the status bar
  // header text, (b) whether picks can actually be made, and (c) whether
  // we listen for incoming picks vs the start flip.
  fighterMap = {};
  allFighters.forEach(function(f) { fighterMap[f.id] = f; });

  // Populate the division filter dropdown before first render
  populateDivisionFilter();

  // Load the user's draft queue (private — RLS limits this to their own rows).
  // Awaited so the first render shows the queue panel populated.
  await loadQueue();

  // Render all three panels. Pre-draft this still works: the board shows
  // empty slots labelled with manager names, the fighter pool shows every
  // fighter as available (no picks yet), and My Roster is empty.
  renderAll();

  // Pre-draft we only watch the leagues row (for the start flip + schedule
  // changes) and the personal queue. Live draft additionally subscribes to
  // incoming picks. Splitting these means we don't open a picks channel
  // for nothing during the lobby phase.
  subscribeToQueue();
  if (league.draft_started) {
    subscribeToRealtime();
    // Watch the leagues row in live draft too, so all clients see pause /
    // resume / commish-revert state changes in real time. (Pre-draft uses
    // subscribeToLobbyFlip for the start flip.)
    subscribeToLeagueChanges();
  } else {
    subscribeToLobbyFlip();
    startPredraftCountdown();
  }

  // Commissioner-only toolbar: reveal the Pause / Undo / Clear buttons if
  // the viewer is the commish (primary or co-) and the draft has actually
  // started. Pre-draft these actions don't make sense (nothing to pause /
  // undo / clear yet).
  if (league.draft_started && isCommish()) {
    initCommishTools();
  }

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

  // Same pattern for team-roster headers — clicking any column header on
  // the draft board opens that team's roster in the whole-roster modal.
  document.addEventListener('click', function(e) {
    var trigger = e.target.closest('[data-open-team-roster]');
    if (!trigger) return;
    showWholeRosterModal(trigger.getAttribute('data-open-team-roster'));
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
    if (!league.draft_started) {
      alert("The draft hasn't started yet.");
      return;
    }
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

  // Whole Roster button — opens the sectioned roster modal
  var viewWholeRosterBtn = document.getElementById('viewWholeRosterBtn');
  if (viewWholeRosterBtn) viewWholeRosterBtn.addEventListener('click', showWholeRosterModal);

  // Reveal the page now that everything is ready
  // Clear the inline display:none so CSS's display:flex takes over.
  // Setting 'block' instead would override the flex container and cause
  // .draft-room (flex:1 1 0) to fall back to content-height — which makes
  // the bottom panels collapse to 0 because the board's tall table
  // pushes the room past 100vh.
  document.getElementById('pageContent').style.display = '';
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
//   - ROSTER_SLOTS_PER_DIVISION slot(s) per weight class (8 men + 3 women)
//   - ROSTER_FLEX_SLOTS any-division flex slots (overflow from any class)
//   - Defaults today: 1 per class + 6 flex = 17 fighters per roster
// ========================================================================
function canPick(fighter, currentPickFighters) {
  const divCounts = {};
  currentPickFighters.forEach(function(f) {
    divCounts[f.primary_division] = (divCounts[f.primary_division] || 0) + 1;
  });

  // Tally how many fighters have already overflowed into any-flex slots
  let flexUsed = 0;
  Object.keys(divCounts).forEach(function(div) {
    flexUsed += Math.max(0, divCounts[div] - ROSTER_SLOTS_PER_DIVISION);
  });

  // Pickable if either this division still has room OR the flex bucket does
  const divHasRoom  = (divCounts[fighter.primary_division] || 0) < ROSTER_SLOTS_PER_DIVISION;
  const flexHasRoom = flexUsed < ROSTER_FLEX_SLOTS;
  return divHasRoom || flexHasRoom;
}

// ========================================================================
// MAKE A PICK
// Inserts the pick into the rosters table. The Realtime event fires and
// updates all connected clients including the picker's own screen.
// ========================================================================
async function makePick(fighter) {
  if (!isMyTurn() || picking) return;

  // Picks are blocked while the commissioner has paused the draft.
  // Surface this so the user gets feedback instead of a silent no-op.
  if (league.draft_paused_at) {
    alert('The draft is paused. Wait for the commissioner to resume.');
    return;
  }

  const myPickFighters = getMyPickFighters();
  if (!canPick(fighter, myPickFighters)) return;

  // Lock immediately to prevent double-pick while the INSERT is in flight
  picking = true;
  renderFighterPool();

  // Safety net: handleNewPick is what's normally responsible for releasing
  // the lock (it fires off the realtime draft_picks INSERT). If realtime
  // hiccups — channel drops, RLS blocks the select-back, trigger fails —
  // the lock would stay true forever and EVERY future pick attempt would
  // silently bail with no error. After 5s, refetch picks from the DB and
  // resync. If our pick is in there, accept it. If not, release the lock
  // so the user can try again.
  const safetyTimeout = setTimeout(async function() {
    if (!picking) return;  // already cleared by handleNewPick — nothing to do
    console.warn('[draft] pick lock held >5s, resyncing from DB');
    const { data: freshPicks } = await supabaseClient
      .from('draft_picks')
      .select('*')
      .eq('league_id', leagueId)
      .order('draft_pick');
    if (freshPicks) picks = freshPicks;
    picking = false;
    renderAll();
  }, 5000);

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
    clearTimeout(safetyTimeout);
    console.error('Pick failed:', error.message);
    picking = false;

    // Resync from the DB. We use SELECT * so this works regardless of which
    // optional columns the draft_picks table happens to have — earlier we
    // hit 400s by SELECT-ing a column that didn't exist in this league's
    // schema. The renderers only need a few fields (id, fighter_id,
    // league_member_id, draft_pick, draft_round) and ignore the rest.
    const { data: freshPicks } = await supabaseClient
      .from('draft_picks')
      .select('*')
      .eq('league_id', leagueId)
      .order('draft_pick');
    if (freshPicks) picks = freshPicks;

    // Specifically catch the unique-slot violation. This means our local
    // state was stale: someone (probably us, on an earlier attempt where
    // realtime didn't deliver) already picked at this slot. Tell the user
    // what happened so they don't keep clicking the same fighter.
    if (error.code === '23505' || /duplicate key/i.test(error.message)) {
      alert('That pick slot was already taken. The board has been resynced — try again.');
    } else {
      alert('Pick failed: ' + error.message);
    }
    renderAll();
    return;
  }

  // Don't wait for realtime to confirm our own pick — resync from the DB
  // immediately so the board updates right away. Realtime is still the
  // mechanism by which OTHER managers learn about this pick; for the
  // picker themselves it's just a backup. The safety timeout is now
  // mostly a no-op for the picker (we'll have already cleared the lock
  // before it fires), but stays in place for the rare case where this
  // post-insert refetch also fails. Using SELECT * here for the same
  // schema-tolerance reason as the error branch above.
  clearTimeout(safetyTimeout);
  const { data: freshPicks } = await supabaseClient
    .from('draft_picks')
    .select('*')
    .eq('league_id', leagueId)
    .order('draft_pick');
  if (freshPicks) picks = freshPicks;
  // Local pick-clock anchor — the timer should restart on every pick.
  pickClockResetAt = Date.now();
  picking = false;
  renderAll();

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

  if (picks.length >= getTotalPicks()) handleDraftComplete();
}

// ========================================================================
// REALTIME SUBSCRIPTION
// Listens for new rows inserted into the rosters table for this league.
// ========================================================================
function subscribeToRealtime() {
  // Listen on draft_picks (immutable record), not rosters. The trigger
  // sync_draft_pick_trigger inserts into draft_picks whenever a roster
  // row lands with draft metadata, so this fires once per pick.
  // We listen on '*' (INSERT/UPDATE/DELETE) so the commissioner's "Undo
  // last pick" action — which deletes a draft_picks row — propagates to
  // every client too.
  supabaseClient
    .channel('draft_room_' + leagueId)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'draft_picks',
      filter: 'league_id=eq.' + leagueId
    }, function(payload) {
      if (payload.eventType === 'INSERT')      handleNewPick(payload);
      else if (payload.eventType === 'DELETE') handlePickDelete(payload);
    })
    .subscribe();
}

// Removes a deleted pick from local state and re-renders. Triggered by
// the commissioner's Undo Last Pick action via the leagues realtime
// channel above.
function handlePickDelete(payload) {
  const oldPick = payload.old;
  if (!oldPick || !oldPick.id) return;
  picks = picks.filter(function(p) { return p.id !== oldPick.id; });
  // Treat the undo as a fresh anchor for the now-active pick so the timer
  // restarts from full duration for whoever's back on the clock.
  pickClockResetAt = Date.now();
  // Releasing the lock matters here too: if we were the one who just
  // picked and our pick got reverted, we want to be able to pick again.
  picking = false;
  renderAll();
}

function handleNewPick(payload) {
  const newPick = payload.new;

  // Guard against duplicate events (Realtime can occasionally fire twice)
  if (picks.find(function(p) { return p.id === newPick.id; })) return;

  picks.push(newPick);
  // Keep sorted by pick number so getCurrentPickNum() stays correct
  picks.sort(function(a, b) { return a.draft_pick - b.draft_pick; });

  // Stamp the local pick-clock anchor so the timer resets even when the
  // payload's created_at is missing or stale.
  pickClockResetAt = Date.now();

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
  renderQueue();
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

  // Personal turn banner — separate concern, but always re-rendered with
  // the rest of the header so it stays in sync.
  renderDraftBanner();
  // The banner can change height (it's hidden when paused/completed,
  // larger when "your pick", smaller for "up in N picks"). Resync the
  // room height so the bottom panels reclaim the difference.
  if (typeof window.syncDraftRoomHeight === 'function') {
    window.syncDraftRoomHeight();
  }

  // Pre-draft: show a live countdown + the absolute scheduled time. The
  // <span class="draft-status__pre"> is the target the predraft countdown
  // interval updates every second; we re-render the surrounding markup
  // only when renderHeader runs (initial load + lobby state changes).
  if (!league.draft_started && league.draft_scheduled_at) {
    turnInfoEl.innerHTML =
      '<span class="draft-status__pre">' + escapeHtml(formatCountdown(league.draft_scheduled_at)) + '</span>' +
      ' · Draft starts ' + escapeHtml(formatScheduledLocal(league.draft_scheduled_at));
    pickCounterEl.textContent = '0 / ' + totalPicks + ' picks';
    stopPickTimer();
    return;
  }

  if (league.draft_completed || picks.length >= totalPicks) {
    turnInfoEl.innerHTML = '<span class="draft-status__complete">Draft Complete</span>';
    pickCounterEl.textContent = '';
    stopPickTimer();
    return;
  }

  // Paused state takes precedence over the turn indicator. Freeze the
  // pick clock too so it doesn't keep ticking down toward zero while
  // the commissioner has stopped the world.
  if (league.draft_paused_at) {
    const { round: pausedRound, activeManagerId: pausedActive } = getPickInfo(currentPickNum);
    const pausedMember = memberMap[pausedActive];
    const pausedTeam   = pausedMember ? pausedMember.team_name : '?';
    turnInfoEl.innerHTML =
      '<span class="draft-status__paused">Draft Paused</span> · ' +
      escapeHtml(pausedTeam) + ' is on the clock · Round ' + pausedRound;
    pickCounterEl.textContent = 'Pick ' + currentPickNum + ' of ' + totalPicks;
    stopPickTimer();
    const valueEl     = document.getElementById('draftTimerValue');
    const containerEl = document.getElementById('draftTimer');
    if (valueEl)     valueEl.textContent = 'PAUSED';
    if (containerEl) containerEl.hidden  = false;
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

  // Restart the pick clock anchored to the current pick's start time.
  startPickTimer();
}

// ========================================================================
// PERSONAL TURN BANNER
// Tall crimson "YOU'RE ON THE CLOCK" when it's the viewer's pick; subtler
// "Up in N picks" indicator otherwise. Hidden during pre-draft (the status
// strip handles the countdown), completion, and pause (the status strip
// shows the paused state).
// ========================================================================
function renderDraftBanner() {
  const bannerEl = document.getElementById('draftBanner');
  const textEl   = document.getElementById('draftBannerText');
  if (!bannerEl || !textEl) return;

  // Hide for any state where a turn-aware banner would be misleading.
  if (!league.draft_started ||
      league.draft_completed ||
      league.draft_paused_at ||
      picks.length >= getTotalPicks()) {
    bannerEl.hidden = true;
    return;
  }

  bannerEl.hidden = false;
  bannerEl.classList.remove('draft-banner--mine', 'draft-banner--waiting', 'draft-banner--ondeck', 'draft-banner--done');

  const picksUntil = picksUntilMyTurn();
  if (picksUntil === 0) {
    // It's the viewer's pick.
    bannerEl.classList.add('draft-banner--mine');
    textEl.textContent = "You're on the clock";
  } else if (picksUntil === -1) {
    // Viewer has no more picks (somehow they ran out before the draft did).
    bannerEl.classList.add('draft-banner--done');
    textEl.textContent = 'You have no more picks';
  } else if (picksUntil === 1) {
    // On deck — call this out a bit louder than the generic "up in N".
    bannerEl.classList.add('draft-banner--ondeck');
    textEl.textContent = 'On deck — you pick next';
  } else {
    bannerEl.classList.add('draft-banner--waiting');
    textEl.textContent = 'Up in ' + picksUntil + ' picks';
  }
}

// Returns the number of picks between now and the viewer's next pick.
// 0 means it's their turn right now. -1 means they have no more picks
// remaining in the draft.
function picksUntilMyTurn() {
  const total   = getTotalPicks();
  const current = getCurrentPickNum();
  for (let p = current; p <= total; p++) {
    if (getPickInfo(p).activeManagerId === myMemberId) {
      return p - current;
    }
  }
  return -1;
}

// ========================================================================
// PICK TIMER
// Counts down from league.pick_timer_seconds, anchored server-side to:
//   * The previous pick's created_at (for picks 2..N)
//   * league.draft_started_at      (for pick 1)
// All clients see the same remaining time (modulo clock skew). The timer
// is informational in v1 — we don't auto-pick on expiry; that's a follow-up.
// ========================================================================

// Returns when the active pick clock started (Date), or null if we can't
// determine — in which case the timer hides itself.
function getActivePickStartedAt() {
  if (picks.length === 0) {
    return league.draft_started_at ? new Date(league.draft_started_at) : null;
  }
  // Sorted by draft_pick asc; the last element is the most recent pick.
  const last = picks[picks.length - 1];
  // Prefer the server-side created_at (consistent across all clients) when
  // present, and fall back to the local reset anchor (updated whenever
  // picks change) so the timer resets even if created_at is missing.
  if (last && last.created_at) return new Date(last.created_at);
  if (pickClockResetAt)        return new Date(pickClockResetAt);
  return league.draft_started_at ? new Date(league.draft_started_at) : null;
}

function startPickTimer() {
  stopPickTimer();
  const containerEl = document.getElementById('draftTimer');
  const valueEl     = document.getElementById('draftTimerValue');
  if (!containerEl || !valueEl) return;

  // No anchor → hide the timer entirely (e.g., legacy league with no
  // draft_started_at and no picks yet).
  const started = getActivePickStartedAt();
  if (!started) { containerEl.hidden = true; return; }

  const totalSec = league.pick_timer_seconds || 90;
  containerEl.hidden = false;

  function tick() {
    const elapsedSec = (Date.now() - started.getTime()) / 1000;
    const remaining  = Math.max(0, Math.ceil(totalSec - elapsedSec));

    valueEl.textContent = formatMmSs(remaining);

    // Color states — gold/yellow at 30s, crimson at 10s, "EXPIRED" at 0.
    containerEl.classList.remove('draft-timer--low', 'draft-timer--critical', 'draft-timer--expired');
    if (remaining === 0)        containerEl.classList.add('draft-timer--expired');
    else if (remaining <= 10)   containerEl.classList.add('draft-timer--critical');
    else if (remaining <= 30)   containerEl.classList.add('draft-timer--low');

    // Once expired we leave the badge showing 0:00 and stop ticking.
    // Auto-pick is intentionally not implemented here — that's a separate
    // follow-up that needs roster-construction validation + write race
    // handling.
    if (remaining === 0) stopPickTimer();
  }

  tick(); // paint immediately so users don't see "--" for a second
  pickTimerInterval = setInterval(tick, 1000);
}

function stopPickTimer() {
  if (pickTimerInterval) {
    clearInterval(pickTimerInterval);
    pickTimerInterval = null;
  }
}

function formatMmSs(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
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
    const subBadge    = f.is_sub_champion && f.sub_title_type === 'interim'
                          ? '<span class="subrank-badge subrank-interim">INT</span>'
                        : f.is_sub_champion && f.sub_title_type === 'bmf'
                          ? '<span class="subrank-badge subrank-bmf">BMF</span>'
                          : '';
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

    // Queue toggle — shown next to the pick button regardless of whose
    // turn it is. If already queued, the button reads "Queued ✕" and
    // removes; otherwise "+ Queue" adds.
    const inQueue = isQueued(f.id);
    const queueBtnLabel = inQueue ? 'Queued &#x2715;' : '+ Queue';
    const queueBtnClass = inQueue
      ? 'btn-ghost lineup-row-btn draft-queue-btn draft-queue-btn--queued'
      : 'btn-ghost lineup-row-btn draft-queue-btn';
    const queueBtn = '<button class="' + queueBtnClass + '" data-queue-fighter-id="' + f.id + '">' +
                       queueBtnLabel +
                     '</button>';

    // Inline --div-accent on the row so the row's left-border and division
    // label can pull from a single variable — keeps the styling DRY despite
    // having 11 different division colors.
    const divAccent = divisionColor(f.primary_division);

    html +=
      '<div class="lineup-roster-row draft-pool-row--divcolor' + rowMods + '" style="--div-accent: ' + divAccent + '"' + titleAttr + '>' +
        '<div class="lineup-roster-row__photo-wrap">' + photoHtml + '</div>' +
        '<span class="lineup-roster-row__rank ' + rankClass + '">' + escapeHtml(rankLabel) + (typeof subBadge === 'string' ? subBadge : '') + '</span>' +
        '<div class="lineup-roster-row__info">' +
          '<button class="lineup-roster-row__name" data-open-fighter="' + f.id + '">' +
            escapeHtml(f.name) +
          '</button>' +
          '<span class="lineup-roster-row__division draft-pool-row__division">' + escapeHtml(divLabel) + '</span>' +
        '</div>' +
        '<span class="lineup-roster-row__record">' + record + '</span>' +
        queueBtn +
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

  // Wire queue toggle buttons. Same fighter id either adds or removes
  // depending on whether it's already in the local queue cache.
  poolEl.querySelectorAll('.draft-queue-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const fighterId = btn.getAttribute('data-queue-fighter-id');
      if (isQueued(fighterId)) removeFromQueue(fighterId);
      else                     addToQueue(fighterId);
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
    var subBadge  = f.is_sub_champion && f.sub_title_type === 'interim'
                      ? '<span class="subrank-badge subrank-interim">INT</span>'
                    : f.is_sub_champion && f.sub_title_type === 'bmf'
                      ? '<span class="subrank-badge subrank-bmf">BMF</span>'
                      : '';
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
        '<span class="lineup-roster-row__rank ' + rankClass + '">' + rankLabel + (typeof subBadge === 'string' ? subBadge : '') + '</span>' +
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

  // Preserve the user's scroll position across re-renders. Without this,
  // every realtime pick would yank the board back to the top — frustrating
  // when the user had scrolled down to round 12 to see future picks.
  const boardEl = document.getElementById('draftBoard');
  const oldScrollContainer = boardEl ? boardEl.querySelector('.draft-board') : null;
  const savedScrollTop  = oldScrollContainer ? oldScrollContainer.scrollTop  : 0;
  const savedScrollLeft = oldScrollContainer ? oldScrollContainer.scrollLeft : 0;

  // Pre-build a pick_number -> fighter_id map. Cells render the fighter's
  // name (looked up via fighterMap) and expose data-open-fighter so the
  // delegated click handler opens the fighter modal.
  const pickMap = {};
  picks.forEach(function(p) {
    pickMap[p.draft_pick] = p.fighter_id;
  });

  // Draft board rebuilt as a Sleeper-style grid:
  //   * Manager team names along the top (column headers)
  //   * Each cell is a card with a photo, name, and division/rank meta
  //   * Pick number ("1.1", "2.5"...) lives in the top-right corner
  //   * Tier classes color-tint the background subtly: champion / top5 /
  //     top15 / unranked, so the board reads as "value chart" at a glance
  //   * The whole cell is clickable when a pick has been made (opens the
  //     fighter modal via the existing data-open-fighter delegate)
  let html = '<div class="draft-board"><table class="draft-board__table"><thead><tr>';

  league.draft_order.forEach(function(memberId) {
    const member = memberMap[memberId];
    const isMe   = memberId === myMemberId;
    // Inline --team-accent on the header cell so all descendants (the
    // header's bottom border, the column's pick cells via CSS inheritance)
    // can reference the same color via var(--team-accent).
    const accent = teamColor(memberId);
    // data-open-team-roster makes the header clickable; the document-level
    // delegated handler in initDraft opens the per-team roster modal.
    html += '<th class="draft-board__col-header' + (isMe ? ' draft-board__col-header--mine' : '') +
            '" style="--team-accent: ' + accent + '"' +
            ' data-open-team-roster="' + escapeHtml(memberId) + '"' +
            ' title="View this team\'s roster">';
    html += escapeHtml(member ? member.team_name : '?');
    html += '</th>';
  });
  html += '</tr></thead><tbody>';

  for (let round = 1; round <= totalRounds; round++) {
    html += '<tr>';

    for (let managerIdx = 0; managerIdx < n; managerIdx++) {
      // Map (round, managerIdx) to the absolute pick number.
      // Odd rounds read left-to-right; even rounds read right-to-left.
      const pickNum = round % 2 === 1
        ? (round - 1) * n + managerIdx + 1
        : (round - 1) * n + (n - managerIdx);

      const memberId  = league.draft_order[managerIdx];
      const isMe      = memberId === myMemberId;
      // No "on the clock" highlight pre-draft — the cell at pick #1 isn't
      // an active pick yet, just the slot for whoever drafts first when it
      // starts.
      const isCurrent = league.draft_started && pickNum === currentPickNum && picks.length < totalPicks;
      const positionInRound = ((pickNum - 1) % n) + 1;

      // Determine tier (only relevant for made picks; influences cell tint)
      let tierClass = '';
      const fighter = pickMap[pickNum] ? fighterMap[pickMap[pickNum]] : null;
      if (fighter) {
        if (fighter.is_champion)                                tierClass = ' draft-board__cell--champion';
        else if (fighter.current_rank && fighter.current_rank <= 5)  tierClass = ' draft-board__cell--top5';
        else if (fighter.current_rank && fighter.current_rank <= 15) tierClass = ' draft-board__cell--top15';
        else                                                          tierClass = ' draft-board__cell--unranked';
      }

      let cellClass = 'draft-board__cell';
      if (isMe)             cellClass += ' draft-board__cell--mine';
      if (pickMap[pickNum]) cellClass += ' draft-board__cell--made' + tierClass;
      else if (isCurrent)   cellClass += ' draft-board__cell--current';
      else                  cellClass += ' draft-board__cell--empty';

      // Each cell carries two custom properties:
      //   --team-accent : the column's team color (used by empty cells so
      //                   the column reads as a colored vertical band)
      //   --div-accent  : the picked fighter's weight-class color (used by
      //                   cells with picks so each card pops by division)
      // CSS picks --div-accent when set, falls back to --team-accent for
      // empty cells so columns stay traceable end-to-end.
      const cellAccent = teamColor(memberId);
      let cellStyle = '--team-accent: ' + cellAccent;
      if (fighter) {
        cellStyle += '; --div-accent: ' + divisionColor(fighter.primary_division);
      }
      html += '<td class="' + cellClass + '" style="' + cellStyle + '">';
      // "round.position" label in the top-right of every cell. Snake-aware:
      // round 2 reads 2.1, 2.2, ... right-to-left, matching pick order.
      // Suppressed on the on-the-clock cell so it doesn't compete visually
      // with the "On the clock" label.
      if (!isCurrent) {
        html += '<span class="draft-board__pick-num">' + round + '.' + positionInRound + '</span>';
      }

      // Snake-order arrow in the gutter pointing at the next pick. In odd
      // rounds picks flow left→right (→); even rounds flow right→left (←);
      // at the end of every round the snake turns (↓). The final pick gets
      // no arrow since there's nothing after it.
      if (pickNum < totalPicks) {
        const lastInRound = positionInRound === n;
        let arrowDir;
        if (lastInRound)         arrowDir = 'down';
        else if (round % 2 === 1) arrowDir = 'right';
        else                      arrowDir = 'left';
        const arrowGlyph = arrowDir === 'right' ? '&rarr;'
                         : arrowDir === 'left'  ? '&larr;'
                         :                        '&darr;';
        html += '<span class="draft-board__arrow draft-board__arrow--' + arrowDir +
                '" aria-hidden="true">' + arrowGlyph + '</span>';
      }

      if (fighter) {
        const divLabel  = DIVISION_LABELS[fighter.primary_division] || fighter.primary_division;
        const rankLabel = fighter.is_champion
          ? 'Champion'
          : (fighter.current_rank ? '#' + fighter.current_rank : 'Unranked');
        const photoHtml = fighter.photo_url
          ? '<img class="draft-board__cell-photo" src="' + escapeHtml(fighter.photo_url) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
          : '<div class="draft-board__cell-photo draft-board__cell-photo--placeholder"></div>';

        html +=
          '<button class="draft-board__pick" data-open-fighter="' + pickMap[pickNum] + '">' +
            photoHtml +
            '<div class="draft-board__pick-info">' +
              '<span class="draft-board__pick-name">' + escapeHtml(fighter.name) + '</span>' +
              '<span class="draft-board__pick-meta">' + escapeHtml(divLabel) + ' · ' + rankLabel + '</span>' +
            '</div>' +
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

  // Restore the saved scroll position on the freshly-injected .draft-board
  // container. We re-query because the previous element was replaced.
  const newScrollContainer = document.getElementById('draftBoard').querySelector('.draft-board');
  if (newScrollContainer) {
    newScrollContainer.scrollTop  = savedScrollTop;
    newScrollContainer.scrollLeft = savedScrollLeft;
  }
}

// ========================================================================
// RENDER MY ROSTER
// Slot progress indicators (pip dots) + list of drafted fighters.
// ========================================================================
function renderMyRoster() {
  const myPickFighters = getMyPickFighters();

  // Group fighters into the slot category they'd actually occupy. Each
  // weight class holds up to ROSTER_SLOTS_PER_DIVISION; overflow goes to
  // the Any-Division Flex bucket (up to ROSTER_FLEX_SLOTS).
  const inDiv = {};
  ALL_DRAFT_DIVISIONS.forEach(function(d) { inDiv[d] = []; });
  const anyFlex = [];

  myPickFighters.forEach(function(f) {
    if (inDiv[f.primary_division] && inDiv[f.primary_division].length < ROSTER_SLOTS_PER_DIVISION) {
      inDiv[f.primary_division].push(f);
    } else if (inDiv[f.primary_division] !== undefined) {
      anyFlex.push(f);
    }
  });

  document.getElementById('myPickCount').textContent = myPickFighters.length;

  let html = '<div class="draft-slots">';

  ALL_DRAFT_DIVISIONS.forEach(function(div) {
    html += '<div class="draft-slots__row">';
    html += '<span class="draft-slots__label">' + escapeHtml(DIVISION_LABELS[div]) + '</span>';
    html += '<span class="draft-slots__pips">' + renderPips(inDiv[div], ROSTER_SLOTS_PER_DIVISION) + '</span>';
    html += '</div>';
  });

  html += '<div class="draft-slots__row">';
  html += '<span class="draft-slots__label">Any-Division Flex</span>';
  html += '<span class="draft-slots__pips">' + renderPips(anyFlex.slice(0, ROSTER_FLEX_SLOTS), ROSTER_FLEX_SLOTS) + '</span>';
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
      const subBadge  = f.is_sub_champion && f.sub_title_type === 'interim'
                          ? '<span class="subrank-badge subrank-interim">INT</span>'
                        : f.is_sub_champion && f.sub_title_type === 'bmf'
                          ? '<span class="subrank-badge subrank-bmf">BMF</span>'
                          : '';
      const divLabel  = DIVISION_LABELS[f.primary_division] || f.primary_division;
      const photoHtml = f.photo_url
        ? '<img class="lineup-roster-row__photo" src="' + escapeHtml(f.photo_url) + '" alt="' + escapeHtml(f.name) + '" onerror="this.style.display=\'none\'">'
        : '';
      html +=
        '<div class="lineup-roster-row draft-my-pick">' +
          '<span class="draft-my-pick__num">' + (idx + 1) + '</span>' +
          '<div class="lineup-roster-row__photo-wrap">' + photoHtml + '</div>' +
          '<span class="lineup-roster-row__rank ' + rankClass + '">' + rankLabel + (typeof subBadge === 'string' ? subBadge : '') + '</span>' +
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

// ========================================================================
// WHOLE ROSTER MODAL
// Single-screen sectioned view of every fighter on a team's draft roster.
// memberId is optional — defaults to the current user's roster. Pass any
// member's id (e.g., from a clicked draft-board column header) to view
// their roster instead. Uses the same whole-team-* styles already defined
// for the lineup page so the visual language stays consistent. Click any
// tile to open the existing fighter detail modal.
// ========================================================================
function showWholeRosterModal(memberId) {
  var existing = document.getElementById('wholeRosterModal');
  if (existing) existing.remove();

  var targetMemberId = memberId || myMemberId;
  var targetMember   = memberMap[targetMemberId];
  if (!targetMember) return;
  var isMyRoster     = (targetMemberId === myMemberId);
  var fighters       = picks
    .filter(function(p) { return p.league_member_id === targetMemberId; })
    .map(function(p) { return fighterMap[p.fighter_id]; })
    .filter(Boolean);

  // Group by slot (same logic as renderMyRoster). Each weight class holds
  // up to ROSTER_SLOTS_PER_DIVISION; overflow goes to Any-Division Flex.
  var inDiv   = {};
  ALL_DRAFT_DIVISIONS.forEach(function(d) { inDiv[d] = []; });
  var anyFlex = [];

  fighters.forEach(function(f) {
    if (inDiv[f.primary_division] && inDiv[f.primary_division].length < ROSTER_SLOTS_PER_DIVISION) {
      inDiv[f.primary_division].push(f);
    } else if (inDiv[f.primary_division] !== undefined) {
      anyFlex.push(f);
    }
  });

  // Always render every weight-class section + the flex section, even when
  // empty — empty placeholders communicate which slots still need to be
  // filled during the draft.
  var sectionsHtml = '';
  ALL_DRAFT_DIVISIONS.forEach(function(div) {
    sectionsHtml += renderWholeRosterSection(DIVISION_LABELS[div], inDiv[div], {});
  });
  sectionsHtml += renderWholeRosterSection('Any-Division Flex', anyFlex.slice(0, ROSTER_FLEX_SLOTS), { showDivision: true });

  var eyebrowText = isMyRoster ? 'Whole Roster' : 'Team Roster';
  var titleText   = (isMyRoster ? 'My Picks' : escapeHtml(targetMember.team_name)) +
                    ' &middot; ' + fighters.length + ' / ' + ROSTER_SIZE_BASE;

  var modal = document.createElement('div');
  modal.id = 'wholeRosterModal';
  modal.className = 'fight-card-modal-overlay';
  modal.innerHTML =
    '<div class="fight-card-modal whole-team-modal" role="dialog" aria-modal="true" aria-label="Roster">' +
      '<div class="fight-card-modal__header">' +
        '<div>' +
          '<p class="fight-card-modal__eyebrow">' + eyebrowText + '</p>' +
          '<p class="fight-card-modal__title">' + titleText + '</p>' +
        '</div>' +
        '<button class="fight-card-modal__close" id="closeWholeRosterBtn" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="fight-card-modal__body whole-team-modal__body">' +
        '<div class="whole-team-sections">' + sectionsHtml + '</div>' +
      '</div>' +
    '</div>';

  document.body.appendChild(modal);

  document.getElementById('closeWholeRosterBtn').addEventListener('click', closeWholeRosterModal);
  modal.addEventListener('click', function(e) {
    if (e.target === modal) closeWholeRosterModal();
  });
  document.addEventListener('keydown', handleWholeRosterEscape);

  // Click a tile → open the existing fighter detail modal
  modal.querySelectorAll('[data-roster-tile-id]').forEach(function(tile) {
    tile.addEventListener('click', function() {
      var fid = tile.getAttribute('data-roster-tile-id');
      if (fid && typeof showFighterModal === 'function') showFighterModal(fid);
    });
  });
}

function closeWholeRosterModal() {
  var modal = document.getElementById('wholeRosterModal');
  if (modal) modal.remove();
  document.removeEventListener('keydown', handleWholeRosterEscape);
}

function handleWholeRosterEscape(e) {
  if (e.key === 'Escape') closeWholeRosterModal();
}

// One section column = weight class label + up to 2 fighter tiles below.
// Pads to 2 slots with dashed empty placeholders so sections with one
// (or zero) drafted fighters still read as balanced.
function renderWholeRosterSection(label, fighters, opts) {
  opts = opts || {};
  var slotCount = 2;
  var tilesHtml = fighters.map(function(f) { return renderWholeRosterTile(f, opts); }).join('');
  for (var i = fighters.length; i < slotCount; i++) {
    tilesHtml += '<div class="whole-team-tile-empty" aria-hidden="true"></div>';
  }
  return (
    '<div class="whole-team-section">' +
      '<p class="whole-team-section__label">' + escapeHtml(label) + '</p>' +
      '<div class="whole-team-section__tiles">' + tilesHtml + '</div>' +
    '</div>'
  );
}

// One tile = photo + rank badge + name (and optional division for flex sections).
function renderWholeRosterTile(fighter, opts) {
  opts = opts || {};
  var rankLabel = fighter.is_champion ? 'C' : (fighter.current_rank ? '#' + fighter.current_rank : 'NR');
  // Strip the "Men's "/"Women's " prefix when the division does show — the
  // section header already establishes that context.
  var rawDiv  = DIVISION_LABELS[fighter.primary_division] || fighter.primary_division || '';
  var divLabel = rawDiv.replace(/^Men's\s+/, '').replace(/^Women's\s+/, '');
  var photoHtml = fighter.photo_url
    ? '<img class="whole-team-tile__photo" src="' + escapeHtml(fighter.photo_url) + '" alt="" onerror="this.style.display=\'none\'">'
    : '<div class="whole-team-tile__photo-placeholder"></div>';

  var classes = 'whole-team-tile';
  if (fighter.is_champion) classes += ' whole-team-tile--champion';

  return (
    '<button class="' + classes + '" data-roster-tile-id="' + fighter.id + '" type="button">' +
      '<div class="whole-team-tile__photo-wrap">' +
        photoHtml +
        '<span class="whole-team-tile__rank">' + escapeHtml(rankLabel) + '</span>' +
      '</div>' +
      '<div class="whole-team-tile__info">' +
        '<p class="whole-team-tile__name" title="' + escapeHtml(fighter.name) + '">' + escapeHtml(fighter.name) + '</p>' +
        (opts.showDivision
          ? '<p class="whole-team-tile__div">' + escapeHtml(divLabel) + '</p>'
          : '') +
      '</div>' +
    '</button>'
  );
}

// Returns the fighter objects for the current user's picks, in pick order
function getMyPickFighters() {
  return picks
    .filter(function(p) { return p.league_member_id === myMemberId; })
    .map(function(p) { return fighterMap[p.fighter_id]; })
    .filter(Boolean);
}

// Renders dot indicators for a slot category. Each dot reflects the tier
// of the fighter occupying that slot, or shows an empty/outline state if
// the slot isn't filled:
//   champion   → gold
//   ranked     → crimson
//   unranked   → muted gray fill
//   empty slot → hollow outline
// Lets you scan your roster and instantly see slot strength per division.
function renderPips(fighters, total) {
  let html = '';
  for (let i = 0; i < total; i++) {
    const f = fighters[i];
    let cls = 'pip';
    if (!f)                       cls += ' pip-empty';
    else if (f.is_champion)       cls += ' pip-tier-champion';
    else if (f.current_rank)      cls += ' pip-tier-ranked';
    else                          cls += ' pip-tier-unranked';
    html += '<span class="' + cls + '"></span>';
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
// DRAFT QUEUE
// Personal pre-draft list of fighters this user wants to target. Reads
// from / writes to public.draft_queue. Auto-cleaned by a Postgres trigger
// on draft_picks insert; we mirror that with a realtime subscription so
// the UI reflects "fighter X just got drafted, removing from your queue"
// without a manual refresh.
// ========================================================================

async function loadQueue() {
  const { data, error } = await supabaseClient
    .from('draft_queue')
    .select('fighter_id, position')
    .eq('league_member_id', myMemberId)
    .order('position');
  if (error) {
    console.warn('[queue] load failed:', error.message);
    queue = [];
    return;
  }
  queue = data || [];
}

function isQueued(fighterId) {
  return queue.some(function(q) { return q.fighter_id === fighterId; });
}

// Insert at the end of the queue. Position = max(existing) + 1 so we
// don't collide with existing rows. The DB unique key (member, fighter)
// prevents a double-add.
async function addToQueue(fighterId) {
  if (isQueued(fighterId)) return;
  // Skip if the fighter has already been drafted (shouldn't happen
  // because we hide the toggle in that case, but defensive)
  if (picks.some(function(p) { return p.fighter_id === fighterId; })) return;

  const nextPos = queue.length === 0
    ? 1
    : (queue[queue.length - 1].position + 1);

  const { error } = await supabaseClient.from('draft_queue').insert({
    league_id:        leagueId,
    league_member_id: myMemberId,
    fighter_id:       fighterId,
    position:         nextPos
  });
  if (error) {
    console.warn('[queue] add failed:', error.message);
    return;
  }
  // Optimistic local update — realtime will eventually mirror, but the
  // user expects immediate feedback when they click.
  queue.push({ fighter_id: fighterId, position: nextPos });
  renderFighterPool();
  renderQueue();
}

async function removeFromQueue(fighterId) {
  const { error } = await supabaseClient
    .from('draft_queue')
    .delete()
    .eq('league_member_id', myMemberId)
    .eq('fighter_id', fighterId);
  if (error) {
    console.warn('[queue] remove failed:', error.message);
    return;
  }
  queue = queue.filter(function(q) { return q.fighter_id !== fighterId; });
  renderFighterPool();
  renderQueue();
}

// Move a queue entry up (delta -1) or down (delta +1). Does this by
// swapping positions with the adjacent neighbor. We update both rows
// in two sequential UPDATEs — small race window if the user clicks
// twice rapidly, but acceptable for a personal queue.
async function reorderQueue(fighterId, delta) {
  const idx = queue.findIndex(function(q) { return q.fighter_id === fighterId; });
  if (idx === -1) return;
  const target = idx + delta;
  if (target < 0 || target >= queue.length) return;

  const a = queue[idx];
  const b = queue[target];

  // Swap positions in the DB via two updates. We assign each to a
  // temporary high value first to avoid the (member, position) collisions
  // — but since there's no unique constraint on position itself, we can
  // just swap directly.
  const errA = (await supabaseClient.from('draft_queue').update({ position: b.position })
    .eq('league_member_id', myMemberId).eq('fighter_id', a.fighter_id)).error;
  const errB = (await supabaseClient.from('draft_queue').update({ position: a.position })
    .eq('league_member_id', myMemberId).eq('fighter_id', b.fighter_id)).error;
  if (errA || errB) {
    console.warn('[queue] reorder failed:', errA || errB);
    // Reload to be safe — local state may be inconsistent.
    await loadQueue();
    renderQueue();
    return;
  }

  // Swap locally
  const tmp = a.position; a.position = b.position; b.position = tmp;
  queue.sort(function(x, y) { return x.position - y.position; });
  renderQueue();
}

// Render the queue panel. Called from renderAll so it stays in sync with
// every other render path (pick made, queue changed, etc.).
function renderQueue() {
  const listEl  = document.getElementById('queueList');
  const countEl = document.getElementById('queueCount');
  const hintEl  = document.getElementById('queueHint');
  if (!listEl) return;

  countEl.textContent = queue.length;
  hintEl.textContent  = queue.length === 0
    ? 'Empty'
    : (isMyTurn() ? 'Your pick — draft from queue or pool' : 'Queued for upcoming picks');

  if (queue.length === 0) {
    listEl.innerHTML =
      '<p class="draft-empty" style="padding: var(--space-4) 0">' +
        'Add fighters here while waiting for your turn. They auto-clear when drafted.' +
      '</p>';
    return;
  }

  const myTurn         = isMyTurn() && !picking;
  const myPickFighters = getMyPickFighters();

  let html = '';
  queue.forEach(function(q, idx) {
    const f = fighterMap[q.fighter_id];
    if (!f) return; // fighter not in cache (shouldn't happen)

    const rankLabel = f.is_champion ? 'C' : (f.current_rank ? '#' + f.current_rank : 'NR');
    const rankClass = f.is_champion ? 'rank-champion' : (f.current_rank ? 'rank-ranked' : 'rank-unranked');
    const subBadge  = f.is_sub_champion && f.sub_title_type === 'interim'
                        ? '<span class="subrank-badge subrank-interim">INT</span>'
                      : f.is_sub_champion && f.sub_title_type === 'bmf'
                        ? '<span class="subrank-badge subrank-bmf">BMF</span>'
                        : '';
    const divLabel  = DIVISION_LABELS[f.primary_division] || f.primary_division;

    // When it's my turn AND the fighter is a legal pick, the queue row
    // gets a "Pick" shortcut that drafts them straight from the queue.
    let pickShortcut = '';
    if (myTurn && canPick(f, myPickFighters)) {
      pickShortcut = '<button class="btn-primary lineup-row-btn draft-queue-pick-btn" ' +
                       'data-queue-pick-id="' + f.id + '">Pick</button>';
    }

    const upDisabled   = idx === 0                  ? ' disabled' : '';
    const downDisabled = idx === queue.length - 1   ? ' disabled' : '';

    html +=
      '<div class="lineup-roster-row draft-queue-row">' +
        '<span class="draft-queue-row__pos">' + (idx + 1) + '</span>' +
        '<span class="lineup-roster-row__rank ' + rankClass + '">' + escapeHtml(rankLabel) + (typeof subBadge === 'string' ? subBadge : '') + '</span>' +
        '<div class="lineup-roster-row__info">' +
          '<button class="lineup-roster-row__name" data-open-fighter="' + f.id + '">' +
            escapeHtml(f.name) +
          '</button>' +
          '<span class="lineup-roster-row__division">' + escapeHtml(divLabel) + '</span>' +
        '</div>' +
        '<div class="draft-queue-row__controls">' +
          '<button class="draft-queue-row__arrow" data-queue-up="' + f.id + '"' + upDisabled + ' aria-label="Move up">&#9650;</button>' +
          '<button class="draft-queue-row__arrow" data-queue-down="' + f.id + '"' + downDisabled + ' aria-label="Move down">&#9660;</button>' +
        '</div>' +
        pickShortcut +
        '<button class="draft-queue-row__remove" data-queue-remove="' + f.id + '" aria-label="Remove from queue">&times;</button>' +
      '</div>';
  });

  listEl.innerHTML = html;

  // Wire row interactions
  listEl.querySelectorAll('[data-queue-up]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      reorderQueue(btn.getAttribute('data-queue-up'), -1);
    });
  });
  listEl.querySelectorAll('[data-queue-down]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      reorderQueue(btn.getAttribute('data-queue-down'), +1);
    });
  });
  listEl.querySelectorAll('[data-queue-remove]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      removeFromQueue(btn.getAttribute('data-queue-remove'));
    });
  });
  listEl.querySelectorAll('.draft-queue-pick-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const fighter = fighterMap[btn.getAttribute('data-queue-pick-id')];
      if (fighter) makePick(fighter);
    });
  });
}

// Subscribe to changes on draft_queue for THIS user. Insert + delete are
// the only events we care about. RLS ensures we only see our own rows.
// The trigger that auto-removes on pick will fire deletes here; we react
// by trimming the local cache.
function subscribeToQueue() {
  supabaseClient
    .channel('draft_queue_' + leagueId + '_' + myMemberId)
    .on('postgres_changes', {
      event:  '*',
      schema: 'public',
      table:  'draft_queue',
      filter: 'league_member_id=eq.' + myMemberId
    }, function(payload) {
      // INSERT: append if not already present (we do optimistic adds locally)
      // DELETE: drop the matching row.
      // UPDATE: update position; re-sort.
      if (payload.eventType === 'INSERT') {
        const row = payload.new;
        if (!queue.some(function(q) { return q.fighter_id === row.fighter_id; })) {
          queue.push({ fighter_id: row.fighter_id, position: row.position });
          queue.sort(function(a, b) { return a.position - b.position; });
        }
      } else if (payload.eventType === 'DELETE') {
        const row = payload.old;
        queue = queue.filter(function(q) { return q.fighter_id !== row.fighter_id; });
      } else if (payload.eventType === 'UPDATE') {
        const row = payload.new;
        const item = queue.find(function(q) { return q.fighter_id === row.fighter_id; });
        if (item) {
          item.position = row.position;
          queue.sort(function(a, b) { return a.position - b.position; });
        }
      }
      renderQueue();
      renderFighterPool();
    })
    .subscribe();
}

// ========================================================================
// PRE-DRAFT (LOBBY) STATE
// When the draft is scheduled but not yet started, the room renders just
// like an active draft — empty board, all fighters available, queue
// editable — except the status bar shows a countdown instead of a turn
// indicator, and pick attempts alert "draft hasn't started yet."
// ========================================================================

let predraftCountdownInterval = null;

// Updates the .draft-status__pre span (rendered by renderHeader) once
// per second so the countdown ticks. We update only the text node, not
// the whole turnInfo, to avoid flashing the surrounding text.
function startPredraftCountdown() {
  stopPredraftCountdown();
  predraftCountdownInterval = setInterval(function() {
    const el = document.querySelector('.draft-status__pre');
    if (!el) {
      // turnInfo moved past pre-draft state; nothing more to update.
      stopPredraftCountdown();
      return;
    }
    el.textContent = formatCountdown(league.draft_scheduled_at);
  }, 1000);
}

function stopPredraftCountdown() {
  if (predraftCountdownInterval) {
    clearInterval(predraftCountdownInterval);
    predraftCountdownInterval = null;
  }
}

// Watch the leagues row so the room reacts to schedule changes and to
// the draft actually starting. Three transitions to handle:
//   * draft_started flips true → reload to enter the live draft cleanly
//     (picks subscription, queue mirror trigger, etc. all get a fresh start)
//   * draft_scheduled_at changes (commish edited it) → update local state
//     and re-render the header so the new time shows
//   * draft_scheduled_at cleared while still not started → bounce back to
//     the league page (no schedule = nothing to show in the room)
function subscribeToLobbyFlip() {
  supabaseClient
    .channel('lobby_' + leagueId)
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'leagues',
      filter: 'id=eq.' + leagueId
    }, function(payload) {
      const updated = payload.new;

      if (updated.draft_started) {
        window.location.reload();
        return;
      }

      if (updated.draft_scheduled_at !== league.draft_scheduled_at) {
        league.draft_scheduled_at = updated.draft_scheduled_at;
        if (!league.draft_scheduled_at) {
          window.location.href = 'league.html?id=' + leagueId;
          return;
        }
        renderHeader();
      }
    })
    .subscribe();
}

// "Mon, Apr 28 at 7:30 PM" in the viewer's local timezone. Mirrors the
// helper of the same name in league.js — kept here so draft.js doesn't
// have to depend on league.js being loaded.
function formatScheduledLocal(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const datePart = d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric'
  });
  const timePart = d.toLocaleTimeString(undefined, {
    hour: 'numeric', minute: '2-digit'
  });
  return datePart + ' at ' + timePart;
}

// "Starts in 1d 2h 3m 4s" / "Starts in 12s" / "Starting..."
function formatCountdown(iso) {
  const target = new Date(iso).getTime();
  const diffMs = target - Date.now();
  if (diffMs <= 0) return 'Starting...';

  const totalSec = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSec / 86400);
  const hrs  = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  let parts = [];
  if (days > 0)                          parts.push(days + 'd');
  if (days > 0 || hrs  > 0)              parts.push(hrs  + 'h');
  if (days > 0 || hrs  > 0 || mins > 0)  parts.push(mins + 'm');
  parts.push(secs + 's');
  return 'Starts in ' + parts.join(' ');
}

// ========================================================================
// COMMISSIONER CONTROLS
// Pause/resume, undo last pick, clear board. Visible to the primary
// commissioner and any co-commissioner. The destructive actions go through
// SECURITY DEFINER RPCs (see sql/2026-04-26_draft_commish_controls.sql) so
// the deletes can bypass RLS while still being authorized server-side.
// ========================================================================

// True if the viewing user is the primary commissioner OR a co-commissioner.
function isCommish() {
  if (!members || !user) return false;
  if (league.commissioner_id === user.id) return true;
  const myMember = members.find(function(m) { return m.user_id === user.id; });
  return !!(myMember && myMember.is_commissioner);
}

function initCommishTools() {
  const tools = document.getElementById('draftCommishTools');
  if (!tools) return;
  tools.hidden = false;

  document.getElementById('commishPauseBtn').addEventListener('click', toggleDraftPause);
  document.getElementById('commishUndoBtn').addEventListener('click', undoLastPick);
  document.getElementById('commishClearBtn').addEventListener('click', clearDraftBoard);

  // Initial label sync (in case we loaded into a paused draft)
  refreshCommishToolbar();

  // The toolbar just took ~38px of vertical space — resync the room
  // height so the bottom panels shrink to fit.
  if (typeof window.syncDraftRoomHeight === 'function') {
    window.syncDraftRoomHeight();
  }
}

// Updates the Pause/Resume button label based on current pause state.
// Called on init and after every leagues UPDATE delivered via realtime.
function refreshCommishToolbar() {
  const pauseBtn = document.getElementById('commishPauseBtn');
  if (!pauseBtn) return;
  pauseBtn.textContent = league.draft_paused_at ? 'Resume Draft' : 'Pause Draft';
}

async function toggleDraftPause() {
  const pausing = !league.draft_paused_at;
  const btn = document.getElementById('commishPauseBtn');
  btn.disabled = true;

  const { error } = await supabaseClient
    .from('leagues')
    .update({ draft_paused_at: pausing ? new Date().toISOString() : null })
    .eq('id', leagueId);

  btn.disabled = false;
  if (error) {
    alert('Error toggling pause: ' + error.message);
    return;
  }
  // Realtime will fire on the leagues UPDATE and call refreshCommishToolbar
  // for everyone, but we also update local state immediately for snappy UI.
  league.draft_paused_at = pausing ? new Date().toISOString() : null;
  refreshCommishToolbar();
  renderHeader();
}

async function undoLastPick() {
  if (picks.length === 0) {
    alert('No picks to undo yet.');
    return;
  }
  // Show the most recent pick in the prompt so the commish knows what
  // they're about to undo.
  const lastPick = picks[picks.length - 1];
  const fighter  = fighterMap[lastPick.fighter_id];
  const member   = memberMap[lastPick.league_member_id];
  const desc     = (fighter ? fighter.name : 'Unknown') +
                   ' (drafted by ' + (member ? member.team_name : 'unknown') + ')';
  if (!confirm('Undo last pick — ' + desc + '?')) return;

  const btn = document.getElementById('commishUndoBtn');
  btn.disabled = true;
  btn.textContent = 'Undoing...';

  const { error } = await supabaseClient.rpc('revert_last_draft_pick', {
    p_league_id: leagueId
  });

  btn.disabled = false;
  btn.textContent = 'Undo Last Pick';

  if (error) {
    alert('Error reverting pick: ' + error.message);
    return;
  }
  // The DELETE on draft_picks fires realtime, which calls handlePickDelete
  // for everyone. Local state updates there.
}

async function clearDraftBoard() {
  // Two-step confirmation since this wipes the whole board. The second
  // prompt asks for the league name to make accidental clears very hard.
  if (!confirm('Clear the entire draft board? This deletes every pick and cannot be undone.')) return;
  const typed = prompt('Type the league name to confirm: "' + league.name + '"');
  if (typed === null) return;
  if (typed.trim() !== league.name) {
    alert('League name did not match. Aborted.');
    return;
  }

  const btn = document.getElementById('commishClearBtn');
  btn.disabled = true;
  btn.textContent = 'Clearing...';

  const { error } = await supabaseClient.rpc('clear_draft_board', {
    p_league_id: leagueId
  });

  btn.disabled = false;
  btn.textContent = 'Clear Board';

  if (error) {
    alert('Error clearing board: ' + error.message);
    return;
  }
  // We just deleted every draft_picks row. Each delete fires realtime, but
  // bulk deletes can be flaky to track row-by-row, so resync from the DB
  // directly to be safe.
  const { data: freshPicks } = await supabaseClient
    .from('draft_picks')
    .select('*')
    .eq('league_id', leagueId)
    .order('draft_pick');
  picks = freshPicks || [];
  league.draft_completed = false;
  picking = false;
  renderAll();
}

// ========================================================================
// LEAGUES REALTIME (live draft)
// Watches the leagues row for pause/resume/clear changes during an active
// draft. Pre-draft uses subscribeToLobbyFlip for the start flip; this is
// the equivalent for the live phase.
// ========================================================================
function subscribeToLeagueChanges() {
  supabaseClient
    .channel('league_live_' + leagueId)
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'leagues',
      filter: 'id=eq.' + leagueId
    }, function(payload) {
      const updated = payload.new;
      const wasPaused = !!league.draft_paused_at;
      const isPaused  = !!updated.draft_paused_at;
      league.draft_paused_at = updated.draft_paused_at;
      league.draft_completed = updated.draft_completed;

      // Re-render header so the timer reflects pause state, and update
      // the commish toolbar label if the viewer is a commish.
      refreshCommishToolbar();
      renderHeader();

      // If draft_completed flipped (rare during live, but the clear-board
      // RPC un-completes it), re-render the whole room.
      if (wasPaused !== isPaused) {
        renderFighterPool();
      }
    })
    .subscribe();
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
