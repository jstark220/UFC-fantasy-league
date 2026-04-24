// ========================================================================
// SCORE EVENT PAGE LOGIC
// Commissioner-only page for entering fight results and triggering the
// v1.2 fantasy scoring calculation for a specific UFC event.
//
// Flow:
//   1. Pick an event from the dropdown.
//   2. Add each fight via the inline form (fighter search, stats, outcome).
//   3. Review the computed score preview per manager.
//   4. Click "Save Scores" to upsert rows into the scores table.
//
// URL params: ?league=LEAGUE_UUID  (redirects to dashboard.html if missing)
// Depends on supabaseClient (supabase-config.js) and requireAuth (auth-guard.js).
// ========================================================================

// Card position multipliers per v1.2 scoring spec
const CARD_MULTIPLIERS = {
  main_event:     1.2,
  co_main_event:  1.1,
  main_card:      1.0,
  prelim:         1.0,
  early_prelim:   1.0
};

// Human-readable weight class names (mirrors lineup.js / roster.js)
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

// Module-level state
let user, leagueId, league, members;
let allFighters    = [];  // full fighters table, used for the search autocomplete
let selectedEvent  = null;  // the ufc_events row currently selected
let fightResults   = [];    // fight_results rows already saved for selectedEvent
let editingFightId = null;  // non-null when editing an existing fight row

// ========================================================================
// INIT
// ========================================================================
async function initScoreEvent() {
  user = await requireAuth();
  if (!user) return;

  leagueId = new URLSearchParams(window.location.search).get('league');
  if (!leagueId) { window.location.href = 'dashboard.html'; return; }

  document.getElementById('leagueLink').href = 'league.html?id=' + leagueId;

  // Load league + members + full fighters list in parallel
  const [leagueRes, membersRes, fightersRes] = await Promise.all([
    supabaseClient
      .from('leagues')
      .select('id, name, commissioner_id, draft_started')
      .eq('id', leagueId)
      .single(),
    supabaseClient
      .from('league_members')
      .select('id, user_id, team_name')
      .eq('league_id', leagueId),
    supabaseClient
      .from('fighters')
      .select('id, name, primary_division, current_rank, is_champion')
      .order('name')
  ]);

  if (leagueRes.error || !leagueRes.data) {
    window.location.href = 'dashboard.html';
    return;
  }

  league  = leagueRes.data;
  members = membersRes.data || [];

  // Commissioner-only page: redirect anyone who is not the commissioner
  if (league.commissioner_id !== user.id) {
    window.location.href = 'league.html?id=' + leagueId;
    return;
  }

  allFighters = fightersRes.data || [];

  document.title = 'Score Event - ' + league.name;
  document.getElementById('leagueName').textContent = league.name;

  renderEventSelector();
  wireUpForm();

  document.getElementById('pageContent').style.display = 'block';
}

// ========================================================================
// EVENT SELECTOR
// Shows a dropdown of all past/present UFC events. Choosing one loads the
// fight results already saved for that event and shows the fight card section.
// ========================================================================
async function renderEventSelector() {
  const el = document.getElementById('eventSelectorContent');

  // Fetch all events to populate the dropdown (newest first for easy picking)
  const { data: events, error } = await supabaseClient
    .from('ufc_events')
    .select('id, name, event_date')
    .order('event_date', { ascending: false });

  if (error || !events || events.length === 0) {
    el.innerHTML = '<p class="score-empty">No UFC events found. Seed at least one event before scoring.</p>';
    return;
  }

  let html = '<div class="form-group event-selector-group">';
  html += '<label for="eventSelect">Select Event</label>';
  html += '<select id="eventSelect"><option value="">-- Pick an event --</option>';

  events.forEach(function(ev) {
    const dateStr = new Date(ev.event_date + 'T12:00:00').toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric'
    });
    html += '<option value="' + ev.id + '">' + escapeHtml(ev.name) + ' (' + escapeHtml(dateStr) + ')</option>';
  });

  html += '</select></div>';
  el.innerHTML = html;

  document.getElementById('eventSelect').addEventListener('change', async function() {
    const eventId = this.value;
    if (!eventId) {
      selectedEvent = null;
      document.getElementById('fightCardSection').style.display = 'none';
      document.getElementById('scorePreviewSection').style.display = 'none';
      return;
    }
    selectedEvent = events.find(function(ev) { return ev.id === eventId; });
    await loadFightsForEvent(eventId);
    document.getElementById('fightCardSection').style.display = 'block';
    document.getElementById('fightFormSection').style.display = 'none';
  });
}

