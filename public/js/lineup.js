// ========================================================================
// LINEUP PAGE LOGIC
// Lets each manager pick 3 starters from their roster for the next UFC event.
// Selections are saved immediately on click. The page becomes read-only once
// the lineup locks (at the event's first prelim start time).
//
// Shell state: when the ufc_events table has no upcoming events, the page
// shows an informational empty state. The selection UI is fully built and
// will activate as soon as event data is seeded.
//
// URL param: ?id=LEAGUE_UUID
// Depends on supabaseClient (supabase-config.js) and requireAuth (auth-guard.js).
// ========================================================================

// Human-readable division names. Must stay in sync with draft.js and roster.js.
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

const MAX_STARTERS = 3;

let user, leagueId, myMemberId;
let myRoster    = []; // fighter objects on this manager's roster
let nextEvent   = null;
let selections  = new Set();   // fighter_id values currently marked as starters
let selectionRowIds = {};      // fighter_id -> starter_selections row id (for deletes)
let isLocked    = false;

// ========================================================================
// INIT
// Two-phase load: (1) league + members + next event in parallel, then
// (2) my roster + current selections once myMemberId is known.
// ========================================================================
async function initLineup() {
  user = await requireAuth();
  if (!user) return;

  leagueId = new URLSearchParams(window.location.search).get('id');
  if (!leagueId) { window.location.href = 'dashboard.html'; return; }

  document.getElementById('leagueLink').href = 'league.html?id=' + leagueId;

  // Phase 1: get league context, member list, and next event
  const [leagueRes, membersRes, eventRes] = await Promise.all([
    supabaseClient
      .from('leagues')
      .select('id, name, draft_started')
      .eq('id', leagueId)
      .single(),
    supabaseClient
      .from('league_members')
      .select('id, user_id, team_name')
      .eq('league_id', leagueId),
    // Fetch the soonest event whose date is today or later.
    // TODO: once events have a status column, also filter by status = 'upcoming'.
    supabaseClient
      .from('ufc_events')
      .select('id, name, event_date')
      .gte('event_date', new Date().toISOString().split('T')[0])
      .order('event_date')
      .limit(1)
  ]);

  if (leagueRes.error || !leagueRes.data) {
    window.location.href = 'dashboard.html';
    return;
  }

  const league  = leagueRes.data;
  const members = membersRes.data || [];

  // Verify the current user is a member
  const myMember = members.find(function(m) { return m.user_id === user.id; });
  if (!myMember) { window.location.href = 'dashboard.html'; return; }
  myMemberId = myMember.id;

  document.title = 'Lineup - ' + league.name;
  document.getElementById('leagueName').textContent = league.name;

  // Pull the single next event out of the array (empty array = no upcoming events)
  nextEvent = (eventRes.data && eventRes.data.length > 0) ? eventRes.data[0] : null;

  // Check if the lineup window is already closed.
  // The real lock is the first prelim start time; we use event_date as a proxy
  // until per-fight start times are available in the database.
  // Compare date strings directly (YYYY-MM-DD) to avoid UTC-vs-local timezone issues.
  const todayStr = new Date().toISOString().split('T')[0];
  isLocked = nextEvent ? nextEvent.event_date < todayStr : false;

  // Phase 2: load my roster and any existing selections for this event
  const rosterQuery = supabaseClient
    .from('rosters')
    .select('fighters(id, name, primary_division, current_rank, is_champion)')
    .eq('league_id', leagueId)
    .eq('league_member_id', myMemberId);

  // Only bother fetching selections if there is an event to select starters for
  const selectionsQuery = nextEvent
    ? supabaseClient
        .from('starter_selections')
        .select('id, fighter_id')
        .eq('league_member_id', myMemberId)
        .eq('event_id', nextEvent.id)
    : Promise.resolve({ data: [] });

  const [rosterRes, selectionsRes] = await Promise.all([rosterQuery, selectionsQuery]);

  // Extract the nested fighter objects from the join result
  myRoster = (rosterRes.data || [])
    .map(function(r) { return r.fighters; })
    .filter(Boolean);

  // Build the selections Set and the row-id map for deletes
  const existingSelections = selectionsRes.data || [];
  selections = new Set(existingSelections.map(function(s) { return s.fighter_id; }));
  selectionRowIds = {};
  existingSelections.forEach(function(s) { selectionRowIds[s.fighter_id] = s.id; });

  renderEventBanner(league);
  renderLineup(league);

  document.getElementById('pageContent').style.display = 'block';
}

// ========================================================================
// RENDER EVENT BANNER
// Dark header bar showing the event name, date, and whether the lineup
// is still open or has locked.
// ========================================================================
function renderEventBanner(league) {
  const el = document.getElementById('eventBanner');

  if (!nextEvent) {
    // No upcoming event - show a minimal note
    el.innerHTML =
      '<div class="event-banner">' +
        '<p class="event-banner-name">No upcoming events scheduled</p>' +
        '<p class="event-banner-date">Check back when the next UFC event is posted.</p>' +
      '</div>';
    return;
  }

  // Append T12:00:00 so the date is parsed as local noon, not UTC midnight.
  // Without this, "2026-05-03" would display as May 2 in US timezones.
  const dateStr = new Date(nextEvent.event_date + 'T12:00:00').toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const lockHtml = isLocked
    ? '<p class="event-banner-lock"><span class="lock-closed">&#128274; Lineup locked</span></p>'
    : '<p class="event-banner-lock"><span class="lock-open">&#128275; Lineup open</span> — locks at first prelim on ' + escapeHtml(dateStr) + '</p>';

  el.innerHTML =
    '<div class="event-banner">' +
      '<p class="event-banner-name">' + escapeHtml(nextEvent.name) + '</p>' +
      '<p class="event-banner-date">' + escapeHtml(dateStr) + '</p>' +
      lockHtml +
    '</div>';
}

