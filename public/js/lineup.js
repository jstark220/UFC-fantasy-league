// ========================================================================
// LINEUP PAGE LOGIC
// Lets each manager pick 3 starters from their roster for the next UFC event.
// Starter cards display at the top; the full roster list is below.
// Clicking "Start" on a roster row fills a card slot. Clicking "Bench" on
// a card empties that slot and returns the fighter to the bench.
//
// Placeholder data is used for now. The TODO comments mark the four places
// to swap in real Supabase queries when the data is ready.
//
// URL param: ?id=LEAGUE_UUID
// Depends on supabaseClient (supabase-config.js) and requireAuth (auth-guard.js).
// ========================================================================

// Men's division keys in weight-class order (lightest to heaviest)
const MENS_DIVISIONS = [
  'flyweight', 'bantamweight', 'featherweight', 'lightweight',
  'welterweight', 'middleweight', 'light_heavyweight', 'heavyweight'
];
// Women's divisions treated as a shared flex pool after the first 2 picks
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

const MAX_STARTERS = 3;

// Card-position ordering used to sort fights from headliner down.
const CARD_POSITION_ORDER = { main_event: 0, co_main: 1, main_card: 2 };

// ---- Placeholder roster (replace with real DB fetch when ready) ----
// TODO: replace this array with the rosters table query from the existing
// initLineup() Phase 2 fetch.
const PLACEHOLDER_ROSTER = [
  {
    id: 'p1',
    name: 'Islam Makhachev',
    primary_division: 'lightweight',
    current_rank: null,
    is_champion: true,
    record_wins: 27, record_losses: 1, record_draws: 0,
    photo_url: 'https://ufc.com/images/styles/athlete_bio_full_body/s3/2025-01/7/MAKHACHEV_ISLAM_L_BELT_01-18.png?itok=lQCE4AsW'
  },
  {
    id: 'p2',
    name: 'Alex Pereira',
    primary_division: 'light_heavyweight',
    current_rank: 1,
    is_champion: false,
    record_wins: 12, record_losses: 2, record_draws: 0,
    photo_url: 'https://ufc.com/images/styles/athlete_bio_full_body/s3/2025-03/PEREIRA_ALEX_L.png?itok=bcJxsjY3'
  },
  {
    id: 'p3',
    name: 'Ilia Topuria',
    primary_division: 'lightweight',
    current_rank: 2,
    is_champion: false,
    record_wins: 17, record_losses: 0, record_draws: 0,
    photo_url: 'https://ufc.com/images/styles/athlete_bio_full_body/s3/2024-10/TOPURIA_ILIA_L_BELT_10-26.png?itok=63v_RyKk'
  },
  {
    id: 'p4',
    name: 'Dustin Poirier',
    primary_division: 'lightweight',
    current_rank: 3,
    is_champion: false,
    record_wins: 30, record_losses: 9, record_draws: 0,
    photo_url: 'https://ufc.com/images/styles/athlete_bio_full_body/s3/2025-01/5/POIRIER_DUSTIN_L_06-01.png?itok=-a4s9rA3'
  },
  {
    id: 'p5',
    name: 'Dricus du Plessis',
    primary_division: 'middleweight',
    current_rank: null,
    is_champion: true,
    record_wins: 23, record_losses: 2, record_draws: 0,
    photo_url: 'https://ufc.com/images/styles/athlete_bio_full_body/s3/2025-08/DU_PLESSIS_DRICUS_L_01-20.png?itok=ci2IaNRH'
  },
  {
    id: 'p6',
    name: 'Sean O\'Malley',
    primary_division: 'bantamweight',
    current_rank: 2,
    is_champion: false,
    record_wins: 18, record_losses: 2, record_draws: 0,
    photo_url: 'https://ufc.com/images/styles/athlete_bio_full_body/s3/2026-01/OMALLEY_SEAN_L_01-24.png?itok=rrhehnzb'
  },
  {
    id: 'p7',
    name: 'Merab Dvalishvili',
    primary_division: 'bantamweight',
    current_rank: null,
    is_champion: true,
    record_wins: 20, record_losses: 4, record_draws: 0,
    photo_url: 'https://ufc.com/images/styles/athlete_bio_full_body/s3/2022-08/DVALISHVILI_MERAB_L_08-20.png?itok=NSMoEfhc'
  },
  {
    id: 'p8',
    name: 'Paddy Pimblett',
    primary_division: 'lightweight',
    current_rank: 9,
    is_champion: false,
    record_wins: 22, record_losses: 3, record_draws: 0,
    photo_url: 'https://ufc.com/images/styles/athlete_bio_full_body/s3/2025-01/5/PIMBLETT_PADDY_L_07-27.png?itok=FYFReFh0'
  }
];

// Module-level state
let user, leagueId, myMemberId;
let myRoster      = [];
let availableEvents      = [];   // every event the user can pick from (past + future)
let selectedEvent        = null; // the event currently being viewed/edited
let selectedEventScores  = {};   // fighter_id -> total_points scored at selectedEvent (empty if not yet scored)
let isLocked      = false;       // true when lineup edits are blocked: lock_time passed OR event is in the past
let isPastEvent   = false;       // true when selectedEvent.event_date is before today
let isViewMode    = false;   // true when browsing another manager's lineup from standings
let viewedMember  = null;    // the member object being viewed (null when viewing own lineup)
let isCommish     = false;   // true when the viewer is a commissioner of this league
let lockCountdownTimer = null;  // interval id for the per-second lock countdown
let selections    = new Set();  // fighter IDs currently started
let selectionRowIds = {};       // fighter_id -> starter_selections DB row id
let selectionSlots  = {};       // fighter_id -> slot_position (1, 2, or 3)
let rosterRowIds    = {};       // fighter_id -> rosters table row id (needed to delete)

// Fight card for the currently selected event. Populated by loadEventData()
// from fight_results table. Each entry:
//   { id, redId, blueId, redCorner, blueCorner, weightClass, cardPosition,
//     badge, outcome, winnerId, titleType, isFotN }
let selectedEventFightCard = [];

// ========================================================================
// INIT
// ========================================================================
async function initLineup() {
  user = await requireAuth();
  if (!user) return;

  leagueId = new URLSearchParams(window.location.search).get('id');
  if (!leagueId) { window.location.href = 'dashboard.html'; return; }

  document.getElementById('leagueLink').href = 'league.html?id=' + leagueId;

  const [leagueRes, membersRes, eventRes] = await Promise.all([
    supabaseClient.from('leagues').select('id, name, commissioner_id, draft_started').eq('id', leagueId).single(),
    supabaseClient.from('league_members').select('id, user_id, team_name, is_commissioner').eq('league_id', leagueId),
    // Fetch every event so the user can pick any of them (past or future).
    // Newest first so the dropdown shows the most relevant cards near the top.
    supabaseClient.from('ufc_events')
      .select('id, name, full_name, event_date, venue, lineup_lock_time, is_completed')
      .order('event_date', { ascending: false })
  ]);

  if (leagueRes.error || !leagueRes.data) {
    window.location.href = 'dashboard.html';
    return;
  }

  const league  = leagueRes.data;
  const members = membersRes.data || [];
  const myMember = members.find(function(m) { return m.user_id === user.id; });
  if (!myMember) { window.location.href = 'dashboard.html'; return; }

  // If a member param is present and belongs to a different manager, enter view mode
  const memberParam  = new URLSearchParams(window.location.search).get('member');
  const targetMember = memberParam
    ? members.find(function(m) { return m.id === memberParam; })
    : myMember;
  if (!targetMember) { window.location.href = 'standings.html?id=' + leagueId; return; }

  isViewMode   = targetMember.id !== myMember.id;
  myMemberId   = targetMember.id;
  viewedMember = isViewMode ? targetMember : null;
  isCommish    = Commissioner.memberIsCommissioner(league, myMember);

  // Build the event picker list and pick a sensible default — next upcoming
  // event when one exists, otherwise the most recent past event.
  availableEvents = eventRes.data || [];
  selectedEvent   = pickDefaultEvent(availableEvents);
  recomputeLockStatus(); // sets isLocked / isPastEvent based on selectedEvent

  document.title = (isViewMode ? targetMember.team_name : 'Lineup') + ' - ' + league.name;
  document.getElementById('leagueName').textContent = league.name;

  // In view mode the back link returns to standings; otherwise it stays on the league page
  if (isViewMode) {
    document.getElementById('leagueLink').href = 'standings.html?id=' + leagueId;
    document.getElementById('leagueLink').textContent = '← Standings';
  }

  // Nav links — Lineup is active only when viewing your own
  var nav = '<a href="standings.html?id=' + leagueId + '" class="btn-secondary">Standings</a>';
  nav += '<a href="waivers.html?id='  + leagueId + '" class="btn-secondary">Free Agency</a>';
  nav += '<a href="trades.html?id='   + leagueId + '" class="btn-secondary">Trades</a>';
  nav += '<a href="lineup.html?id='   + leagueId + '" class="' + (isViewMode ? 'btn-secondary' : 'btn-primary') + '">My Lineup</a>';
  document.getElementById('headerActions').innerHTML = nav;

  // Fetch this user's roster ONCE — it's not event-specific.
  const rostersRes = await supabaseClient
    .from('rosters')
    .select('id, draft_pick, slot_override, acquired_at, fighters(id, name, primary_division, current_rank, is_champion, is_sub_champion, sub_title_type, record_wins, record_losses, record_draws, photo_url, age, country)')
    .eq('league_id', leagueId)
    .eq('league_member_id', myMemberId)
    .order('draft_pick');

  if (rostersRes.error) {
    console.error('Failed to load roster:', rostersRes.error.message);
  }

  // Extract the nested fighter objects, attach roster-level metadata, and build ID maps
  rosterRowIds = {};
  myRoster = (rostersRes.data || []).filter(function(r) { return r.fighters; }).map(function(r) {
    rosterRowIds[r.fighters.id] = r.id;
    return Object.assign({}, r.fighters, {
      slot_override: r.slot_override || null,
      acquired_at:   r.acquired_at   || null
    });
  });

  // Load the per-event data (starters + scores) for the default event.
  await loadEventData();

  document.getElementById('pageContent').style.display = 'block';

  renderEventBanner();
  renderStarterSlots();
  renderRosterList();
}

// ========================================================================
// EVENT SELECTION HELPERS
// pickDefaultEvent  — choose initial selectedEvent from availableEvents
// recomputeLockStatus — derive isLocked/isPastEvent from selectedEvent
// loadEventData     — fetch starter_selections + scores for selectedEvent
// onSelectEvent     — handler bound to the event picker dropdown
// ========================================================================

// Picks the next upcoming non-completed event, falling back to the most
// recent past event when none are upcoming. Returns null only if there
// are no events at all.
function pickDefaultEvent(events) {
  if (!events || events.length === 0) return null;
  const todayISO = new Date().toISOString().split('T')[0];
  // events arrives sorted desc by event_date — find the latest one that's
  // either future or today AND not completed (i.e., still in play).
  const upcoming = events.filter(function(e) {
    return e.event_date >= todayISO && !e.is_completed;
  });
  if (upcoming.length > 0) {
    // The latest of upcoming-by-desc-sort is at the END; the soonest is also
    // useful but for "next event" semantics we want the EARLIEST upcoming.
    return upcoming[upcoming.length - 1];
  }
  return events[0]; // most recent past event
}

