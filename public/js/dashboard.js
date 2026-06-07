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

  // Fire-and-forget: replace the placeholder Next Event / Lineup Locks
  // tiles with real data from the soonest upcoming ufc_events row.
  loadNextEventTiles();

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
  // Also pull is_commissioner (per-member co-commissioner flag),
  // leagues.commissioner_id (primary owner) for the Commish badge,
  // and `pinned` so the dashboard can sort pinned leagues to the top
  // and render the pin toggle in the correct state. The PK `id` is
  // included so the pin handler can target this specific row.
  const { data: memberships, error } = await supabaseClient
    .from('league_members')
    .select('id, team_name, league_id, is_commissioner, pinned, leagues(id, name, format, max_managers, commissioner_id)')
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

  // ---- Fetch enrichment data for each league row ----
  // Parallel: every member of every league I'm in (for standings + member
  // counts), every scoring row aggregated to a points-by-member map, the
  // soonest upcoming event globally, and my own starter selections for
  // that event so we can flag "lineup not set" cards.
  const leagueIds  = memberships.map(function(m) { return m.league_id; });
  const myMemberRowIds = memberships.map(function(m) {
    // memberships is from league_members with this user — we need our
    // league_member id per league. The select above includes team_name
    // and league_id but not the row's PK; refetch lean.
    return null;
  });

  const todayISO = new Date().toISOString().slice(0, 10);

  const [allMembersRes, scoresRes, myRowsRes, nextEventRes] = await Promise.all([
    supabaseClient
      .from('league_members')
      .select('id, league_id, team_name, user_id')
      .in('league_id', leagueIds),
    supabaseClient
      .from('scores')
      .select('league_id, league_member_id, total_points')
      .in('league_id', leagueIds),
    supabaseClient
      .from('league_members')
      .select('id, league_id')
      .in('league_id', leagueIds)
      .eq('user_id', user.id),
    supabaseClient
      .from('ufc_events')
      .select('id, name, event_date, venue, lineup_lock_time')
      // Soonest event that isn't completed. The window starts a day back (UTC)
      // so a live Saturday card that's rolled past midnight UTC stays current
      // instead of the site jumping to the next event mid-card.
      .gte('event_date', new Date(Date.now() - 86400000).toISOString().slice(0, 10))
      .eq('is_completed', false)
      .order('event_date', { ascending: true })
      .limit(1)
      .maybeSingle()
  ]);

  // Index: leagueId -> [{ id, team_name, user_id }]
  var membersByLeague = {};
  (allMembersRes.data || []).forEach(function (m) {
    (membersByLeague[m.league_id] = membersByLeague[m.league_id] || []).push(m);
  });

  // Index: leagueId -> { memberId -> totalPoints }
  var pointsByLeague = {};
  (scoresRes.data || []).forEach(function (row) {
    var bucket = pointsByLeague[row.league_id] = pointsByLeague[row.league_id] || {};
    bucket[row.league_member_id] = (bucket[row.league_member_id] || 0) + Number(row.total_points || 0);
  });

  // Index: leagueId -> my league_member.id
  var myMemberIdByLeague = {};
  (myRowsRes.data || []).forEach(function (m) { myMemberIdByLeague[m.league_id] = m.id; });

  // Next event + my starter selections for it. The selections query runs
  // only if we actually got an event back; otherwise the lineup-status
  // badge is hidden across all cards.
  var nextEvent  = nextEventRes && nextEventRes.data ? nextEventRes.data : null;
  var hasLineup  = {}; // leagueId -> true if I have any starter for nextEvent
  if (nextEvent) {
    var myIds = Object.values(myMemberIdByLeague);
    if (myIds.length > 0) {
      var selRes = await supabaseClient
        .from('starter_selections')
        .select('league_member_id')
        .eq('event_id', nextEvent.id)
        .in('league_member_id', myIds);
      (selRes.data || []).forEach(function (s) {
        // Find which league this member belongs to
        for (var lid in myMemberIdByLeague) {
          if (myMemberIdByLeague[lid] === s.league_member_id) {
            hasLineup[lid] = true;
            break;
          }
        }
      });
    }
  }

  // ---- Render a rich card per league ----
  // Render is wrapped in a closure so the pin toggle can re-run it after
  // flipping a membership's `pinned` flag. All enrichment data (members,
  // points, next event, lineup state) is captured in the closure so the
  // re-render is instantaneous and doesn't re-hit the network.
  var listEl = document.getElementById('leaguesList');
  function renderLeagueList() {
    // Sort: pinned first (preserve original order within each group via
    // a stable sort, which all modern browsers provide).
    memberships.sort(function (a, b) {
      var ap = a.pinned ? 1 : 0;
      var bp = b.pinned ? 1 : 0;
      return bp - ap;
    });

    var wrap = document.createElement('div');
    wrap.className = 'dashboard-league-list';

    memberships.forEach(function (membership) {
      wrap.appendChild(buildLeagueCard({
        user:        user,
        membership:  membership,
        members:     membersByLeague[membership.league_id] || [],
        points:      pointsByLeague[membership.league_id]  || {},
        myMemberId:  myMemberIdByLeague[membership.league_id],
        nextEvent:   nextEvent,
        hasLineup:   !!hasLineup[membership.league_id]
      }));
    });

    // Replace any existing list contents — re-render after a pin toggle
    // shouldn't stack a second copy.
    listEl.innerHTML = '';
    listEl.appendChild(wrap);
  }
  renderLeagueList();

  // ---- Pin / unpin handler (event-delegated on the list) ----
  // The pin button is a sibling of the card <a> with z-index above it,
  // so clicks land on the button — they never bubble to the link. We
  // still call stopPropagation defensively in case the layout changes.
  // Optimistic update: flip the flag locally and re-render immediately,
  // then send the UPDATE. If the DB write fails, revert and re-render.
  listEl.addEventListener('click', async function (e) {
    var btn = e.target.closest('[data-pin-membership-id]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();

    var membershipId = btn.getAttribute('data-pin-membership-id');
    var membership   = memberships.find(function (m) { return String(m.id) === String(membershipId); });
    if (!membership) return;

    var nextPinned = !membership.pinned;
    membership.pinned = nextPinned;
    renderLeagueList();

    var res = await supabaseClient
      .from('league_members')
      .update({ pinned: nextPinned })
      .eq('id', membership.id);

    if (res.error) {
      // Revert on failure so the UI matches reality.
      membership.pinned = !nextPinned;
      renderLeagueList();
      console.error('Pin update failed:', res.error);
    }
  });
}

