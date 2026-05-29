// ========================================================================
// STANDINGS PAGE
// Shows cumulative fantasy points for every manager in the league, sorted
// highest to lowest, with per-period breakdowns.
// URL param: ?id=LEAGUE_UUID
// Depends on: supabaseClient (supabase-config.js), requireAuth (auth-guard.js)
// ========================================================================

var leagueId;
// Module-level cache for the points-breakdown modal — populated on init
// so the modal can build per-fighter breakdowns without re-fetching the
// league row each time it opens.
var leagueScoringConfig = null;
var membersCache = [];

async function initStandings() {
  var user = await requireAuth();
  if (!user) return;

  leagueId = new URLSearchParams(window.location.search).get('id');
  if (!leagueId) { window.location.href = 'dashboard.html'; return; }

  document.getElementById('leagueLink').href = 'league.html?id=' + leagueId;

  var results = await Promise.all([
    supabaseClient
      .from('leagues')
      // Pull scoring_config too — the breakdown modal runs the shared
      // Scoring engine over each fight_results row, and needs the league's
      // overrides so its numbers match the standings.
      .select('id, name, scoring_config')
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

  // Cache for the points-breakdown modal
  leagueScoringConfig = league.scoring_config || null;
  membersCache        = members;

  var myMember = members.find(function(m) { return m.user_id === user.id; });
  if (!myMember) { window.location.href = 'dashboard.html'; return; }

  document.title = 'Standings - ' + league.name;
  document.getElementById('leagueName').textContent = league.name;

  LeagueNav.renderInto('headerActions', {
    leagueId: leagueId,
    memberId: myMember.id,
    active:   'standings'
  });

  var standings = computeStandings(members, scores);
  renderStandings(standings, myMember.id);

  document.getElementById('pageContent').style.display = 'block';
}

// ========================================================================
// COMPUTE STANDINGS
// Returns members sorted by total points descending. Each entry includes:
//   total      — cumulative points
//   lastEvent  — points at the most recently scored event
//   last30d    — points from events within the past 30 days
//   history    — array of points per event (chronological, oldest first,
//                trimmed to the last 8 events) for the sparkline
//   prevRank   — this member's rank AFTER the second-to-last event, so
//                we can compute movement (current rank vs previous)
// ========================================================================
function computeStandings(members, scores) {
  var today = new Date();
  today.setHours(23, 59, 59, 999);
  var thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // ---- Group raw score rows by event, ordered chronologically ----
  // We pre-sort once so the cumulative-rank pass below can iterate in
  // order without re-sorting per member.
  var eventBuckets = {};   // eventId -> { date, pointsByMember }
  scores.forEach(function (s) {
    if (!s.event) return;
    if (!eventBuckets[s.event.id]) {
      eventBuckets[s.event.id] = {
        date:            new Date(s.event.event_date + 'T12:00:00'),
        pointsByMember:  {}
      };
    }
    var b = eventBuckets[s.event.id];
    b.pointsByMember[s.league_member_id] = (b.pointsByMember[s.league_member_id] || 0) + (s.total_points || 0);
  });
  var orderedEvents = Object.keys(eventBuckets)
    .map(function (id) { return { id: id, date: eventBuckets[id].date, pts: eventBuckets[id].pointsByMember }; })
    .sort(function (a, b) { return a.date.getTime() - b.date.getTime(); });

  // ---- Seed every member at zero ----
  // historyMap holds per-member arrays of points per event (chronological).
  var memberMap = {};
  members.forEach(function (m) {
    memberMap[m.id] = { total: 0, lastEvent: 0, last30d: 0, history: [] };
  });

  // ---- Walk events in order, accumulate totals + history ----
  // After each event we snapshot the current ranking. The "previous rank"
  // captured before the final event is what powers the movement arrows.
  var rankByMemberPrev = {};
  for (var i = 0; i < orderedEvents.length; i++) {
    var ev = orderedEvents[i];
    var isLast       = i === orderedEvents.length - 1;
    var isSecondLast = i === orderedEvents.length - 2;

    // Update running totals + per-event history first.
    members.forEach(function (m) {
      var pts = ev.pts[m.id] || 0;
      memberMap[m.id].total += pts;
      memberMap[m.id].history.push(pts);

      if (isLast) memberMap[m.id].lastEvent = pts;
      if (ev.date >= thirtyDaysAgo && ev.date <= today) {
        memberMap[m.id].last30d += pts;
      }
    });

    // Snapshot ranking AFTER the second-to-last event so it represents
    // "rank before the most recent event's points landed."
    if (isSecondLast) {
      var snap = members.slice().sort(function (a, b) {
        var d = memberMap[b.id].total - memberMap[a.id].total;
        return d !== 0 ? d : a.team_name.localeCompare(b.team_name);
      });
      snap.forEach(function (m, idx) { rankByMemberPrev[m.id] = idx + 1; });
    }
  }

  // Trim history to the last 8 events for the sparkline.
  members.forEach(function (m) {
    var h = memberMap[m.id].history;
    if (h.length > 8) memberMap[m.id].history = h.slice(h.length - 8);
  });

  return members.map(function (m) {
    return {
      member:    m,
      total:     memberMap[m.id].total,
      lastEvent: memberMap[m.id].lastEvent,
      last30d:   memberMap[m.id].last30d,
      history:   memberMap[m.id].history,
      prevRank:  rankByMemberPrev[m.id] != null ? rankByMemberPrev[m.id] : null
    };
  }).sort(function (a, b) {
    var diff = b.total - a.total;
    return diff !== 0 ? diff : a.member.team_name.localeCompare(b.member.team_name);
  });
}

// ========================================================================
// SPARKLINE
// Small inline SVG line chart for a manager's last-N event scores. No
// axes, no labels — just the shape. Uses currentColor so it inherits
// the row's text color (or a crimson override on the user's own row).
// ========================================================================
function sparklineSvg(values, opts) {
  opts = opts || {};
  var w     = opts.width  || 80;
  var h     = opts.height || 22;
  if (!values || values.length < 2) {
    return '<svg class="standings-sparkline" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">' +
             '<line x1="2" y1="' + (h / 2) + '" x2="' + (w - 2) + '" y2="' + (h / 2) + '" ' +
                   'stroke="currentColor" stroke-width="1" stroke-dasharray="2 3" opacity="0.4" />' +
           '</svg>';
  }
  var max = Math.max.apply(null, values);
  var min = Math.min.apply(null, values);
  var range = max - min || 1;
  var stepX = (w - 4) / (values.length - 1);
  // Map y so larger values sit higher (smaller y). Pad top/bottom 2px.
  var points = values.map(function (v, i) {
    var x = 2 + i * stepX;
    var y = 2 + (1 - (v - min) / range) * (h - 4);
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  // Trailing dot on the latest point so the eye finds "where we are now."
  var lastIdx = values.length - 1;
  var lastX = 2 + lastIdx * stepX;
  var lastY = 2 + (1 - (values[lastIdx] - min) / range) * (h - 4);
  return (
    '<svg class="standings-sparkline" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">' +
      '<polyline points="' + points + '" fill="none" stroke="currentColor" stroke-width="1.5" ' +
                'stroke-linecap="round" stroke-linejoin="round" />' +
      '<circle cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="2" fill="currentColor" />' +
    '</svg>'
  );
}

// Movement chip helper — given current rank + previous rank, returns the
// arrow markup. Stable (─) when ranks match or there's no previous data.
function movementChipHtml(currentRank, previousRank) {
  if (previousRank == null) {
    return '<span class="standings-movement standings-movement--flat" aria-label="No change">─</span>';
  }
  var delta = previousRank - currentRank;  // positive = moved up
  if (delta === 0) {
    return '<span class="standings-movement standings-movement--flat" aria-label="No change">─</span>';
  }
  if (delta > 0) {
    return '<span class="standings-movement standings-movement--up" aria-label="Up ' + delta + '">' +
             '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9V3" /><path d="m3 6 3-3 3 3" /></svg>' +
             delta +
           '</span>';
  }
  return '<span class="standings-movement standings-movement--down" aria-label="Down ' + (-delta) + '">' +
           '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3v6" /><path d="m3 6 3 3 3-3" /></svg>' +
           (-delta) +
         '</span>';
}

// Medal SVG for #1–#3. Returns empty string for #4+.
function medalSvg(rank) {
  if (rank > 3) return '';
  var klass = rank === 1 ? 'standings-medal--gold'
            : rank === 2 ? 'standings-medal--silver'
            :              'standings-medal--bronze';
  return (
    '<svg class="standings-medal ' + klass + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M8 3 L10 11 M16 3 L14 11" />' +
      '<circle cx="12" cy="15" r="6" fill="currentColor" fill-opacity="0.15" />' +
      '<text x="12" y="18" text-anchor="middle" font-family="system-ui" font-size="7" font-weight="800" fill="currentColor" stroke="none">' + rank + '</text>' +
    '</svg>'
  );
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

    // Top-3 get a medal glyph alongside the number; otherwise just the
    // plain rank number.
    var rankGlyph = medalSvg(rank);

    var totalCell = entry.total > 0
      ? '<button class="standings-pts-link" type="button" ' +
              'data-member-id="' + escapeHtml(member.id) + '" ' +
              'data-team-name="' + escapeHtml(member.team_name) + '" ' +
              'data-total="' + entry.total.toFixed(1) + '" ' +
              'title="See how these points were earned">' +
          entry.total.toFixed(1) +
        '</button>'
      : '—';

    return (
      '<tr class="standings-row' + (isMe ? ' standings-row--me' : '') + '">' +
        '<td class="standings-rank-cell">' +
          '<span class="standings-rank' + rankClass + '">' +
            (rankGlyph || rank) +
          '</span>' +
        '</td>' +
        '<td class="standings-move-cell">' + movementChipHtml(rank, entry.prevRank) + '</td>' +
        '<td class="standings-team-cell">' +
          '<a href="lineup.html?id=' + leagueId + '&member=' + escapeHtml(member.id) + '" class="standings-team-link">' +
            escapeHtml(member.team_name) +
          '</a>' +
          (isMe ? '<span class="standings-you">you</span>' : '') +
        '</td>' +
        '<td class="standings-trend-cell">' + sparklineSvg(entry.history, { width: 88, height: 22 }) + '</td>' +
        '<td class="standings-pts-cell">' + totalCell + '</td>' +
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
          '<th class="standings-th standings-th--move" title="Movement since last event">Δ</th>' +
          '<th class="standings-th standings-th--team">Team</th>' +
          '<th class="standings-th standings-th--trend">Trend</th>' +
          '<th class="standings-th standings-th--pts">Total Pts</th>' +
          '<th class="standings-th standings-th--pts">Last Event</th>' +
          '<th class="standings-th standings-th--pts">Last 30 Days</th>' +
        '</tr>' +
      '</thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table>' +
    '</div>';

  // Wire the clickable Total Pts cells to open the points-breakdown modal.
  document.querySelectorAll('.standings-pts-link').forEach(function (btn) {
    btn.addEventListener('click', function () {
      showPointsBreakdownModal(
        btn.getAttribute('data-member-id'),
        btn.getAttribute('data-team-name'),
        parseFloat(btn.getAttribute('data-total')) || 0
      );
    });
  });
}

// ========================================================================
// POINTS BREAKDOWN MODAL
// Per-fighter / per-fight breakdown of every point this manager has
// scored. Toggleable between "by most points" and "most recent."
// ========================================================================

var ptsBreakdownState = { sort: 'points', rows: [] };

function showPointsBreakdownModal(memberId, teamName, totalPts) {
  // Strip any prior instance so reopening from a different row doesn't
  // stack overlays.
  var existing = document.getElementById('ptsBreakdownModal');
  if (existing) existing.remove();

  // Placeholder while we fetch — instant feedback that the click landed.
  var overlay = document.createElement('div');
  overlay.id = 'ptsBreakdownModal';
  overlay.className = 'pts-breakdown-overlay';
  overlay.innerHTML =
    '<div class="pts-breakdown-modal" role="dialog" aria-modal="true">' +
      '<div class="pts-breakdown-modal__header">' +
        '<div>' +
          '<p class="pts-breakdown-modal__eyebrow">Points Breakdown</p>' +
          '<p class="pts-breakdown-modal__title">' + escapeHtml(teamName) + ' &middot; ' + totalPts.toFixed(1) + ' pts</p>' +
        '</div>' +
        '<button class="pts-breakdown-modal__close" id="closePtsBreakdownBtn" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="pts-breakdown-modal__body" id="ptsBreakdownBody">' +
        '<p class="draft-empty" style="padding: var(--space-6)">Loading breakdown…</p>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  // Wire close handlers
  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onEscape);
  }
  function onEscape(e) { if (e.key === 'Escape') close(); }
  document.getElementById('closePtsBreakdownBtn').addEventListener('click', close);
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onEscape);

  // Fetch and render
  fetchPointsBreakdown(memberId).then(function (rows) {
    ptsBreakdownState.rows = rows;
    ptsBreakdownState.sort = 'points';  // default sort on open
    renderPtsBreakdownBody();
  }).catch(function (err) {
    console.warn('Points breakdown fetch failed:', err);
    document.getElementById('ptsBreakdownBody').innerHTML =
      '<p class="draft-empty" style="padding: var(--space-6)">Could not load breakdown.</p>';
  });
}

// Fetches every starter selection this manager has ever made, joins with
// the corresponding fight_results, and runs the shared scoring engine to
// get per-fighter point totals.
async function fetchPointsBreakdown(memberId) {
  // 1. Every starter slot this manager filled.
  var selRes = await supabaseClient
    .from('starter_selections')
    .select('event_id, fighter_id, event:ufc_events(id, name, event_date), fighter:fighters(id, name, photo_url)')
    .eq('league_member_id', memberId);
  var selections = selRes.data || [];
  if (selections.length === 0) return [];

  // 2. Fight rows for the events those starters appeared in. Pulling by
  //    event_id and then filtering client-side is cheaper than building a
  //    multi-OR filter on (event_id, fighter_id) pairs.
  var eventIds = Array.from(new Set(selections.map(function (s) { return s.event_id; }).filter(Boolean)));
  if (eventIds.length === 0) return [];

  var fightRes = await supabaseClient
    .from('fight_results')
    .select(
      'id, event_id, fighter_a_id, fighter_b_id, winner_id, outcome, ' +
      'end_round, end_time_seconds, card_position, title_type, is_title_defense, ' +
      'fighter_a_sig_strikes, fighter_a_takedowns, fighter_a_knockdowns, fighter_a_control_seconds, ' +
      'fighter_b_sig_strikes, fighter_b_takedowns, fighter_b_knockdowns, fighter_b_control_seconds, ' +
      'fighter_a_opponent_rank, fighter_b_opponent_rank'
    )
    .in('event_id', eventIds);
  var fights = fightRes.data || [];

  // 3. Opponent names — collect any fighter_id appearing on the fight
  //    rows that isn't already in the selections.fighter join.
  var opponentIds = new Set();
  fights.forEach(function (f) {
    if (f.fighter_a_id) opponentIds.add(f.fighter_a_id);
    if (f.fighter_b_id) opponentIds.add(f.fighter_b_id);
  });
  selections.forEach(function (s) { opponentIds.delete(s.fighter_id); });
  var nameMap = {};
  if (opponentIds.size > 0) {
    var oppRes = await supabaseClient
      .from('fighters')
      .select('id, name')
      .in('id', Array.from(opponentIds));
    (oppRes.data || []).forEach(function (f) { nameMap[f.id] = f.name; });
  }

  // 4. Walk each selection, find its matching fight, score it.
  var rows = [];
  selections.forEach(function (sel) {
    var fight = fights.find(function (f) {
      return f.event_id === sel.event_id &&
             (f.fighter_a_id === sel.fighter_id || f.fighter_b_id === sel.fighter_id);
    });
    if (!fight || !fight.outcome) return;  // hasn't happened yet, skip
    var isA = fight.fighter_a_id === sel.fighter_id;
    var score = Scoring.computeFighterScore(fight, isA, leagueScoringConfig);
    var opponentId = isA ? fight.fighter_b_id : fight.fighter_a_id;
    rows.push({
      fighterId:    sel.fighter_id,
      fighterName:  sel.fighter ? sel.fighter.name : '?',
      fighterPhoto: sel.fighter ? sel.fighter.photo_url : null,
      opponentName: nameMap[opponentId] || 'Unknown',
      eventName:    sel.event ? sel.event.name : '?',
      eventDate:    sel.event ? sel.event.event_date : null,
      points:       score.total,
      outcome:      fight.outcome,
      isWinner:     fight.winner_id === sel.fighter_id
    });
  });
  return rows;
}

// Render the body based on the current sort. Re-renders in place so the
// sort toggle feels instant.
function renderPtsBreakdownBody() {
  var body = document.getElementById('ptsBreakdownBody');
  if (!body) return;

  var rows = ptsBreakdownState.rows.slice();
  if (ptsBreakdownState.sort === 'recent') {
    rows.sort(function (a, b) {
      if (!a.eventDate) return 1;
      if (!b.eventDate) return -1;
      return a.eventDate < b.eventDate ? 1 : -1;  // most recent first
    });
  } else {
    rows.sort(function (a, b) { return b.points - a.points; });
  }

  var sortToggle =
    '<div class="pts-breakdown__sort">' +
      '<button class="pts-breakdown__sort-btn' + (ptsBreakdownState.sort === 'points' ? ' pts-breakdown__sort-btn--active' : '') +
              '" data-sort="points" type="button">By Most Points</button>' +
      '<button class="pts-breakdown__sort-btn' + (ptsBreakdownState.sort === 'recent' ? ' pts-breakdown__sort-btn--active' : '') +
              '" data-sort="recent" type="button">Most Recent</button>' +
    '</div>';

  var listHtml = '';
  if (rows.length === 0) {
    listHtml = EmptyState.html({
      kind:    'standings',
      title:   'No completed fights',
      body:    'This manager\'s starters haven\'t scored any points yet.',
      compact: true
    });
  } else {
    listHtml = rows.map(function (r) {
      var photoHtml = r.fighterPhoto
        ? '<img class="pts-breakdown-row__photo" src="' + escapeHtml(r.fighterPhoto) + '" alt="' + escapeHtml(r.fighterName) + '" onerror="this.style.display=\'none\'">'
        : '<div class="pts-breakdown-row__photo pts-breakdown-row__photo--empty"></div>';
      var dateStr = '';
      if (r.eventDate) {
        var d = new Date(r.eventDate + 'T12:00:00');
        dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      }
      var resultBadge = r.isWinner
        ? '<span class="pts-breakdown-row__result pts-breakdown-row__result--win">W</span>'
        : r.outcome === 'draw'
          ? '<span class="pts-breakdown-row__result pts-breakdown-row__result--draw">D</span>'
          : r.outcome === 'no_contest'
            ? '<span class="pts-breakdown-row__result pts-breakdown-row__result--nc">NC</span>'
            : '<span class="pts-breakdown-row__result pts-breakdown-row__result--loss">L</span>';
      return (
        '<div class="pts-breakdown-row">' +
          photoHtml +
          '<div class="pts-breakdown-row__text">' +
            '<p class="pts-breakdown-row__name">' + escapeHtml(r.fighterName) + ' ' + resultBadge + '</p>' +
            '<p class="pts-breakdown-row__sub">vs ' + escapeHtml(r.opponentName) + ' &middot; ' + escapeHtml(r.eventName) +
              (dateStr ? ' &middot; ' + dateStr : '') +
            '</p>' +
          '</div>' +
          '<div class="pts-breakdown-row__points">' + r.points.toFixed(1) + '</div>' +
        '</div>'
      );
    }).join('');
  }

  body.innerHTML = sortToggle + '<div class="pts-breakdown__list">' + listHtml + '</div>';

  // Wire the sort toggle
  body.querySelectorAll('.pts-breakdown__sort-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      ptsBreakdownState.sort = btn.getAttribute('data-sort');
      renderPtsBreakdownBody();
    });
  });
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