// Returns the effective lock time for an event as a Date. Prefers the
// commissioner-set lineup_lock_time when available; otherwise falls back
// to 5pm ET on the event date (first-prelim approximation for UFC cards).
//
// 5pm ET = 21:00 UTC in summer (EDT, UTC-4) or 22:00 UTC in winter (EST,
// UTC-5). We use Intl.DateTimeFormat to detect the correct offset for the
// specific event date so DST transitions are handled correctly.
function getEffectiveLockTime(event) {
  if (!event || !event.event_date) return null;
  if (event.lineup_lock_time) return new Date(event.lineup_lock_time);

  const parts = event.event_date.split('-').map(Number);
  const y = parts[0], m = parts[1], d = parts[2];
  // Tentative midday UTC on event_date — used only to detect EDT vs EST
  const tentative = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  let offsetHours = -5;  // default to EST if Intl is unavailable
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      timeZoneName: 'short',
    });
    const tzPart = fmt.formatToParts(tentative).find(function(p) { return p.type === 'timeZoneName'; });
    if (tzPart && tzPart.value === 'EDT') offsetHours = -4;
  } catch (e) {
    // Older runtimes without Intl support — stick with EST default
  }
  // 5pm ET = (17 - offsetHours) hours UTC. For EDT (-4) that's 21:00 UTC,
  // for EST (-5) that's 22:00 UTC.
  return new Date(Date.UTC(y, m - 1, d, 17 - offsetHours, 0, 0));
}

// Decide whether lineup edits should be blocked. True when the lock_time
// has passed OR the event is in the past (which is always read-only).
function recomputeLockStatus() {
  const todayISO = new Date().toISOString().split('T')[0];
  isPastEvent = !!(selectedEvent && selectedEvent.event_date < todayISO);
  if (!selectedEvent) {
    isLocked = false;
  } else {
    // Effective lock time falls back to event_date + 22:00 UTC if commissioner
    // hasn't set lineup_lock_time. This keeps the countdown / lock state
    // sensible for events that haven't been explicitly configured.
    const effectiveLock = getEffectiveLockTime(selectedEvent);
    const lockTimePassed = !!(effectiveLock && new Date() >= effectiveLock);
    isLocked = isPastEvent || lockTimePassed;
  }
  applyLockStateClasses();
}

// Toggles page-level state classes used by CSS to give the locked/past
// lineup a distinct read-only appearance. View mode keeps its own
// styling and isn't tinted by these classes.
function applyLockStateClasses() {
  const page = document.getElementById('pageContent');
  if (!page) return;
  page.classList.toggle('lineup-locked', isLocked && !isViewMode);
  page.classList.toggle('lineup-past',   isPastEvent && !isViewMode);
}

// Load everything that's tied to the selected event: the starter_selections
// for this member at that event, plus any scores that have been saved, plus
// the fight card. Used by init and by the event-change handler.
async function loadEventData() {
  // Reset per-event state
  selections.clear();
  selectionRowIds = {};
  selectionSlots  = {};
  selectedEventScores = {};
  selectedEventFightCard = [];

  if (!selectedEvent) return;

  const [selectionsRes, scoresRes, fightCardRes] = await Promise.all([
    supabaseClient
      .from('starter_selections')
      .select('id, fighter_id, slot_position')
      .eq('league_member_id', myMemberId)
      .eq('event_id', selectedEvent.id)
      .order('slot_position'),
    supabaseClient
      .from('scores')
      .select('fighter_id, total_points')
      .eq('league_member_id', myMemberId)
      .eq('event_id', selectedEvent.id),
    supabaseClient
      .from('fight_results')
      .select('id, fighter_a_id, fighter_b_id, weight_class, card_position, fight_order, title_type, outcome, winner_id, fight_of_the_night')
      .eq('event_id', selectedEvent.id),
  ]);

  (selectionsRes.data || []).forEach(function(s) {
    selections.add(s.fighter_id);
    selectionRowIds[s.fighter_id] = s.id;
    selectionSlots[s.fighter_id]  = s.slot_position;
  });

  (scoresRes.data || []).forEach(function(row) {
    selectedEventScores[row.fighter_id] = row.total_points;
  });

  // Resolve fighter names, photos, and ranks for the fight card. Some
  // fighters on the card may not be on this user's roster, so we need a
  // separate fighters query.
  const rawFights = fightCardRes.data || [];
  const fighterIds = new Set();
  rawFights.forEach(function(f) {
    if (f.fighter_a_id) fighterIds.add(f.fighter_a_id);
    if (f.fighter_b_id) fighterIds.add(f.fighter_b_id);
  });
  const idArr = Array.from(fighterIds);
  let fighterMap = {};
  if (idArr.length > 0) {
    const fighterRes = await supabaseClient
      .from('fighters')
      .select('id, name, photo_url, current_rank, is_champion, is_sub_champion, sub_title_type, country')
      .in('id', idArr);
    (fighterRes.data || []).forEach(function(f) { fighterMap[f.id] = f; });
  }

  function fighterInfo(id) {
    const f = fighterMap[id];
    if (!f) return { name: '?' };
    return {
      id:           f.id,
      name:         f.name,
      photoUrl:     f.photo_url || null,
      currentRank:  f.current_rank,
      isChampion:   !!f.is_champion,
      isSubChamp:   !!f.is_sub_champion,
      subTitleType: f.sub_title_type,
      country:      f.country || null,
    };
  }

  // Build the structured card. Sort by fight_order (1 = main event) when
  // available, otherwise fall back to card_position ordering. Older rows
  // ingested before the fight_order column existed will have null and be
  // sorted to the end of their card_position bucket.
  selectedEventFightCard = rawFights.map(function(f) {
    const red  = fighterInfo(f.fighter_a_id);
    const blue = fighterInfo(f.fighter_b_id);
    return {
      id:           f.id,
      red:          red,
      blue:         blue,
      // Legacy flat fields kept for buildFightCardLookup compatibility
      redId:        f.fighter_a_id,
      blueId:       f.fighter_b_id,
      redCorner:    red.name,
      blueCorner:   blue.name,
      weightClass:  DIVISION_LABELS[f.weight_class] || f.weight_class || '',
      cardPosition: f.card_position,
      fightOrder:   f.fight_order,
      titleType:    f.title_type,
      outcome:      f.outcome,
      winnerId:     f.winner_id,
      isFotN:       !!f.fight_of_the_night,
      badge:        f.card_position === 'main_event' ? 'Main Event'
                  : f.card_position === 'co_main'    ? 'Co-Main'
                  : f.title_type && f.title_type !== 'none' ? 'Title Fight'
                  : null,
    };
  }).sort(function(a, b) {
    // Prefer fight_order; fall back to card_position when null
    if (a.fightOrder != null && b.fightOrder != null) return a.fightOrder - b.fightOrder;
    if (a.fightOrder != null) return -1;
    if (b.fightOrder != null) return 1;
    const orderA = CARD_POSITION_ORDER[a.cardPosition] != null ? CARD_POSITION_ORDER[a.cardPosition] : 99;
    const orderB = CARD_POSITION_ORDER[b.cardPosition] != null ? CARD_POSITION_ORDER[b.cardPosition] : 99;
    return orderA - orderB;
  });
}

// Switch to a different event from the picker. Re-loads per-event state
// and re-renders everything.
async function onSelectEvent(eventId) {
  const ev = availableEvents.find(function(e) { return e.id === eventId; });
  if (!ev) return;
  selectedEvent = ev;
  recomputeLockStatus();
  await loadEventData();
  renderEventBanner();
  renderStarterSlots();
  renderRosterList();
}

// ========================================================================
// RENDER EVENT BANNER
// Uses the this-week-card CSS. Pulls name, date, and venue from selectedEvent.
// ========================================================================
function renderEventBanner() {
  const el = document.getElementById('eventBanner');
  const started = selections.size;

  // Three possible status labels — past events are "Final", future events
  // toggle between "Open" and "Locked" based on lineup_lock_time.
  var statusLabel;
  if (isPastEvent) {
    statusLabel = '<span style="color: var(--accent-gold);">&#127942; Event final</span>';
  } else if (isLocked) {
    statusLabel = '<span style="color: var(--text-tertiary);">&#128274; Lineup locked</span>';
  } else {
    statusLabel = '<span style="color: #4ade80;">&#128275; Lineup open</span>';
  }

  // Right-side counter — once any scores exist for the event (past final,
  // or live-scored mid-event, or commissioner-tested pre-event), show the
  // running points total. Otherwise show the lock-time hint + slots set.
  // When a future lock_time is known, show a prominent day/hour/min/sec
  // countdown to event start (lineup_lock_time = first prelim).
  var rightHtml;
  var anyEventScores = Object.keys(selectedEventScores).length > 0;
  // Use the effective lock time (with sensible default) so the countdown
  // shows even when the commissioner hasn't explicitly set lineup_lock_time.
  var effectiveLock  = getEffectiveLockTime(selectedEvent);
  var hasFutureLock  = !!(effectiveLock && !isLocked && !isPastEvent);

  if (anyEventScores) {
    var totalScored = 0;
    Object.keys(selectedEventScores).forEach(function(id) { totalScored += selectedEventScores[id] || 0; });
    rightHtml = '<p class="this-week-card__deadline">' +
                  started + '/3 started &middot; ' + (Math.round(totalScored * 100) / 100).toFixed(2) + ' pts' +
                '</p>';
  } else if (hasFutureLock) {
    // Prominent countdown — populated by startLockCountdown(). The four
    // numeric cells are updated every second; the eyebrow + sub line stay
    // static so we don't rebuild HTML in the tick handler.
    rightHtml =
      '<div class="event-countdown" id="eventCountdown">' +
        '<p class="event-countdown__eyebrow">Event starts in</p>' +
        '<div class="event-countdown__time">' +
          '<span class="event-countdown__cell"><span class="event-countdown__num" id="cdDays">--</span><span class="event-countdown__unit">d</span></span>' +
          '<span class="event-countdown__cell"><span class="event-countdown__num" id="cdHours">--</span><span class="event-countdown__unit">h</span></span>' +
          '<span class="event-countdown__cell"><span class="event-countdown__num" id="cdMins">--</span><span class="event-countdown__unit">m</span></span>' +
          '<span class="event-countdown__cell"><span class="event-countdown__num" id="cdSecs">--</span><span class="event-countdown__unit">s</span></span>' +
        '</div>' +
        '<p class="event-countdown__hint">' + started + '/3 set</p>' +
      '</div>';
  } else {
    rightHtml = '<p class="this-week-card__deadline">Locks at first prelim &middot; ' + started + '/3 set</p>';
  }

  var eventName = 'TBD';
  var eventDate = '';
  var eventMatchup = '';
  if (selectedEvent) {
    eventName = selectedEvent.name;
    var dateObj = new Date(selectedEvent.event_date + 'T12:00:00');
    eventDate = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    if (selectedEvent.venue) eventDate += ' &middot; ' + escapeHtml(selectedEvent.venue);
    if (selectedEvent.full_name && selectedEvent.full_name.indexOf(':') !== -1) {
      eventMatchup = selectedEvent.full_name.split(':')[1].trim();
    }
  }

  // Event picker: built from availableEvents, current selection pre-marked.
  // Hidden in view mode (we follow the standings link's intent — a single
  // member's lineup at the implied event).
  var picker = '';
  if (!isViewMode && availableEvents.length > 1) {
    picker = '<div class="lineup-event-picker">' +
               '<label for="lineupEventSelect" class="lineup-event-picker__label">Viewing</label>' +
               '<select id="lineupEventSelect" class="waiver-filter">';
    availableEvents.forEach(function(ev) {
      var d = new Date(ev.event_date + 'T12:00:00');
      var dStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      var sel  = (selectedEvent && ev.id === selectedEvent.id) ? ' selected' : '';
      picker  += '<option value="' + ev.id + '"' + sel + '>' +
                   escapeHtml(ev.name) + ' (' + escapeHtml(dStr) + ')' +
                 '</option>';
    });
    picker += '</select></div>';
  }

  // "Set Your Lineup" eyebrow doesn't fit a past event — adapt by phase.
  var eyebrow;
  if (isViewMode)        eyebrow = escapeHtml(viewedMember.team_name) + '\'s Lineup';
  else if (isPastEvent)  eyebrow = 'Past Event';
  else if (isLocked)     eyebrow = 'Locked Lineup';
  else                   eyebrow = 'Set Your Lineup';

  // Commissioner-only "Edit event" button. Hidden in view mode (irrelevant
  // when viewing another manager's lineup) and when there's no selected event.
  var editEventBtn = (isCommish && !isViewMode && selectedEvent)
    ? '<button class="btn-ghost fight-card-btn" id="editEventBtn">Edit event &rarr;</button>'
    : '';

  el.innerHTML =
    picker +
    '<div class="this-week-card" style="margin-bottom: var(--space-8);">' +
      '<div class="this-week-card__event">' +
        '<p class="this-week-card__eyebrow">' + eyebrow + '</p>' +
        '<p class="this-week-card__name">' + escapeHtml(eventName) + '</p>' +
        (eventDate    ? '<p class="this-week-card__date">'    + eventDate + '</p>' : '') +
        (eventMatchup ? '<p class="this-week-card__matchup">' + escapeHtml(eventMatchup) + '</p>' : '') +
        '<div class="lineup-banner-actions">' +
          '<button class="btn-ghost fight-card-btn" id="viewFightCardBtn">View fight card &rarr;</button>' +
          '<button class="btn-ghost fight-card-btn" id="viewWholeTeamBtn">Whole team &rarr;</button>' +
          // Lets the user pop over to the all-members lineups view for the
          // same event. We pass ?event= so they land on the same card they
          // were just looking at, not the page's default.
          '<a class="btn-ghost fight-card-btn" id="viewAllLineupsLink" href="lineups.html?id=' +
              encodeURIComponent(leagueId) +
              (selectedEvent ? '&event=' + encodeURIComponent(selectedEvent.id) : '') +
              '">View all lineups &rarr;</a>' +
          editEventBtn +
        '</div>' +
      '</div>' +
      '<div class="this-week-card__right">' +
        '<p class="lineup-lock-status">' + statusLabel + '</p>' +
        rightHtml +
      '</div>' +
    '</div>';

  document.getElementById('viewFightCardBtn').addEventListener('click', showFightCardModal);
  document.getElementById('viewWholeTeamBtn').addEventListener('click', showWholeTeamModal);
  var editBtn = document.getElementById('editEventBtn');
  if (editBtn) editBtn.addEventListener('click', showEditEventModal);
  var pickEl = document.getElementById('lineupEventSelect');
  if (pickEl) {
    pickEl.addEventListener('change', function() { onSelectEvent(this.value); });
  }

  // Always restart the countdown after a banner render — it clears any
  // existing timer first and skips itself when the lineup is already
  // locked or there's no lock_time on the event.
  startLockCountdown();
}

