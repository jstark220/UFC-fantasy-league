// ========================================================================
// LEAGUE PAGE LOGIC
// Loads and displays a single league by ID (from the URL query param ?id=).
// Commissioner sees the invite code and remove-member buttons.
// Non-members are redirected to my-leagues.html.
// Depends on supabaseClient (supabase-config.js) and requireAuth (auth-guard.js).
// ========================================================================

// Escapes user-supplied strings before inserting into innerHTML to prevent XSS
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function initLeague() {
  const user = await requireAuth();
  if (!user) return;

  // Read the league ID from the URL query string (?id=UUID)
  const leagueId = new URLSearchParams(window.location.search).get('id');

  if (!leagueId) {
    // No ID in the URL - nothing to show, send back to the list
    window.location.href = 'my-leagues.html';
    return;
  }

  // ---- Fetch league data ----
  const { data: league, error: leagueError } = await supabaseClient
    .from('leagues')
    .select('id, name, format, draft_format, season_start_date, invite_code, commissioner_id, max_managers')
    .eq('id', leagueId)
    .single();

  if (leagueError || !league) {
    // RLS returned nothing, meaning this user is not a member (or the league doesn't exist)
    window.location.href = 'my-leagues.html';
    return;
  }

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

  const isCommissioner = league.commissioner_id === user.id;

  // ---- Reveal the page now that we've confirmed membership ----
  document.getElementById('pageContent').style.display = 'block';

  // Update the browser tab title
  document.title = league.name + ' - UFC Fantasy League';

  // ---- Render league name ----
  document.getElementById('leagueName').textContent = league.name;

  // ---- Render details grid ----
  const formatDisplay     = league.format === 'dynasty' ? 'Dynasty' : 'Season-Long';
  const draftFmtDisplay   = league.draft_format === 'auction' ? 'Auction Draft' : 'Snake Draft';
  const startDateDisplay  = league.season_start_date
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
    // TODO: disable remove buttons after draft locks (draft system not yet built)
    let actionsCell = '';
    if (isCommissioner && !memberIsCommissioner) {
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

  // ---- Wire up remove buttons (only present for commissioner) ----
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
      document.getElementById('memberCount').textContent = members.length;
      renderMembers(members, league, user, isCommissioner);
    });
  });
}

initLeague();
