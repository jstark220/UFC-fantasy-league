// ========================================================================
// LINEUPS PAGE — every league member's starters for one event
//
// URL: lineups.html?id=LEAGUE_UUID&event=EVENT_UUID
//   * id    — required, the league
//   * event — optional, the event to view. Defaults to the next upcoming
//             event (or the most recent past event if none upcoming).
//
// Reads:
//   league_members      — team names + commissioner flags
//   ufc_events          — populates the event picker + provides lock time
//   starter_selections  — who started whom for the selected event
//   rosters/fighters    — fighter details for the starter cards
//   scores              — per-member, per-fighter points if scored
//
// Writes: nothing. This is a read-only roll-up view.
// ========================================================================

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

// Max possible starter count (numbered PPV). Fight Nights only run 2 —
// pull the real count for the selected event from waiver-phase.js.
const MAX_STARTERS = 3;
// League's scoring_config — populated by init() and read by
// currentStarterCount so the count matches the commissioner's overrides.
let leagueScoringConfig = null;
function currentStarterCount() {
  return (typeof getStarterCountForEvent === 'function')
    ? getStarterCountForEvent(selectedEvent, leagueScoringConfig)
    : MAX_STARTERS;
}

// ---- Module state — populated by init, read by every render path ----
let leagueId       = null;
let myMember       = null;     // current viewer's league_members row
let availableEvents = [];      // every UFC event the user can pick
let selectedEvent  = null;     // the event currently being viewed
let members        = [];       // every member of this league
let fightersById   = {};       // fighter id -> fighter row, for starter rendering
// Per-event state, reset on event change
let selectionsByMember = {};   // member id -> [fighter_id, fighter_id, ...]
let scoresByMember     = {};   // member id -> { fighter_id: total_points }

// ========================================================================
// INIT
// ========================================================================
async function initLineups() {
  const user = await requireAuth();
  if (!user) return;

  const params = new URLSearchParams(window.location.search);
  leagueId = params.get('id');
  if (!leagueId) {
    window.location.href = 'dashboard.html';
    return;
  }

  // Eagerly wire the back-to-my-lineup link
  document.getElementById('lineupBackLink').href = 'lineup.html?id=' + leagueId;

  // Pull league + membership + events + roster + fighters in parallel
  const [leagueRes, membersRes, eventsRes, rostersRes, fightersRes] = await Promise.all([
    supabaseClient.from('leagues').select('id, name, scoring_config').eq('id', leagueId).single(),
    supabaseClient.from('league_members').select('id, user_id, team_name, is_commissioner').eq('league_id', leagueId),
    supabaseClient.from('ufc_events').select('id, name, full_name, event_date, venue, lineup_lock_time').order('event_date', { ascending: false }),
    supabaseClient.from('rosters').select('fighter_id, league_member_id, slot_override').eq('league_id', leagueId),
    supabaseClient.from('fighters').select('id, name, primary_division, current_rank, is_champion, record_wins, record_losses, record_draws, photo_url')
  ]);

  if (leagueRes.error || !leagueRes.data) {
    window.location.href = 'dashboard.html';
    return;
  }

  const league = leagueRes.data;
  leagueScoringConfig = league.scoring_config || null;
  members      = membersRes.data || [];

  myMember = members.find(function(m) { return m.user_id === user.id; });
  if (!myMember) { window.location.href = 'dashboard.html'; return; }

  availableEvents = eventsRes.data || [];

  // Build the fighter lookup once — we'll reach into it for every starter
  // card rendered. fighter rows include the rank + photo we need.
  (fightersRes.data || []).forEach(function(f) { fightersById[f.id] = f; });

  // Pick the initial event: URL ?event= takes precedence, otherwise default
  const requestedEventId = params.get('event');
  if (requestedEventId) {
    selectedEvent = availableEvents.find(function(e) { return e.id === requestedEventId; }) || null;
  }
  if (!selectedEvent) selectedEvent = pickDefaultEvent(availableEvents);

  document.title = league.name + ' Lineups - Knockdown Fantasy';
  document.getElementById('leagueName').textContent = league.name + ' — All Lineups';

  await loadEventData();

  document.getElementById('pageContent').style.display = '';

  renderEventBanner();
  renderLineupsGrid();
}