// ========================================================================
// LOCK COUNTDOWN
// Per-second tick on the "Locks in HH:MM:SS" indicator inside the event
// banner. When the timer reaches zero the page auto-transitions to the
// locked state without a refresh — recomputeLockStatus + re-render.
// ========================================================================
function clearLockCountdown() {
  if (lockCountdownTimer != null) {
    clearInterval(lockCountdownTimer);
    lockCountdownTimer = null;
  }
}

function startLockCountdown() {
  clearLockCountdown();
  if (isLocked || isPastEvent || !selectedEvent) return;

  const daysEl  = document.getElementById('cdDays');
  const hoursEl = document.getElementById('cdHours');
  const minsEl  = document.getElementById('cdMins');
  const secsEl  = document.getElementById('cdSecs');
  if (!daysEl || !hoursEl || !minsEl || !secsEl) return;

  const effectiveLock = getEffectiveLockTime(selectedEvent);
  if (!effectiveLock) return;
  const lockMs = effectiveLock.getTime();
  if (isNaN(lockMs)) return;

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function tick() {
    const remaining = lockMs - Date.now();
    if (remaining <= 0) {
      // Lock just fired — drop the timer and re-render the page through
      // the locked state so all the visual cues and gating apply.
      clearLockCountdown();
      recomputeLockStatus();
      renderEventBanner();
      renderStarterSlots();
      renderRosterList();
      return;
    }
    const totalSec = Math.floor(remaining / 1000);
    daysEl.textContent  = Math.floor(totalSec / 86400);
    hoursEl.textContent = pad(Math.floor((totalSec % 86400) / 3600));
    minsEl.textContent  = pad(Math.floor((totalSec % 3600) / 60));
    secsEl.textContent  = pad(totalSec % 60);
  }

  tick(); // paint immediately so the user never sees the "--" placeholder
  lockCountdownTimer = setInterval(tick, 1000);
}

// ========================================================================
// RENDER STARTER SLOTS
// Three card slots across the top. Slots filled by selected fighters show
// the full fighter card with a Bench button. Empty slots show a placeholder.
// ========================================================================
function renderStarterSlots() {
  const el = document.getElementById('starterSlots');

  // Which fighters are starters, in insertion order (Set preserves order)
  const startedIds   = Array.from(selections);
  const startedFighters = startedIds.map(function(id) {
    return myRoster.find(function(f) { return f.id === id; });
  }).filter(Boolean);

  let html = '';

  for (let slot = 0; slot < MAX_STARTERS; slot++) {
    const fighter = startedFighters[slot];
    if (fighter) {
      html += buildStarterCard(fighter, slot + 1);
    } else {
      html += buildEmptySlot(slot + 1);
    }
  }

  el.innerHTML = html;

  // Update the count label
  document.getElementById('starterCount').textContent = '(' + selections.size + ' / ' + MAX_STARTERS + ')';

  // Wire Bench buttons
  el.querySelectorAll('.lineup-bench-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      toggleStarter(btn.getAttribute('data-fighter-id'));
    });
  });

  // Wire the starter cards themselves to open the fighter modal on click.
  // Clicks that originated on the inner Bench button (or any future button
  // we add to the card) are ignored so existing actions keep working.
  el.querySelectorAll('[data-modal-fighter-id]').forEach(function(card) {
    function openModal() {
      var fid = card.getAttribute('data-modal-fighter-id');
      if (fid && typeof showFighterModal === 'function') showFighterModal(fid);
    }
    card.addEventListener('click', function(e) {
      // Bail if the click came from an inner button (Bench, etc.)
      if (e.target.closest('button, a')) return;
      openModal();
    });
    // Keyboard activation — card has role="button" and tabindex=0
    card.addEventListener('keydown', function(e) {
      if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('button, a')) {
        e.preventDefault();
        openModal();
      }
    });
  });
}

// Returns the HTML for a filled starter card
function buildStarterCard(fighter, slotNum) {
  const tierClass  = tierModifier(fighter);
  const rankLabel  = fighter.is_champion ? 'C'     : (fighter.current_rank ? '#' + fighter.current_rank : 'NR');
  const rankSub    = fighter.is_champion ? 'CHAMP' : 'RANK';
  const divLabel   = DIVISION_LABELS[fighter.primary_division] || fighter.primary_division;
  const record     = fighter.record_wins + '-' + fighter.record_losses + (fighter.record_draws ? '-' + fighter.record_draws : '');
  const photoHtml  = fighter.photo_url
    ? '<img class="fighter-card__photo" src="' + fighter.photo_url + '" alt="' + escapeHtml(fighter.name) + '" onerror="this.style.display=\'none\'">'
    : '<div class="fighter-card__photo-placeholder"></div>';
  const champBadge = fighter.is_champion ? '<span class="fighter-card__badge-champ">Champ</span>' : '';

  // Inline score — sits next to the record at the bottom of the card so
  // it never collides with the rank badge (top-left) or CHAMP badge
  // (top-right). Surfaced whenever any scores have been saved for the
  // event; if this fighter doesn't have a score row yet (e.g., their
  // fight hasn't been entered), we show a muted "—" so the absence
  // reads as "0 pts so far" rather than a missing element.
  var scoreInline = '';
  var anyScoresSaved = Object.keys(selectedEventScores).length > 0;
  if (anyScoresSaved) {
    var pts = selectedEventScores[fighter.id];
    var hasPts = (pts != null);
    var ptsStr = hasPts ? (Math.round(pts * 100) / 100).toFixed(2) : '—';
    // Empty modifier dims the value when there's no score yet
    var emptyMod = hasPts ? '' : ' fighter-card__pts--empty';
    scoreInline = '<span class="fighter-card__pts' + emptyMod + '">' +
                    '<span class="fighter-card__pts-val">' + ptsStr + '</span>' +
                    '<span class="fighter-card__pts-label">PTS</span>' +
                  '</span>';
  }

  return (
    // data-modal-fighter-id is the click target for opening the fighter
    // modal. tabindex/role/aria-label make the card keyboard-activatable.
    '<div class="fighter-card lineup-starter-card ' + tierClass + '" ' +
         'data-modal-fighter-id="' + fighter.id + '" ' +
         'tabindex="0" role="button" ' +
         'aria-label="View ' + escapeHtml(fighter.name) + ' details">' +
      '<div class="fighter-card__photo-wrap">' + photoHtml + '</div>' +
      '<div class="fighter-card__rating">' +
        '<span class="fighter-card__rating-num">' + rankLabel + '</span>' +
        '<span class="fighter-card__rating-label">' + rankSub + '</span>' +
      '</div>' +
      champBadge +
      '<div class="fighter-card__info">' +
        '<p class="fighter-card__division">' + escapeHtml(divLabel) + '</p>' +
        '<p class="fighter-card__name">' + escapeHtml(fighter.name) + '</p>' +
        '<div class="fighter-card__stat-row">' +
          '<p class="fighter-card__record">' + record + '</p>' +
          scoreInline +
        '</div>' +
        (isLocked || isViewMode
          ? '<span class="lineup-starter-badge">Starter ' + slotNum + '</span>'
          : '<button class="lineup-bench-btn" data-fighter-id="' + fighter.id + '">Bench</button>') +
      '</div>' +
    '</div>'
  );
}

// Returns the HTML for an empty slot placeholder
function buildEmptySlot(slotNum) {
  return (
    '<div class="lineup-slot--empty">' +
      '<p class="lineup-slot__number">' + slotNum + '</p>' +
      '<p class="lineup-slot__label">Starter</p>' +
    '</div>'
  );
}

