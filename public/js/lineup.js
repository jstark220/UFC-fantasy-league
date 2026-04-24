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

// ---- Placeholder fight card (replace with real ufc_events / fight_results query) ----
// TODO: fetch fights from the fights/fight_card table once seeded.
const PLACEHOLDER_FIGHTS = [
  {
    section: 'Main Card',
    fights: [
      { redCorner: 'Islam Makhachev',     blueCorner: 'Arman Tsarukyan',      weightClass: 'Lightweight',        badge: 'Main Event' },
      { redCorner: 'Alex Pereira',        blueCorner: 'Jiří Procházka',       weightClass: 'Light Heavyweight',  badge: 'Co-Main'    },
      { redCorner: 'Shavkat Rakhmonov',   blueCorner: 'Ian Machado Garry',    weightClass: 'Welterweight'                            },
      { redCorner: 'Robert Whittaker',    blueCorner: 'Ikram Aliskerov',      weightClass: 'Middleweight'                            },
      { redCorner: 'Justin Gaethje',      blueCorner: 'Dan Hooker',           weightClass: 'Lightweight'                             }
    ]
  },
  {
    section: 'Prelims',
    fights: [
      { redCorner: 'Paddy Pimblett',      blueCorner: 'Michael Chandler',     weightClass: 'Lightweight'   },
      { redCorner: 'Caio Borralho',       blueCorner: 'Brendan Allen',        weightClass: 'Middleweight'  },
      { redCorner: 'Chris Curtis',        blueCorner: 'Jack Della Maddalena', weightClass: 'Welterweight'  },
      { redCorner: 'Tabatha Ricci',       blueCorner: 'Angela Hill',          weightClass: "Women's Strawweight" }
    ]
  },
  {
    section: 'Early Prelims',
    fights: [
      { redCorner: 'Erin Blanchfield',    blueCorner: 'Natalia Silva',        weightClass: "Women's Flyweight" },
      { redCorner: 'Joshua Van',          blueCorner: 'Raoni Barcelos',       weightClass: 'Bantamweight'      },
      { redCorner: 'Cody Durden',         blueCorner: 'Felipe dos Santos',    weightClass: 'Flyweight'         }
    ]
  }
];

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
let myRoster   = [];
let nextEvent  = null;
let isLocked   = false;
let selections    = new Set();  // fighter IDs currently started
let selectionRowIds = {};       // fighter_id -> starter_selections DB row id
let rosterRowIds    = {};       // fighter_id -> rosters table row id (needed to delete)

// ========================================================================
// INIT
// ========================================================================
async function initLineup() {
  user = await requireAuth();
  if (!user) return;

  leagueId = new URLSearchParams(window.location.search).get('id');
  if (!leagueId) { window.location.href = 'dashboard.html'; return; }

  document.getElementById('leagueLink').href = 'league.html?id=' + leagueId;

  // TODO: swap this Promise.all for the real Phase 1 query from the original
  // lineup.js once event data is seeded (league, members, ufc_events).
  const [leagueRes, membersRes] = await Promise.all([
    supabaseClient.from('leagues').select('id, name, draft_started').eq('id', leagueId).single(),
    supabaseClient.from('league_members').select('id, user_id, team_name').eq('league_id', leagueId)
  ]);

  if (leagueRes.error || !leagueRes.data) {
    window.location.href = 'dashboard.html';
    return;
  }

  const league  = leagueRes.data;
  const members = membersRes.data || [];
  const myMember = members.find(function(m) { return m.user_id === user.id; });
  if (!myMember) { window.location.href = 'dashboard.html'; return; }
  myMemberId = myMember.id;

  document.title   = 'Lineup - ' + league.name;
  document.getElementById('leagueName').textContent = league.name;

  // Nav links in the league header
  var nav = '<a href="standings.html?id=' + leagueId + '" class="btn-secondary">Standings</a>';
  nav += '<a href="roster.html?id='   + leagueId + '" class="btn-secondary">Rosters</a>';
  nav += '<a href="waivers.html?id='  + leagueId + '" class="btn-secondary">Waivers</a>';
  nav += '<a href="lineup.html?id='   + leagueId + '" class="btn-primary">Lineup</a>';
  document.getElementById('headerActions').innerHTML = nav;

  // Fetch this user's roster for the league, joined with full fighter details.
  // slot_override stores manual flex moves the user has made (e.g. 'any_flex').
  const rostersRes = await supabaseClient
    .from('rosters')
    .select('id, draft_pick, slot_override, fighters(id, name, primary_division, current_rank, is_champion, record_wins, record_losses, record_draws, photo_url)')
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
    // Spread fighter fields and attach slot_override from the roster row
    return Object.assign({}, r.fighters, { slot_override: r.slot_override || null });
  });

  document.getElementById('pageContent').style.display = 'block';

  renderEventBanner();
  renderStarterSlots();
  renderRosterList();
}

