// ========================================================================
// MY LEAGUES PAGE LOGIC
// Loads all leagues the current user belongs to and renders them as cards.
// Depends on supabaseClient (supabase-config.js) and requireAuth (auth-guard.js).
// ========================================================================

async function initMyLeagues() {
  const user = await requireAuth();
  if (!user) return;

  document.getElementById('pageContent').style.display = 'block';

  const listEl = document.getElementById('leagueList');

  // ---- Step 1: fetch the user's league memberships with league details ----
  // Supabase lets us join a related table inline using the FK relationship.
  // This returns each membership row with the full leagues row nested inside.
  const { data: memberships, error } = await supabaseClient
    .from('league_members')
    .select('team_name, league_id, is_commissioner, leagues(id, name, format, commissioner_id, max_managers)')
    .eq('user_id', user.id);

  if (error) {
    listEl.innerHTML = '<p style="color: red;">Error loading leagues: ' + error.message + '</p>';
    return;
  }

  // No leagues yet - show empty state with action prompts
  if (!memberships || memberships.length === 0) {
    listEl.innerHTML =
      '<div class="empty-state">' +
        '<p>You are not in any leagues yet.</p>' +
        '<a href="create-league.html" class="btn-gold">Create a League</a> &nbsp;' +
        '<a href="join-league.html" class="btn-secondary">Join a League</a>' +
      '</div>';
    return;
  }

  // ---- Step 2: fetch member counts for all the user's leagues ----
  // We get all league_member rows for those leagues so we can count per league.
  const leagueIds = memberships.map(function(m) { return m.league_id; });

  const { data: allMembers, error: countError } = await supabaseClient
    .from('league_members')
    .select('league_id')
    .in('league_id', leagueIds);

  // Count members per league_id into a plain object { leagueId: count }
  const memberCounts = {};
  if (allMembers) {
    allMembers.forEach(function(m) {
      memberCounts[m.league_id] = (memberCounts[m.league_id] || 0) + 1;
    });
  }

  // ---- Step 3: render a card for each league ----
  listEl.innerHTML = '';
  const listDiv = document.createElement('div');
  listDiv.className = 'league-list';

  memberships.forEach(function(membership) {
    const league = membership.leagues;
    // Three-tier role: primary owner / co-commissioner / plain member.
    const isPrimary   = Commissioner.isPrimaryCommissioner(league, user.id);
    const isCoCommish = !isPrimary && membership.is_commissioner === true;
    // Anything that gates by "is a commissioner" should treat the two
    // commissioner tiers the same — kept as a single boolean for consumers.
    const isCommissioner = isPrimary || isCoCommish;
    const memberCount = memberCounts[membership.league_id] || 0;

    // Format display values from enum strings
    const formatDisplay = league.format === 'dynasty' ? 'Dynasty' : 'Season-Long';
    var roleDisplay, badgeClass;
    if (isPrimary)         { roleDisplay = 'Commissioner';     badgeClass = 'badge-commissioner'; }
    else if (isCoCommish)  { roleDisplay = 'Co-commissioner';  badgeClass = 'badge-co-commissioner'; }
    else                   { roleDisplay = 'Member';           badgeClass = 'badge-member'; }

    const card = document.createElement('div');
    card.className = 'league-card';
    card.innerHTML =
      '<div class="league-card-info">' +
        '<p class="league-card-name">' + escapeHtml(league.name) + '</p>' +
        '<div class="league-card-meta">' +
          '<span>' + formatDisplay + '</span>' +
          '<span>' + memberCount + ' / ' + league.max_managers + ' managers</span>' +
          '<span>Your team: ' + escapeHtml(membership.team_name) + '</span>' +
          '<span class="badge ' + badgeClass + '">' + roleDisplay + '</span>' +
        '</div>' +
      '</div>' +
      '<a href="league.html?id=' + league.id + '" class="btn-secondary">View</a>';

    listDiv.appendChild(card);
  });

  listEl.appendChild(listDiv);
}

// Escapes user-supplied strings before inserting into innerHTML to prevent XSS
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

initMyLeagues();