// ========================================================================
// FIGHT CARD LOOKUP
// Builds a map of fighter_id -> matchup info from selectedEventFightCard so
// roster rows can be highlighted and annotated when a fighter is on the card
// of the currently-selected event. Falls back to lowercase-name keys for any
// legacy callers that still match by name.
// ========================================================================
function buildFightCardLookup() {
  var lookup = {};
  selectedEventFightCard.forEach(function(fight) {
    if (fight.redId) {
      lookup[fight.redId] = {
        opponent: fight.blueCorner, opponentId: fight.blueId,
        weightClass: fight.weightClass, badge: fight.badge,
        outcome: fight.outcome, winnerId: fight.winnerId,
      };
    }
    if (fight.blueId) {
      lookup[fight.blueId] = {
        opponent: fight.redCorner, opponentId: fight.redId,
        weightClass: fight.weightClass, badge: fight.badge,
        outcome: fight.outcome, winnerId: fight.winnerId,
      };
    }
    // Keep name-keyed entries for any consumers (and as a fallback for
    // edge cases where the roster fighter id doesn't match the card id).
    if (fight.redCorner)  lookup[fight.redCorner.toLowerCase()]  = lookup[fight.redId];
    if (fight.blueCorner) lookup[fight.blueCorner.toLowerCase()] = lookup[fight.blueId];
  });
  return lookup;
}

// ========================================================================
// RENDER ROSTER LIST
// Renders the roster grouped by slot category (division, Women's Flex,
// Any-Division Flex) with a section header showing slot limit pips.
// Started fighters are highlighted and show a Bench button; benched show Start.
// ========================================================================
function renderRosterList() {
  const el = document.getElementById('rosterList');

  if (myRoster.length === 0) {
    el.innerHTML = '<p class="draft-empty">No fighters on your roster yet.</p>';
    return;
  }

  const isFull = selections.size >= MAX_STARTERS;

  // Determine whether the +3 cap expansion is currently in effect. Only when
  // expanded do we split out a "Temporary Extended Roster Flex" (TERF) section
  // for the most recently acquired fighters that exceed the normal cap of 20.
  const eventDate    = selectedEvent ? selectedEvent.event_date : null;
  const capExpanded  = typeof isCapExpanded === 'function' ? isCapExpanded(new Date(), eventDate) : false;
  const overflow     = Math.max(0, myRoster.length - 20);
  const showTerf     = capExpanded && overflow > 0;

  // If TERF is active, peel the most-recently-acquired N fighters off the
  // bottom and run slot assignment on the rest. They don't compete for slot
  // construction limits while they're "extended". Auto-drop on Wed 3am ET
  // will hit these same fighters first.
  let coreRoster = myRoster;
  let terfRoster = [];
  if (showTerf) {
    const sortedByAcquired = myRoster.slice().sort(function(a, b) {
      const ta = a.acquired_at ? new Date(a.acquired_at).getTime() : 0;
      const tb = b.acquired_at ? new Date(b.acquired_at).getTime() : 0;
      return ta - tb; // oldest first
    });
    coreRoster = sortedByAcquired.slice(0, sortedByAcquired.length - overflow);
    terfRoster = sortedByAcquired.slice(sortedByAcquired.length - overflow);
  }

  // Assign each core fighter to its slot category using the same greedy rules as the draft
  const assigned = assignSlots(coreRoster);

  // Build a map of slot type -> array of fighters (in roster order)
  const groups = {};
  MENS_DIVISIONS.forEach(function(d) { groups[d] = []; });
  groups['women_flex'] = [];
  groups['any_flex']   = [];

  assigned.forEach(function(item) {
    if (groups[item.slotType] !== undefined) {
      groups[item.slotType].push(item.fighter);
    }
  });

  // Build the render context once so all row renderers share the same derived data
  const ctx = {
    isFull:        selections.size >= MAX_STARTERS,
    flexCount:     groups['any_flex'].length,
    flexDivisions: groups['any_flex'].map(function(f) { return f.primary_division; }),
    divisionGroups: groups,
    // Map of lowercase fighter name -> { opponent, weightClass, badge } for upcoming card
    fightCard: buildFightCardLookup()
  };

  let html = '';

  // Men's divisions — only render sections that have at least one fighter
  MENS_DIVISIONS.forEach(function(div) {
    if (groups[div].length === 0) return;
    html += renderSlotSection(DIVISION_LABELS[div], groups[div], 2, ctx, div);
  });

  // Women's flex section
  if (groups['women_flex'].length > 0) {
    html += renderSlotSection("Women's Flex", groups['women_flex'], 2, ctx, 'women_flex');
  }

  // Any-division flex section
  if (groups['any_flex'].length > 0) {
    html += renderSlotSection('Any-Division Flex', groups['any_flex'], 2, ctx, 'any_flex');
  }

  // Temporary Extended Roster Flex — visible only while the +3 expansion is
  // active (Thu 3am ET event-week → Sun 3am ET after event). These fighters
  // will be auto-dropped Wed 3am ET if you don't drop down to 20 manually.
  if (showTerf) {
    html += renderTerfSection(terfRoster, ctx);
  }

  // Surface any roster construction violations introduced by trades / FA adds
  renderImbalanceBanner(myRoster, capExpanded);

  el.innerHTML = html;

  // Wire Start / Bench buttons
  el.querySelectorAll('[data-fighter-id]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      toggleStarter(btn.getAttribute('data-fighter-id'));
    });
  });

  // Wire Drop buttons
  el.querySelectorAll('[data-drop-id]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      dropFighter(btn.getAttribute('data-drop-id'));
    });
  });

  // Wire Move to Flex buttons
  el.querySelectorAll('[data-flex-id]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      showMoveToFlexModal(btn.getAttribute('data-flex-id'));
    });
  });

  // Wire Move out of Flex buttons
  el.querySelectorAll('[data-unflex-id]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      showMoveOutOfFlexModal(btn.getAttribute('data-unflex-id'));
    });
  });

  // Wire fighter name buttons to open the profile modal
  el.querySelectorAll('[data-open-fighter]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      showFighterModal(btn.getAttribute('data-open-fighter'));
    });
  });
}

// Computes whether the roster fits the construction rules. Trades, instant
// FA adds, and approved waivers can all leave a roster in a state that's at
// the cap but distributed wrong — e.g. you traded away a welterweight and
// now have an empty Welterweight slot.
//
// Slot layout: 2 per men's division, 2 women's flex, 2 any-flex (20 total).
// Fighters above the per-division/women caps spill into the any-flex slots,
// which is allowed up to the 2 any-flex slot count. The two failure modes:
//
//   * Shortage — a men's division has < 2, or women count < 2. Means an
//     empty slot the manager can't fill from their current roster.
//   * Excess  — total any-flex demand exceeds the 2 available any-flex
//     slots, i.e. fighters can't all be assigned to slots.
//
// Returns null when balanced; otherwise { shortages, excesses }.
function detectRosterImbalance(roster) {
  const counts = {};
  MENS_DIVISIONS.forEach(function(d) { counts[d] = 0; });
  let womenTotal = 0;

  roster.forEach(function(f) {
    if (WOMENS_DIVISIONS.includes(f.primary_division)) {
      womenTotal++;
    } else if (counts[f.primary_division] !== undefined) {
      counts[f.primary_division]++;
    }
  });

  // How many fighters would need an any-flex slot? Each men's division above
  // 2 contributes its surplus; women's count above 2 does the same.
  let anyFlexDemand = 0;
  const sources = [];
  MENS_DIVISIONS.forEach(function(d) {
    if (counts[d] > 2) {
      anyFlexDemand += counts[d] - 2;
      sources.push(DIVISION_LABELS[d] + ' (' + counts[d] + ')');
    }
  });
  if (womenTotal > 2) {
    anyFlexDemand += womenTotal - 2;
    sources.push("women's fighters (" + womenTotal + ')');
  }

  const shortages = [];
  const excesses  = [];

  // Shortages: unfillable slots
  MENS_DIVISIONS.forEach(function(d) {
    if (counts[d] < 2) {
      shortages.push(DIVISION_LABELS[d] + ' (' + counts[d] + ' of 2)');
    }
  });
  if (womenTotal < 2) shortages.push("Women's Flex (" + womenTotal + ' of 2)');

  // Excess: only flag when total spillover actually exceeds the 2 any-flex slots
  if (anyFlexDemand > 2) {
    excesses.push(
      'Any-Division Flex needs ' + anyFlexDemand + ' slots but only has 2 — ' +
      'too many fighters in ' + sources.join(', ')
    );
  }

  if (shortages.length === 0 && excesses.length === 0) return null;
  return { shortages: shortages, excesses: excesses };
}

// Populates #rosterImbalanceBanner. Hidden when balanced, or when the +3
// cap expansion is active (TERF window) — during expansion the player is
// expected to be temporarily over, so flagging it would just be noise.
function renderImbalanceBanner(roster, capExpanded) {
  const el = document.getElementById('rosterImbalanceBanner');
  if (!el) return;

  if (capExpanded) {
    // The TERF section already explains the +3 state; don't double up.
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }

  const issues = detectRosterImbalance(roster);
  if (!issues) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }

  let body = '';
  if (issues.shortages.length > 0) {
    body += '<p class="roster-imbalance-banner__line"><strong>Short:</strong> ' +
            issues.shortages.map(escapeHtml).join(', ') + '.</p>';
  }
  if (issues.excesses.length > 0) {
    body += '<p class="roster-imbalance-banner__line"><strong>Over:</strong> ' +
            issues.excesses.map(escapeHtml).join(', ') + '.</p>';
  }

  el.innerHTML =
    '<p class="roster-imbalance-banner__title">Roster construction is out of alignment</p>' +
    body +
    '<p class="roster-imbalance-banner__hint">' +
      'Add a fighter from a short division and drop one from an over slot to rebalance. ' +
      'You can still set starters, but the roster won\'t be valid for league play until ' +
      'it matches the construction rules.' +
    '</p>';
  el.style.display = '';
}

// Renders the Temporary Extended Roster Flex section — the +3 fighters
// granted during the Thu→Sun event-week cap expansion. Headers + footnote
// make it explicit these slots are temporary and will be auto-dropped if
// the roster isn't trimmed back to 20 by Wed 3am ET.
function renderTerfSection(fighters, ctx) {
  if (!fighters || fighters.length === 0) return '';
  const pipsHtml = renderPips(fighters.length, 3);
  let html = '<div class="lineup-slot-header lineup-slot-header--terf">';
  html += '<span class="lineup-slot-header__title">Temporary Extended Roster Flex</span>';
  html += '<span class="lineup-slot-header__pips">' + pipsHtml + '</span>';
  html += '</div>';
  html += '<p class="lineup-terf-note">' +
            'These three slots are open while waivers are active for the upcoming event. ' +
            'Drop your roster back to 20 by Wed 3am ET, or the most recently added fighters here will be auto-dropped.' +
          '</p>';

  // Sort started fighters to the top (mirrors renderSlotSection)
  const sorted = fighters.slice().sort(function(a, b) {
    const aStarted = selections.has(a.id);
    const bStarted = selections.has(b.id);
    if (aStarted !== bStarted) return aStarted ? -1 : 1;
    return 0;
  });
  sorted.forEach(function(fighter) {
    html += renderRosterRow(fighter, ctx, 'any_flex');
  });
  return html;
}

