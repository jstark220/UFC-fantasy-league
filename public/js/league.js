// ========================================================================
// LEAGUE PAGE LOGIC
// Loads and displays a single league by ID (from the URL query param ?id=).
// Commissioner sees the invite code, draft controls, and remove-member buttons.
// Non-members are redirected to my-leagues.html.
// Depends on supabaseClient (supabase-config.js) and requireAuth (auth-guard.js).
// ========================================================================

// Module-level state so all render functions and async handlers can share it
// without re-fetching from the server.
let leagueData  = null;
let membersData = [];
let userRef     = null;
let leagueIdRef = null;

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
    window.location.href = 'my-leagues.html';
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
    window.location.href = 'my-leagues.html';
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
    window.location.href = 'my-leagues.html';
    return;
  }

  // ---- Verify the current user is actually a member ----
  // RLS may allow reading the league row without being a member in some policies.
  // This client-side check is an extra safety layer.
  const isMember = members.some(function(m) { return m.user_id === user.id; });
  if (!isMember) {
    window.location.href = 'my-leagues.html';
    return;
  }
  membersData = members;

  const isCommissioner = league.commissioner_id === user.id;

  // ---- Reveal the page now that we've confirmed membership ----
  document.getElementById('pageContent').style.display = 'block';

  // Update the browser tab title
  document.title = league.name + ' - UFC Fantasy League';

  // ---- Render league name ----
  document.getElementById('leagueName').textContent = league.name;

  // ---- Show Rosters link once the draft has started ----
  if (league.draft_started) {
    document.getElementById('headerActions').innerHTML =
      '<a href="roster.html?id=' + leagueId + '" class="btn-gold">Rosters</a>';
  }

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
      '<a href="draft.html?id=' + leagueIdRef + '" class="btn-gold">View Draft Board</a>';
    return;
  }

  if (leagueData.draft_started) {
    el.innerHTML =
      '<p class="draft-status-note">Draft is currently in progress.</p>' +
      '<a href="draft.html?id=' + leagueIdRef + '" class="btn-gold">Enter Draft Room</a>';
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
        '<button class="btn-gold" id="startDraftBtn"' + startDisabled + '>Start Draft</button>' +
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

initLeague();