// Default event = next upcoming (earliest future). If none, the most recent
// past event. Mirrors lineup.js so both pages land on the same default.
function pickDefaultEvent(events) {
  if (events.length === 0) return null;
  const todayISO = new Date().toISOString().split('T')[0];
  const upcoming = events.filter(function(e) { return e.event_date >= todayISO; });
  if (upcoming.length > 0) return upcoming[upcoming.length - 1];
  return events[0];
}

// ========================================================================
// LOAD EVENT DATA — selections + scores for the selected event
// ========================================================================
async function loadEventData() {
  selectionsByMember = {};
  scoresByMember     = {};
  if (!selectedEvent) return;

  const memberIds = members.map(function(m) { return m.id; });
  if (memberIds.length === 0) return;

  const [selRes, scoreRes] = await Promise.all([
    supabaseClient
      .from('starter_selections')
      .select('league_member_id, fighter_id, slot_position')
      .eq('event_id', selectedEvent.id)
      .in('league_member_id', memberIds)
      .order('slot_position'),
    supabaseClient
      .from('scores')
      .select('league_member_id, fighter_id, total_points')
      .eq('event_id', selectedEvent.id)
      .in('league_member_id', memberIds)
  ]);

  (selRes.data || []).forEach(function(s) {
    if (!selectionsByMember[s.league_member_id]) selectionsByMember[s.league_member_id] = [];
    selectionsByMember[s.league_member_id].push(s.fighter_id);
  });

  (scoreRes.data || []).forEach(function(row) {
    if (!scoresByMember[row.league_member_id]) scoresByMember[row.league_member_id] = {};
    scoresByMember[row.league_member_id][row.fighter_id] = row.total_points;
  });
}

