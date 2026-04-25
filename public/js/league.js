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
let myMemberId  = null;  // current user's league_members.id, needed for roster inserts

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
  // draft_started, draft_completed, draft_order, roster_size added to support draft setup UI
  const { data: league, error: leagueError } = await supabaseClient
    .from('leagues')
    .select('id, name, format, draft_format, season_start_date, invite_code, commissioner_id, max_managers, draft_started, draft_completed, draft_order, roster_size')
    .eq('id', leagueId)
    .single();

  if (leagueError || !league) {
    // RLS returned nothing, meaning this user is not a member (or the league doesn't exist)
    window.location.href = 'dashboard.html';
    return;
  }
  leagueData = league;

  // ---- Fetch member list ----
  // Declared with let so the remove handler can update the local copy without reloading
  let { data: members, error: membersError } = await supabaseClient
    .from('league_members')
    .select('id, team_name, user_id')
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

  const isCommissioner = league.commissioner_id === user.id;

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

  // ---- Render nav links in the page header ----
  // Standings is always visible. Lineup/Waivers/Trades appear once the draft starts.
  var navHtml = '<a href="standings.html?id=' + leagueId + '" class="btn-secondary">Standings</a>';
  if (league.draft_started && !league.draft_completed) {
    navHtml += '<a href="draft.html?id=' + leagueId + '" class="btn-primary">Draft Room</a>';
  }
  if (league.draft_started) {
    navHtml += '<a href="waivers.html?id=' + leagueId + '" class="btn-secondary">Waivers</a>';
    navHtml += '<a href="trades.html?id=' + leagueId + '" class="btn-secondary">Trades</a>';
    if (league.draft_completed) {
      navHtml += '<a href="lineup.html?id=' + leagueId + '" class="btn-primary">Lineup</a>';
    }
  }
  if (isCommissioner && league.draft_started) {
    navHtml += '<a href="score-event.html?league=' + leagueId + '" class="btn-secondary">Score Event</a>';
  }
  document.getElementById('headerActions').innerHTML = navHtml;

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
          document.getElementById('copyInviteBtn').textContent = 'Copy';
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
}

// ========================================================================
// RENDER DRAFT SECTION
// Shows different UI based on current draft state. Called on load and again
// whenever the Realtime subscription delivers a league UPDATE.
// ========================================================================
function renderDraftSection() {
  const el = document.getElementById('draftContent');
  const isCommissioner = leagueData.commissioner_id === userRef.id;

  if (leagueData.draft_completed) {
    el.innerHTML =
      '<p class="draft-status-note">The draft is complete.</p>' +
      '<a href="draft.html?id=' + leagueIdRef + '" class="btn-secondary">View Draft Board</a>';
    return;
  }

  if (leagueData.draft_started) {
    el.innerHTML =
      '<p class="draft-status-note">Draft is currently in progress.</p>' +
      '<a href="draft.html?id=' + leagueIdRef + '" class="btn-primary">Enter Draft Room</a>';
    return;
  }

  // Draft has not started yet
  const orderHtml = renderDraftOrderList();

  if (isCommissioner) {
    // Commissioner controls: randomize order, preview it, then start
    // Start Draft button is disabled until a draft order has been saved
    const startDisabled = !leagueData.draft_order ? ' disabled' : '';

    el.innerHTML =
      '<p class="draft-status-note">Set the draft order, then start the draft when all managers have joined.</p>' +
      '<div id="draftOrderPreview">' + orderHtml + '</div>' +
      '<div class="draft-actions">' +
        '<button class="btn-secondary" id="randomizeBtn">Randomize Order</button>' +
        '<button class="btn-primary" id="startDraftBtn"' + startDisabled + '>Start Draft</button>' +
      '</div>';

    document.getElementById('randomizeBtn').addEventListener('click', randomizeDraftOrder);
    document.getElementById('startDraftBtn').addEventListener('click', startDraft);
  } else {
    // Non-commissioner sees the order (if set) and a waiting message
    el.innerHTML =
      '<p class="draft-status-note">Waiting for the commissioner to start the draft.</p>' +
      '<div id="draftOrderPreview">' + orderHtml + '</div>';
  }
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
// RANDOMIZE DRAFT ORDER
// Fisher-Yates shuffle of the current member IDs, then saves the result
// to leagues.draft_order. Re-renders the draft section on success.
// ========================================================================
async function randomizeDraftOrder() {
  const btn = document.getElementById('randomizeBtn');
  btn.disabled = true;
  btn.textContent = 'Randomizing...';

  // Build an array of member IDs and shuffle it in place
  const order = membersData.map(function(m) { return m.id; });
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = order[i];
    order[i] = order[j];
    order[j] = temp;
  }

  const { error } = await supabaseClient
    .from('leagues')
    .update({ draft_order: order })
    .eq('id', leagueIdRef);

  if (error) {
    alert('Error saving draft order: ' + error.message);
    btn.disabled = false;
    btn.textContent = 'Randomize Order';
    return;
  }

  // Update local state and re-render so the new order appears immediately
  leagueData.draft_order = order;
  renderDraftSection();
}

