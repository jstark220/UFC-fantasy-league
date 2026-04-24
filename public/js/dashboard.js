// ========================================================================
// DASHBOARD PAGE LOGIC
// Checks auth, then fetches the user's leagues to populate the stat strip
// and league list. Shows an empty state if the user has no leagues.
// Depends on supabaseClient (supabase-config.js) and requireAuth (auth-guard.js).
// ========================================================================

async function initDashboard() {
  const user = await requireAuth();
  if (!user) return;

  // Auth confirmed — reveal the page
  document.getElementById('dashboardContent').style.display = 'block';

  // Use the local part of the email as a display name until profiles exist
  const username = user.email.split('@')[0];
  document.getElementById('welcomeName').textContent = username;

  // ---- Fetch the user's league memberships with league details ----
  const { data: memberships, error } = await supabaseClient
    .from('league_members')
    .select('team_name, league_id, leagues(id, name, format, max_managers)')
    .eq('user_id', user.id);

  if (error) {
    document.getElementById('leaguesEmpty').style.display = 'block';
    document.getElementById('leaguesEmpty').querySelector('.dashboard-empty__title').textContent =
      'Error loading leagues: ' + error.message;
    return;
  }

  // Update the Active Leagues stat chip with the real count
  document.getElementById('statLeagues').textContent =
    memberships ? memberships.length : 0;

  // No leagues: show empty state
  if (!memberships || memberships.length === 0) {
    document.getElementById('leaguesEmpty').style.display = 'block';
    return;
  }

  // ---- Fetch member counts for each league ----
  const leagueIds = memberships.map(function(m) { return m.league_id; });

  const { data: allMembers } = await supabaseClient
    .from('league_members')
    .select('league_id')
    .in('league_id', leagueIds);

  // Build a lookup of { leagueId: memberCount }
  var memberCounts = {};
  if (allMembers) {
    allMembers.forEach(function(m) {
      memberCounts[m.league_id] = (memberCounts[m.league_id] || 0) + 1;
    });
  }

  // ---- Render a compact row for each league ----
  var listEl = document.getElementById('leaguesList');
  var wrap = document.createElement('div');
  wrap.className = 'dashboard-league-list';

  memberships.forEach(function(membership) {
    var league = membership.leagues;
    var memberCount = memberCounts[membership.league_id] || 0;
    var formatLabel = league.format === 'dynasty' ? 'Dynasty' : 'Season-Long';

    var row = document.createElement('div');
    row.className = 'dashboard-league-row';
    row.innerHTML =
      '<div class="dashboard-league-row__info">' +
        '<p class="dashboard-league-row__name">' + escapeHtml(league.name) + '</p>' +
        '<p class="dashboard-league-row__meta">' +
          formatLabel + ' &middot; ' +
          memberCount + ' / ' + league.max_managers + ' managers &middot; ' +
          'Your team: ' + escapeHtml(membership.team_name) +
        '</p>' +
      '</div>' +
      '<a href="league.html?id=' + league.id + '" class="btn-secondary">View league</a>';

    wrap.appendChild(row);
  });

  listEl.appendChild(wrap);
}

// Escapes user-supplied strings before inserting into innerHTML to prevent XSS
function escapeHtml(str) {
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

initDashboard();
