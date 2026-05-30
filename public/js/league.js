// ========================================================================
// LEAGUE PAGE LOGIC
// Loads and displays a single league by ID (from the URL query param ?id=).
// Commissioner sees the invite code, draft controls, and remove-member buttons.
// Non-members are redirected to dashboard.html.
// Depends on supabaseClient (supabase-config.js) and requireAuth (auth-guard.js).
// ========================================================================

// Module-level state so all render functions and async handlers can share it
// without re-fetching from the server.
let leagueData  = null;
let membersData = [];
let userRef     = null;
let leagueIdRef = null;
// How many draft picks have been made. The draft order stays editable until
// the FIRST pick (so a draft accidentally started before the order was set can
// be fixed). Loaded once; the order-save path re-checks before writing.
let picksMade   = 0;
let myMemberId  = null;  // current user's league_members.id, needed for roster inserts

// Builds the absolute shareable join URL for an invite code, derived from
// the current page's directory so it works in both local dev (/public/…)
// and production (root). Friends click this and land on join-league with
// the code prefilled — or get bounced through login/signup and back if
// they're not yet authenticated (auth-guard preserves ?next=).
function buildInviteLink(code) {
  const path = window.location.pathname;
  const dir = path.substring(0, path.lastIndexOf('/'));
  return window.location.origin + dir + '/join-league.html?code=' + encodeURIComponent(code);
}

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

// Escapes user-supplied strings before inserting into innerHTML to prevent XSS
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function initLeague() {
  const user = await requireAuth();
  if (!user) return;
  userRef = user;

  // Read the league ID from the URL query string (?id=UUID)
  const leagueId = new URLSearchParams(window.location.search).get('id');
  if (!leagueId) {
    window.location.href = 'dashboard.html';
    return;
  }
  leagueIdRef = leagueId;

  // ---- Fetch league data ----
  // draft_started, draft_completed, draft_order, draft_scheduled_at, roster_size
  // are all needed for the draft setup UI (status, order preview, scheduled
  // countdown).
  const { data: league, error: leagueError } = await supabaseClient
    .from('leagues')
    .select('id, name, format, draft_format, season_start_date, invite_code, commissioner_id, max_managers, draft_started, draft_completed, draft_order, draft_scheduled_at, roster_size, scoring_config')
    .eq('id', leagueId)
    .single();

  if (leagueError || !league) {
    // RLS returned nothing, meaning this user is not a member (or the league doesn't exist)
    window.location.href = 'dashboard.html';
    return;
  }
  leagueData = league;

  // How many picks exist? Only matters once the draft has started — it's what
  // keeps the "Set Draft Order" button available until someone actually picks.
  picksMade = 0;
  if (league.draft_started && !league.draft_completed) {
    const { count } = await supabaseClient
      .from('draft_picks')
      .select('id', { count: 'exact', head: true })
      .eq('league_id', leagueId);
    picksMade = count || 0;
  }

  // ---- Fetch member list ----
  // Declared with let so the remove handler can update the local copy without reloading
  let { data: members, error: membersError } = await supabaseClient
    .from('league_members')
    .select('id, team_name, user_id, is_commissioner, chat_last_seen_at')
    .eq('league_id', leagueId);

  if (membersError) {
    window.location.href = 'dashboard.html';
    return;
  }

  // ---- Verify the current user is actually a member ----
  // RLS may allow reading the league row without being a member in some policies.
  // This client-side check is an extra safety layer.
  const myMember = members.find(function(m) { return m.user_id === user.id; });
  if (!myMember) {
    window.location.href = 'dashboard.html';
    return;
  }
  membersData = members;
  myMemberId  = myMember.id;

  // True for the primary owner OR any co-commissioner. Co-commissioners
  // get the same UI affordances (invite code visibility, settings access,
  // commissioner-only nav buttons) as the primary.
  const isCommissioner = Commissioner.isCommissioner(league, members, user.id);

  // ---- Reveal the page now that we've confirmed membership ----
  document.getElementById('pageContent').style.display = 'block';

  // Update the browser tab title
  document.title = league.name + ' - Knockdown Fantasy';

  // ---- Render league name ----
  document.getElementById('leagueName').textContent = league.name;

  // ---- Wire lineup, free agents, and stats links ----
  document.getElementById('rosterLink').href  = 'lineup.html?id='    + leagueId;
  document.getElementById('waiverLink').href  = 'waivers.html?id='   + leagueId;
  document.getElementById('settingsLink').href = 'league-settings.html?id=' + leagueId;

  // Commish Powers — revealed only for commissioners. Page is gated
  // server-side via RLS, but the link itself is hidden so non-commish
  // members don't see a tease they can't act on.
  var commishPowersLink = document.getElementById('commishPowersLink');
  if (commishPowersLink) {
    commishPowersLink.href = 'commissioner.html?id=' + leagueId;
    commishPowersLink.style.display = isCommissioner ? 'block' : 'none';
  }

  // ---- Wire the activity card ----
  // The card itself is in league.html; we point the "See all" link at the
  // standalone activity page and ask the shared module to render the
  // last 8 events into the embedded slot. Fire-and-forget — failures
  // surface inside the feed widget, not as a page-level error.
  document.getElementById('activitySeeAllLink').href = 'activity.html?id=' + leagueId;
  if (typeof LeagueActivity !== 'undefined') {
    LeagueActivity.renderFeed(
      document.getElementById('leagueActivityFeed'),
      leagueId,
      { limit: 8 }
    );
  }

  // ---- Wire the "Next Event" banner ----
  // Fire-and-forget: replaces the hardcoded placeholder card with the
  // soonest upcoming event from ufc_events and starts a live countdown.
  wireNextEventBanner();

  // ---- Wire the comprehensive "How it works" primer ----
  // LeaguePrimer is shared across every league-context page. Passing the
  // pre-fetched league row in preempts its own background fetch.
  if (typeof LeaguePrimer !== 'undefined') {
    LeaguePrimer.install(league);
  }

  // ---- Render nav tabs in the page header ----
  // Tabs visible depend on draft phase. Draft Room is a first-class tab
  // in the strip while the draft is live (between start and completion);
  // it disappears once draft_completed flips, since the room is no longer
  // a useful destination at that point.
  var tabs = ['leagueHome'];
  if (league.draft_started && !league.draft_completed) {
    tabs.push('draftRoom');
  }
  tabs.push('standings');
  if (league.draft_started) {
    tabs.push('freeAgency', 'trades');
    if (league.draft_completed) tabs.push('lineup');
  }
  if (isCommissioner && league.draft_started) tabs.push('scoreEvent');

  var headerEl = document.getElementById('headerActions');
  headerEl.innerHTML = '<div id="leagueNavStrip"></div>';
  LeagueNav.renderInto('leagueNavStrip', {
    leagueId: leagueId,
    memberId: myMemberId,
    active:   'leagueHome',
    tabs:     tabs
  });

  // ---- Render details grid ----
  const formatDisplay    = league.format === 'dynasty' ? 'Dynasty' : 'Season-Long';
  const draftFmtDisplay  = league.draft_format === 'auction' ? 'Auction Draft' : 'Snake Draft';
  const startDateDisplay = league.season_start_date
    ? new Date(league.season_start_date).toLocaleDateString()
    : 'Not set';

  document.getElementById('leagueDetails').innerHTML =
    '<span class="detail-label">Format</span>'      + '<span class="detail-value">' + formatDisplay + '</span>' +
    '<span class="detail-label">Draft</span>'       + '<span class="detail-value">' + draftFmtDisplay + '</span>' +
    '<span class="detail-label">Start Date</span>'  + '<span class="detail-value">' + startDateDisplay + '</span>';

  // ---- Show invite code to commissioner only ----
  if (isCommissioner) {
    document.getElementById('inviteSection').style.display = 'block';
    document.getElementById('inviteCodeDisplay').textContent = league.invite_code;

    document.getElementById('copyInviteBtn').addEventListener('click', function() {
      navigator.clipboard.writeText(league.invite_code).then(function() {
        document.getElementById('copyInviteBtn').textContent = 'Copied!';
        setTimeout(function() {
          document.getElementById('copyInviteBtn').textContent = 'Copy code';
        }, 2000);
      });
    });

    document.getElementById('copyInviteLinkBtn').addEventListener('click', function() {
      navigator.clipboard.writeText(buildInviteLink(league.invite_code)).then(function() {
        document.getElementById('copyInviteLinkBtn').textContent = 'Copied!';
        setTimeout(function() {
          document.getElementById('copyInviteLinkBtn').textContent = 'Copy link';
        }, 2000);
      });
    });
  }

  // ---- Render member count ----
  document.getElementById('memberCount').textContent = members.length;
  document.getElementById('maxManagers').textContent = league.max_managers;

  // ---- Show Actions column header if commissioner ----
  if (isCommissioner) {
    document.getElementById('actionsHeader').style.display = '';
  }

  // ---- Render member rows ----
  renderMembers(members, league, user, isCommissioner);

  // ---- Render draft section and subscribe to live league updates ----
  renderDraftSection();
  subscribeToLeagueUpdates();

  // ---- Load real free agents into the panel ----
  loadFreeAgents();

  // ---- Wire the Top Performers widget to real data from the most recent
  // completed event. Replaces the hardcoded placeholder rows in the HTML.
  renderTopPerformers();
}