// Renders one slot category: a header row (title + pip dots) followed by fighter rows.
function renderSlotSection(title, fighters, totalSlots, ctx, slotType) {
  const pipsHtml = renderPips(fighters.length, totalSlots);
  let html = '<div class="lineup-slot-header">';
  html += '<span class="lineup-slot-header__title">' + escapeHtml(title) + '</span>';
  html += '<span class="lineup-slot-header__pips">' + pipsHtml + '</span>';
  html += '</div>';

  // Sort started fighters to the top within each section
  const sorted = fighters.slice().sort(function(a, b) {
    const aStarted = selections.has(a.id);
    const bStarted = selections.has(b.id);
    if (aStarted !== bStarted) return aStarted ? -1 : 1;
    return 0;
  });

  sorted.forEach(function(fighter) {
    html += renderRosterRow(fighter, ctx, slotType);
  });

  return html;
}

// Returns the HTML for a single roster row.
function renderRosterRow(fighter, ctx, slotType) {
  const isStarted  = selections.has(fighter.id);
  const rankLabel  = fighter.is_champion ? 'C' : (fighter.current_rank ? '#' + fighter.current_rank : 'NR');
  const rankClass  = fighter.is_champion ? 'rank-champion' : (fighter.current_rank ? 'rank-ranked' : 'rank-unranked');
  let subBadge = '';
  if (fighter.is_sub_champion && fighter.sub_title_type === 'interim') {
    subBadge = '<span class="subrank-badge subrank-interim">INT</span>';
  } else if (fighter.is_sub_champion && fighter.sub_title_type === 'bmf') {
    subBadge = '<span class="subrank-badge subrank-bmf">BMF</span>';
  }
  const divLabel   = DIVISION_LABELS[fighter.primary_division] || fighter.primary_division;
  const record     = fighter.record_wins + '-' + fighter.record_losses + (fighter.record_draws ? '-' + fighter.record_draws : '');
  // Compose flag · division · age into a single sub-line. Each piece optional.
  const flag = (typeof countryFlag === 'function') ? countryFlag(fighter.country) : '';
  let subParts = [];
  if (flag)              subParts.push(flag);
  if (divLabel)          subParts.push(divLabel);
  if (fighter.age != null) subParts.push('Age ' + fighter.age);
  const divLine = subParts.join(' · ');
  // Prefer ID-based matching (handles same-named fighters) but fall back to
  // lowercase-name in case a roster fighter's record id differs from the
  // fight_results id for any reason.
  const fightInfo  = ctx.fightCard[fighter.id] || ctx.fightCard[fighter.name.toLowerCase()] || null;
  const rowClass   = (isStarted ? ' lineup-roster-row--started' : '') + (fightInfo ? ' lineup-roster-row--on-card' : '');
  const photoHtml  = fighter.photo_url
    ? '<img class="lineup-roster-row__photo" src="' + fighter.photo_url + '" alt="' + escapeHtml(fighter.name) + '" onerror="this.style.display=\'none\'">'
    : '';

  let btnHtml;
  if (isViewMode) {
    btnHtml = isStarted ? '<span class="lineup-starter-badge">Starter</span>' : '';
  } else if (isLocked) {
    btnHtml = isStarted
      ? '<span class="lineup-starter-badge">Starter</span>'
      : '<span class="lineup-bench-badge">Bench</span>';
  } else if (isStarted) {
    btnHtml = '<button class="btn-ghost lineup-row-btn" data-fighter-id="' + fighter.id + '">Bench</button>';
  } else if (ctx.isFull) {
    btnHtml = '<button class="btn-secondary lineup-row-btn" disabled>Start</button>';
  } else {
    btnHtml = '<button class="btn-secondary lineup-row-btn" data-fighter-id="' + fighter.id + '">Start</button>';
  }

  // "→ Flex": only when not already in any_flex, AND either a flex slot is
  // open OR a valid swap partner exists in flex.
  // Men: swap partner must share division (so they can return to that slot).
  // Women: any woman in flex can swap back to women_flex, regardless of specific division.
  // Roster slot moves are independent of event state (they change slot_override
  // on the rosters row, not anything event-scoped), so we don't gate on isLocked.
  var fighterIsWoman = WOMENS_DIVISIONS.indexOf(fighter.primary_division) !== -1;
  var flexSwapExists = fighterIsWoman
    ? ctx.flexDivisions.some(function(d) { return WOMENS_DIVISIONS.indexOf(d) !== -1; })
    : ctx.flexDivisions.indexOf(fighter.primary_division) !== -1;
  var flexEligible = slotType !== 'any_flex' &&
    (ctx.flexCount < 2 || flexSwapExists);
  var flexBtn = (!isViewMode && flexEligible)
    ? '<button class="lineup-flex-btn" data-flex-id="' + fighter.id + '" title="Move to Any-Division Flex">&rarr; Flex</button>'
    : '';

  var unflexBtn = (!isViewMode && slotType === 'any_flex')
    ? '<button class="lineup-flex-btn" data-unflex-id="' + fighter.id + '" title="Move back to division slot">&larr; Out</button>'
    : '';

  const dropBtn = !isViewMode
    ? '<button class="lineup-drop-btn" data-drop-id="' + fighter.id + '" title="Drop from roster">Drop</button>'
    : '';

  return (
    '<div class="lineup-roster-row' + rowClass + '" id="roster-row-' + fighter.id + '">' +
      '<div class="lineup-roster-row__photo-wrap">' + photoHtml + '</div>' +
      '<span class="lineup-roster-row__rank ' + rankClass + '">' + rankLabel + subBadge + '</span>' +
      '<div class="lineup-roster-row__info">' +
        '<button class="lineup-roster-row__name" data-open-fighter="' + fighter.id + '">' + escapeHtml(fighter.name) + '</button>' +
        (fightInfo
          ? '<span class="lineup-roster-row__matchup">' +
              'vs. ' + escapeHtml(fightInfo.opponent) +
              (fightInfo.badge ? ' <span class="lineup-roster-row__matchup-badge">' + escapeHtml(fightInfo.badge) + '</span>' : '') +
            '</span>'
          : '') +
        '<span class="lineup-roster-row__division">' + escapeHtml(divLine) + '</span>' +
      '</div>' +
      '<span class="lineup-roster-row__record">' + record + '</span>' +
      btnHtml +
      flexBtn +
      unflexBtn +
      dropBtn +
    '</div>'
  );
}

// ========================================================================
// TOGGLE STARTER
// Adds or removes a fighter from the selection, then re-renders both the
// card slots and the roster list so the UI updates immediately.
// TODO: once wired to real data, call the Supabase insert/delete here
// (see the original toggleStarter in the git history for the exact queries).
// ========================================================================
async function toggleStarter(fighterId) {
  if (isLocked) return;
  if (!selectedEvent) { alert('No upcoming event found. Cannot save starters.'); return; }

  if (selections.has(fighterId)) {
    // Bench: delete from DB first, then update local state
    const rowId = selectionRowIds[fighterId];
    if (rowId) {
      const { error } = await supabaseClient
        .from('starter_selections')
        .delete()
        .eq('id', rowId);
      if (error) { alert('Error removing starter: ' + error.message); return; }
      delete selectionRowIds[fighterId];
      delete selectionSlots[fighterId];
    }
    selections.delete(fighterId);
  } else {
    if (selections.size >= MAX_STARTERS) return;
    // Start: pick the smallest slot_position in [1, MAX_STARTERS] that isn't
    // already in use. The previous "selections.size + 1" approach collided
    // with surviving rows when a starter was benched and a new one started
    // (the freed slot wasn't reused, so we'd insert a duplicate of an
    // existing slot_position).
    const taken = new Set(Object.values(selectionSlots));
    let slotPos = 0;
    for (let i = 1; i <= MAX_STARTERS; i++) {
      if (!taken.has(i)) { slotPos = i; break; }
    }
    if (slotPos === 0) return; // shouldn't happen given the size check above

    const { data, error } = await supabaseClient
      .from('starter_selections')
      .insert({
        league_member_id: myMemberId,
        event_id:         selectedEvent.id,
        fighter_id:       fighterId,
        slot_position:    slotPos
      })
      .select('id')
      .single();
    if (error) { alert('Error saving starter: ' + error.message); return; }
    selectionRowIds[fighterId] = data.id;
    selectionSlots[fighterId]  = slotPos;
    selections.add(fighterId);
  }

  renderStarterSlots();
  renderRosterList();
  renderEventBanner();
}

// ========================================================================
// DROP FIGHTER
// Deletes a fighter from the user's roster and logs the drop so the rolling
// 48hr waiver hold and the Wednesday auto-drop bookkeeping both pick it up.
// Dropped fighters are NOT immediate free agents — they sit on waivers until
// 3am ET on (drop_date + 2 days), regardless of the current waiver phase.
// ========================================================================
async function dropFighter(fighterId) {
  if (isViewMode) return;

  const fighter = myRoster.find(function(f) { return f.id === fighterId; });
  if (!fighter) return;

  const confirmed = confirm(
    'Drop ' + fighter.name + ' from your roster?\n\n' +
    'They will go on rolling waivers for ~48 hours before becoming a free agent. ' +
    'Other managers can submit claims during that period. This cannot be undone.'
  );
  if (!confirmed) return;

  const rowId = rosterRowIds[fighterId];
  if (!rowId) {
    alert('Could not find roster entry to delete. Please refresh the page.');
    return;
  }

  const { error } = await supabaseClient
    .from('rosters')
    .delete()
    .eq('id', rowId);

  if (error) {
    alert('Error dropping fighter: ' + error.message);
    return;
  }

  // Log the drop so the waivers page can apply the rolling-waiver hold.
  // Failure is non-fatal — the drop itself already succeeded; we just lose
  // the audit trail on the rare error case. Surface a console warning.
  const dropLog = await supabaseClient.from('roster_drops').insert({
    league_id: leagueId,
    league_member_id: myMemberId,
    fighter_id: fighterId,
    source: 'manual'
  });
  if (dropLog.error) console.warn('roster_drops insert failed:', dropLog.error);

  // Mirror to the league activity feed. Fire-and-forget — failures are
  // logged inside LeagueActivity and don't affect the user-facing flow.
  if (typeof LeagueActivity !== 'undefined') {
    LeagueActivity.logEvent(leagueId, LeagueActivity.KINDS.DROP, {
      fighter_id:   fighterId,
      fighter_name: fighter.name,
      source:       'manual'
    }, myMemberId);
  }

  // If the dropped fighter was a starter, clean up their starter_selection row too
  const selRowId = selectionRowIds[fighterId];
  if (selRowId) {
    await supabaseClient.from('starter_selections').delete().eq('id', selRowId);
    delete selectionRowIds[fighterId];
    delete selectionSlots[fighterId];
  }

  // Update local state so the UI refreshes instantly without a full page reload
  myRoster = myRoster.filter(function(f) { return f.id !== fighterId; });
  delete rosterRowIds[fighterId];
  selections.delete(fighterId);

  renderStarterSlots();
  renderRosterList();
  renderEventBanner();
}