// ========================================================================
// START DRAFT
// Sets draft_started = true in the DB. The commissioner is redirected here
// immediately; all other members are redirected via the Realtime subscription.
// ========================================================================
async function startDraft() {
  if (!confirm('Start the draft? This cannot be undone.')) return;

  const btn = document.getElementById('startDraftBtn');
  btn.disabled = true;
  btn.textContent = 'Starting...';

  const { error } = await supabaseClient
    .from('leagues')
    .update({ draft_started: true })
    .eq('id', leagueIdRef);

  if (error) {
    alert('Error starting draft: ' + error.message);
    btn.disabled = false;
    btn.textContent = 'Start Draft';
    return;
  }

  window.location.href = 'draft.html?id=' + leagueIdRef;
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
    const memberIsCommissioner = member.user_id === league.commissioner_id;
    const badgeClass = memberIsCommissioner ? 'badge-commissioner' : 'badge-member';
    const roleLabel  = memberIsCommissioner ? 'Commissioner' : 'Member';

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

  // Fetch all roster rows for this league and all fighters in parallel
  const [rostersRes, fightersRes] = await Promise.all([
    supabaseClient
      .from('rosters')
      .select('fighter_id, league_member_id')
      .eq('league_id', leagueIdRef),
    supabaseClient
      .from('fighters')
      .select('id, name, primary_division, current_rank, is_champion, photo_url')
      .order('is_champion', { ascending: false })
      .order('current_rank', { ascending: true, nullsFirst: false })
      .order('name')
  ]);

  if (rostersRes.error || fightersRes.error) {
    el.innerHTML = '<p class="draft-empty">Could not load free agents.</p>';
    return;
  }

  // Which fighters are already owned by someone in this league?
  const ownedIds = new Set(rostersRes.data.map(function(r) { return r.fighter_id; }));

  // How many fighters is the current user already carrying?
  const myRosterCount = rostersRes.data.filter(function(r) {
    return r.league_member_id === myMemberId;
  }).length;

  const available = fightersRes.data.filter(function(f) { return !ownedIds.has(f.id); });

  if (available.length === 0) {
    el.innerHTML = '<p class="draft-empty">No free agents available.</p>';
    return;
  }

  // Show top 5 available fighters
  el.innerHTML = available.slice(0, 5).map(function(fighter) {
    // Show "C" for champion, "#N" for ranked, "NR" for unranked
    const badge = fighter.is_champion ? 'C'
                : fighter.current_rank ? '#' + fighter.current_rank
                : 'NR';
    const divLabel = DIVISION_LABELS[fighter.primary_division] || fighter.primary_division;

    return (
      '<div class="free-agent-row">' +
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
          'data-fighter-id="'   + fighter.id                    + '" ' +
          'data-fighter-name="' + escapeHtml(fighter.name)      + '">' +
          'Add' +
        '</button>' +
      '</div>'
    );
  }).join('');

  // Wire each Add button
  el.querySelectorAll('.free-agent-row__add').forEach(function(btn) {
    btn.addEventListener('click', async function() {
      const fighterId   = btn.getAttribute('data-fighter-id');
      const fighterName = btn.getAttribute('data-fighter-name');
      const rosterMax   = leagueData.roster_size || 20;

      // If the roster is already full, send them to the full waivers flow
      if (myRosterCount >= rosterMax) {
        if (confirm(
          'Your roster is full (' + myRosterCount + '/' + rosterMax + ').\n' +
          'Go to the Waivers page to drop a player first?'
        )) {
          window.location.href = 'waivers.html?id=' + leagueIdRef;
        }
        return;
      }

      btn.disabled    = true;
      btn.textContent = 'Adding...';

      const { error } = await supabaseClient
        .from('rosters')
        .insert({
          league_id:        leagueIdRef,
          league_member_id: myMemberId,
          fighter_id:       fighterId
        });

      if (error) {
        alert('Error adding ' + fighterName + ': ' + error.message);
        btn.disabled    = false;
        btn.textContent = 'Add';
        return;
      }

      // Refresh the list so the newly-added fighter disappears
      await loadFreeAgents();
    });
  });
}

initLeague();