// ========================================================================
// RENDER DRAFT SECTION
// Shows different UI based on current draft state. Called on load and again
// whenever the Realtime subscription delivers a league UPDATE.
// ========================================================================
function renderDraftSection() {
  const el = document.getElementById('draftContent');
  const isCommissioner = Commissioner.isCommissioner(leagueData, membersData, userRef.id);

  if (leagueData.draft_completed) {
    el.innerHTML =
      '<p class="draft-status-note">The draft is complete.</p>' +
      '<a href="draft.html?id=' + leagueIdRef + '" class="btn-secondary">View Draft Board</a>';
    return;
  }

  if (leagueData.draft_started) {
    // The draft order stays editable until the FIRST pick is made. This rescues
    // a draft that was started before an order was set (the draft room is
    // broken with no pick order) and lets the commish reorder right up until
    // someone actually drafts.
    if (isCommissioner && picksMade === 0) {
      const noOrder = !leagueData.draft_order || leagueData.draft_order.length === 0;
      el.innerHTML =
        '<p class="draft-status-note">' +
          (noOrder
            ? 'The draft has started but no draft order is set yet. Set the order below, then enter the draft room.'
            : 'The draft has started but no picks have been made yet — you can still change the draft order.') +
        '</p>' +
        '<div id="draftOrderPreview">' + renderDraftOrderList() + '</div>' +
        '<div class="draft-actions">' +
          '<button class="btn-secondary" id="setOrderBtn">Set Draft Order</button>' +
          (noOrder ? '' : '<a href="draft.html?id=' + leagueIdRef + '" class="btn-primary">Enter Draft Room</a>') +
        '</div>';
      document.getElementById('setOrderBtn').addEventListener('click', openDraftOrderModal);
      return;
    }
    el.innerHTML =
      '<p class="draft-status-note">Draft is currently in progress.</p>' +
      '<div class="draft-actions">' +
        '<a href="draft.html?id=' + leagueIdRef + '" class="btn-primary">Enter Draft Room</a>' +
        '<a href="draft.html?id=' + leagueIdRef + '&mock=1" class="btn-ghost">Mock Draft</a>' +
      '</div>';
    return;
  }

  // Draft has not started yet. Tear down any prior countdown interval so we
  // don't leak timers when the section re-renders (Realtime updates, etc.).
  stopDraftCountdown();

  const orderHtml      = renderDraftOrderList();
  const isScheduled    = !!leagueData.draft_scheduled_at;
  const orderIsSet     = !!leagueData.draft_order;
  const timeBtnLabel   = isScheduled ? 'Change Draft Time' : 'Set Draft Time';
  const timeBtnDisabled = orderIsSet ? '' : ' disabled';

  // The scheduled section (countdown + absolute time + lobby link) shows the
  // same to everyone — commissioner and members — when a time has been set.
  // The Enter Draft Room link lets managers enter the lobby and watch the
  // countdown together inside the draft room before the draft starts.
  const scheduledHtml = isScheduled
    ? '<div class="draft-schedule" id="draftSchedule">' +
        '<p class="draft-schedule__label">Draft starts</p>' +
        '<p class="draft-schedule__when" id="draftScheduleWhen">' + escapeHtml(formatScheduledLocal(leagueData.draft_scheduled_at)) + '</p>' +
        '<p class="draft-schedule__countdown" id="draftScheduleCountdown">' + escapeHtml(formatCountdown(leagueData.draft_scheduled_at)) + '</p>' +
        '<div class="draft-schedule__actions">' +
          '<a href="draft.html?id=' + leagueIdRef + '" class="btn-secondary draft-schedule__enter">Enter Draft Room</a>' +
          '<a href="draft.html?id=' + leagueIdRef + '&mock=1" class="btn-ghost draft-schedule__mock">Mock Draft</a>' +
        '</div>' +
      '</div>'
    : '';

  // Mock-draft link shown to every member in pre-draft, regardless of
  // schedule state. It's the primary entry point for practicing — handy
  // when no schedule is set yet so commish/members can't otherwise click
  // into the draft surface at all.
  const mockLink =
    '<a href="draft.html?id=' + leagueIdRef + '&mock=1" class="btn-ghost league-mock-link">Mock Draft</a>';

  if (isCommissioner) {
    // Commissioner controls: set draft order, then set draft time. The
    // "Set Draft Time" button is disabled until a draft order has been
    // saved (you can't start a draft with no pick order).
    el.innerHTML =
      '<p class="draft-status-note">Set the draft order, then set a time to start the draft (or start it now).</p>' +
      '<div id="draftOrderPreview">' + orderHtml + '</div>' +
      scheduledHtml +
      '<div class="draft-actions">' +
        '<button class="btn-secondary" id="setOrderBtn">Set Draft Order</button>' +
        '<button class="btn-primary" id="setTimeBtn"' + timeBtnDisabled + '>' + timeBtnLabel + '</button>' +
        (isScheduled ? '' : mockLink) +
      '</div>';

    document.getElementById('setOrderBtn').addEventListener('click', openDraftOrderModal);
    document.getElementById('setTimeBtn').addEventListener('click', openDraftTimeModal);
  } else {
    // Non-commissioner sees the order (if set), the scheduled time (if any),
    // and a waiting message.
    const waitMsg = isScheduled
      ? 'Draft scheduled. The commissioner will start it at the scheduled time.'
      : 'Waiting for the commissioner to start the draft.';
    el.innerHTML =
      '<p class="draft-status-note">' + waitMsg + '</p>' +
      '<div id="draftOrderPreview">' + orderHtml + '</div>' +
      scheduledHtml +
      // Non-commish member without a schedule has no other CTA — the
      // Mock Draft link is their only entry into the draft surface.
      (isScheduled ? '' : '<div class="draft-actions">' + mockLink + '</div>');
  }

  // If a schedule exists, kick off the live countdown so seconds tick.
  if (isScheduled) startDraftCountdown();
}

