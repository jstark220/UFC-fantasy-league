// ========================================================================
// DASHBOARD PAGE LOGIC
// Checks auth, then fetches the user's leagues to populate the stat strip
// and league list. Shows an empty state if the user has no leagues.
// Depends on supabaseClient (supabase-config.js) and requireAuth (auth-guard.js).
// ========================================================================

async function initDashboard() {
  const user = await requireAuth();
  if (!user) return;

  // OAuth redirect lands here with ?next=/path if the user was deep-linked
  // (e.g., invite URL) before signing in. Forward them onward immediately
  // and skip the dashboard render — they didn't ask to see it.
  const next = new URLSearchParams(window.location.search).get('next');
  if (next && next.charAt(0) === '/') {
    window.location.replace(next);
    return;
  }

  // Auth confirmed — reveal the page
  document.getElementById('dashboardContent').style.display = 'block';

  // Prefer the user's saved display_name from profiles; fall back to the
  // local part of their email if they haven't set one yet.
  const fallback = (user.email || '').split('@')[0];
  const { data: profile } = await supabaseClient
    .from('profiles')
    .select('display_name')
    .eq('id', user.id)
    .maybeSingle();
  const displayName = (profile && profile.display_name) || fallback;
  document.getElementById('welcomeName').textContent = displayName;

  // ---- Fetch the user's league memberships with league details ----
  // Also pull is_commissioner (per-member co-commissioner flag) and
  // leagues.commissioner_id (primary owner) so we can show a Commish
  // badge inline with each league row.
  const { data: memberships, error } = await supabaseClient
    .from('league_members')
    .select('team_name, league_id, is_commissioner, leagues(id, name, format, max_managers, commissioner_id)')
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

    // Commissioner of this league? Primary owner (leagues.commissioner_id)
    // OR a co-commissioner (league_members.is_commissioner). Mirrors the
    // logic in Commissioner.memberIsCommissioner so the badge matches the
    // gating everywhere else in the app.
    var isCommish = (league.commissioner_id === user.id) ||
                    (membership.is_commissioner === true);

    var commishBadge = isCommish
      ? '<span class="commish-badge" title="You\'re a commissioner of this league">Commish</span>'
      : '';

    var row = document.createElement('div');
    row.className = 'dashboard-league-row';
    row.innerHTML =
      '<div class="dashboard-league-row__info">' +
        '<p class="dashboard-league-row__name">' +
          escapeHtml(league.name) +
          commishBadge +
        '</p>' +
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
