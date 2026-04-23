// ========================================================================
// ROSTER PAGE LOGIC
// Displays any manager's roster for a given league, grouped by slot category.
// URL param: ?id=LEAGUE_UUID
// Defaults to the current user's own roster; a dropdown lets you browse others.
// Depends on supabaseClient (supabase-config.js) and requireAuth (auth-guard.js).
// ========================================================================

// Must match the weight_class enum in the database and the constants in draft.js
const MENS_DIVISIONS = [
  'flyweight', 'bantamweight', 'featherweight', 'lightweight',
  'welterweight', 'middleweight', 'light_heavyweight', 'heavyweight'
];
const WOMENS_DIVISIONS = ['strawweight', 'flyweight_w', 'bantamweight_w'];

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
// ========================================================================
let user, leagueId, league, members, myMemberId;
let allRosters = []; // all roster rows for the league, each with a nested fighters object

// ========================================================================
// INIT
// ========================================================================
async function initRoster() {
  user = await requireAuth();
  if (!user) return;

  leagueId = new URLSearchParams(window.location.search).get('id');
  if (!leagueId) { window.location.href = 'my-leagues.html'; return; }

  // Set the back link before data arrives
  document.getElementById('leagueLink').href = 'league.html?id=' + leagueId;

  // Load league, members, and all rosters for this league in parallel
  const [leagueRes, membersRes, rostersRes] = await Promise.all([
    supabaseClient
      .from('leagues')
      .select('id, name, draft_started, roster_size')
      .eq('id', leagueId)
      .single(),
    supabaseClient
      .from('league_members')
      .select('id, user_id, team_name')
      .eq('league_id', leagueId),
    // Join fighter details directly so we don't need a second query per manager
    supabaseClient
      .from('rosters')
      .select('id, league_member_id, draft_pick, draft_round, fighters(id, name, primary_division, current_rank, is_champion, record_wins, record_losses, record_draws)')
      .eq('league_id', leagueId)
      .order('draft_pick')
  ]);

  if (leagueRes.error || !leagueRes.data) {
    window.location.href = 'my-leagues.html';
    return;
  }

  league  = leagueRes.data;
  members = membersRes.data || [];

  // Verify the current user is a member of this league
  const myMember = members.find(function(m) { return m.user_id === user.id; });
  if (!myMember) { window.location.href = 'my-leagues.html'; return; }
  myMemberId = myMember.id;

  allRosters = rostersRes.data || [];

  // Set page title
  document.title = 'Rosters - ' + league.name;
  document.getElementById('leagueName').textContent = league.name;

  // If the draft hasn't started there are no rosters to show yet
  if (!league.draft_started) {
    document.getElementById('pageContent').style.display = 'block';
    document.getElementById('rosterContent').innerHTML =
      '<div class="empty-state"><p>The draft hasn\'t started yet. Check back after the draft!</p></div>';
    return;
  }

  // Allow linking directly to a specific team via ?member=MEMBER_ID (e.g. from standings)
  const memberParam = new URLSearchParams(window.location.search).get('member');
  const defaultMemberId = (memberParam && members.find(function(m) { return m.id === memberParam; }))
    ? memberParam
    : myMemberId;

  populateManagerSelect(defaultMemberId);
  renderRoster(defaultMemberId);

  document.getElementById('pageContent').style.display = 'block';
}

// ========================================================================
// MANAGER SELECT DROPDOWN
// Defaults to the current user's team; changing it re-renders the roster.
// ========================================================================
function populateManagerSelect(defaultMemberId) {
  const select = document.getElementById('managerSelect');

  members.forEach(function(m) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.team_name + (m.id === myMemberId ? ' (you)' : '');
    if (m.id === defaultMemberId) opt.selected = true;
    select.appendChild(opt);
  });

  select.addEventListener('change', function() {
    renderRoster(this.value);
  });
}