// Returns an HTML string showing the draft pick order as a numbered list,
// or a placeholder message if no order has been set yet.
function renderDraftOrderList() {
  if (!leagueData.draft_order || leagueData.draft_order.length === 0) {
    return '<p class="draft-empty">Draft order not yet set.</p>';
  }

  // Map each member ID in the order array to that member's team name
  const items = leagueData.draft_order.map(function(memberId, idx) {
    const member = membersData.find(function(m) { return m.id === memberId; });
    const name = member ? escapeHtml(member.team_name) : '(departed member)';
    return '<li><span class="draft-order-pos">' + (idx + 1) + '</span>' + name + '</li>';
  });

  return '<ol class="draft-order-list">' + items.join('') + '</ol>';
}

// ========================================================================
// DRAFT ORDER MODAL
// Lets the commissioner manually reorder managers (up/down arrows) or
// randomize the order. Working order is held in module-level state while
// the modal is open and only persisted on Save.
// ========================================================================

// Working copy of the order while the modal is open. Empty when closed.
let draftOrderWorking = [];

// Renders the modal HTML for the current draftOrderWorking array. Pulled
// out into its own function so we can re-render the list in place after
// each arrow click or randomize without rebuilding the whole modal.
function renderDraftOrderEditList() {
  const items = draftOrderWorking.map(function(memberId, idx) {
    const member = membersData.find(function(m) { return m.id === memberId; });
    const name = member ? escapeHtml(member.team_name) : '(departed member)';
    // Arrow disabled at the boundaries so the user can't move the top
    // entry up or the bottom entry down (would be a no-op anyway).
    const upDisabled   = idx === 0                              ? ' disabled' : '';
    const downDisabled = idx === draftOrderWorking.length - 1   ? ' disabled' : '';
    return '<li class="draft-order-edit__item">' +
      '<span class="draft-order-edit__pos">' + (idx + 1) + '</span>' +
      '<span class="draft-order-edit__name">' + name + '</span>' +
      '<button class="draft-order-edit__arrow" data-action="up" data-idx="' + idx + '"' + upDisabled + ' aria-label="Move up">&#8593;</button>' +
      '<button class="draft-order-edit__arrow" data-action="down" data-idx="' + idx + '"' + downDisabled + ' aria-label="Move down">&#8595;</button>' +
      '</li>';
  });
  return items.join('');
}

// Re-renders just the <ol> contents and re-wires its arrows. Called after
// each manual swap or randomize so the displayed positions stay in sync
// with draftOrderWorking.
function refreshDraftOrderEditList() {
  const list = document.getElementById('draftOrderEditList');
  if (!list) return;
  list.innerHTML = renderDraftOrderEditList();
  wireDraftOrderArrows();
}

// Attaches click handlers to every up/down arrow currently in the modal.
// Re-run after each refresh because innerHTML wipes the old listeners.
function wireDraftOrderArrows() {
  document.querySelectorAll('.draft-order-edit__arrow').forEach(function(btn) {
    btn.addEventListener('click', function() {
      if (btn.disabled) return;
      const action = btn.getAttribute('data-action');
      const idx    = parseInt(btn.getAttribute('data-idx'), 10);

      // Swap with the neighbor in the appropriate direction
      if (action === 'up' && idx > 0) {
        const tmp = draftOrderWorking[idx - 1];
        draftOrderWorking[idx - 1] = draftOrderWorking[idx];
        draftOrderWorking[idx]     = tmp;
      } else if (action === 'down' && idx < draftOrderWorking.length - 1) {
        const tmp = draftOrderWorking[idx + 1];
        draftOrderWorking[idx + 1] = draftOrderWorking[idx];
        draftOrderWorking[idx]     = tmp;
      }
      refreshDraftOrderEditList();
    });
  });
}

// Builds the working order from either the existing saved order, or the
// current member list as a fallback. Then renders the modal into the DOM
// and wires every interactive element.
function openDraftOrderModal() {
  // Seed the working order. If a saved order exists and includes ALL
  // current members, use it as-is. Otherwise rebuild from membersData
  // so newly-joined managers don't get silently excluded from the editor.
  const memberIds = membersData.map(function(m) { return m.id; });
  if (leagueData.draft_order &&
      leagueData.draft_order.length === memberIds.length &&
      leagueData.draft_order.every(function(id) { return memberIds.indexOf(id) !== -1; })) {
    draftOrderWorking = leagueData.draft_order.slice();
  } else {
    draftOrderWorking = memberIds.slice();
  }

  const overlay = document.createElement('div');
  overlay.className = 'draft-order-modal-overlay';
  overlay.id        = 'draftOrderModalOverlay';
  overlay.innerHTML =
    '<div class="draft-order-modal">' +
      '<div class="draft-order-modal__header">' +
        '<h3 class="draft-order-modal__title">Set Draft Order</h3>' +
        '<button class="draft-order-modal__close" id="draftOrderModalClose" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="draft-order-modal__body">' +
        '<p class="draft-order-modal__help">Use the arrows to reorder, or click Randomize.</p>' +
        '<ol class="draft-order-edit" id="draftOrderEditList">' + renderDraftOrderEditList() + '</ol>' +
      '</div>' +
      '<div class="draft-order-modal__actions">' +
        '<button class="btn-secondary" id="draftOrderRandomBtn">Randomize</button>' +
        '<div class="draft-order-modal__actions-right">' +
          '<button class="btn-secondary" id="draftOrderCancelBtn">Cancel</button>' +
          '<button class="btn-primary" id="draftOrderSaveBtn">Save Order</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  // Backdrop click closes (only when target is the overlay itself, not the modal card)
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeDraftOrderModal();
  });

  document.getElementById('draftOrderModalClose').addEventListener('click', closeDraftOrderModal);
  document.getElementById('draftOrderCancelBtn').addEventListener('click', closeDraftOrderModal);
  document.getElementById('draftOrderRandomBtn').addEventListener('click', randomizeDraftOrderInModal);
  document.getElementById('draftOrderSaveBtn').addEventListener('click', saveDraftOrderFromModal);
  wireDraftOrderArrows();
}

// Fisher-Yates shuffle of the working order. Doesn't persist — the user
// still has to hit Save.
function randomizeDraftOrderInModal() {
  for (let i = draftOrderWorking.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = draftOrderWorking[i];
    draftOrderWorking[i] = draftOrderWorking[j];
    draftOrderWorking[j] = temp;
  }
  refreshDraftOrderEditList();
}