// ========================================================================
// LOAD FIGHTS FOR EVENT
// Fetches all fight_results rows for the selected event and re-renders the
// fight card list and score preview.
// ========================================================================
async function loadFightsForEvent(eventId) {
  const { data, error } = await supabaseClient
    .from('fight_results')
    .select('*')
    .eq('event_id', eventId)
    .order('created_at');

  if (error) {
    alert('Error loading fight results: ' + error.message);
    return;
  }

  fightResults = data || [];

  // Update section title with the event name
  const eventName = selectedEvent ? selectedEvent.name : 'Event';
  document.getElementById('fightCardTitle').textContent = 'Fight Card: ' + escapeHtml(eventName);

  renderFightCardList();

  // Refresh preview whenever fights are reloaded
  if (fightResults.length > 0) {
    await computeAndShowPreview();
  } else {
    document.getElementById('scorePreviewSection').style.display = 'none';
  }
}

// ========================================================================
// RENDER FIGHT CARD LIST
// Shows each saved fight as a summary row with an Edit button.
// ========================================================================
function renderFightCardList() {
  const el = document.getElementById('fightCardList');

  if (fightResults.length === 0) {
    el.innerHTML = '<p class="score-empty">No fights added yet. Click "+ Add Fight" to start.</p>';
    return;
  }

  // Build a quick fighter name lookup from allFighters
  const fighterMap = {};
  allFighters.forEach(function(f) { fighterMap[f.id] = f.name; });

  let html = '<table class="fight-card-table"><thead><tr>';
  html += '<th>Fighters</th><th>Position</th><th>Outcome</th><th>Method</th><th></th>';
  html += '</tr></thead><tbody>';

  fightResults.forEach(function(fight) {
    const nameA     = fighterMap[fight.fighter_a_id] || '(unknown)';
    const nameB     = fighterMap[fight.fighter_b_id] || '(unknown)';
    const pos       = formatCardPosition(fight.card_position);
    const outcome   = formatOutcome(fight, fighterMap);
    const method    = fight.outcome ? formatMethod(fight) : '-';

    html += '<tr>';
    html += '<td>' + escapeHtml(nameA) + ' vs ' + escapeHtml(nameB) + '</td>';
    html += '<td>' + escapeHtml(pos) + '</td>';
    html += '<td>' + escapeHtml(outcome) + '</td>';
    html += '<td>' + escapeHtml(method) + '</td>';
    html += '<td><button class="btn-secondary btn-sm" data-fight-id="' + fight.id + '">Edit</button></td>';
    html += '</tr>';
  });

  html += '</tbody></table>';
  el.innerHTML = html;

  // Wire up edit buttons
  el.querySelectorAll('.btn-sm[data-fight-id]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      openEditFight(btn.getAttribute('data-fight-id'));
    });
  });
}

// Helper: human-readable card position label
function formatCardPosition(pos) {
  const labels = {
    main_event:    'Main Event',
    co_main_event: 'Co-Main',
    main_card:     'Main Card',
    prelim:        'Prelim',
    early_prelim:  'Early Prelim'
  };
  return labels[pos] || pos;
}

// Helper: outcome summary string for the fight card list
function formatOutcome(fight, fighterMap) {
  if (!fight.outcome) return 'Pending';
  if (fight.outcome === 'draw')      return 'Draw';
  if (fight.outcome === 'no_contest') return 'No Contest';
  if (fight.outcome === 'cancelled')  return 'Cancelled';
  const winnerId = fight.winner_id;
  if (!winnerId) return fight.outcome;
  return (fighterMap[winnerId] || '?') + ' wins';
}