// ========================================================================
// RENDER ROSTER
// Takes a league_member_id, pulls their picks from allRosters, assigns each
// fighter to a slot category, then renders sections grouped by slot.
// ========================================================================
function renderRoster(memberId) {
  // Get this manager's picks in pick order
  const memberPicks = allRosters
    .filter(function(r) { return r.league_member_id === memberId; })
    .sort(function(a, b) { return a.draft_pick - b.draft_pick; });

  const totalPicks  = memberPicks.length;
  const rosterSize  = league.roster_size || 20;

  // Update the summary line above the sections
  document.getElementById('rosterSummary').textContent =
    totalPicks + ' / ' + rosterSize + ' picks';

  if (totalPicks === 0) {
    document.getElementById('rosterContent').innerHTML =
      '<div class="empty-state"><p>No picks yet for this team.</p></div>';
    return;
  }

  // Extract the nested fighter objects (Supabase returns them under the key 'fighters')
  const fighters = memberPicks
    .map(function(r) { return r.fighters; })
    .filter(Boolean);

  // Assign each fighter to its slot category using the same greedy rules
  // that were enforced during the draft
  const assigned = assignSlots(fighters);

  // Group assigned fighters by their slot type key
  const groups = {};
  MENS_DIVISIONS.forEach(function(d) { groups[d] = []; });
  groups['women_flex'] = [];
  groups['any_flex']   = [];

  assigned.forEach(function(item) {
    if (groups[item.slotType] !== undefined) {
      groups[item.slotType].push(item.fighter);
    }
  });

  let html = '';

  // Render a section for each men's division that has at least one pick
  MENS_DIVISIONS.forEach(function(div) {
    if (groups[div].length === 0) return;
    html += renderSection(DIVISION_LABELS[div], groups[div], 2);
  });

  // Women's flex section
  if (groups['women_flex'].length > 0) {
    html += renderSection("Women's Flex", groups['women_flex'], 2);
  }

  // Any-division flex section
  if (groups['any_flex'].length > 0) {
    html += renderSection('Any-Division Flex', groups['any_flex'], 2);
  }

  document.getElementById('rosterContent').innerHTML = html;
}

// ========================================================================
// ASSIGN SLOTS
// Mirrors the canPick logic from draft.js. Given an array of fighter objects
// in draft order, greedily assigns each to its slot category.
// ========================================================================
function assignSlots(fighters) {
  const menCounts = {};
  MENS_DIVISIONS.forEach(function(d) { menCounts[d] = 0; });
  let womenCount = 0;
  let flexCount  = 0;

  return fighters.map(function(f) {
    const isWoman = WOMENS_DIVISIONS.includes(f.primary_division);

    if (isWoman) {
      if (womenCount < 2) {
        womenCount++;
        return { fighter: f, slotType: 'women_flex' };
      } else {
        flexCount++;
        return { fighter: f, slotType: 'any_flex' };
      }
    } else {
      const divCount = menCounts[f.primary_division] || 0;
      if (divCount < 2) {
        menCounts[f.primary_division] = divCount + 1;
        return { fighter: f, slotType: f.primary_division };
      } else {
        flexCount++;
        return { fighter: f, slotType: 'any_flex' };
      }
    }
  });
}

// ========================================================================
// RENDER SECTION
// Produces one slot-category section: a header with pip dots + a fighter table.
// ========================================================================
function renderSection(title, fighters, totalSlots) {
  const pipsHtml = renderPips(fighters.length, totalSlots);

  let html = '<div class="section roster-section">';
  html += '<div class="roster-section-header">';
  html += '<span class="roster-section-title">' + escapeHtml(title) + '</span>';
  html += '<span class="roster-section-pips">' + pipsHtml + '</span>';
  html += '</div>';

  html += '<table class="roster-table">';
  html += '<thead><tr><th>Rank</th><th>Name</th><th>Record</th></tr></thead>';
  html += '<tbody>';

  fighters.forEach(function(f) {
    const rankDisplay = f.is_champion
      ? 'C'
      : (f.current_rank ? '#' + f.current_rank : '-');

    const rankClass = f.is_champion
      ? 'rank-champion'
      : (f.current_rank ? 'rank-ranked' : 'rank-unranked');

    const record = f.record_wins + '-' + f.record_losses + '-' + f.record_draws;

    html += '<tr>';
    html += '<td><span class="' + rankClass + '">' + escapeHtml(rankDisplay) + '</span></td>';
    html += '<td>' + escapeHtml(f.name) + '</td>';
    html += '<td>' + record + '</td>';
    html += '</tr>';
  });

  html += '</tbody></table>';
  html += '</div>';

  return html;
}

// Renders filled/empty pip dots for a slot category
function renderPips(filled, total) {
  let html = '';
  for (let i = 0; i < total; i++) {
    html += '<span class="pip ' + (i < filled ? 'pip-filled' : 'pip-empty') + '"></span>';
  }
  return html;
}

// Escapes user-supplied strings before inserting into innerHTML to prevent XSS
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

initRoster();