// Persists the working order to leagues.draft_order, then closes the
// modal and re-renders the draft section so the preview updates.
async function saveDraftOrderFromModal() {
  const saveBtn = document.getElementById('draftOrderSaveBtn');
  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving...';

  // Safety: never reorder once a pick has been made (the page's pick count
  // could be stale if someone drafted while this was open). Re-check live.
  if (leagueData.draft_started) {
    const { count } = await supabaseClient
      .from('draft_picks')
      .select('id', { count: 'exact', head: true })
      .eq('league_id', leagueIdRef);
    if ((count || 0) > 0) {
      picksMade = count;
      alert('A pick has already been made, so the draft order can no longer be changed.');
      closeDraftOrderModal();
      renderDraftSection();
      return;
    }
  }

  const { error } = await supabaseClient
    .from('leagues')
    .update({ draft_order: draftOrderWorking })
    .eq('id', leagueIdRef);

  if (error) {
    alert('Error saving draft order: ' + error.message);
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Save Order';
    return;
  }

  leagueData.draft_order = draftOrderWorking.slice();
  closeDraftOrderModal();
  renderDraftSection();
}

// Removes the modal from the DOM and clears the working state.
function closeDraftOrderModal() {
  const overlay = document.getElementById('draftOrderModalOverlay');
  if (overlay) overlay.remove();
  draftOrderWorking = [];
}

// ========================================================================
// DRAFT TIME MODAL
// Lets the commissioner either start the draft immediately or schedule
// it for a future time. A scheduled draft is auto-started by the
// start-scheduled-drafts pg_cron job (see SQL migration). The commissioner
// can also clear an existing schedule from this same modal.
// ========================================================================

// Renders the modal HTML. Shape changes slightly when a schedule already
// exists (we show the current time + a Clear option above the picker).
function buildDraftTimeModalHtml() {
  const isScheduled  = !!leagueData.draft_scheduled_at;
  const currentLabel = isScheduled
    ? '<div class="draft-time-modal__current">' +
        '<p class="draft-time-modal__current-label">Currently scheduled for</p>' +
        '<p class="draft-time-modal__current-when">' + escapeHtml(formatScheduledLocal(leagueData.draft_scheduled_at)) + '</p>' +
        '<button class="btn-ghost" id="draftTimeClearBtn">Clear schedule</button>' +
      '</div>'
    : '';

  // Default the picker to "one hour from now" rounded to the next 5 minutes,
  // unless a schedule already exists — then prefill it for editing.
  const defaultIso = isScheduled
    ? toLocalDatetimeInput(new Date(leagueData.draft_scheduled_at))
    : toLocalDatetimeInput(roundUpToNext5Minutes(new Date(Date.now() + 60 * 60 * 1000)));

  return '<div class="draft-time-modal">' +
    '<div class="draft-time-modal__header">' +
      '<h3 class="draft-time-modal__title">Set Draft Time</h3>' +
      '<button class="draft-time-modal__close" id="draftTimeModalClose" aria-label="Close">&times;</button>' +
    '</div>' +
    '<div class="draft-time-modal__body">' +
      currentLabel +
      '<div class="draft-time-modal__option">' +
        '<p class="draft-time-modal__option-label">Start the draft now</p>' +
        '<button class="btn-primary" id="draftTimeStartNowBtn">Start Now</button>' +
      '</div>' +
      '<div class="draft-time-modal__divider"><span>or</span></div>' +
      '<div class="draft-time-modal__option">' +
        '<p class="draft-time-modal__option-label">Schedule for later</p>' +
        '<input type="datetime-local" class="draft-time-modal__input" id="draftTimeInput" value="' + defaultIso + '">' +
        '<p class="draft-time-modal__hint">Time is in your local timezone.</p>' +
        '<button class="btn-primary" id="draftTimeScheduleBtn">' + (isScheduled ? 'Update Schedule' : 'Schedule Draft') + '</button>' +
      '</div>' +
    '</div>' +
    '<div class="draft-time-modal__actions">' +
      '<button class="btn-secondary" id="draftTimeCancelBtn">Cancel</button>' +
    '</div>' +
  '</div>';
}

function openDraftTimeModal() {
  if (!leagueData.draft_order) {
    alert('Set the draft order before scheduling the draft.');
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'draft-time-modal-overlay';
  overlay.id        = 'draftTimeModalOverlay';
  overlay.innerHTML = buildDraftTimeModalHtml();
  document.body.appendChild(overlay);

  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeDraftTimeModal();
  });

  document.getElementById('draftTimeModalClose').addEventListener('click', closeDraftTimeModal);
  document.getElementById('draftTimeCancelBtn').addEventListener('click', closeDraftTimeModal);
  document.getElementById('draftTimeStartNowBtn').addEventListener('click', startDraftNow);
  document.getElementById('draftTimeScheduleBtn').addEventListener('click', scheduleDraft);

  const clearBtn = document.getElementById('draftTimeClearBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearDraftSchedule);
}

function closeDraftTimeModal() {
  const overlay = document.getElementById('draftTimeModalOverlay');
  if (overlay) overlay.remove();
}

// Immediate start. Same DB write as the original startDraft did, plus we
// clear any pending schedule so the cron job won't fight us. Redirects
// the commissioner to the draft room; other members follow via Realtime.
async function startDraftNow() {
  if (!confirm('Start the draft now? This cannot be undone.')) return;

  const btn = document.getElementById('draftTimeStartNowBtn');
  btn.disabled    = true;
  btn.textContent = 'Starting...';

  const { error } = await supabaseClient
    .from('leagues')
    .update({
      draft_started:      true,
      draft_started_at:   new Date().toISOString(),
      draft_scheduled_at: null
    })
    .eq('id', leagueIdRef);

  if (error) {
    alert('Error starting draft: ' + error.message);
    btn.disabled    = false;
    btn.textContent = 'Start Now';
    return;
  }

  window.location.href = 'draft.html?id=' + leagueIdRef;
}

// Save a future draft time. Validates that the chosen time is in the
// future (a stale picker value can produce a past time once the user
// gets around to clicking).
async function scheduleDraft() {
  const input = document.getElementById('draftTimeInput');
  if (!input || !input.value) {
    alert('Pick a date and time first.');
    return;
  }

  // datetime-local values have no tz info; new Date(value) interprets
  // them in the browser's local tz, which is exactly what we want.
  const when = new Date(input.value);
  if (isNaN(when.getTime())) {
    alert('That date/time is invalid.');
    return;
  }
  if (when.getTime() <= Date.now() + 60 * 1000) {
    alert('Pick a time at least a minute in the future. To start the draft right away, use Start Now.');
    return;
  }

  const btn = document.getElementById('draftTimeScheduleBtn');
  const originalLabel = btn.textContent;
  btn.disabled    = true;
  btn.textContent = 'Saving...';

  const { error } = await supabaseClient
    .from('leagues')
    .update({ draft_scheduled_at: when.toISOString() })
    .eq('id', leagueIdRef);

  if (error) {
    alert('Error scheduling draft: ' + error.message);
    btn.disabled    = false;
    btn.textContent = originalLabel;
    return;
  }

  leagueData.draft_scheduled_at = when.toISOString();
  closeDraftTimeModal();
  renderDraftSection();
}

// Removes a pending schedule. Doesn't start the draft.
async function clearDraftSchedule() {
  if (!confirm('Clear the scheduled draft time?')) return;

  const btn = document.getElementById('draftTimeClearBtn');
  btn.disabled    = true;
  btn.textContent = 'Clearing...';

  const { error } = await supabaseClient
    .from('leagues')
    .update({ draft_scheduled_at: null })
    .eq('id', leagueIdRef);

  if (error) {
    alert('Error clearing schedule: ' + error.message);
    btn.disabled    = false;
    btn.textContent = 'Clear schedule';
    return;
  }

  leagueData.draft_scheduled_at = null;
  closeDraftTimeModal();
  renderDraftSection();
}