// ========================================================================
// RENDER EVENT BANNER
// Uses the this-week-card CSS. Hardcoded to UFC 329 for the placeholder;
// TODO: replace nextEvent with the real ufc_events query result.
// ========================================================================
function renderEventBanner() {
  const el = document.getElementById('eventBanner');
  const started = selections.size;
  const lockLabel = isLocked
    ? '<span style="color: var(--text-tertiary);">&#128274; Lineup locked</span>'
    : '<span style="color: #4ade80;">&#128275; Lineup open</span>';

  el.innerHTML =
    '<div class="this-week-card" style="margin-bottom: var(--space-8);">' +
      '<div class="this-week-card__event">' +
        '<p class="this-week-card__eyebrow">Set Your Lineup</p>' +
        '<p class="this-week-card__name">UFC 329</p>' +
        '<p class="this-week-card__date">Saturday, May 3 &middot; T-Mobile Arena, Las Vegas</p>' +
        '<p class="this-week-card__matchup">Makhachev vs. Tsarukyan II</p>' +
        '<button class="btn-ghost fight-card-btn" id="viewFightCardBtn">View fight card &rarr;</button>' +
      '</div>' +
      '<div class="this-week-card__right">' +
        '<p class="lineup-lock-status">' + lockLabel + '</p>' +
        '<p class="this-week-card__deadline">Locks at first prelim &middot; ' + started + '/3 set</p>' +
      '</div>' +
    '</div>';

  document.getElementById('viewFightCardBtn').addEventListener('click', showFightCardModal);
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

  return (
    '<div class="fighter-card ' + tierClass + '">' +
      '<div class="fighter-card__photo-wrap">' + photoHtml + '</div>' +
      '<div class="fighter-card__rating">' +
        '<span class="fighter-card__rating-num">' + rankLabel + '</span>' +
        '<span class="fighter-card__rating-label">' + rankSub + '</span>' +
      '</div>' +
      champBadge +
      '<div class="fighter-card__info">' +
        '<p class="fighter-card__division">' + escapeHtml(divLabel) + '</p>' +
        '<p class="fighter-card__name">' + escapeHtml(fighter.name) + '</p>' +
        '<p class="fighter-card__record">' + record + '</p>' +
        (isLocked
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

  // Assign each fighter to its slot category using the same greedy rules as the draft
  const assigned = assignSlots(myRoster);

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

  let html = '';

  // Men's divisions — only render sections that have at least one fighter
  MENS_DIVISIONS.forEach(function(div) {
    if (groups[div].length === 0) return;
    html += renderSlotSection(DIVISION_LABELS[div], groups[div], 2, isFull, div);
  });

  // Women's flex section
  if (groups['women_flex'].length > 0) {
    html += renderSlotSection("Women's Flex", groups['women_flex'], 2, isFull, 'women_flex');
  }

  // Any-division flex section (no "Move to Flex" button shown here — already in flex)
  if (groups['any_flex'].length > 0) {
    html += renderSlotSection('Any-Division Flex', groups['any_flex'], 2, isFull, 'any_flex');
  }

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
}

// Renders one slot category: a header row (title + pip dots) followed by fighter rows.
// slotType is passed through so each row knows whether to show the "→ Flex" button.
function renderSlotSection(title, fighters, totalSlots, isFull, slotType) {
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
    html += renderRosterRow(fighter, isFull, slotType);
  });

  return html;
}

