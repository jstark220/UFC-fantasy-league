// ========================================================================
// STANDINGS PAGE
// Shows cumulative fantasy points for every manager in the league, sorted
// highest to lowest, with per-period breakdowns.
// URL param: ?id=LEAGUE_UUID
// Depends on: supabaseClient (supabase-config.js), requireAuth (auth-guard.js)
// ========================================================================

var leagueId;

async function initStandings() {
  var user = await requireAuth();
  if (!user) return;

  leagueId = new URLSearchParams(window.location.search).get('id');
  if (!leagueId) { window.location.href = 'dashboard.html'; return; }

  document.getElementById('leagueLink').href = 'league.html?id=' + leagueId;

  var results = await Promise.all([
    supabaseClient
      .from('leagues')
      .select('id, name')
      .eq('id', leagueId)
      .single(),

    supabaseClient
      .from('league_members')
      .select('id, user_id, team_name')
      .eq('league_id', leagueId),

    // Join scores with the event so we can group by date for period columns
    supabaseClient
      .from('scores')
      .select('league_member_id, total_points, event:ufc_events(id, event_date)')
      .eq('league_id', leagueId)
  ]);

  var leagueRes  = results[0];
  var membersRes = results[1];
  var scoresRes  = results[2];

  if (leagueRes.error || !leagueRes.data) {
    window.location.href = 'dashboard.html';
    return;
  }

  var league  = leagueRes.data;
  var members = membersRes.data || [];
  var scores  = scoresRes.data  || [];

  var myMember = members.find(function(m) { return m.user_id === user.id; });
  if (!myMember) { window.location.href = 'dashboard.html'; return; }

  document.title = 'Standings - ' + league.name;
  document.getElementById('leagueName').textContent = league.name;

  var nav = '<a href="standings.html?id=' + leagueId + '" class="btn-primary">Standings</a>';
  nav    += '<a href="waivers.html?id='   + leagueId + '" class="btn-secondary">Free Agency</a>';
  nav    += '<a href="trades.html?id='    + leagueId + '" class="btn-secondary">Trades</a>';
  nav    += '<a href="lineup.html?id='    + leagueId + '" class="btn-secondary">My Lineup</a>';
  document.getElementById('headerActions').innerHTML = nav;

  var standings = computeStandings(members, scores);
  renderStandings(standings, myMember.id);

  document.getElementById('pageContent').style.display = 'block';
}

// ========================================================================
// COMPUTE STANDINGS
// Returns members sorted by total points descending, each entry annotated
// with total, lastEvent (points at the most recently scored event), and
// last30d (points from events within the past 30 days).
// ========================================================================
function computeStandings(members, scores) {
  var today = new Date();
  today.setHours(23, 59, 59, 999);
  var thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // Find the event_id with the latest event_date among all scored events
  var latestEventId   = null;
  var latestEventDate = null;
  scores.forEach(function(s) {
    if (!s.event) return;
    var d = new Date(s.event.event_date + 'T12:00:00');
    if (!latestEventDate || d > latestEventDate) {
      latestEventDate = d;
      latestEventId   = s.event.id;
    }
  });

  // Seed every member at zero so all appear even with no score rows
  var memberMap = {};
  members.forEach(function(m) {
    memberMap[m.id] = { total: 0, lastEvent: 0, last30d: 0 };
  });

  scores.forEach(function(s) {
    if (!memberMap[s.league_member_id]) return;
    var pts = s.total_points || 0;
    memberMap[s.league_member_id].total += pts;

    if (s.event) {
      var eventDate = new Date(s.event.event_date + 'T12:00:00');

      if (s.event.id === latestEventId) {
        memberMap[s.league_member_id].lastEvent += pts;
      }

      if (eventDate >= thirtyDaysAgo && eventDate <= today) {
        memberMap[s.league_member_id].last30d += pts;
      }
    }
  });

  return members.map(function(m) {
    return { member: m, total: memberMap[m.id].total, lastEvent: memberMap[m.id].lastEvent, last30d: memberMap[m.id].last30d };
  }).sort(function(a, b) {
    var diff = b.total - a.total;
    return diff !== 0 ? diff : a.member.team_name.localeCompare(b.member.team_name);
  });
}

// ========================================================================
// RENDER
// ========================================================================
function renderStandings(standings, myMemberId) {
  // Assign ranks with proper tie handling (tied managers share the same rank number)
  var ranks = [];
  standings.forEach(function(entry, idx) {
    if (idx === 0) { ranks.push(1); return; }
    ranks.push(standings[idx].total === standings[idx - 1].total ? ranks[idx - 1] : idx + 1);
  });

  var rows = standings.map(function(entry, idx) {
    var member = entry.member;
    var rank   = ranks[idx];
    var isMe   = member.id === myMemberId;

    var rankClass = rank === 1 ? ' standings-rank--gold'
                  : rank === 2 ? ' standings-rank--silver'
                  : rank === 3 ? ' standings-rank--bronze' : '';

    return (
      '<tr class="standings-row' + (isMe ? ' standings-row--me' : '') + '">' +
        '<td class="standings-rank-cell">' +
          '<span class="standings-rank' + rankClass + '">' + rank + '</span>' +
        '</td>' +
        '<td class="standings-team-cell">' +
          '<a href="lineup.html?id=' + leagueId + '&member=' + escapeHtml(member.id) + '" class="standings-team-link">' +
            escapeHtml(member.team_name) +
          '</a>' +
          (isMe ? '<span class="standings-you">you</span>' : '') +
        '</td>' +
        '<td class="standings-pts-cell">' + (entry.total > 0 ? entry.total.toFixed(1) : '—') + '</td>' +
        '<td class="standings-pts-cell">' + formatDelta(entry.lastEvent) + '</td>' +
        '<td class="standings-pts-cell">' + formatDelta(entry.last30d)   + '</td>' +
      '</tr>'
    );
  }).join('');

  var hasAnyScores = standings.some(function(e) { return e.total > 0; });
  var emptyNote = hasAnyScores ? '' :
    '<p class="standings-empty-note">No events have been scored yet. Points will appear here after the first event.</p>';

  document.getElementById('standingsContent').innerHTML =
    emptyNote +
    '<div class="standings-card">' +
    '<table class="standings-table">' +
      '<thead>' +
        '<tr>' +
          '<th class="standings-th standings-th--rank">#</th>' +
          '<th class="standings-th standings-th--team">Team</th>' +
          '<th class="standings-th standings-th--pts">Total Pts</th>' +
          '<th class="standings-th standings-th--pts">Last Event</th>' +
          '<th class="standings-th standings-th--pts">Last 30 Days</th>' +
        '</tr>' +
      '</thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table>' +
    '</div>';
}

// Formats a period score: positive values get a green + prefix, zero shows a dash
function formatDelta(pts) {
  if (pts > 0) {
    return '<span class="standings-delta standings-delta--up">+' + pts.toFixed(1) + '</span>';
  }
  return '<span class="standings-delta standings-delta--zero">&mdash;</span>';
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  var div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

initStandings();