// ========================================================================
// SCHEDULED DRAFT COUNTDOWN
// Live "Starts in Xd Xh Xm Xs" timer rendered next to the absolute time.
// Updates every second; cleared whenever renderDraftSection() runs again.
// ========================================================================

let draftCountdownInterval = null;

function startDraftCountdown() {
  stopDraftCountdown();
  draftCountdownInterval = setInterval(function() {
    const el = document.getElementById('draftScheduleCountdown');
    if (!el) {
      // Element was removed (page navigated, section re-rendered without
      // a schedule). Defensive cleanup.
      stopDraftCountdown();
      return;
    }
    el.textContent = formatCountdown(leagueData.draft_scheduled_at);
  }, 1000);
}

function stopDraftCountdown() {
  if (draftCountdownInterval) {
    clearInterval(draftCountdownInterval);
    draftCountdownInterval = null;
  }
}

// Returns a "Mon, Apr 28 at 7:30 PM" style string in the viewer's local tz.
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

// Returns "Starts in 1d 2h 3m 4s" / "Starts in 4m 12s" / "Starting..."
function formatCountdown(iso) {
  const target = new Date(iso).getTime();
  const diffMs = target - Date.now();
  if (diffMs <= 0) return 'Starting...';

  const totalSec = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSec / 86400);
  const hrs  = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  // Drop higher units when they're zero so short countdowns don't look
  // cluttered ("Starts in 12s" beats "Starts in 0d 0h 0m 12s").
  let parts = [];
  if (days > 0)               parts.push(days + 'd');
  if (days > 0 || hrs  > 0)   parts.push(hrs  + 'h');
  if (days > 0 || hrs  > 0 || mins > 0) parts.push(mins + 'm');
  parts.push(secs + 's');
  return 'Starts in ' + parts.join(' ');
}

// Rounds a Date up to the next 5-minute mark. Used to seed a sane
// default in the picker.
function roundUpToNext5Minutes(d) {
  const ms = 5 * 60 * 1000;
  return new Date(Math.ceil(d.getTime() / ms) * ms);
}

// ========================================================================
// NEXT-EVENT BANNER
// Replaces the hardcoded placeholder card on league.html with the soonest
// upcoming UFC event from ufc_events, including a live d/h/m countdown to
// the lineup-lock time (defaults to 5pm ET on the event day when the
// commissioner hasn't set lineup_lock_time).
// ========================================================================

// Display name for the upcoming-event banner. Numbered PPVs ("UFC 329")
// show as-is; non-numbered Vegas cards are at the UFC Apex facility, so
// they label as "UFC APEX"; everything else gets re-labelled as
// "UFC <City>" using the first chunk of ufc_events.venue. Matches the
// helper of the same name in lineup.js.
function displayEventName(ev) {
  if (!ev) return '';
  if (/^UFC\s+\d+\b/i.test(ev.name || '')) return ev.name;
  if (ev.venue) {
    var venue = String(ev.venue);
    if (/las vegas/i.test(venue))  return 'UFC APEX';
    // One-off override: the Washington card is sponsor-named "Freedom 250".
    if (/washington/i.test(venue)) return 'UFC Freedom 250';
    var city = venue.split(',')[0].trim();
    if (city) return 'UFC ' + city;
  }
  return ev.name || '';
}

// Compute "5pm ET on event_date" with DST awareness. Matches
// getEffectiveLockTime in lineup.js so both pages count down to the same
// moment.
function nextEventLockTime(event) {
  if (!event || !event.event_date) return null;
  if (event.lineup_lock_time) return new Date(event.lineup_lock_time);
  const parts = event.event_date.split('-').map(Number);
  const y = parts[0], m = parts[1], d = parts[2];
  const tentative = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  let offsetHours = -5;  // EST default
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', timeZoneName: 'short'
    });
    const tzPart = fmt.formatToParts(tentative).find(function (p) { return p.type === 'timeZoneName'; });
    if (tzPart && tzPart.value === 'EDT') offsetHours = -4;
  } catch (e) { /* stick with EST */ }
  return new Date(Date.UTC(y, m - 1, d, 17 - offsetHours, 0, 0));
}

// "Max Holloway" -> "Holloway" for the compact "Vs." matchup line.
function _lastNameOf(fullName) {
  if (!fullName) return '';
  var parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1];
}

var _nextEventInterval = null;

async function wireNextEventBanner() {
  const todayISO = new Date().toISOString().split('T')[0];

  // Fetch the soonest upcoming event. We have to be careful here: this
  // league might have an override that bumps an event's date EARLIER than
  // the soonest one in ufc_events, OR bumps the soonest event LATER than
  // it would otherwise be. So we can't just `.gte(today)` on ufc_events.
  // Strategy: fetch a small recent window of events + this league's
  // overrides, merge, then pick the soonest effective upcoming event in JS.
  const { data: rawEvents, error } = await supabaseClient
    .from('ufc_events')
    .select('id, name, full_name, event_date, venue, lineup_lock_time')
    .gte('event_date', todayISO)
    .order('event_date', { ascending: true })
    .limit(8);

  if (error || !rawEvents || rawEvents.length === 0) return;

  var overrides = await EventOverrides.fetchForLeague(supabaseClient, leagueIdRef, rawEvents.map(function(e){return e.id;}));
  var merged    = EventOverrides.mergeAll(rawEvents, overrides);
  // Pick the soonest effective event whose date is today or later. If every
  // event got overridden into the past, fall back to the soonest of any.
  var upcoming = merged.filter(function(e) { return e.event_date && e.event_date >= todayISO; });
  upcoming.sort(function(a, b) { return String(a.event_date).localeCompare(String(b.event_date)); });
  var event = upcoming[0] || merged[0];
  if (!event) return;

  // Headline name — Fight Nights show as "UFC <City>" instead of the
  // generic "UFC Fight Night".
  const nameEl = document.querySelector('.this-week-card__name');
  if (nameEl) nameEl.textContent = displayEventName(event);

  // Date + venue line
  const dateEl = document.querySelector('.this-week-card__date');
  if (dateEl) {
    const d = new Date(event.event_date + 'T12:00:00');
    let dateStr = d.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric'
    });
    if (event.venue) dateStr += ' · ' + event.venue;
    dateEl.textContent = dateStr;
  }

  // Matchup line. Try the actual main-event fight first, then fall back
  // to the colon suffix in full_name ("UFC 329: McGregor vs. Holloway 2").
  const matchupEl = document.querySelector('.this-week-card__matchup');
  if (matchupEl) {
    let matchup = '';
    try {
      const { data: mainFight } = await supabaseClient
        .from('fight_results')
        .select('fighter_a_id, fighter_b_id')
        .eq('event_id', event.id)
        .eq('card_position', 'main_event')
        .maybeSingle();
      if (mainFight) {
        const { data: pair } = await supabaseClient
          .from('fighters')
          .select('id, name')
          .in('id', [mainFight.fighter_a_id, mainFight.fighter_b_id]);
        if (pair && pair.length === 2) {
          const a = pair.find(function (p) { return p.id === mainFight.fighter_a_id; });
          const b = pair.find(function (p) { return p.id === mainFight.fighter_b_id; });
          if (a && b) matchup = _lastNameOf(a.name) + ' vs. ' + _lastNameOf(b.name);
        }
      }
    } catch (_e) { /* fall through to full_name parse */ }

    if (!matchup && event.full_name && event.full_name.indexOf(':') !== -1) {
      matchup = event.full_name.split(':').slice(1).join(':').trim();
    }
    if (matchup) {
      matchupEl.textContent = matchup;
      matchupEl.style.display = '';
    } else {
      matchupEl.style.display = 'none';
    }
  }

  // Kick off the d/h/m/s countdown
  const target = nextEventLockTime(event);
  if (target) startNextEventCountdown(target);

  // Wire the "View fight card" button to the shared modal. Uses the
  // event id we already fetched, so no extra query at click time.
  const fcBtn = document.getElementById('viewFightCardBtn');
  if (fcBtn && typeof FightCardModal !== 'undefined') {
    fcBtn.addEventListener('click', function () {
      FightCardModal.show(event.id, { leagueId: leagueIdRef });
    });
  } else if (fcBtn) {
    // FightCardModal failed to load — hide the button so it doesn't
    // sit there as a dead control.
    fcBtn.style.display = 'none';
  }
}