// Helper: method label + round/time for the fight card list
function formatMethod(fight) {
  const labels = {
    ko_tko: 'KO/TKO', submission: 'Sub', decision_u: 'Dec (U)',
    decision_s: 'Dec (S)', decision_m: 'Dec (M)', dq: 'DQ',
    draw: 'Draw', no_contest: 'NC', cancelled: 'Cancelled'
  };
  const label = labels[fight.outcome] || fight.outcome || '-';
  if (!fight.end_round) return label;
  const mins = Math.floor((fight.end_time_seconds || 0) / 60);
  const secs = String((fight.end_time_seconds || 0) % 60).padStart(2, '0');
  return label + ' R' + fight.end_round + ' ' + mins + ':' + secs;
}

// ========================================================================
// WIRE UP FORM
// Attaches all form-level event listeners once on init. Individual field
// values are populated per-fight when opening the add/edit form.
// ========================================================================
function wireUpForm() {
  document.getElementById('addFightBtn').addEventListener('click', openNewFight);
  document.getElementById('cancelFightBtn').addEventListener('click', closeFightForm);
  document.getElementById('fightForm').addEventListener('submit', handleFightFormSubmit);
  document.getElementById('saveScoresBtn').addEventListener('click', saveScores);

  // Fighter A search
  wireSearchInput('fighterASearch', 'fighterADropdown', 'fighterAId', 'fighterASelected', 'statsHeaderA');
  // Fighter B search
  wireSearchInput('fighterBSearch', 'fighterBDropdown', 'fighterBId', 'fighterBSelected', 'statsHeaderB');
}

// ========================================================================
// FIGHTER SEARCH AUTOCOMPLETE
// Filters allFighters by name as the user types, shows a dropdown of
// matches, and sets a hidden input with the selected fighter's UUID.
// ========================================================================
function wireSearchInput(searchId, dropdownId, hiddenId, selectedId, headerLabelId) {
  const searchEl   = document.getElementById(searchId);
  const dropdownEl = document.getElementById(dropdownId);

  searchEl.addEventListener('input', function() {
    const query = this.value.trim().toLowerCase();

    if (query.length < 2) {
      dropdownEl.style.display = 'none';
      return;
    }

    const matches = allFighters.filter(function(f) {
      return f.name.toLowerCase().includes(query);
    }).slice(0, 8);  // cap to 8 results for a manageable list

    if (matches.length === 0) {
      dropdownEl.style.display = 'none';
      return;
    }

    let html = '';
    matches.forEach(function(f) {
      const div = DIVISION_LABELS[f.primary_division] || f.primary_division;
      html += '<div class="fighter-dropdown-item" data-fighter-id="' + f.id + '">' +
              escapeHtml(f.name) + '<span class="fighter-dropdown-div">' + escapeHtml(div) + '</span></div>';
    });

    dropdownEl.innerHTML = html;
    dropdownEl.style.display = 'block';

    // Select a fighter on click
    dropdownEl.querySelectorAll('.fighter-dropdown-item').forEach(function(item) {
      item.addEventListener('click', function() {
        const fighterId = item.getAttribute('data-fighter-id');
        const fighter   = allFighters.find(function(f) { return f.id === fighterId; });

        document.getElementById(hiddenId).value = fighterId;
        searchEl.value = fighter.name;
        dropdownEl.style.display = 'none';

        // Update the stats column header to show the actual fighter's name
        const rankStr = fighter.is_champion ? ' (C)' : (fighter.current_rank ? ' (#' + fighter.current_rank + ')' : '');
        document.getElementById(headerLabelId).textContent = fighter.name + rankStr;

        // Set visible confirmation below the search box
        const div = DIVISION_LABELS[fighter.primary_division] || fighter.primary_division;
        document.getElementById(selectedId).textContent = div;
      });
    });
  });

  // Close dropdown when focus leaves the search field
  searchEl.addEventListener('blur', function() {
    setTimeout(function() { dropdownEl.style.display = 'none'; }, 150);
  });
}

// ========================================================================
// OPEN / CLOSE FIGHT FORM
// ========================================================================
function openNewFight() {
  editingFightId = null;
  resetFightForm();
  document.getElementById('fightFormTitle').textContent = 'Add Fight';
  document.getElementById('fightFormSection').style.display = 'block';
  document.getElementById('fightFormSection').scrollIntoView({ behavior: 'smooth' });
}