// ========================================================================
// RENDER EVENT BANNER
// Reuses the .this-week-card visual treatment from the lineup page so the
// two pages feel like halves of the same flow.
// ========================================================================
function renderEventBanner() {
  const el = document.getElementById('eventBanner');
  if (!selectedEvent) {
    el.innerHTML = EmptyState.html({
      kind:  'events',
      title: 'No events scheduled',
      body:  'Once the UFC calendar publishes more cards, they\'ll show up here.'
    });
    return;
  }

  const dateObj  = new Date(selectedEvent.event_date + 'T12:00:00');
  const dateStr  = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const venueStr = selectedEvent.venue ? ' · ' + escapeHtml(selectedEvent.venue) : '';
  const matchup  = (selectedEvent.full_name && selectedEvent.full_name.indexOf(':') !== -1)
    ? selectedEvent.full_name.split(':')[1].trim()
    : '';

  // Status: past / locked / open. Mirrors the gate logic on the lineup page.
  const todayISO = new Date().toISOString().split('T')[0];
  const isPast   = selectedEvent.event_date < todayISO;
  const lockTimePassed = !!(selectedEvent.lineup_lock_time &&
                            new Date() >= new Date(selectedEvent.lineup_lock_time));
  const isLocked = isPast || lockTimePassed;

  let statusLabel;
  if (isPast)         statusLabel = '<span style="color: var(--accent-gold);">&#127942; Event final</span>';
  else if (isLocked)  statusLabel = '<span style="color: var(--text-tertiary);">&#128274; Lineups locked</span>';
  else                statusLabel = '<span style="color: #4ade80;">&#128275; Lineups open</span>';

  // Event picker — only shown when there's more than one to choose from
  let pickerHtml = '';
  if (availableEvents.length > 1) {
    pickerHtml = '<div class="lineup-event-picker">' +
                   '<label for="lineupsEventSelect" class="lineup-event-picker__label">Viewing</label>' +
                   '<select id="lineupsEventSelect" class="waiver-filter">';
    availableEvents.forEach(function(ev) {
      const d = new Date(ev.event_date + 'T12:00:00');
      const dStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const sel  = ev.id === selectedEvent.id ? ' selected' : '';
      pickerHtml += '<option value="' + ev.id + '"' + sel + '>' +
                      escapeHtml(ev.name) + ' (' + escapeHtml(dStr) + ')' +
                    '</option>';
    });
    pickerHtml += '</select></div>';
  }

  el.innerHTML =
    pickerHtml +
    '<div class="this-week-card">' +
      '<div class="this-week-card__event">' +
        '<p class="this-week-card__eyebrow">All Lineups</p>' +
        '<p class="this-week-card__name">' + escapeHtml(selectedEvent.name) + '</p>' +
        '<p class="this-week-card__date">' + escapeHtml(dateStr) + venueStr + '</p>' +
        (matchup ? '<p class="this-week-card__matchup">' + escapeHtml(matchup) + '</p>' : '') +
      '</div>' +
      '<div class="this-week-card__right">' +
        '<p style="font-size: 14px; font-weight: 700; letter-spacing: 0.04em;">' + statusLabel + '</p>' +
      '</div>' +
    '</div>';

  // Wire the picker — re-loads event data and re-renders both regions.
  const pickEl = document.getElementById('lineupsEventSelect');
  if (pickEl) {
    pickEl.addEventListener('change', async function(e) {
      const newEv = availableEvents.find(function(ev) { return ev.id === e.target.value; });
      if (!newEv) return;
      selectedEvent = newEv;
      // Reflect in the URL so refreshing the page lands on the same event
      const url = new URL(window.location);
      url.searchParams.set('event', newEv.id);
      history.replaceState(null, '', url);
      await loadEventData();
      renderEventBanner();
      renderLineupsGrid();
    });
  }
}

// ========================================================================
// RENDER LINEUPS GRID
// One card per league member. Cards are sorted by event-score desc when
// scores exist; otherwise by team name to keep the order stable.
// ========================================================================
function renderLineupsGrid() {
  const el = document.getElementById('lineupsGrid');

  if (members.length === 0) {
    el.innerHTML = EmptyState.html({
      kind:  'roster',
      title: 'No managers yet',
      body:  'Invite friends to join your league and their lineups will show up here.'
    });
    return;
  }

  // Compute total event score per member from scoresByMember
  const eventTotal = {};
  members.forEach(function(m) {
    let total = 0;
    const memberScores = scoresByMember[m.id] || {};
    Object.keys(memberScores).forEach(function(fid) { total += memberScores[fid] || 0; });
    eventTotal[m.id] = total;
  });

  // Are there any scores at all for this event? Drives whether we sort by
  // score (post-event) or by team name (pre-event).
  const anyScores = Object.keys(scoresByMember).length > 0;

  const sorted = members.slice().sort(function(a, b) {
    if (anyScores) {
      if ((eventTotal[b.id] || 0) !== (eventTotal[a.id] || 0)) {
        return (eventTotal[b.id] || 0) - (eventTotal[a.id] || 0);
      }
    }
    return (a.team_name || '').localeCompare(b.team_name || '');
  });

  el.innerHTML = sorted.map(function(m) {
    return renderManagerCard(m, eventTotal[m.id] || 0, anyScores);
  }).join('');
}