function startNextEventCountdown(target) {
  if (_nextEventInterval) clearInterval(_nextEventInterval);
  const daysEl  = document.getElementById('twDays');
  const hoursEl = document.getElementById('twHours');
  const minsEl  = document.getElementById('twMins');
  const secsEl  = document.getElementById('twSecs');
  if (!daysEl || !hoursEl || !minsEl) return;

  function tick() {
    const now = new Date();
    let diff = target.getTime() - now.getTime();
    if (diff < 0) diff = 0;
    const days  = Math.floor(diff / 86400000); diff -= days  * 86400000;
    const hours = Math.floor(diff / 3600000);  diff -= hours * 3600000;
    const mins  = Math.floor(diff / 60000);    diff -= mins  * 60000;
    const secs  = Math.floor(diff / 1000);
    daysEl.textContent  = String(days);
    hoursEl.textContent = String(hours);
    minsEl.textContent  = String(mins);
    if (secsEl) secsEl.textContent = String(secs);
  }
  tick();
  // 1-second cadence drives the seconds digit.
  _nextEventInterval = setInterval(tick, 1000);
}

// Converts a Date into the value format <input type="datetime-local">
// expects: "YYYY-MM-DDTHH:mm" in local time. We can't use toISOString()
// because that's UTC; the input would jump tz.
function toLocalDatetimeInput(d) {
  const pad = function(n) { return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + '-' +
    pad(d.getMonth() + 1) + '-' +
    pad(d.getDate()) + 'T' +
    pad(d.getHours()) + ':' +
    pad(d.getMinutes());
}

// ========================================================================
// SUBSCRIBE TO LEAGUE UPDATES
// Listens for live changes to this league row via Supabase Realtime.
// Handles two cases: draft_started flip (redirect all members) and
// draft_order changes (update the order preview without a page reload).
// Requires the leagues table to be in the supabase_realtime publication.
// ========================================================================
function subscribeToLeagueUpdates() {
  supabaseClient
    .channel('league_updates_' + leagueIdRef)
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'leagues',
      filter: 'id=eq.' + leagueIdRef
    }, function(payload) {
      const updated = payload.new;

      // If the draft just flipped to started, go to the draft room right away
      if (updated.draft_started && !leagueData.draft_started) {
        window.location.href = 'draft.html?id=' + leagueIdRef;
        return;
      }

      // For all other changes (order update, completion), refresh local state
      // and re-render the draft section so the UI stays in sync
      leagueData = Object.assign({}, leagueData, updated);
      renderDraftSection();
    })
    .subscribe();
}

// ========================================================================
// RENDER MEMBERS
// Builds the member table rows. Extracted into its own function so we can
// call it again after removing a member without reloading the whole page.
// ========================================================================
function renderMembers(members, league, user, isCommissioner) {
  const tbody = document.getElementById('memberTableBody');
  tbody.innerHTML = '';

  members.forEach(function(member) {
    // Three-tier role badge: primary owner, co-commissioner, plain member.
    // Only the primary can promote/demote others (handled in league-settings).
    const isPrimary = Commissioner.isPrimaryCommissioner(league, member.user_id);
    const isCoCommish = !isPrimary && member.is_commissioner === true;
    var badgeClass, roleLabel;
    if (isPrimary)         { badgeClass = 'badge-commissioner';     roleLabel = 'Commissioner'; }
    else if (isCoCommish)  { badgeClass = 'badge-co-commissioner';  roleLabel = 'Co-commissioner'; }
    else                   { badgeClass = 'badge-member';           roleLabel = 'Member'; }
    // Pre-existing call sites in this function reference the boolean —
    // keep that shape so the conditionals below don't have to change.
    const memberIsCommissioner = isPrimary;

    const row = document.createElement('tr');

    // Build the row, conditionally adding a Remove button for the commissioner.
    // Commissioner cannot remove themselves (no remove button on their own row).
    // Remove buttons are hidden once the draft starts to prevent mid-draft disruption.
    let actionsCell = '';
    if (isCommissioner && !memberIsCommissioner && !leagueData.draft_started) {
      actionsCell = '<td><button class="btn-danger" data-member-id="' + member.id + '" data-team-name="' + escapeHtml(member.team_name) + '">Remove</button></td>';
    } else if (isCommissioner) {
      actionsCell = '<td></td>';
    }

    row.innerHTML =
      '<td>' + escapeHtml(member.team_name) + '</td>' +
      '<td><span class="badge ' + badgeClass + '">' + roleLabel + '</span></td>' +
      actionsCell;

    tbody.appendChild(row);
  });

  // ---- Wire up remove buttons (only present for commissioner before draft) ----
  tbody.querySelectorAll('.btn-danger').forEach(function(btn) {
    btn.addEventListener('click', async function() {
      const memberId = btn.getAttribute('data-member-id');
      const teamName = btn.getAttribute('data-team-name');

      // Simple confirmation before a destructive action
      if (!confirm('Remove ' + teamName + ' from the league?')) return;

      btn.disabled = true;
      btn.textContent = 'Removing...';

      const { error } = await supabaseClient
        .from('league_members')
        .delete()
        .eq('id', memberId);

      if (error) {
        alert('Error removing member: ' + error.message);
        btn.disabled = false;
        btn.textContent = 'Remove';
        return;
      }

      // Remove the row from the local members array and re-render without a page reload
      members = members.filter(function(m) { return m.id !== memberId; });
      membersData = members;
      document.getElementById('memberCount').textContent = members.length;
      renderMembers(members, league, user, isCommissioner);
    });
  });
}