// ========================================================================
// LEAGUE CARD
// One rich card per league: header (name + commish badge), three stat
// tiles (your rank, points behind #1, next event countdown), and a
// footer alert when the lineup isn't set for the upcoming event.
// The whole card is a single <a> so clicking anywhere jumps to the
// league hub — the right-side arrow is decorative.
// ========================================================================
function buildLeagueCard(opts) {
  var league      = opts.membership.leagues;
  var memberCount = opts.members.length;
  var formatLabel = league.format === 'dynasty' ? 'Dynasty' : 'Season-Long';
  var isCommish   = (league.commissioner_id === opts.user.id)
                 || (opts.membership.is_commissioner === true);

  // ---- Standings: sort members by total points desc; find my position ----
  var ranked = opts.members
    .map(function (m) { return { id: m.id, total: opts.points[m.id] || 0 }; })
    .sort(function (a, b) { return b.total - a.total; });

  var hasAnyScores = ranked.some(function (r) { return r.total > 0; });
  var myRank       = '—';
  var myTotal      = 0;
  var pointsBehind = null;
  if (hasAnyScores && opts.myMemberId) {
    for (var i = 0; i < ranked.length; i++) {
      if (ranked[i].id === opts.myMemberId) {
        myRank  = i + 1;
        myTotal = ranked[i].total;
        if (i > 0) pointsBehind = ranked[0].total - myTotal;
        break;
      }
    }
  }

  var rankClass = myRank === 1 ? ' league-card-stat__value--gold'
                : myRank === 2 ? ' league-card-stat__value--silver'
                : myRank === 3 ? ' league-card-stat__value--bronze'
                : '';
  var rankSub = hasAnyScores ? 'of ' + memberCount : 'no scores yet';
  var rankDisplay = hasAnyScores
    ? '#' + myRank
    : '—';

  // ---- Behind tile: "-142.3" vs leader, "1st" if leading, "—" if no scores
  var behindDisplay, behindSub;
  if (!hasAnyScores) {
    behindDisplay = '—';
    behindSub     = 'season ahead';
  } else if (myRank === 1) {
    behindDisplay = myTotal.toFixed(1);
    behindSub     = 'pts in 1st';
  } else if (pointsBehind != null) {
    behindDisplay = '-' + pointsBehind.toFixed(1);
    behindSub     = 'behind 1st';
  } else {
    behindDisplay = '—';
    behindSub     = 'pts';
  }

  // ---- Next event tile: name + countdown to lock (or "TBD") ----
  var nextDisplay, nextSub;
  if (opts.nextEvent) {
    nextDisplay = displayEventName(opts.nextEvent);
    var lockISO = opts.nextEvent.lineup_lock_time;
    var lockDate = lockISO ? new Date(lockISO) : new Date(opts.nextEvent.event_date + 'T17:00:00');
    var diffMs = lockDate.getTime() - Date.now();
    if (diffMs <= 0) {
      nextSub = 'lineup locked';
    } else {
      var days  = Math.floor(diffMs / 86400000);
      var hours = Math.floor((diffMs % 86400000) / 3600000);
      if (days > 0)      nextSub = 'locks in ' + days + 'd ' + hours + 'h';
      else if (hours > 0)nextSub = 'locks in ' + hours + 'h';
      else               nextSub = 'locks soon';
    }
  } else {
    nextDisplay = 'TBD';
    nextSub     = 'no events scheduled';
  }

  // ---- Lineup alert: only show before lock when no starters set ----
  var alertHtml = '';
  if (opts.nextEvent && !opts.hasLineup) {
    var locked = opts.nextEvent.lineup_lock_time
      ? new Date(opts.nextEvent.lineup_lock_time).getTime() < Date.now()
      : false;
    if (!locked) {
      alertHtml =
        '<div class="dashboard-league-card__alert">' +
          '<svg class="dashboard-league-card__alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M12 4 2 20h20Z" /><path d="M12 10v5" /><circle cx="12" cy="18" r="0.5" fill="currentColor" />' +
          '</svg>' +
          '<span>Lineup not set for ' + escapeHtml(displayEventName(opts.nextEvent)) + '</span>' +
        '</div>';
    }
  }

  var commishBadge = isCommish
    ? '<span class="commish-badge" title="You\'re a commissioner of this league">Commish</span>'
    : '';

  // Pin toggle. Lives as a sibling of the card <a> (see the wrap below)
  // so it can be a real <button> — nesting button-in-anchor would be
  // invalid HTML. Absolute positioning with z-index above the link means
  // clicks on the pin never reach the anchor in the first place.
  var isPinned = !!opts.membership.pinned;
  var pinBtnHtml =
    '<button class="dashboard-league-card__pin' +
      (isPinned ? ' dashboard-league-card__pin--active' : '') + '"' +
      ' type="button"' +
      ' data-pin-membership-id="' + escapeHtml(String(opts.membership.id)) + '"' +
      ' aria-label="' + (isPinned ? 'Unpin this league' : 'Pin this league to top') + '"' +
      ' aria-pressed="' + (isPinned ? 'true' : 'false') + '"' +
      ' title="' + (isPinned ? 'Unpin' : 'Pin to top') + '">' +
      // Pin SVG. Filled (currentColor) when active; outline when not.
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ' +
           'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M12 17v5" />' +
        '<path d="M9 17h6" />' +
        '<path d="M7 9V4h10v5l2 4v3H5v-3l2-4z"' +
              (isPinned ? ' fill="currentColor"' : '') + ' />' +
      '</svg>' +
    '</button>';

  var anchor = document.createElement('a');
  anchor.className = 'dashboard-league-card' + (isPinned ? ' dashboard-league-card--pinned' : '');
  anchor.href = 'league.html?id=' + encodeURIComponent(league.id);
  anchor.innerHTML =
    '<div class="dashboard-league-card__header">' +
      '<div class="dashboard-league-card__heading">' +
        '<p class="dashboard-league-card__name">' +
          escapeHtml(league.name) + commishBadge +
        '</p>' +
        '<p class="dashboard-league-card__meta">' +
          formatLabel + ' · ' +
          memberCount + ' / ' + league.max_managers + ' managers · ' +
          'Your team: ' + escapeHtml(opts.membership.team_name) +
        '</p>' +
      '</div>' +
      '<svg class="dashboard-league-card__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M9 6l6 6-6 6" />' +
      '</svg>' +
    '</div>' +

    '<div class="dashboard-league-card__stats">' +
      '<div class="league-card-stat">' +
        '<span class="league-card-stat__value' + rankClass + '">' + rankDisplay + '</span>' +
        '<span class="league-card-stat__label">' + rankSub + '</span>' +
      '</div>' +
      '<div class="league-card-stat">' +
        '<span class="league-card-stat__value">' + escapeHtml(behindDisplay) + '</span>' +
        '<span class="league-card-stat__label">' + behindSub + '</span>' +
      '</div>' +
      '<div class="league-card-stat league-card-stat--wide">' +
        '<span class="league-card-stat__value league-card-stat__value--text">' + escapeHtml(nextDisplay) + '</span>' +
        '<span class="league-card-stat__label">' + escapeHtml(nextSub) + '</span>' +
      '</div>' +
    '</div>' +

    alertHtml;

  // Wrap the anchor + pin button so the button can be a sibling overlay
  // (button-in-anchor would be invalid HTML). The wrap is the actual
  // child of .dashboard-league-list.
  var wrap = document.createElement('div');
  wrap.className = 'dashboard-league-card-wrap';
  wrap.innerHTML = pinBtnHtml;
  wrap.appendChild(anchor);
  return wrap;
}