// ========================================================================
// MOVE TO FLEX MODAL
// Shows a dialog letting the user move a fighter from a division slot into
// the Any-Division Flex. If a flex slot is open, they just confirm. If both
// flex slots are taken, they pick which flex fighter to swap out.
// ========================================================================
function showMoveToFlexModal(fighterId) {
  if (isViewMode) return;

  const mover = myRoster.find(function(f) { return f.id === fighterId; });
  if (!mover) return;

  // Recompute slot assignments to get the current any_flex fighters
  const assigned     = assignSlots(myRoster);
  const allFlexFighters = assigned
    .filter(function(item) { return item.slotType === 'any_flex'; })
    .map(function(item) { return item.fighter; });

  const flexOpen = allFlexFighters.length < 2;

  // When flex is full, valid swap partners are fighters who can cleanly return to a
  // non-flex slot once the mover takes their place.
  // Men: must share the mover's division. Women: any woman can return to women_flex.
  var moverIsWoman = WOMENS_DIVISIONS.indexOf(mover.primary_division) !== -1;
  const swappableFlex = allFlexFighters.filter(function(f) {
    if (moverIsWoman) return WOMENS_DIVISIONS.indexOf(f.primary_division) !== -1;
    return f.primary_division === mover.primary_division;
  });

  var existing = document.getElementById('moveFlexModal');
  if (existing) existing.remove();

  const divLabel = DIVISION_LABELS[mover.primary_division] || mover.primary_division;

  let swapOptionsHtml = '';
  if (!flexOpen) {
    var swapDesc = moverIsWoman
      ? 'Both flex slots are taken. Choose which woman to swap out (she will return to Women\'s Flex):'
      : 'Both flex slots are taken. Choose who to swap out (must share your division so they can take your slot):';
    swapOptionsHtml =
      '<p class="move-flex-body-text">' + swapDesc + '</p>' +
      '<div class="flex-swap-options" id="flexSwapOptions">' +
        swappableFlex.map(function(f, i) {
          const fDiv = DIVISION_LABELS[f.primary_division] || f.primary_division;
          const selected = i === 0 ? ' flex-swap-option--selected' : '';
          return (
            '<div class="flex-swap-option' + selected + '" data-swap-id="' + f.id + '">' +
              '<div class="flex-swap-option__info">' +
                '<span class="flex-swap-option__name">' + escapeHtml(f.name) + '</span>' +
                '<span class="flex-swap-option__div">' + escapeHtml(fDiv) + '</span>' +
              '</div>' +
            '</div>'
          );
        }).join('') +
      '</div>';
  } else {
    swapOptionsHtml =
      '<p class="move-flex-body-text">There\'s an open flex slot. ' +
      escapeHtml(mover.name) + ' will move there, freeing their ' +
      escapeHtml(divLabel) + ' slot.</p>';
  }

  var modal = document.createElement('div');
  modal.id = 'moveFlexModal';
  modal.className = 'move-flex-modal-overlay';
  modal.innerHTML =
    '<div class="move-flex-modal" role="dialog" aria-modal="true">' +
      '<div class="move-flex-modal__header">' +
        '<p class="move-flex-modal__title">Move to Any-Division Flex</p>' +
        '<button class="move-flex-modal__close" id="closeMoveFlexBtn" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="move-flex-modal__body">' +
        '<p class="move-flex-fighter-name">' +
          escapeHtml(mover.name) +
          '<span class="move-flex-fighter-div">' + escapeHtml(divLabel) + ' &rarr; Any-Division Flex</span>' +
        '</p>' +
        swapOptionsHtml +
        '<div class="move-flex-modal__actions">' +
          '<button class="btn-ghost" id="cancelMoveFlexBtn">Cancel</button>' +
          '<button class="btn-primary" id="confirmMoveFlexBtn">Move to Flex</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  document.body.appendChild(modal);

  // Wire swap option selection (radio-style toggle)
  modal.querySelectorAll('.flex-swap-option').forEach(function(opt) {
    opt.addEventListener('click', function() {
      modal.querySelectorAll('.flex-swap-option').forEach(function(o) {
        o.classList.remove('flex-swap-option--selected');
      });
      opt.classList.add('flex-swap-option--selected');
    });
  });

  // Confirm button
  document.getElementById('confirmMoveFlexBtn').addEventListener('click', function() {
    var swapPartnerId = null;
    if (!flexOpen) {
      var selected = modal.querySelector('.flex-swap-option--selected');
      // If flex is full but no same-division swap partner exists the button shouldn't
      // be reachable, but guard anyway
      if (!selected) return;
      swapPartnerId = selected.getAttribute('data-swap-id');
    }
    closeMoveToFlexModal();
    moveToFlex(fighterId, swapPartnerId);
  });

  document.getElementById('cancelMoveFlexBtn').addEventListener('click', closeMoveToFlexModal);
  document.getElementById('closeMoveFlexBtn').addEventListener('click', closeMoveToFlexModal);

  modal.addEventListener('click', function(e) {
    if (e.target === modal) closeMoveToFlexModal();
  });

  document.addEventListener('keydown', handleFlexModalEscape);
}

function closeMoveToFlexModal() {
  var modal = document.getElementById('moveFlexModal');
  if (modal) modal.remove();
  document.removeEventListener('keydown', handleFlexModalEscape);
}

function handleFlexModalEscape(e) {
  if (e.key === 'Escape') closeMoveToFlexModal();
}

// Persists the flex move to Supabase and updates local state.
// swapPartnerId is the flex fighter being moved back to their division slot,
// or null if there was an open flex slot.
async function moveToFlex(moverId, swapPartnerId) {
  const updates = [
    supabaseClient.from('rosters').update({ slot_override: 'any_flex' }).eq('id', rosterRowIds[moverId])
  ];

  if (swapPartnerId) {
    updates.push(
      supabaseClient.from('rosters').update({ slot_override: null }).eq('id', rosterRowIds[swapPartnerId])
    );
  }

  const results = await Promise.all(updates);
  const failed  = results.find(function(r) { return r.error; });
  if (failed) {
    alert('Error updating flex slot: ' + failed.error.message);
    return;
  }

  // Update local state — fighter objects are plain objects so we set the property directly
  var moverFighter = myRoster.find(function(f) { return f.id === moverId; });
  if (moverFighter) moverFighter.slot_override = 'any_flex';

  if (swapPartnerId) {
    var swapFighter = myRoster.find(function(f) { return f.id === swapPartnerId; });
    if (swapFighter) swapFighter.slot_override = null;
  }

  renderStarterSlots();
  renderRosterList();
}

// ========================================================================
// MOVE OUT OF FLEX MODAL
// For fighters currently in any_flex, lets the user move them back to their
// division slot. If the division is full (2 fighters already there), the user
// picks one of those division fighters to bump to flex in exchange.
// ========================================================================
function showMoveOutOfFlexModal(fighterId) {
  if (isViewMode) return;

  const mover = myRoster.find(function(f) { return f.id === fighterId; });
  if (!mover) return;

  // Find fighters currently occupying the target slot.
  // Women in any_flex return to women_flex, not a division-specific slot.
  const assigned = assignSlots(myRoster);
  var moverIsWoman = WOMENS_DIVISIONS.indexOf(mover.primary_division) !== -1;
  const divFighters = assigned
    .filter(function(item) {
      return moverIsWoman
        ? item.slotType === 'women_flex'
        : item.slotType === mover.primary_division;
    })
    .map(function(item) { return item.fighter; });

  const divHasRoom = divFighters.length < 2;

  var existing = document.getElementById('moveFlexModal');
  if (existing) existing.remove();

  const divLabel  = DIVISION_LABELS[mover.primary_division] || mover.primary_division;
  // Label for the target slot shown in the modal
  const targetSlotLabel = moverIsWoman ? "Women's Flex" : divLabel;

  let swapOptionsHtml = '';
  if (divHasRoom) {
    swapOptionsHtml =
      '<p class="move-flex-body-text">There\'s an open ' + escapeHtml(targetSlotLabel) +
      ' slot. ' + escapeHtml(mover.name) + ' will move there.</p>';
  } else {
    swapOptionsHtml =
      '<p class="move-flex-body-text">' + escapeHtml(targetSlotLabel) + ' is full. Choose who to send to flex:</p>' +
      '<div class="flex-swap-options">' +
        divFighters.map(function(f, i) {
          const fDiv = DIVISION_LABELS[f.primary_division] || f.primary_division;
          const selected = i === 0 ? ' flex-swap-option--selected' : '';
          return (
            '<div class="flex-swap-option' + selected + '" data-swap-id="' + f.id + '">' +
              '<div class="flex-swap-option__info">' +
                '<span class="flex-swap-option__name">' + escapeHtml(f.name) + '</span>' +
                '<span class="flex-swap-option__div">' + escapeHtml(fDiv) + '</span>' +
              '</div>' +
            '</div>'
          );
        }).join('') +
      '</div>';
  }

  var modal = document.createElement('div');
  modal.id = 'moveFlexModal';
  modal.className = 'move-flex-modal-overlay';
  modal.innerHTML =
    '<div class="move-flex-modal" role="dialog" aria-modal="true">' +
      '<div class="move-flex-modal__header">' +
        '<p class="move-flex-modal__title">Move Out of Flex</p>' +
        '<button class="move-flex-modal__close" id="closeMoveFlexBtn" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="move-flex-modal__body">' +
        '<p class="move-flex-fighter-name">' +
          escapeHtml(mover.name) +
          '<span class="move-flex-fighter-div">Any-Division Flex &rarr; ' + escapeHtml(targetSlotLabel) + '</span>' +
        '</p>' +
        swapOptionsHtml +
        '<div class="move-flex-modal__actions">' +
          '<button class="btn-ghost" id="cancelMoveFlexBtn">Cancel</button>' +
          '<button class="btn-primary" id="confirmMoveFlexBtn">Move Out</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  document.body.appendChild(modal);

  modal.querySelectorAll('.flex-swap-option').forEach(function(opt) {
    opt.addEventListener('click', function() {
      modal.querySelectorAll('.flex-swap-option').forEach(function(o) {
        o.classList.remove('flex-swap-option--selected');
      });
      opt.classList.add('flex-swap-option--selected');
    });
  });

  document.getElementById('confirmMoveFlexBtn').addEventListener('click', function() {
    var swapPartnerId = null;
    if (!divHasRoom) {
      var selected = modal.querySelector('.flex-swap-option--selected');
      if (!selected) return;
      swapPartnerId = selected.getAttribute('data-swap-id');
    }
    closeMoveToFlexModal();
    moveOutOfFlex(fighterId, swapPartnerId);
  });

  document.getElementById('cancelMoveFlexBtn').addEventListener('click', closeMoveToFlexModal);
  document.getElementById('closeMoveFlexBtn').addEventListener('click', closeMoveToFlexModal);
  modal.addEventListener('click', function(e) { if (e.target === modal) closeMoveToFlexModal(); });
  document.addEventListener('keydown', handleFlexModalEscape);
}

// Persists moving a fighter out of any_flex back to their division slot.
// If swapPartnerId is given, that division fighter gets bumped to flex.
async function moveOutOfFlex(moverId, swapPartnerId) {
  const updates = [
    supabaseClient.from('rosters').update({ slot_override: null }).eq('id', rosterRowIds[moverId])
  ];

  if (swapPartnerId) {
    updates.push(
      supabaseClient.from('rosters').update({ slot_override: 'any_flex' }).eq('id', rosterRowIds[swapPartnerId])
    );
  }

  const results = await Promise.all(updates);
  const failed  = results.find(function(r) { return r.error; });
  if (failed) {
    alert('Error updating flex slot: ' + failed.error.message);
    return;
  }

  var moverFighter = myRoster.find(function(f) { return f.id === moverId; });
  if (moverFighter) moverFighter.slot_override = null;

  if (swapPartnerId) {
    var swapFighter = myRoster.find(function(f) { return f.id === swapPartnerId; });
    if (swapFighter) swapFighter.slot_override = 'any_flex';
  }

  renderStarterSlots();
  renderRosterList();
}