// ========================================================================
// LOAD FREE AGENTS
// Fetches fighters not on any roster in this league (sorted by rank) and
// renders them into #freeAgentList with working Add buttons.
// Called on page load and again after each successful add so the list
// stays current without a full page reload.
// ========================================================================
async function loadFreeAgents() {
  const el = document.getElementById('freeAgentList');

  // Fetch rosters, fighters, the next event (for phase math), and recent
  // roster_drops (for the per-fighter rolling-waiver check) in parallel.
  // The next-event date drives whether we're in WINDOW_PRE / WINDOW_POST
  // (in which case ALL adds are claims) or in plain free agency.
  const todayISO = new Date().toISOString().split('T')[0];
  const [rostersRes, fightersRes, nextEventRes, dropsRes] = await Promise.all([
    supabaseClient
      .from('rosters')
      .select('fighter_id, league_member_id')
      .eq('league_id', leagueIdRef),
    supabaseClient
      .from('fighters')
      .select('id, name, primary_division, current_rank, is_champion, photo_url')
      .order('is_champion', { ascending: false })
      .order('current_rank', { ascending: true, nullsFirst: false })
      .order('name'),
    // Fetch a small upcoming window so we can apply this league's overrides
    // and still pick the soonest effective event. The override could move
    // an event earlier or later, so a single-row query on global ufc_events
    // isn't enough.
    supabaseClient
      .from('ufc_events')
      .select('id, event_date')
      .gte('event_date', todayISO)
      .order('event_date', { ascending: true })
      .limit(8),
    supabaseClient
      .from('roster_drops')
      .select('fighter_id, dropped_at')
      .eq('league_id', leagueIdRef)
      .order('dropped_at', { ascending: false })
  ]);

  if (rostersRes.error || fightersRes.error) {
    el.innerHTML = EmptyState.html({
      kind:    'fighters',
      title:   'Couldn\'t load free agents',
      body:    'Refresh the page or try again in a moment.',
      compact: true
    });
    return;
  }

  // Which fighters are already owned by someone in this league?
  const ownedIds = new Set(rostersRes.data.map(function(r) { return r.fighter_id; }));

  const available = fightersRes.data.filter(function(f) { return !ownedIds.has(f.id); });

  if (available.length === 0) {
    el.innerHTML = EmptyState.html({
      kind:    'fighters',
      title:   'No free agents',
      body:    'Every fighter is rostered right now. Check back after the next waiver cycle.',
      compact: true
    });
    return;
  }

  // Decide button label per fighter. Two conditions force "Claim":
  //   1. League is currently in WINDOW_PRE / WINDOW_POST — every add this
  //      window queues as a claim and processes at the cutoff.
  //   2. The fighter was dropped within the rolling-waiver window
  //      (until 3am ET on drop_date_ET + 2 days).
  // If neither applies, the add is instant and the button reads "Add".
  const now = new Date();
  // Merge per-league overrides onto the upcoming-event window, then pick
  // the soonest effective event whose date is still today-or-later. This
  // ensures waiver phase math respects this league's override schedule.
  var rawNextEvents = (nextEventRes && nextEventRes.data) ? nextEventRes.data : [];
  var nextEventOverrides = await EventOverrides.fetchForLeague(supabaseClient, leagueIdRef, rawNextEvents.map(function(e){return e.id;}));
  var nextEventsMerged   = EventOverrides.mergeAll(rawNextEvents, nextEventOverrides);
  nextEventsMerged = nextEventsMerged
    .filter(function(e) { return e.event_date && e.event_date >= todayISO; })
    .sort(function(a, b) { return String(a.event_date).localeCompare(String(b.event_date)); });
  const nextEventDate = nextEventsMerged[0] ? nextEventsMerged[0].event_date : null;
  const phaseInfo = (typeof getWaiverPhase === 'function')
    ? getWaiverPhase(now, nextEventDate)
    : { phase: 'FA' };
  const inClaimWindow = phaseInfo.phase === 'WINDOW_PRE' || phaseInfo.phase === 'WINDOW_POST';

  // Build a fighter_id -> most recent dropped_at lookup. The query is
  // ordered desc, so the first hit per id is the freshest drop.
  const latestDropByFighter = {};
  (dropsRes && dropsRes.data ? dropsRes.data : []).forEach(function(d) {
    if (!latestDropByFighter[d.fighter_id]) latestDropByFighter[d.fighter_id] = d.dropped_at;
  });

  // Pre-draft, free agency is closed entirely — surface this directly on
  // the Top Free Agents widget so users don't get bounced into the waivers
  // page just to see the closed-banner message.
  const fasClosed = !leagueData.draft_completed;

  function buttonLabel(fighter) {
    if (fasClosed) return 'Add';
    if (inClaimWindow) return 'Claim';
    var droppedAt = latestDropByFighter[fighter.id];
    if (droppedAt && typeof isOnRollingWaiver === 'function' &&
        isOnRollingWaiver(new Date(droppedAt), now)) {
      return 'Claim';
    }
    // Post-draft FA still routes through waivers as a claim (matches
    // the waivers page logic — see decideAddMode in waivers.js).
    return 'Claim';
  }

  // Show top 5 available fighters
  el.innerHTML = available.slice(0, 5).map(function(fighter) {
    // Show "C" for champion, "#N" for ranked, "NR" for unranked
    const badge = fighter.is_champion ? 'C'
                : fighter.current_rank ? '#' + fighter.current_rank
                : 'NR';
    const divLabel = DIVISION_LABELS[fighter.primary_division] || fighter.primary_division;
    const label    = buttonLabel(fighter);

    return (
      '<div class="free-agent-row" ' +
           'data-open-fighter="' + escapeHtml(fighter.id) + '" ' +
           'tabindex="0" role="button" aria-label="' + escapeHtml(fighter.name) + ' details">' +
        '<div class="free-agent-row__photo-wrap">' +
          (fighter.photo_url
            ? '<img class="free-agent-row__photo" src="' + fighter.photo_url + '" alt="' + escapeHtml(fighter.name) + '" onerror="this.style.display=\'none\'">'
            : '') +
        '</div>' +
        '<div class="free-agent-row__info">' +
          '<span class="free-agent-row__name">'     + escapeHtml(fighter.name)   + '</span>' +
          '<span class="free-agent-row__division">' + escapeHtml(divLabel)        + '</span>' +
        '</div>' +
        '<span class="free-agent-row__ovr">' + badge + '</span>' +
        '<button class="btn-secondary free-agent-row__add" ' +
          (fasClosed ? 'disabled title="Available after the draft completes" ' : '') +
          'data-fighter-id="'   + fighter.id                    + '" ' +
          'data-fighter-name="' + escapeHtml(fighter.name)      + '">' +
          escapeHtml(label) +
        '</button>' +
      '</div>'
    );
  }).join('');

  // Wire each Add button. Hands off to the waivers page rather than
  // doing the insert inline — the waivers page is the single source of
  // truth for add/claim gating (rolling waivers on recently-dropped
  // fighters, claim windows, roster construction validation). Doing
  // an inline insert here previously let users re-add fighters they
  // had just dropped, bypassing the 48h rolling waiver hold.
  // stopPropagation so clicking the button doesn't also fire the row's
  // "open fighter modal" handler.
  el.querySelectorAll('.free-agent-row__add').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var fighterId = btn.getAttribute('data-fighter-id');
      window.location.href = 'waivers.html?id=' + leagueIdRef +
                             '&claim=' + encodeURIComponent(fighterId);
    });
  });

  // Row click opens the fighter modal. Same keyboard shortcut as the
  // Top Performers rows (Enter / Space).
  el.querySelectorAll('.free-agent-row[data-open-fighter]').forEach(function(row) {
    row.addEventListener('click', function() {
      var fid = row.getAttribute('data-open-fighter');
      if (fid && typeof showFighterModal === 'function') showFighterModal(fid);
    });
    row.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        var fid = row.getAttribute('data-open-fighter');
        if (fid && typeof showFighterModal === 'function') showFighterModal(fid);
      }
    });
  });
}