// Returns the HTML for a single roster row.
// slotType is this fighter's current slot category (used to decide whether to show flex button).
function renderRosterRow(fighter, isFull, slotType) {
  const isStarted  = selections.has(fighter.id);
  const rankLabel  = fighter.is_champion ? 'C' : (fighter.current_rank ? '#' + fighter.current_rank : 'NR');
  const rankClass  = fighter.is_champion ? 'rank-champion' : (fighter.current_rank ? 'rank-ranked' : 'rank-unranked');
  const divLabel   = DIVISION_LABELS[fighter.primary_division] || fighter.primary_division;
  const record     = fighter.record_wins + '-' + fighter.record_losses + (fighter.record_draws ? '-' + fighter.record_draws : '');
  const rowClass   = isStarted ? ' lineup-roster-row--started' : '';
  const photoHtml  = fighter.photo_url
    ? '<img class="lineup-roster-row__photo" src="' + fighter.photo_url + '" alt="' + escapeHtml(fighter.name) + '" onerror="this.style.display=\'none\'">'
    : '';

  let btnHtml;
  if (isLocked) {
    btnHtml = isStarted
      ? '<span class="lineup-starter-badge">Starter</span>'
      : '<span class="lineup-bench-badge">Bench</span>';
  } else if (isStarted) {
    btnHtml = '<button class="btn-ghost lineup-row-btn" data-fighter-id="' + fighter.id + '">Bench</button>';
  } else if (isFull) {
    btnHtml = '<button class="btn-secondary lineup-row-btn" disabled>Start</button>';
  } else {
    btnHtml = '<button class="btn-secondary lineup-row-btn" data-fighter-id="' + fighter.id + '">Start</button>';
  }

  // "Move to Flex" button: only for fighters not already in the any_flex slot,
  // and only when the lineup isn't locked
  const flexBtn = (!isLocked && slotType !== 'any_flex')
    ? '<button class="lineup-flex-btn" data-flex-id="' + fighter.id + '" title="Move to Any-Division Flex">&rarr; Flex</button>'
    : '';

  // Drop button is hidden while the lineup is locked (can't change roster mid-event)
  const dropBtn = isLocked
    ? ''
    : '<button class="lineup-drop-btn" data-drop-id="' + fighter.id + '" title="Drop from roster">Drop</button>';

  return (
    '<div class="lineup-roster-row' + rowClass + '" id="roster-row-' + fighter.id + '">' +
      '<div class="lineup-roster-row__photo-wrap">' + photoHtml + '</div>' +
      '<span class="lineup-roster-row__rank ' + rankClass + '">' + rankLabel + '</span>' +
      '<div class="lineup-roster-row__info">' +
        '<span class="lineup-roster-row__name">' + escapeHtml(fighter.name) + '</span>' +
        '<span class="lineup-roster-row__division">' + escapeHtml(divLabel) + '</span>' +
      '</div>' +
      '<span class="lineup-roster-row__record">' + record + '</span>' +
      btnHtml +
      flexBtn +
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
function toggleStarter(fighterId) {
  if (isLocked) return;

  if (selections.has(fighterId)) {
    selections.delete(fighterId);
  } else {
    if (selections.size >= MAX_STARTERS) return;
    selections.add(fighterId);
  }

  renderStarterSlots();
  renderRosterList();
  renderEventBanner();
}

// ========================================================================
// DROP FIGHTER
// Deletes a fighter from the user's roster. Asks for confirmation first
// since this is irreversible (the fighter goes to free agency, not waivers).
// ========================================================================
async function dropFighter(fighterId) {
  if (isLocked) return;

  const fighter = myRoster.find(function(f) { return f.id === fighterId; });
  if (!fighter) return;

  const confirmed = confirm('Drop ' + fighter.name + ' from your roster?\n\nThey will become a free agent. This cannot be undone.');
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
  if (isLocked) return;

  const mover = myRoster.find(function(f) { return f.id === fighterId; });
  if (!mover) return;

  // Find the current any_flex fighters by re-running slot assignment
  const assigned   = assignSlots(myRoster);
  const flexFighters = assigned
    .filter(function(item) { return item.slotType === 'any_flex'; })
    .map(function(item) { return item.fighter; });

  const flexOpen = flexFighters.length < 2;

  // Remove any existing modal
  var existing = document.getElementById('moveFlexModal');
  if (existing) existing.remove();

  const divLabel = DIVISION_LABELS[mover.primary_division] || mover.primary_division;

  // Build swap option rows (only shown when flex is full)
  let swapOptionsHtml = '';
  if (!flexOpen) {
    swapOptionsHtml =
      '<p class="move-flex-body-text">Both flex slots are taken. Choose who to swap out:</p>' +
      '<div class="flex-swap-options" id="flexSwapOptions">' +
        flexFighters.map(function(f, i) {
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
// FIGHT CARD MODAL
// Injects a full-screen overlay showing all fights grouped by section.
// Clicking the overlay or the close button dismisses it.
// ========================================================================
function showFightCardModal() {
  // Remove any existing modal first
  var existing = document.getElementById('fightCardModal');
  if (existing) existing.remove();

  var sectionsHtml = PLACEHOLDER_FIGHTS.map(function(section) {
    var fightsHtml = section.fights.map(function(fight) {
      var badgeHtml = fight.badge
        ? '<span class="fight-row__badge">' + escapeHtml(fight.badge) + '</span>'
        : '';
      return (
        '<div class="fight-row">' +
          '<span class="fight-row__fighter fight-row__fighter--red">' + escapeHtml(fight.redCorner) + '</span>' +
          '<div class="fight-row__center">' +
            badgeHtml +
            '<span class="fight-row__weight">' + escapeHtml(fight.weightClass) + '</span>' +
            '<span class="fight-row__vs">vs</span>' +
          '</div>' +
          '<span class="fight-row__fighter fight-row__fighter--blue">' + escapeHtml(fight.blueCorner) + '</span>' +
        '</div>'
      );
    }).join('');

    return (
      '<div class="fight-card-section">' +
        '<p class="fight-card-section__label">' + escapeHtml(section.section) + '</p>' +
        fightsHtml +
      '</div>'
    );
  }).join('');

  var modal = document.createElement('div');
  modal.id = 'fightCardModal';
  modal.className = 'fight-card-modal-overlay';
  modal.innerHTML =
    '<div class="fight-card-modal" role="dialog" aria-modal="true" aria-label="UFC 329 Fight Card">' +
      '<div class="fight-card-modal__header">' +
        '<div>' +
          '<p class="fight-card-modal__eyebrow">Fight Card</p>' +
          '<p class="fight-card-modal__title">UFC 329</p>' +
        '</div>' +
        '<button class="fight-card-modal__close" id="closeFightCardBtn" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="fight-card-modal__body">' + sectionsHtml + '</div>' +
    '</div>';

  document.body.appendChild(modal);

  // Close on button click
  document.getElementById('closeFightCardBtn').addEventListener('click', closeFightCardModal);

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