// ========================================================================
// FIGHT CARD MODAL
// Injects a full-screen overlay showing all fights grouped by section.
// Clicking the overlay or the close button dismisses it.
// ========================================================================
function showFightCardModal() {
  // Remove any existing modal first
  var existing = document.getElementById('fightCardModal');
  if (existing) existing.remove();

  // Build id-keyed lookups so each corner can be tagged with its roster
  // ownership state. Skipped in view mode — "Yours"/"Starter" pills don't
  // make sense when looking at another manager's lineup.
  var rosterIds  = {};
  var starterIds = {};
  if (!isViewMode) {
    myRoster.forEach(function(f) { rosterIds[f.id] = true; });
    selections.forEach(function(id) { starterIds[id] = true; });
  }
  function cornerClass(fighterId, sideMod) {
    var classes = 'fight-row__fighter ' + sideMod;
    if (starterIds[fighterId])      classes += ' fight-row__fighter--starter';
    else if (rosterIds[fighterId])  classes += ' fight-row__fighter--mine';
    return classes;
  }

  // Group fights for display. UFC main cards are conventionally the top 5
  // fights (main event + co-main + 3 others). Fights 6+ are prelims.
  // We use fight_order when available; fall back to splitting at index 5.
  var hasOrder = selectedEventFightCard.some(function(f) { return f.fightOrder != null; });
  var mainCardFights, prelimFights;
  if (hasOrder) {
    mainCardFights = selectedEventFightCard.filter(function(f) { return f.fightOrder != null && f.fightOrder <= 5; });
    prelimFights   = selectedEventFightCard.filter(function(f) { return f.fightOrder == null || f.fightOrder > 5; });
  } else {
    // Legacy data without fight_order — keep the old main_event/co_main split
    mainCardFights = selectedEventFightCard.slice(0, 5);
    prelimFights   = selectedEventFightCard.slice(5);
  }

  // Subline for each fighter: champion / interim / BMF / rank (whichever
  // applies) — kept compact so the row stays on one line on most screens.
  function rankSubline(f) {
    if (!f) return '';
    if (f.isChampion) return '<span class="fight-row__rank fight-row__rank--champ">Champion</span>';
    if (f.isSubChamp && f.subTitleType === 'interim') return '<span class="fight-row__rank fight-row__rank--interim">Interim Champion</span>';
    if (f.isSubChamp && f.subTitleType === 'bmf')     return '<span class="fight-row__rank fight-row__rank--bmf">BMF Champion</span>';
    if (f.currentRank) return '<span class="fight-row__rank">#' + f.currentRank + '</span>';
    return '<span class="fight-row__rank fight-row__rank--unranked">Unranked</span>';
  }

  function ownershipPill(fighterId) {
    if (starterIds[fighterId]) return '<span class="fight-row__pill fight-row__pill--starter">STARTER</span>';
    if (rosterIds[fighterId])  return '<span class="fight-row__pill fight-row__pill--yours">YOURS</span>';
    return '';
  }

  function fighterSide(fighter, sideMod, isWinner) {
    if (!fighter || !fighter.id) {
      return '<div class="fight-row__side ' + sideMod + '"><span class="fight-row__name">TBD</span></div>';
    }
    const photoHtml = fighter.photoUrl
      ? '<img class="fight-row__photo" src="' + escapeHtml(fighter.photoUrl) + '" alt="' + escapeHtml(fighter.name) + '" onerror="this.style.display=\'none\'">'
      : '<div class="fight-row__photo fight-row__photo--placeholder"></div>';
    const winnerMark = isWinner ? '<span class="fight-row__winner-mark" title="Winner">✓</span>' : '';
    const flag = (typeof countryFlag === 'function') ? countryFlag(fighter.country) : '';
    const flagHtml = flag ? '<span class="fight-row__flag">' + flag + '</span>' : '';
    return (
      '<button class="fight-row__side ' + sideMod + '" data-open-fighter="' + fighter.id + '" type="button">' +
        photoHtml +
        '<div class="fight-row__text">' +
          '<span class="fight-row__name">' + winnerMark + flagHtml + escapeHtml(fighter.name) + '</span>' +
          '<span class="fight-row__sub">' + rankSubline(fighter) + ownershipPill(fighter.id) + '</span>' +
        '</div>' +
      '</button>'
    );
  }

  function fightRowHtml(fight) {
    var badgeHtml = fight.badge
      ? '<span class="fight-row__badge">' + escapeHtml(fight.badge) + '</span>'
      : '';
    var redIsWinner  = fight.outcome && fight.winnerId === fight.redId;
    var blueIsWinner = fight.outcome && fight.winnerId === fight.blueId;
    return (
      '<div class="fight-row">' +
        fighterSide(fight.red,  'fight-row__side--red',  redIsWinner) +
        '<div class="fight-row__center">' +
          badgeHtml +
          '<span class="fight-row__weight">' + escapeHtml(fight.weightClass) + '</span>' +
          '<span class="fight-row__vs">vs</span>' +
        '</div>' +
        fighterSide(fight.blue, 'fight-row__side--blue', blueIsWinner) +
      '</div>'
    );
  }

  var sectionsHtml = '';
  if (selectedEventFightCard.length === 0) {
    sectionsHtml = '<p class="draft-empty" style="padding:var(--space-6)">No fights yet for this event. The card hasn\'t been announced or scraped.</p>';
  } else {
    if (mainCardFights.length > 0) {
      sectionsHtml +=
        '<div class="fight-card-section">' +
          '<p class="fight-card-section__label">Main Card</p>' +
          mainCardFights.map(fightRowHtml).join('') +
        '</div>';
    }
    if (prelimFights.length > 0) {
      sectionsHtml +=
        '<div class="fight-card-section">' +
          '<p class="fight-card-section__label">Prelims</p>' +
          prelimFights.map(fightRowHtml).join('') +
        '</div>';
    }
  }

  var modal = document.createElement('div');
  modal.id = 'fightCardModal';
  modal.className = 'fight-card-modal-overlay';
  modal.innerHTML =
    '<div class="fight-card-modal" role="dialog" aria-modal="true" aria-label="Fight Card">' +
      '<div class="fight-card-modal__header">' +
        '<div>' +
          '<p class="fight-card-modal__eyebrow">Fight Card</p>' +
          '<p class="fight-card-modal__title">' + escapeHtml(selectedEvent ? selectedEvent.name : 'TBD') + '</p>' +
        '</div>' +
        '<button class="fight-card-modal__close" id="closeFightCardBtn" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="fight-card-modal__body">' + sectionsHtml + '</div>' +
    '</div>';

  document.body.appendChild(modal);

  // Close on button click
  document.getElementById('closeFightCardBtn').addEventListener('click', closeFightCardModal);

  // Wire each fighter side to open the fighter modal. We don't close the
  // fight card modal — the fighter modal opens on top, and dismissing it
  // returns the user to the same fight card view.
  modal.querySelectorAll('[data-open-fighter]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var fid = btn.getAttribute('data-open-fighter');
      if (fid && typeof showFighterModal === 'function') showFighterModal(fid);
    });
  });

  // Close on overlay click (but not on the modal itself)
  modal.addEventListener('click', function(e) {
    if (e.target === modal) closeFightCardModal();
  });

  // Close on Escape key
  document.addEventListener('keydown', handleModalEscape);
}

function closeFightCardModal() {
  var modal = document.getElementById('fightCardModal');
  if (modal) modal.remove();
  document.removeEventListener('keydown', handleModalEscape);
}

function handleModalEscape(e) {
  if (e.key === 'Escape') closeFightCardModal();
}

// ========================================================================
// WHOLE TEAM MODAL
// Compact 5×4 grid of every fighter on the user's roster, fits on a single
// desktop screen without scrolling. Starters are highlighted; click any
// tile to open the existing fighter detail modal. Read-only — Bench/Start
// edits still happen on the main lineup page.
// ========================================================================
function showWholeTeamModal() {
  var existing = document.getElementById('wholeTeamModal');
  if (existing) existing.remove();

  var titleText = selectedEvent
    ? 'My Roster &middot; ' + escapeHtml(selectedEvent.name)
    : 'My Roster';

  // Group fighters by slot type using the same assignment the main roster
  // list uses, so the modal mirrors how the user already thinks about
  // their team (men's divisions, women's flex, any-division flex).
  var assigned = assignSlots(myRoster);
  var groups = {};
  MENS_DIVISIONS.forEach(function(d) { groups[d] = []; });
  groups['women_flex'] = [];
  groups['any_flex']   = [];
  assigned.forEach(function(item) {
    if (groups[item.slotType]) groups[item.slotType].push(item.fighter);
  });

  // Section options:
  //   showDivision — print the fighter's actual division on the tile.
  //                  Useful in flex sections (where it's not implied by
  //                  the section header), redundant in everywhere else.
  var sectionsHtml = '';
  MENS_DIVISIONS.forEach(function(div) {
    if (groups[div].length > 0) {
      sectionsHtml += renderTeamSection(DIVISION_LABELS[div], groups[div], {});
    }
  });
  if (groups['women_flex'].length > 0) {
    sectionsHtml += renderTeamSection("Women's Flex", groups['women_flex'], { showDivision: true });
  }
  if (groups['any_flex'].length > 0) {
    sectionsHtml += renderTeamSection('Any-Division Flex', groups['any_flex'], { showDivision: true });
  }

  var modal = document.createElement('div');
  modal.id = 'wholeTeamModal';
  modal.className = 'fight-card-modal-overlay';
  modal.innerHTML =
    '<div class="fight-card-modal whole-team-modal" role="dialog" aria-modal="true" aria-label="Whole team">' +
      '<div class="fight-card-modal__header">' +
        '<div>' +
          '<p class="fight-card-modal__eyebrow">Whole Team</p>' +
          '<p class="fight-card-modal__title">' + titleText + '</p>' +
        '</div>' +
        '<button class="fight-card-modal__close" id="closeWholeTeamBtn" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="fight-card-modal__body whole-team-modal__body">' +
        (myRoster.length === 0
          ? '<p class="draft-empty">No fighters on your roster yet.</p>'
          : '<div class="whole-team-sections">' + sectionsHtml + '</div>') +
      '</div>' +
    '</div>';

  document.body.appendChild(modal);

  document.getElementById('closeWholeTeamBtn').addEventListener('click', closeWholeTeamModal);
  modal.addEventListener('click', function(e) {
    if (e.target === modal) closeWholeTeamModal();
  });
  document.addEventListener('keydown', handleWholeTeamEscape);

  // Click a tile → open the existing fighter detail modal. Tiles defer to
  // showFighterModal (loaded on this page) so we get the same rich view as
  // anywhere else without duplicating render logic.
  modal.querySelectorAll('[data-team-tile-id]').forEach(function(tile) {
    tile.addEventListener('click', function() {
      var fid = tile.getAttribute('data-team-tile-id');
      if (fid && typeof showFighterModal === 'function') showFighterModal(fid);
    });
  });
}

