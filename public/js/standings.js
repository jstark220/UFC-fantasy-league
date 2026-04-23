// ========================================================================
// STANDINGS PAGE LOGIC
// Shows cumulative fantasy points for every manager in the league, sorted
// from highest to lowest. Data comes from the scores table (summed per
// manager per event). When no events have been scored yet, all managers
// show 0.00 pts — the table still renders so the page is ready to go.
// URL param: ?id=LEAGUE_UUID
// Depends on supabaseClient (supabase-config.js) and requireAuth (auth-guard.js).
// ========================================================================

let user, leagueId, league, members, myMemberId;
let allScores = [];

async function initStandings() {
  user = await requireAuth();
  if (!user) return;

  leagueId = new URLSearchParams(window.location.search).get('id');
  if (!leagueId) { window.location.href = 'my-leagues.html'; return; }

  document.getElementById('leagueLink').href = 'league.html?id=' + leagueId;

  // Load everything in parallel
  const [leagueRes, membersRes, scoresRes] = await Promise.all([
    supabaseClient
      .from('leagues')
      .select('id, name, commissioner_id')
      .eq('id', leagueId)
      .single(),
    supabaseClient
      .from('league_members')
      .select('id, user_id, team_name')
      .eq('league_id', leagueId),
    // Fetch individual score rows; we sum them in JS grouped by member and event.
    // total_points is the per-fighter score for a single fight on a single event.
    supabaseClient
      .from('scores')
      .select('league_member_id, event_id, total_points')
      .eq('league_id', leagueId)
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

  allScores = scoresRes.data || [];

  document.title    = 'Standings - ' + league.name;
  document.getElementById('leagueName').textContent = league.name;

  const totals = buildTotals();
  renderStandings(totals);
  renderEventHistory(totals);

  document.getElementById('pageContent').style.display = 'block';
}

// ========================================================================
// BUILD TOTALS
// Aggregates the scores rows into per-member stats:
//   total          - cumulative points across all events
//   eventsPlayed   - how many distinct events this member has scores for
//   eventPts       - map of event_id -> total points that event
// ========================================================================
function buildTotals() {
  const map = {};

  // Seed every member at zero so they appear even with no score rows
  members.forEach(function(m) {
    map[m.id] = { total: 0, eventsPlayed: 0, eventPts: {} };
  });

  allScores.forEach(function(s) {
    if (!map[s.league_member_id]) return;
    const pts = s.total_points || 0;
    map[s.league_member_id].total += pts;
    // Sum multiple fighter scores within the same event into one event total
    map[s.league_member_id].eventPts[s.event_id] =
      (map[s.league_member_id].eventPts[s.event_id] || 0) + pts;
  });

  // Compute derived fields once the per-event breakdown is complete
  members.forEach(function(m) {
    const evPts    = map[m.id].eventPts;
    const eventIds = Object.keys(evPts);
    map[m.id].eventsPlayed = eventIds.length;
    // Last event points - uses insertion order of eventIds.
    // TODO: sort by event_date once ufc_events data is available, then use the latest.
    map[m.id].lastEventPts =
      eventIds.length > 0 ? evPts[eventIds[eventIds.length - 1]] : null;
  });

  return map;
}

// ========================================================================
// RENDER STANDINGS TABLE
// ========================================================================
function renderStandings(totals) {
  // Sort: highest total first; alphabetical as a tiebreaker
  const sorted = members.slice().sort(function(a, b) {
    const diff = totals[b.id].total - totals[a.id].total;
    return diff !== 0 ? diff : a.team_name.localeCompare(b.team_name);
  });

  const tbody = document.getElementById('standingsBody');
  tbody.innerHTML = '';

  sorted.forEach(function(member, idx) {
    const data = totals[member.id];
    const rank  = idx + 1;
    const total = data.total.toFixed(2);
    const avg   = data.eventsPlayed > 0
      ? (data.total / data.eventsPlayed).toFixed(2)
      : '-';
    const last  = data.lastEventPts !== null
      ? data.lastEventPts.toFixed(2)
      : '-';
    const isMe  = member.id === myMemberId;

    const row = document.createElement('tr');
    if (isMe) row.className = 'standings-row-me';

    // Team name links through to that manager's roster on the roster page
    row.innerHTML =
      '<td><span class="rank-badge rank-pos-' + rank + '">' + rank + '</span></td>' +
      '<td>' +
        '<a href="roster.html?id=' + leagueId + '&member=' + member.id + '" class="standings-team-link">' +
          escapeHtml(member.team_name) +
        '</a>' +
        (isMe ? ' <span class="standings-you-tag">(you)</span>' : '') +
      '</td>' +
      '<td class="pts-cell">' + total + '</td>' +
      '<td class="pts-cell">' + avg + '</td>' +
      '<td class="pts-cell">' + last + '</td>';

    tbody.appendChild(row);
  });
}

// ========================================================================
// RENDER EVENT HISTORY
// Shows a per-event points breakdown once scoring data exists.
// ========================================================================
function renderEventHistory(totals) {
  const historyEl = document.getElementById('eventHistory');

  // Collect every event_id that appears in any member's breakdown
  const eventIdSet = {};
  members.forEach(function(m) {
    Object.keys(totals[m.id].eventPts).forEach(function(eid) {
      eventIdSet[eid] = true;
    });
  });
  const eventIds = Object.keys(eventIdSet);

  if (eventIds.length === 0) {
    historyEl.innerHTML =
      '<p class="standings-empty">No events have been scored yet. ' +
      'Points will appear here after the commissioner enters results for each event.</p>';
    return;
  }

  // TODO: join with ufc_events to show human-readable event names and sort by date.
  // For now, render a simple per-event pts column for each scored event.
  // Sort members the same way as the standings table
  const sorted = members.slice().sort(function(a, b) {
    return totals[b.id].total - totals[a.id].total;
  });

  let html = '<table><thead><tr><th>Team</th>';
  eventIds.forEach(function(eid) {
    // Show only the first 8 characters of the event UUID until event names are available
    html += '<th class="th-pts">Event ' + escapeHtml(eid.substring(0, 8)) + '...</th>';
  });
  html += '</tr></thead><tbody>';

  sorted.forEach(function(member) {
    const isMe = member.id === myMemberId;
    html += '<tr' + (isMe ? ' class="standings-row-me"' : '') + '>';
    html += '<td>' + escapeHtml(member.team_name) + '</td>';
    eventIds.forEach(function(eid) {
      const pts = totals[member.id].eventPts[eid];
      html += '<td class="pts-cell">' + (pts !== undefined ? pts.toFixed(2) : '-') + '</td>';
    });
    html += '</tr>';
  });

  html += '</tbody></table>';
  historyEl.innerHTML = html;
}

// Escapes user-supplied strings before inserting into innerHTML to prevent XSS
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

initStandings();