// ========================================================================
// RENDER LINEUP
// Shows the manager's full roster as a selectable table. Fighters that are
// currently starters are highlighted. Up to MAX_STARTERS may be selected.
// ========================================================================
function renderLineup(league) {
  const el = document.getElementById('lineupContent');

  // Update the "X / 3" counter in the section heading
  const countEl = document.getElementById('starterCount');
  countEl.textContent = selections.size + ' / ' + MAX_STARTERS;
  countEl.className = 'starter-count' + (selections.size === MAX_STARTERS ? ' starter-count-full' : '');

  if (!league.draft_started) {
    el.innerHTML =
      '<div class="lineup-empty-state">' +
        '<p>Your roster is empty. Complete the draft first, then come back to set your lineup.</p>' +
      '</div>';
    return;
  }

  if (!nextEvent) {
    el.innerHTML =
      '<div class="lineup-empty-state">' +
        '<p>When the next event is scheduled you\'ll be able to pick 3 fighters from your ' +
        'roster as starters. Their stats score normally; non-starters score 0 that card.</p>' +
      '</div>';
    return;
  }

  if (myRoster.length === 0) {
    el.innerHTML =
      '<div class="lineup-empty-state"><p>No fighters on your roster yet.</p></div>';
    return;
  }

  if (isLocked) {
    el.innerHTML =
      '<div class="lineup-locked-notice">&#128274; Lineup is locked for this event.</div>';
  }

  // Sort roster: starters first, then by division order, then name
  const sorted = myRoster.slice().sort(function(a, b) {
    const aSelected = selections.has(a.id);
    const bSelected = selections.has(b.id);
    if (aSelected !== bSelected) return aSelected ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  let html = '<table class="lineup-table"><thead><tr>';
  html += '<th>Rank</th><th>Name</th><th>Division</th>';
  // TODO: add "On Card" column once fight card data is linked to ufc_events
  html += '<th class="th-action">Starter</th>';
  html += '</tr></thead><tbody>';

  sorted.forEach(function(f) {
    const isSelected   = selections.has(f.id);
    const isFull       = selections.size >= MAX_STARTERS;
    const rankDisplay  = f.is_champion ? 'C' : (f.current_rank ? '#' + f.current_rank : '-');
    const rankClass    = f.is_champion ? 'rank-champion' : (f.current_rank ? 'rank-ranked' : 'rank-unranked');
    const divLabel     = DIVISION_LABELS[f.primary_division] || f.primary_division;
    const rowClass     = isSelected ? ' class="lineup-row-selected"' : '';

    let btnHtml;
    if (isLocked) {
      // Read-only after lock: show state but no interaction
      btnHtml = isSelected
        ? '<span class="starter-badge">Starter</span>'
        : '<span class="bench-badge">Bench</span>';
    } else if (isSelected) {
      btnHtml = '<button class="btn-start btn-start-active" data-fighter-id="' + f.id + '">Remove</button>';
    } else if (isFull) {
      btnHtml = '<button class="btn-start" disabled>Start</button>';
    } else {
      btnHtml = '<button class="btn-start" data-fighter-id="' + f.id + '">Start</button>';
    }

    html += '<tr' + rowClass + '>';
    html += '<td><span class="' + rankClass + '">' + escapeHtml(rankDisplay) + '</span></td>';
    html += '<td>' + escapeHtml(f.name) + '</td>';
    html += '<td>' + escapeHtml(divLabel) + '</td>';
    html += '<td>' + btnHtml + '</td>';
    html += '</tr>';
  });

  html += '</tbody></table>';
  el.innerHTML = (isLocked ? el.innerHTML : '') + html;

  // Wire up toggle buttons (only present when not locked)
  if (!isLocked) {
    el.querySelectorAll('.btn-start[data-fighter-id]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        toggleStarter(btn.getAttribute('data-fighter-id'));
      });
    });
  }
}

// ========================================================================
// TOGGLE STARTER
// Adds or removes a fighter from the starter selections for this event.
// Saves immediately to the database on each click.
// ========================================================================
async function toggleStarter(fighterId) {
  if (isLocked) return;

  const isSelected = selections.has(fighterId);

  if (isSelected) {
    // Remove: delete the existing starter_selections row
    const rowId = selectionRowIds[fighterId];
    if (!rowId) return;

    const { error } = await supabaseClient
      .from('starter_selections')
      .delete()
      .eq('id', rowId);

    if (error) {
      alert('Error removing starter: ' + error.message);
      return;
    }

    selections.delete(fighterId);
    delete selectionRowIds[fighterId];

  } else {
    // Add: guard against exceeding the 3-starter limit
    if (selections.size >= MAX_STARTERS) return;

    const { data: newRow, error } = await supabaseClient
      .from('starter_selections')
      .insert({
        league_member_id: myMemberId,
        event_id:         nextEvent.id,
        fighter_id:       fighterId,
        slot_position:    selections.size + 1  // 1, 2, or 3
      })
      .select('id')
      .single();

    if (error) {
      alert('Error saving starter: ' + error.message);
      return;
    }

    selections.add(fighterId);
    selectionRowIds[fighterId] = newRow.id;
  }

  // Re-render with updated selections (pass a minimal league-like object)
  renderLineup({ draft_started: true });
}

// Escapes user-supplied strings before inserting into innerHTML to prevent XSS
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

initLineup();