function closeWholeTeamModal() {
  var modal = document.getElementById('wholeTeamModal');
  if (modal) modal.remove();
  document.removeEventListener('keydown', handleWholeTeamEscape);
}

function handleWholeTeamEscape(e) {
  if (e.key === 'Escape') closeWholeTeamModal();
}

// One section = a weight-class label with its fighters laid out below.
// Pads to 2 slots with dashed empty placeholders so a section with only
// one fighter doesn't look lopsided next to a fully-filled neighbor.
function renderTeamSection(label, fighters, opts) {
  opts = opts || {};
  var slotCount = 2;
  var tilesHtml = fighters.map(function(f) { return renderTeamTile(f, opts); }).join('');
  for (var i = fighters.length; i < slotCount; i++) {
    tilesHtml += '<div class="whole-team-tile-empty" aria-hidden="true"></div>';
  }
  return (
    '<div class="whole-team-section">' +
      '<p class="whole-team-section__label">' + escapeHtml(label) + '</p>' +
      '<div class="whole-team-section__tiles">' + tilesHtml + '</div>' +
    '</div>'
  );
}

// One tile = photo + rank badge + starter mark + name (and optional division).
// Champion gets a gold accent on the rank badge; starter gets a crimson border.
// `opts.showDivision` adds a division line beneath the name — only useful in
// flex sections where the section header doesn't already imply the division.
function renderTeamTile(fighter, opts) {
  opts = opts || {};
  var isStarter = selections.has(fighter.id);
  var rankLabel = fighter.is_champion ? 'C' : (fighter.current_rank ? '#' + fighter.current_rank : 'NR');
  // Strip the "Men's "/"Women's " prefix — the section header already
  // establishes that context and the long version overflows narrow tiles.
  var rawDiv  = DIVISION_LABELS[fighter.primary_division] || fighter.primary_division || '';
  var divLabel = rawDiv.replace(/^Men's\s+/, '').replace(/^Women's\s+/, '');
  var photoHtml = fighter.photo_url
    ? '<img class="whole-team-tile__photo" src="' + fighter.photo_url + '" alt="" onerror="this.style.display=\'none\'">'
    : '<div class="whole-team-tile__photo-placeholder"></div>';

  var classes = 'whole-team-tile';
  if (isStarter)            classes += ' whole-team-tile--starter';
  if (fighter.is_champion)  classes += ' whole-team-tile--champion';

  return (
    '<button class="' + classes + '" data-team-tile-id="' + fighter.id + '" type="button">' +
      '<div class="whole-team-tile__photo-wrap">' +
        photoHtml +
        '<span class="whole-team-tile__rank">' + escapeHtml(rankLabel) + '</span>' +
        (isStarter
          ? '<span class="whole-team-tile__badge" title="Starter" aria-label="Starter">&#9733;</span>'
          : '') +
      '</div>' +
      '<div class="whole-team-tile__info">' +
        '<p class="whole-team-tile__name" title="' + escapeHtml(fighter.name) + '">' + escapeHtml(fighter.name) + '</p>' +
        (opts.showDivision
          ? '<p class="whole-team-tile__div">' + escapeHtml(divLabel) + '</p>'
          : '') +
      '</div>' +
    '</button>'
  );
}

// ========================================================================
// EDIT EVENT MODAL (commissioner-only)
// Lets a commissioner update name / full_name / event_date / lineup_lock_time
// / venue on the currently selected event. Fight management is delegated to
// score-event.html via the "Manage fights" link — that page is the canonical
// fight CRUD surface and we don't duplicate it here.
// Note: ufc_events is GLOBAL across leagues, so edits affect every league
// using this event. The modal surfaces this so the commissioner isn't surprised.
// ========================================================================

// Convert a Postgres timestamptz / ISO string into the value format expected
// by an <input type="datetime-local">: "YYYY-MM-DDTHH:mm" in the browser's
// local timezone. Returns '' when the input is missing.
function isoToLocalDatetime(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  var off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

function showEditEventModal() {
  if (!isCommish || !selectedEvent) return;

  var existing = document.getElementById('editEventModal');
  if (existing) existing.remove();

  var ev = selectedEvent;
  var modal = document.createElement('div');
  modal.id = 'editEventModal';
  modal.className = 'fight-card-modal-overlay';
  modal.innerHTML =
    '<div class="fight-card-modal" role="dialog" aria-modal="true" aria-label="Edit Event">' +
      '<div class="fight-card-modal__header">' +
        '<div>' +
          '<p class="fight-card-modal__eyebrow">Commissioner Tools</p>' +
          '<p class="fight-card-modal__title">Edit Event</p>' +
        '</div>' +
        '<button class="fight-card-modal__close" id="closeEditEventBtn" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="fight-card-modal__body">' +
        '<p class="form-hint" style="margin-bottom: var(--space-4);">' +
          'This event is shared across every league. Changes here affect all leagues using it.' +
        '</p>' +
        '<div class="form-group">' +
          '<label for="editEventName">Event name <span style="color: var(--accent-crimson);">*</span></label>' +
          '<input type="text" id="editEventName" placeholder="UFC 315" value="' + escapeHtml(ev.name || '') + '">' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="editEventFullName">Full name</label>' +
          '<input type="text" id="editEventFullName" placeholder="UFC 315: Makhachev vs Tsarukyan" value="' + escapeHtml(ev.full_name || '') + '">' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="editEventDate">Event date <span style="color: var(--accent-crimson);">*</span></label>' +
          '<input type="date" id="editEventDate" value="' + escapeHtml(ev.event_date || '') + '">' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="editEventLockTime">Lineup lock time</label>' +
          '<input type="datetime-local" id="editEventLockTime" value="' + isoToLocalDatetime(ev.lineup_lock_time) + '">' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="editEventVenue">Venue</label>' +
          '<input type="text" id="editEventVenue" placeholder="T-Mobile Arena, Las Vegas" value="' + escapeHtml(ev.venue || '') + '">' +
        '</div>' +
        '<div style="display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); margin-top: var(--space-6); flex-wrap: wrap;">' +
          '<a class="btn-ghost" href="score-event.html?league=' + encodeURIComponent(leagueId) + '">Manage fights &rarr;</a>' +
          '<div style="display: flex; gap: var(--space-3);">' +
            '<button class="btn-ghost" id="cancelEditEventBtn" type="button">Cancel</button>' +
            '<button class="btn-primary" id="saveEditEventBtn" type="button">Save changes</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  document.body.appendChild(modal);

  document.getElementById('closeEditEventBtn').addEventListener('click', closeEditEventModal);
  document.getElementById('cancelEditEventBtn').addEventListener('click', closeEditEventModal);
  document.getElementById('saveEditEventBtn').addEventListener('click', saveEditEvent);

  modal.addEventListener('click', function(e) {
    if (e.target === modal) closeEditEventModal();
  });

  document.addEventListener('keydown', handleEditEventEscape);
  document.getElementById('editEventName').focus();
}

function closeEditEventModal() {
  var modal = document.getElementById('editEventModal');
  if (modal) modal.remove();
  document.removeEventListener('keydown', handleEditEventEscape);
}

function handleEditEventEscape(e) {
  if (e.key === 'Escape') closeEditEventModal();
}

async function saveEditEvent() {
  if (!isCommish || !selectedEvent) return;

  var name      = document.getElementById('editEventName').value.trim();
  var fullName  = document.getElementById('editEventFullName').value.trim() || null;
  var date      = document.getElementById('editEventDate').value;
  var lockLocal = document.getElementById('editEventLockTime').value;
  var venue     = document.getElementById('editEventVenue').value.trim() || null;

  if (!name) { alert('Event name is required.'); return; }
  if (!date) { alert('Event date is required.'); return; }

  // datetime-local omits seconds and timezone — new Date() interprets it as
  // local time, then toISOString() gives us the UTC value Postgres stores.
  var lockIso = lockLocal ? new Date(lockLocal).toISOString() : null;

  var saveBtn = document.getElementById('saveEditEventBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  var { error } = await supabaseClient
    .from('ufc_events')
    .update({
      name:              name,
      full_name:         fullName,
      event_date:        date,
      lineup_lock_time:  lockIso,
      venue:             venue
    })
    .eq('id', selectedEvent.id);

  if (error) {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save changes';
    alert('Could not save changes: ' + error.message);
    return;
  }

  // Merge the saved values into local state so the page reflects them
  // without a full reload. recomputeLockStatus picks up date/lock changes.
  selectedEvent.name              = name;
  selectedEvent.full_name         = fullName;
  selectedEvent.event_date        = date;
  selectedEvent.lineup_lock_time  = lockIso;
  selectedEvent.venue             = venue;
  var idx = availableEvents.findIndex(function(e) { return e.id === selectedEvent.id; });
  if (idx !== -1) availableEvents[idx] = selectedEvent;

  closeEditEventModal();
  recomputeLockStatus();
  renderEventBanner();
  renderRosterList(); // matchup chips on the roster rows depend on the event
}

// ========================================================================
// SLOT ASSIGNMENT
// Mirrors the canPick logic from draft.js so the roster sections stay
// consistent with how picks were made. Given fighters in roster order,
// greedily assigns each to its slot category.
// ========================================================================
function assignSlots(fighters) {
  const menCounts = {};
  MENS_DIVISIONS.forEach(function(d) { menCounts[d] = 0; });
  let womenCount = 0;
  let flexCount  = 0;
  const result   = [];

  // Pinned fighters (slot_override = 'any_flex') are processed first so they claim
  // their flex slot before the greedy algorithm hands those slots to overflow fighters.
  const pinned   = fighters.filter(function(f) { return f.slot_override === 'any_flex'; });
  const unpinned = fighters.filter(function(f) { return f.slot_override !== 'any_flex'; });

  pinned.forEach(function(f) {
    flexCount++;
    result.push({ fighter: f, slotType: 'any_flex' });
  });

  unpinned.forEach(function(f) {
    const isWoman = WOMENS_DIVISIONS.includes(f.primary_division);

    if (isWoman) {
      if (womenCount < 2) {
        womenCount++;
        result.push({ fighter: f, slotType: 'women_flex' });
      } else {
        flexCount++;
        result.push({ fighter: f, slotType: 'any_flex' });
      }
    } else {
      const divCount = menCounts[f.primary_division] || 0;
      if (divCount < 2) {
        menCounts[f.primary_division] = divCount + 1;
        result.push({ fighter: f, slotType: f.primary_division });
      } else {
        flexCount++;
        result.push({ fighter: f, slotType: 'any_flex' });
      }
    }
  });

  return result;
}

// Returns filled/empty pip dots HTML for a slot category
function renderPips(filled, total) {
  let html = '';
  for (let i = 0; i < total; i++) {
    html += '<span class="pip ' + (i < filled ? 'pip-filled' : 'pip-empty') + '"></span>';
  }
  return html;
}

// ========================================================================
// HELPERS
// ========================================================================

// Returns the fighter card tier modifier class based on rank
function tierModifier(fighter) {
  if (fighter.is_champion)                           return 'fighter-card--champion';
  if (fighter.current_rank && fighter.current_rank <= 5)  return 'fighter-card--top5';
  if (fighter.current_rank && fighter.current_rank <= 15) return 'fighter-card--top15';
  return '';
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

initLineup();