// Escapes user-supplied strings before inserting into innerHTML to prevent XSS
function escapeHtml(str) {
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ========================================================================
// NEXT EVENT + LINEUP LOCK TILES
// Replaces the hardcoded placeholders with the soonest upcoming UFC
// event. Same display rule as the rest of the app — numbered PPVs show
// as-is, Vegas → UFC APEX, Washington → UFC Freedom 250, else
// "UFC <City>" pulled from the first chunk of ufc_events.venue.
// ========================================================================

function displayEventName(ev) {
  if (!ev) return '';
  if (/^UFC\s+\d+\b/i.test(ev.name || '')) return ev.name;
  if (ev.venue) {
    var venue = String(ev.venue);
    if (/las vegas/i.test(venue))  return 'UFC APEX';
    if (/washington/i.test(venue)) return 'UFC Freedom 250';
    var city = venue.split(',')[0].trim();
    if (city) return 'UFC ' + city;
  }
  return ev.name || '';
}

async function loadNextEventTiles() {
  var nameEl    = document.getElementById('statNextEvent');
  var lockEl    = document.getElementById('statLineupLock');
  var welcomeEl = document.getElementById('welcomeSub');

  // Soonest event that isn't completed (window starts a day back so a live
  // card past midnight UTC stays current).
  var res = await supabaseClient
    .from('ufc_events')
    .select('id, name, event_date, venue, lineup_lock_time')
    .gte('event_date', new Date(Date.now() - 86400000).toISOString().slice(0, 10))
    .eq('is_completed', false)
    .order('event_date', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (res.error || !res.data) {
    if (nameEl)    nameEl.textContent    = '—';
    if (lockEl)    lockEl.textContent    = 'TBD';
    if (welcomeEl) welcomeEl.textContent = 'No upcoming card scheduled';
    return;
  }
  var event = res.data;

  if (nameEl) nameEl.textContent = displayEventName(event);

  // Lock display: short weekday + month + day. Card locks Saturday at
  // first prelim; the date itself is the most useful at-a-glance signal.
  if (lockEl) {
    var d = new Date(event.event_date + 'T12:00:00');
    lockEl.textContent = d.toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric'
    });
  }

  // Welcome subtitle under the user's name. Prefer the explicit
  // lineup_lock_time when present; otherwise infer the weekday from
  // the event date (UFC cards lock at the first prelim, same day).
  // Past lock but pre-event still gets a "Lineups locked" hint.
  if (welcomeEl) {
    var lockSource = event.lineup_lock_time
      ? new Date(event.lineup_lock_time)
      : new Date(event.event_date + 'T17:00:00');
    var weekday = lockSource.toLocaleDateString('en-US', { weekday: 'long' });
    var locked  = lockSource.getTime() < Date.now();
    welcomeEl.textContent = locked
      ? 'Lineups locked · ' + displayEventName(event)
      : 'Next card locks ' + weekday + ' · ' + displayEventName(event);
  }
}

initDashboard();