// ========================================================================
// TOP PERFORMERS WIDGET
// Replaces the hardcoded placeholder rows in the left panel of
// league-live-row with the actual top 5 scorers from the most recent
// completed event. Uses the shared Scoring engine + this league's
// scoring_config so the numbers match whatever the standings show.
// ========================================================================

function formatDivisionLabel(s) {
  if (!s) return '';
  if (s === 'strawweight')    return "Women's Strawweight";
  if (s === 'flyweight_w')    return "Women's Flyweight";
  if (s === 'bantamweight_w') return "Women's Bantamweight";
  // Men's divisions stay snake-case in the DB → display as Title Case
  return s.split('_').map(function (w) {
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

async function renderTopPerformers() {
  // Locate the Top Performers panel via its section label so we don't
  // depend on a specific position in the live-row.
  var panelLabel = null;
  document.querySelectorAll('.league-live-panel .section-label').forEach(function (lbl) {
    if (lbl.textContent.indexOf('Top Performers') === 0) panelLabel = lbl;
  });
  if (!panelLabel) return;
  var panel = panelLabel.closest('.league-live-panel');

  function showEmpty(message) {
    panel.querySelectorAll('.performer-row, .draft-empty').forEach(function (el) { el.remove(); });
    panelLabel.insertAdjacentHTML('afterend', '<p class="draft-empty">' + escapeHtml(message) + '</p>');
  }

  // 1. Most recent completed event. Pull `venue` too so we can apply the
  // same display rules used elsewhere ("UFC <City>" for Fight Nights,
  // "UFC APEX" for Vegas, numbered PPVs unchanged).
  var eventRes = await supabaseClient
    .from('ufc_events')
    .select('id, name, event_date, venue')
    .eq('is_completed', true)
    .order('event_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  var event = eventRes && eventRes.data ? eventRes.data : null;
  if (!event) {
    panelLabel.textContent = 'Top Performers';
    showEmpty('No completed events yet.');
    return;
  }
  // Apply this league's overrides so the panel's event name / date reflect
  // commissioner customization. fight_results stays linked to the global
  // ufc_events row, so this is purely a display tweak — scoring is unchanged.
  var topPerfOverrides = await EventOverrides.fetchForLeague(supabaseClient, leagueIdRef, [event.id]);
  event = EventOverrides.merge(event, topPerfOverrides[event.id]);

  // 2. Fight results for the event — full column list so the shared
  // Scoring engine has everything it needs to compute per-fighter scores.
  var fightRes = await supabaseClient
    .from('fight_results')
    .select(
      'id, event_id, fighter_a_id, fighter_b_id, winner_id, outcome, ' +
      'end_round, end_time_seconds, card_position, title_type, is_title_defense, ' +
      'fighter_a_sig_strikes, fighter_a_takedowns, fighter_a_knockdowns, fighter_a_control_seconds, ' +
      'fighter_b_sig_strikes, fighter_b_takedowns, fighter_b_knockdowns, fighter_b_control_seconds, ' +
      'fighter_a_opponent_rank, fighter_b_opponent_rank'
    )
    .eq('event_id', event.id)
    .not('outcome', 'is', null);
  var fights = (fightRes && fightRes.data) || [];

  panelLabel.textContent = 'Top Performers · ' + displayEventName(event);

  if (fights.length === 0) {
    showEmpty('No scored fights yet.');
    return;
  }

  // 3. Per-fighter scores. No-contests are skipped (the scoring engine
  // would still compute base activity points, but a NC isn't a "performer"
  // moment so it doesn't belong on this leaderboard).
  var scoringCfg = leagueData ? leagueData.scoring_config : null;
  var byFighter = {};
  fights.forEach(function (fight) {
    if (fight.outcome === 'no_contest') return;
    [true, false].forEach(function (isA) {
      var fid = isA ? fight.fighter_a_id : fight.fighter_b_id;
      if (!fid) return;
      var score = Scoring.computeFighterScore(fight, isA, scoringCfg);
      byFighter[fid] = score.total;
    });
  });

  var top = Object.keys(byFighter)
    .map(function (id) { return { id: id, pts: byFighter[id] }; })
    .sort(function (a, b) { return b.pts - a.pts; })
    .slice(0, 5);
  if (top.length === 0) {
    showEmpty('No scored fights yet.');
    return;
  }

  // 4. Fighter details + roster ownership for the top 5.
  var ids = top.map(function (t) { return t.id; });
  var supplemental = await Promise.all([
    supabaseClient.from('fighters').select('id, name, primary_division, photo_url').in('id', ids),
    supabaseClient.from('rosters').select('fighter_id, league_member_id').eq('league_id', leagueIdRef).in('fighter_id', ids)
  ]);
  var fighterMap = {};
  (supplemental[0].data || []).forEach(function (f) { fighterMap[f.id] = f; });
  var ownerMap = {};
  (supplemental[1].data || []).forEach(function (r) { ownerMap[r.fighter_id] = r.league_member_id; });
  var memberNameMap = {};
  (membersData || []).forEach(function (m) { memberNameMap[m.id] = m.team_name; });

  // 5. Render rows
  var rowsHtml = top.map(function (t, idx) {
    var f = fighterMap[t.id];
    if (!f) return '';
    var rank = idx + 1;
    var rankClass = rank === 1 ? ' performer-row--gold'
                  : rank === 2 ? ' performer-row--silver'
                  : rank === 3 ? ' performer-row--bronze' : '';
    var ownerId   = ownerMap[t.id];
    var ownerName = ownerId ? (memberNameMap[ownerId] || '—') : 'Free Agent';
    var division  = formatDivisionLabel(f.primary_division);
    var photoSrc  = f.photo_url ? ' src="' + escapeHtml(f.photo_url) + '"' : '';
    return (
      '<div class="performer-row' + rankClass + '" ' +
           'data-open-fighter="' + escapeHtml(f.id) + '" ' +
           'tabindex="0" role="button" aria-label="' + escapeHtml(f.name) + ' details">' +
        '<span class="performer-row__rank">' + rank + '</span>' +
        '<div class="performer-row__photo-wrap">' +
          '<img class="performer-row__photo"' + photoSrc + ' alt="' + escapeHtml(f.name) + '" onerror="this.style.display=\'none\'">' +
        '</div>' +
        '<div class="performer-row__info">' +
          '<span class="performer-row__name">' + escapeHtml(f.name) + '</span>' +
          '<span class="performer-row__division">' + escapeHtml(division) + '</span>' +
        '</div>' +
        '<div class="performer-row__right">' +
          '<span class="performer-row__pts">' + t.pts.toFixed(1) + '</span>' +
          '<span class="performer-row__owner">' + escapeHtml(ownerName) + '</span>' +
        '</div>' +
      '</div>'
    );
  }).join('');

  panel.querySelectorAll('.performer-row, .draft-empty').forEach(function (el) { el.remove(); });
  panelLabel.insertAdjacentHTML('afterend', rowsHtml);

  // Wire row clicks to open the fighter modal.
  panel.querySelectorAll('.performer-row[data-open-fighter]').forEach(function (row) {
    row.addEventListener('click', function () {
      var fid = row.getAttribute('data-open-fighter');
      if (fid && typeof showFighterModal === 'function') showFighterModal(fid);
    });
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        var fid = row.getAttribute('data-open-fighter');
        if (fid && typeof showFighterModal === 'function') showFighterModal(fid);
      }
    });
  });
}

initLeague();