function openEditFight(fightId) {
  editingFightId = fightId;
  const fight = fightResults.find(function(f) { return f.id === fightId; });
  if (!fight) return;

  populateFightForm(fight);
  document.getElementById('fightFormTitle').textContent = 'Edit Fight';
  document.getElementById('fightFormSection').style.display = 'block';
  document.getElementById('fightFormSection').scrollIntoView({ behavior: 'smooth' });
}

function closeFightForm() {
  document.getElementById('fightFormSection').style.display = 'none';
  editingFightId = null;
}

// ========================================================================
// RESET FIGHT FORM
// Clears all fields back to their defaults for adding a new fight.
// ========================================================================
function resetFightForm() {
  document.getElementById('cardPosition').value   = 'main_card';
  document.getElementById('weightClass').value    = 'lightweight';
  document.getElementById('titleType').value      = 'none';
  document.getElementById('isTitleDefense').checked = false;
  document.getElementById('fightOfTheNight').checked = false;
  document.getElementById('outcome').value        = '';
  document.getElementById('winner').value         = '';
  document.getElementById('endRound').value       = '';
  document.getElementById('endTimeSeconds').value = '';

  document.getElementById('fighterASearch').value  = '';
  document.getElementById('fighterAId').value      = '';
  document.getElementById('fighterASelected').textContent = '';
  document.getElementById('statsHeaderA').textContent     = 'Fighter A Stats';

  document.getElementById('fighterBSearch').value  = '';
  document.getElementById('fighterBId').value      = '';
  document.getElementById('fighterBSelected').textContent = '';
  document.getElementById('statsHeaderB').textContent     = 'Fighter B Stats';

  ['aSigStrikes','aTakedowns','aReversals','aKnockdowns','aControlSeconds'].forEach(function(id) {
    document.getElementById(id).value = '0';
  });
  document.getElementById('aOpponentRank').value = '';
  document.getElementById('aPotN').checked = false;

  ['bSigStrikes','bTakedowns','bReversals','bKnockdowns','bControlSeconds'].forEach(function(id) {
    document.getElementById(id).value = '0';
  });
  document.getElementById('bOpponentRank').value = '';
  document.getElementById('bPotN').checked = false;
}

// ========================================================================
// POPULATE FIGHT FORM
// Fills in the form fields from an existing fight_results row for editing.
// ========================================================================
function populateFightForm(fight) {
  resetFightForm();

  document.getElementById('cardPosition').value      = fight.card_position || 'main_card';
  document.getElementById('weightClass').value       = fight.weight_class  || 'lightweight';
  document.getElementById('titleType').value         = fight.title_type    || 'none';
  document.getElementById('isTitleDefense').checked  = !!fight.is_title_defense;
  document.getElementById('fightOfTheNight').checked = !!fight.fight_of_the_night;
  document.getElementById('outcome').value           = fight.outcome || '';
  // Derive winner dropdown value from winner_id
  if (fight.winner_id && fight.winner_id === fight.fighter_a_id)      document.getElementById('winner').value = 'a';
  else if (fight.winner_id && fight.winner_id === fight.fighter_b_id) document.getElementById('winner').value = 'b';
  else                                                                  document.getElementById('winner').value = '';
  document.getElementById('endRound').value          = fight.end_round || '';
  document.getElementById('endTimeSeconds').value    = fight.end_time_seconds != null ? fight.end_time_seconds : '';

  // Populate fighter A
  const fighterA = allFighters.find(function(f) { return f.id === fight.fighter_a_id; });
  if (fighterA) {
    document.getElementById('fighterAId').value         = fighterA.id;
    document.getElementById('fighterASearch').value     = fighterA.name;
    document.getElementById('fighterASelected').textContent = DIVISION_LABELS[fighterA.primary_division] || '';
    const rankA = fighterA.is_champion ? ' (C)' : (fighterA.current_rank ? ' (#' + fighterA.current_rank + ')' : '');
    document.getElementById('statsHeaderA').textContent = fighterA.name + rankA;
  }

  // Populate fighter B
  const fighterB = allFighters.find(function(f) { return f.id === fight.fighter_b_id; });
  if (fighterB) {
    document.getElementById('fighterBId').value         = fighterB.id;
    document.getElementById('fighterBSearch').value     = fighterB.name;
    document.getElementById('fighterBSelected').textContent = DIVISION_LABELS[fighterB.primary_division] || '';
    const rankB = fighterB.is_champion ? ' (C)' : (fighterB.current_rank ? ' (#' + fighterB.current_rank + ')' : '');
    document.getElementById('statsHeaderB').textContent = fighterB.name + rankB;
  }

  document.getElementById('aSigStrikes').value     = fight.fighter_a_sig_strikes   || 0;
  document.getElementById('aTakedowns').value      = fight.fighter_a_takedowns      || 0;
  document.getElementById('aReversals').value      = fight.fighter_a_reversals      || 0;
  document.getElementById('aKnockdowns').value     = fight.fighter_a_knockdowns     || 0;
  document.getElementById('aControlSeconds').value = fight.fighter_a_control_seconds || 0;
  document.getElementById('aOpponentRank').value   = fight.fighter_a_opponent_rank != null ? fight.fighter_a_opponent_rank : '';
  document.getElementById('aPotN').checked         = !!fight.fighter_a_potn;

  document.getElementById('bSigStrikes').value     = fight.fighter_b_sig_strikes   || 0;
  document.getElementById('bTakedowns').value      = fight.fighter_b_takedowns      || 0;
  document.getElementById('bReversals').value      = fight.fighter_b_reversals      || 0;
  document.getElementById('bKnockdowns').value     = fight.fighter_b_knockdowns     || 0;
  document.getElementById('bControlSeconds').value = fight.fighter_b_control_seconds || 0;
  document.getElementById('bOpponentRank').value   = fight.fighter_b_opponent_rank != null ? fight.fighter_b_opponent_rank : '';
  document.getElementById('bPotN').checked         = !!fight.fighter_b_potn;
}