// One manager's card: header (team name + total) + 3 starter slots.
function renderManagerCard(member, totalScore, anyScoresThisEvent) {
  const isMe        = member.id === myMember.id;
  const selectionIds = selectionsByMember[member.id] || [];
  const memberScores = scoresByMember[member.id]    || {};

  // Build slots — count depends on event type (3 for numbered, 2 for FN)
  const starterCount = currentStarterCount();
  let slotsHtml = '';
  for (let i = 0; i < starterCount; i++) {
    const fid = selectionIds[i];
    const fighter = fid ? fightersById[fid] : null;
    if (fighter) {
      slotsHtml += renderStarterTile(fighter, memberScores[fid], anyScoresThisEvent);
    } else {
      slotsHtml += '<div class="lineups-slot lineups-slot--empty"><span>Not set</span></div>';
    }
  }

  const totalLabel = anyScoresThisEvent
    ? '<span class="lineups-card__total">' + (Math.round(totalScore * 100) / 100).toFixed(1) + ' pts</span>'
    : '<span class="lineups-card__total lineups-card__total--muted">' + selectionIds.length + ' / 3 set</span>';

  // Click target: the whole card links to the per-member lineup view so the
  // user can see bench + roster construction. Own card links back to "your"
  // lineup page.
  const targetUrl = isMe
    ? 'lineup.html?id=' + leagueId
    : 'lineup.html?id=' + leagueId + '&member=' + member.id;

  return (
    '<a class="lineups-card' + (isMe ? ' lineups-card--me' : '') + '" href="' + targetUrl + '">' +
      '<div class="lineups-card__header">' +
        '<div class="lineups-card__team">' +
          '<span class="lineups-card__name">' + escapeHtml(member.team_name) + '</span>' +
          (isMe ? '<span class="lineups-card__you">You</span>' : '') +
        '</div>' +
        totalLabel +
      '</div>' +
      '<div class="lineups-card__slots">' + slotsHtml + '</div>' +
    '</a>'
  );
}

// One starter slot. Compact — photo, name, division, optional points chip.
function renderStarterTile(fighter, points, anyScoresThisEvent) {
  const divLabel = DIVISION_LABELS[fighter.primary_division] || fighter.primary_division;
  const rankBadge = fighter.is_champion ? 'C'
                  : fighter.current_rank ? '#' + fighter.current_rank
                  : 'NR';
  const photoHtml = fighter.photo_url
    ? '<img class="lineups-slot__photo" src="' + fighter.photo_url + '" alt="' + escapeHtml(fighter.name) + '" onerror="this.style.display=\'none\'">'
    : '<div class="lineups-slot__photo lineups-slot__photo--placeholder"></div>';

  // Points chip — same convention as the lineup page: render once any
  // scores exist for the event. "—" placeholder for fighters without
  // a score row yet (their fight hasn't been entered).
  let ptsHtml = '';
  if (anyScoresThisEvent) {
    const hasPts = points != null;
    const ptsStr = hasPts ? (Math.round(points * 100) / 100).toFixed(1) : '—';
    const emptyMod = hasPts ? '' : ' lineups-slot__pts--empty';
    ptsHtml = '<span class="lineups-slot__pts' + emptyMod + '">' + ptsStr + '</span>';
  }

  // tier modifier so the slot border matches champion / top-5 / top-15
  let tierClass = '';
  if (fighter.is_champion)              tierClass = ' lineups-slot--champion';
  else if (fighter.current_rank <= 5)   tierClass = ' lineups-slot--top5';
  else if (fighter.current_rank <= 15)  tierClass = ' lineups-slot--top15';

  return (
    '<div class="lineups-slot' + tierClass + '">' +
      '<div class="lineups-slot__photo-wrap">' + photoHtml +
        '<span class="lineups-slot__rank">' + rankBadge + '</span>' +
      '</div>' +
      '<div class="lineups-slot__info">' +
        '<span class="lineups-slot__name">' + escapeHtml(fighter.name) + '</span>' +
        '<span class="lineups-slot__division">' + escapeHtml(divLabel) + '</span>' +
      '</div>' +
      ptsHtml +
    '</div>'
  );
}

// Inline escape so this file has no external deps beyond supabaseClient
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

initLineups();