// ========================================================================
// HANDLE FIGHT FORM SUBMIT
// Validates required fields, builds the fight_results row, then INSERTs or
// UPDATEs depending on whether we're adding a new fight or editing one.
// ========================================================================
async function handleFightFormSubmit(e) {
  e.preventDefault();

  const fighterAId = document.getElementById('fighterAId').value;
  const fighterBId = document.getElementById('fighterBId').value;

  if (!fighterAId || !fighterBId) {
    alert('Please select both fighters before saving.');
    return;
  }
  if (fighterAId === fighterBId) {
    alert('Fighter A and Fighter B must be different fighters.');
    return;
  }
  if (!selectedEvent) {
    alert('No event selected.');
    return;
  }

  const outcome       = document.getElementById('outcome').value || null;
  const winnerSel     = document.getElementById('winner').value;
  const endRound      = parseInt(document.getElementById('endRound').value) || null;
  const endTimeSec    = parseInt(document.getElementById('endTimeSeconds').value);
  const endTimeSecVal = isNaN(endTimeSec) ? null : endTimeSec;

  // Derive winner_id from the winner dropdown (a = fighter A, b = fighter B, blank = no winner)
  let winnerId = null;
  if (winnerSel === 'a') winnerId = fighterAId;
  if (winnerSel === 'b') winnerId = fighterBId;

  const row = {
    event_id:                    selectedEvent.id,
    fighter_a_id:                fighterAId,
    fighter_b_id:                fighterBId,
    weight_class:                document.getElementById('weightClass').value,
    card_position:               document.getElementById('cardPosition').value,
    title_type:                  document.getElementById('titleType').value,
    is_title_defense:            document.getElementById('isTitleDefense').checked,
    fight_of_the_night:          document.getElementById('fightOfTheNight').checked,
    outcome:                     outcome,
    winner_id:                   winnerId,
    end_round:                   endRound,
    end_time_seconds:            endTimeSecVal,
    fighter_a_sig_strikes:       parseInt(document.getElementById('aSigStrikes').value)     || 0,
    fighter_a_takedowns:         parseInt(document.getElementById('aTakedowns').value)      || 0,
    fighter_a_reversals:         parseInt(document.getElementById('aReversals').value)      || 0,
    fighter_a_knockdowns:        parseInt(document.getElementById('aKnockdowns').value)     || 0,
    fighter_a_control_seconds:   parseInt(document.getElementById('aControlSeconds').value) || 0,
    fighter_a_opponent_rank:     parseInt(document.getElementById('aOpponentRank').value)   || null,
    fighter_a_potn:              document.getElementById('aPotN').checked,
    fighter_b_sig_strikes:       parseInt(document.getElementById('bSigStrikes').value)     || 0,
    fighter_b_takedowns:         parseInt(document.getElementById('bTakedowns').value)      || 0,
    fighter_b_reversals:         parseInt(document.getElementById('bReversals').value)      || 0,
    fighter_b_knockdowns:        parseInt(document.getElementById('bKnockdowns').value)     || 0,
    fighter_b_control_seconds:   parseInt(document.getElementById('bControlSeconds').value) || 0,
    fighter_b_opponent_rank:     parseInt(document.getElementById('bOpponentRank').value)   || null,
    fighter_b_potn:              document.getElementById('bPotN').checked
  };

  const btn = document.getElementById('saveFightBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  let saveError;

  if (editingFightId) {
    const { error } = await supabaseClient
      .from('fight_results')
      .update(row)
      .eq('id', editingFightId);
    saveError = error;
  } else {
    const { error } = await supabaseClient
      .from('fight_results')
      .insert(row);
    saveError = error;
  }

  btn.disabled = false;
  btn.textContent = 'Save Fight';

  if (saveError) {
    alert('Error saving fight: ' + saveError.message);
    return;
  }

  closeFightForm();
  await loadFightsForEvent(selectedEvent.id);
}

// ========================================================================
// COMPUTE FIGHTER SCORE (v1.2)
// Takes a fight_results row and a boolean (true = computing for fighter A).
// Returns an object with a numeric total and a breakdown for storage in
// scoring_detail.
// ========================================================================
function computeFighterScore(fight, isA) {
  const prefix = isA ? 'fighter_a_' : 'fighter_b_';
  const opponentPrefix = isA ? 'fighter_b_' : 'fighter_a_';

  const sigStrikes    = fight[prefix + 'sig_strikes']    || 0;
  const takedowns     = fight[prefix + 'takedowns']      || 0;
  const reversals     = fight[prefix + 'reversals']      || 0;
  const knockdowns    = fight[prefix + 'knockdowns']     || 0;
  const controlSec    = fight[prefix + 'control_seconds'] || 0;
  const potn          = !!fight[prefix + 'potn'];
  const opponentRank  = fight[prefix + 'opponent_rank'];  // rank of the opponent they faced

  const fighterId = isA ? fight.fighter_a_id : fight.fighter_b_id;
  const isWinner  = fight.winner_id === fighterId;
  const isDraw    = fight.outcome === 'draw';

  // Base stats score
  const base = (sigStrikes * 0.1) + (takedowns * 1) + (reversals * 1) +
               (knockdowns * 2) + (controlSec * 0.01);

  // Win bonus (only if this fighter won)
  let winBonus = 0;
  if (isWinner) {
    const outcome  = fight.outcome;
    const round    = fight.end_round;
    const timeSec  = fight.end_time_seconds;
    const isFinish = outcome === 'ko_tko' || outcome === 'submission';

    if (isFinish) {
      if      (round === 1) winBonus = 18;
      else if (round === 2) winBonus = 14;
      else if (round === 3) winBonus = 9;
      else                  winBonus = 8;  // R4 or R5 finish

      // Extra +5 bonus for a finish inside 60 seconds of R1
      if (round === 1 && timeSec != null && timeSec < 60) winBonus += 5;
    } else if (outcome === 'decision_u' || outcome === 'decision_s' ||
               outcome === 'decision_m' || outcome === 'dq') {
      winBonus = 6;
    }
  } else if (isDraw) {
    winBonus = 3;  // draws earn both fighters a small bonus
  }

  // Title bonus (only for the winner or both on defense)
  let titleBonus = 0;
  if (isWinner && fight.title_type !== 'none') {
    if (fight.title_type === 'divisional') {
      titleBonus = fight.is_title_defense ? 5 : 10;
    } else if (fight.title_type === 'interim' || fight.title_type === 'bmf') {
      titleBonus = fight.is_title_defense ? 3 : 5;
    }
  }

  // Ranked opponent bonus (only for the winner)
  let rankedOppBonus = 0;
  if (isWinner && opponentRank != null) {
    if      (opponentRank <= 5)  rankedOppBonus = 4;
    else if (opponentRank <= 10) rankedOppBonus = 2;
    else if (opponentRank <= 15) rankedOppBonus = 1;
  }

  // Performance of the Night bonus
  const potnBonus = potn ? 6 : 0;

  // Fight of the Night bonus (shared by both fighters)
  const fotnBonus = fight.fight_of_the_night ? 4 : 0;

  // Card position multiplier
  const multiplier = CARD_MULTIPLIERS[fight.card_position] || 1.0;

  const subtotal   = base + winBonus + titleBonus + rankedOppBonus + potnBonus + fotnBonus;
  const total      = Math.round(subtotal * multiplier * 100) / 100;  // round to 2 decimals

  return {
    fighterId:      fighterId,
    total:          total,
    base_points:    Math.round(base * 100) / 100,
    win_bonus:      winBonus,
    title_bonus:    titleBonus,
    ranked_opp_bonus: rankedOppBonus,
    potn_bonus:     potnBonus,
    fotn_bonus:     fotnBonus,
    card_multiplier: multiplier,
    scoring_detail: {
      sig_strikes:      sigStrikes,
      takedowns:        takedowns,
      reversals:        reversals,
      knockdowns:       knockdowns,
      control_seconds:  controlSec,
      opponent_rank:    opponentRank,
      is_winner:        isWinner,
      is_draw:          isDraw,
      outcome:          fight.outcome,
      end_round:        fight.end_round,
      end_time_seconds: fight.end_time_seconds
    }
  };
}

// ========================================================================
// COMPUTE AND SHOW PREVIEW
// For each fight result, computes both fighters' scores. Then looks at each
// league member's starter selections for this event and sums their starters'
// scores to produce a per-manager total for the preview table.
// ========================================================================
async function computeAndShowPreview() {
  if (!selectedEvent || fightResults.length === 0) {
    document.getElementById('scorePreviewSection').style.display = 'none';
    return;
  }

  // Build a map of fighter_id -> computed score object from all fight results
  const fighterScores = {};
  fightResults.forEach(function(fight) {
    if (fight.fighter_a_id) {
      fighterScores[fight.fighter_a_id] = { fight: fight, scoreObj: computeFighterScore(fight, true) };
    }
    if (fight.fighter_b_id) {
      fighterScores[fight.fighter_b_id] = { fight: fight, scoreObj: computeFighterScore(fight, false) };
    }
  });

  // Fetch all starter selections for this event across all league members
  const { data: allSelections, error: selErr } = await supabaseClient
    .from('starter_selections')
    .select('league_member_id, fighter_id')
    .eq('event_id', selectedEvent.id)
    .in('league_member_id', members.map(function(m) { return m.id; }));

  if (selErr) {
    alert('Error loading starter selections: ' + selErr.message);
    return;
  }

  // Group selections by member
  const selByMember = {};
  members.forEach(function(m) { selByMember[m.id] = []; });
  (allSelections || []).forEach(function(s) {
    if (selByMember[s.league_member_id]) {
      selByMember[s.league_member_id].push(s.fighter_id);
    }
  });

  // Compute per-member totals and build the rows for the preview table
  const previewRows = members.map(function(member) {
    const starterIds = selByMember[member.id] || [];
    let memberTotal  = 0;
    const starterDetails = [];

    starterIds.forEach(function(fid) {
      const entry = fighterScores[fid];
      if (entry) {
        memberTotal += entry.scoreObj.total;
        const fighterName = (allFighters.find(function(f) { return f.id === fid; }) || {}).name || fid;
        starterDetails.push({ name: fighterName, pts: entry.scoreObj.total });
      } else {
        // Fighter in selections but no fight result entered yet: 0 pts, note it
        const fighterName = (allFighters.find(function(f) { return f.id === fid; }) || {}).name || fid;
        starterDetails.push({ name: fighterName, pts: 0, noFight: true });
      }
    });

    memberTotal = Math.round(memberTotal * 100) / 100;

    return { member: member, total: memberTotal, starters: starterDetails };
  });

  // Sort preview: highest first
  previewRows.sort(function(a, b) { return b.total - a.total; });

  // Render the preview table
  let html = '<table class="score-preview-table"><thead><tr>';
  html += '<th>Team</th><th>Starters</th><th class="pts-cell">Event Pts</th>';
  html += '</tr></thead><tbody>';

  previewRows.forEach(function(row) {
    const starterHtml = row.starters.length > 0
      ? row.starters.map(function(s) {
          return escapeHtml(s.name) + ': ' + s.pts.toFixed(2) + (s.noFight ? ' (no fight)' : '');
        }).join('<br>')
      : '<span class="score-preview-none">No starters selected</span>';

    html += '<tr>';
    html += '<td>' + escapeHtml(row.member.team_name) + '</td>';
    html += '<td class="score-preview-starters">' + starterHtml + '</td>';
    html += '<td class="pts-cell"><strong>' + row.total.toFixed(2) + '</strong></td>';
    html += '</tr>';
  });

  html += '</tbody></table>';
  document.getElementById('scorePreviewContent').innerHTML = html;
  document.getElementById('scorePreviewSection').style.display = 'block';
}

// ========================================================================
// SAVE SCORES
// Computes final scores and upserts one row per (member, event, fighter)
// triplet into the scores table. Uses the unique constraint on
// (league_member_id, event_id, fighter_id) for idempotent re-saves.
// ========================================================================
async function saveScores() {
  if (!selectedEvent || fightResults.length === 0) return;

  if (!confirm('Save scores for ' + selectedEvent.name + '? This will overwrite any previously saved scores for this event.')) return;

  const btn = document.getElementById('saveScoresBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  // Build fighter_id -> { scoreObj, fight } map
  const fighterScores = {};
  fightResults.forEach(function(fight) {
    if (fight.fighter_a_id) {
      fighterScores[fight.fighter_a_id] = { fight: fight, scoreObj: computeFighterScore(fight, true) };
    }
    if (fight.fighter_b_id) {
      fighterScores[fight.fighter_b_id] = { fight: fight, scoreObj: computeFighterScore(fight, false) };
    }
  });

  // Load all starter selections for this event for this league's members
  const { data: allSelections, error: selErr } = await supabaseClient
    .from('starter_selections')
    .select('league_member_id, fighter_id')
    .eq('event_id', selectedEvent.id)
    .in('league_member_id', members.map(function(m) { return m.id; }));

  if (selErr) {
    alert('Error loading selections: ' + selErr.message);
    btn.disabled = false;
    btn.textContent = 'Save Scores to Standings';
    return;
  }

  // Build the upsert payload
  const upsertRows = [];

  (allSelections || []).forEach(function(sel) {
    const entry = fighterScores[sel.fighter_id];
    if (!entry) return;  // fighter not in any entered fight: skip (scores 0 by omission)

    const s = entry.scoreObj;
    upsertRows.push({
      league_member_id: sel.league_member_id,
      league_id:        leagueId,
      event_id:         selectedEvent.id,
      fight_result_id:  entry.fight.id,
      fighter_id:       sel.fighter_id,
      base_points:      s.base_points,
      win_bonus:        s.win_bonus,
      title_bonus:      s.title_bonus,
      ranked_opp_bonus: s.ranked_opp_bonus,
      potn_bonus:       s.potn_bonus,
      fotn_bonus:       s.fotn_bonus,
      card_multiplier:  s.card_multiplier,
      total_points:     s.total,
      scoring_detail:   s.scoring_detail,
      calculated_at:    new Date().toISOString()
    });
  });

  if (upsertRows.length === 0) {
    alert('No starter selections found for this event. Make sure managers have set their lineups before scoring.');
    btn.disabled = false;
    btn.textContent = 'Save Scores to Standings';
    return;
  }

  const { error: upsertErr } = await supabaseClient
    .from('scores')
    .upsert(upsertRows, { onConflict: 'league_member_id,event_id,fighter_id' });

  btn.disabled = false;
  btn.textContent = 'Save Scores to Standings';

  if (upsertErr) {
    alert('Error saving scores: ' + upsertErr.message);
    return;
  }

  alert('Scores saved! Visit the Standings page to see the updated results.');
}

// Escapes user-supplied strings before inserting into innerHTML to prevent XSS
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

initScoreEvent();
