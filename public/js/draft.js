// ========================================================================
// DRAFT PAGE LOGIC
// Real-time snake draft room. All clients subscribe to Supabase Realtime
// to see picks as they happen. The active manager clicks a fighter to pick;
// all other clients watch the board update live.
// Depends on supabaseClient (supabase-config.js) and requireAuth (auth-guard.js).
// ========================================================================

// ========================================================================
// ROSTER SLOT DEFINITIONS
// These enum values must match the weight_class enum in the database exactly.
// ========================================================================
const MENS_DIVISIONS = [
  'flyweight', 'bantamweight', 'featherweight', 'lightweight',
  'welterweight', 'middleweight', 'light_heavyweight', 'heavyweight'
];
const WOMENS_DIVISIONS = ['strawweight', 'flyweight_w', 'bantamweight_w'];

// Human-readable labels for display in the fighter pool and roster panel
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

// CSS custom-property names for each division's accent color. Defined in
// tokens.css. Looked up at render time and applied as an inline style on
// the row so we don't have to fan out 11 selectors in the stylesheet.
const DIVISION_COLOR_VAR = {
  strawweight:        '--div-strawweight',
  flyweight_w:        '--div-flyweight-w',
  bantamweight_w:     '--div-bantamweight-w',
  flyweight:          '--div-flyweight',
  bantamweight:       '--div-bantamweight',
  featherweight:      '--div-featherweight',
  lightweight:        '--div-lightweight',
  welterweight:       '--div-welterweight',
  middleweight:       '--div-middleweight',
  light_heavyweight:  '--div-light_heavyweight',
  heavyweight:        '--div-heavyweight'
};

// Returns the var(--div-…) reference for a fighter's primary_division.
// Falls back to a neutral border color so unknown divisions never break the row.
function divisionColor(primaryDivision) {
  const cssVar = DIVISION_COLOR_VAR[primaryDivision];
  return cssVar ? 'var(' + cssVar + ')' : 'var(--border-strong)';
}

// Look up a fighter's composite fantasy-value score via the shared module.
// Returns 0 when the FV cache hasn't loaded yet, when the module isn't
// present, or when this fighter has no fight history — keeping the sort
// stable in every state instead of throwing.
function fighterFvScore(fighter) {
  if (typeof FantasyValue === 'undefined') return 0;
  var pts = FantasyValue.pointsFor(fighter.id);
  if (!pts) return 0;
  return FantasyValue.computeFantasyValue(fighter, pts);
}

// Read one of the points-map metrics (avgPts / totalPts / recentPts) for a
// fighter. Same fall-throughs as fighterFvScore so sorts stay deterministic
// before the FV cache resolves.
function fighterPtsValue(fighter, ptsKey) {
  if (typeof FantasyValue === 'undefined') return 0;
  var pts = FantasyValue.pointsFor(fighter.id);
  if (!pts) return 0;
  var v = pts[ptsKey];
  return typeof v === 'number' ? v : 0;
}

// "Fights MMM DD vs Opponent" line shown under the division label when the
// fighter has an upcoming booked fight. Same markup the lineup page uses
// (lineup-roster-row__matchup + waiver-next-fight classes) so styling is
// shared. Returns '' if the next-fight data hasn't loaded yet OR the
// fighter has no booked next fight — both are normal states.
function nextFightLine(fighter) {
  if (typeof NextFight === 'undefined') return '';
  var nf = fighterNextFight[fighter.id];
  if (!nf) return '';
  return (
    '<span class="lineup-roster-row__matchup waiver-next-fight">' +
      'Fights ' + escapeHtml(NextFight.formatShort(nf)) +
    '</span>'
  );
}

// Trend chips — narrative microstats that turn a fighter row from "name +
// stats" into "name + story." Reads from the FantasyValue points map for
// streak data; uses the fighter row directly for champion / sub-title
// status. Returns at most 2 chips per fighter so rows stay scannable;
// priority order: champion > sub-title > streak > debut > coming-off-loss.
function trendChipsHtml(fighter) {
  var chips = [];

  // Champion + interim/BMF holders already get the gold rank badge + photo
  // ring, so we DON'T emit a redundant "Champion" chip here. Streaks and
  // debut status are the value-add chips that other surfaces don't have.

  var pts = (typeof FantasyValue !== 'undefined' && FantasyValue.pointsFor)
    ? FantasyValue.pointsFor(fighter.id) : null;

  // Hot streak — 3+ wins gets the fire chip; 2-fight win streak is too
  // common to be noteworthy, so we cap the streak chip at 3+.
  if (pts && pts.winStreak >= 3) {
    chips.push({
      label: pts.winStreak + 'W streak',
      icon:  '🔥',
      tone:  'hot'
    });
  }

  // Coming off a loss — useful negative signal, especially mid-late draft
  // where managers chase value off cold streaks. Don't show alongside a
  // win streak (they're mutually exclusive in the data anyway).
  if (pts && pts.lossStreak >= 2) {
    chips.push({
      label: pts.lossStreak + 'L skid',
      icon:  '📉',
      tone:  'cold'
    });
  }

  // UFC debut / no fight history. Only flag fighters who explicitly have
  // zero fights in our data — distinct from "FV cache hasn't loaded yet"
  // (in which case pts is null and we just skip the chip).
  if (pts && pts.fightCount === 0) {
    chips.push({
      label: 'Debut',
      icon:  '🆕',
      tone:  'new'
    });
  }

  if (chips.length === 0) return '';

  // Cap at 2 so the row never gets crowded.
  return '<span class="draft-trend-chips">' +
    chips.slice(0, 2).map(function(c) {
      return '<span class="draft-trend-chip draft-trend-chip--' + c.tone + '">' +
        '<span class="draft-trend-chip__icon" aria-hidden="true">' + c.icon + '</span>' +
        '<span class="draft-trend-chip__label">' + escapeHtml(c.label) + '</span>' +
      '</span>';
    }).join('') +
  '</span>';
}

// One-time setup: auto-draft toggle. Wires the click handler, restores
// prior choice from localStorage (per-league key), keeps the banner +
// button label in sync, and fires maybeAutoPickNow() whenever the toggle
// flips ON so the user doesn't have to wait for a turn-change event.
function setupAutoDraftToggle() {
  var btn    = document.getElementById('autoDraftToggle');
  var banner = document.getElementById('autoDraftBanner');
  if (!btn) return;

  var storageKey = 'draft-autodraft:' + leagueId;

  function paint() {
    btn.classList.toggle('draft-autodraft-toggle--on', autoDraftOn);
    btn.setAttribute('aria-pressed', autoDraftOn ? 'true' : 'false');
    if (banner) banner.hidden = !autoDraftOn;
  }

  function setOn(next) {
    autoDraftOn = !!next;
    try { localStorage.setItem(storageKey, autoDraftOn ? '1' : '0'); } catch (_) { /* private mode */ }
    paint();
    // If the user just turned it on AND it's already their turn, fire
    // immediately. maybeAutoPickNow handles the picking-already-in-flight
    // and pause guards.
    if (autoDraftOn) maybeAutoPickNow();
  }

  btn.addEventListener('click', function() { setOn(!autoDraftOn); });

  // Restore prior choice — default off for new visitors so we never pick
  // for someone without explicit consent.
  var saved = null;
  try { saved = localStorage.getItem(storageKey); } catch (_) { /* private mode */ }
  autoDraftOn = (saved === '1');
  paint();
}

// One-time setup: mock-mode chrome. Reveals the MOCK badge in the top
// nav, wires the Start + Restart buttons, and shows the "Ready when you
// are" banner until the user clicks Start. No-op outside mock mode so
// the real draft is unaffected.
//   Start  : user-initiated kickoff. Flips mockStarted=true, hides the
//            banner, and fires the AI scheduler (which is a no-op if it
//            happens to be the user's turn first).
//   Restart: wipes the in-memory picks, cancels any pending AI timer,
//            and re-fires the scheduler. mockStarted stays true so the
//            mock just runs again without re-showing the banner.
function setupMockChrome() {
  var badge        = document.getElementById('draftMockBadge');
  var reset        = document.getElementById('draftMockResetBtn');
  var startBanner  = document.getElementById('draftMockStartBanner');
  var startBtn     = document.getElementById('draftMockStartBtn');

  if (!isMockMode) {
    if (badge)       badge.hidden       = true;
    if (reset)       reset.hidden       = true;
    if (startBanner) startBanner.hidden = true;
    return;
  }

  if (badge) badge.hidden = false;
  // Restart visible only after the mock has actually started — before
  // that there's nothing to restart from.
  if (reset) {
    reset.hidden = true;
    reset.addEventListener('click', function() {
      if (mockAiTimer) { clearTimeout(mockAiTimer); mockAiTimer = null; }
      picks = [];
      mockPickIdCounter   = 0;
      pickClockResetAt    = Date.now();
      picking             = false;
      lastAnimatedPickId  = null;
      wasMyTurn           = false;
      lastClockBand       = 'none';
      draftDoneSounded    = false;
      league.draft_completed = false;
      renderAll();
      maybeScheduleNextAiPick();
    });
  }

  if (startBanner) startBanner.hidden = false;

  // Rebuild the "Your Pick" dropdown whenever the user changes Teams,
  // so the position list always matches the chosen team count (no slot
  // #10 option when they pick 4 teams). "Random" stays at the top.
  var teamCountSel = document.getElementById('draftMockTeamCount');
  var pickPosSel   = document.getElementById('draftMockPickPos');
  function repopulatePickPositions() {
    if (!teamCountSel || !pickPosSel) return;
    var n = parseInt(teamCountSel.value, 10);
    if (!isFinite(n) || n < 2) n = 8;
    var prevValue = pickPosSel.value;
    pickPosSel.innerHTML = '<option value="random">Random</option>';
    for (var i = 1; i <= n; i++) {
      pickPosSel.insertAdjacentHTML(
        'beforeend',
        '<option value="' + i + '">#' + i + '</option>'
      );
    }
    // Preserve the user's prior choice when possible; otherwise reset
    // to Random (the original default).
    pickPosSel.value = (prevValue === 'random' || parseInt(prevValue, 10) <= n)
      ? prevValue
      : 'random';
  }
  if (teamCountSel) {
    teamCountSel.addEventListener('change', repopulatePickPositions);
    repopulatePickPositions();
  }

  if (startBtn) {
    startBtn.addEventListener('click', function() {
      // Resize the draft to the chosen team count BEFORE flipping
      // mockStarted, so the first render after the banner closes already
      // reflects the right number of slots.
      var sel = document.getElementById('draftMockTeamCount');
      var teamCount = sel ? parseInt(sel.value, 10) : NaN;
      if (!isFinite(teamCount) || teamCount < 2) teamCount = members.length;

      // Pick position: numeric 1..N puts the user at that exact slot in
      // the snake; "random" / invalid falls back to a random slot.
      var posSel = document.getElementById('draftMockPickPos');
      var posRaw = posSel ? posSel.value : 'random';
      var pickPosition = parseInt(posRaw, 10);
      if (!isFinite(pickPosition) || pickPosition < 1 || pickPosition > teamCount) {
        pickPosition = null;
      }
      league.draft_order = buildMockDraftOrder(teamCount, pickPosition);

      mockStarted = true;
      if (startBanner) startBanner.hidden = true;
      if (reset)       reset.hidden       = false;
      // Re-render so the status strip / next-pick indicator reflect the
      // active state (the room was rendered earlier but maybeAutoPickNow
      // / scheduler haven't been allowed to do anything yet).
      renderAll();
      maybeScheduleNextAiPick();
      // Auto-draft might be on and the user might be picker #1 — give it
      // the same chance to fire as any normal turn-start moment.
      maybeAutoPickNow();
    });
  }
}

// Build a mock draft order of exactly `teamCount` member ids. The user's
// real member id is always included. Up to (teamCount - 1) other real
// league members are pulled in; any remaining seats get filled with
// synthetic "Bot N" members which are pushed onto both `members` and
// `memberMap` so name/colour lookups continue to work.
//
// `pickPosition` (optional, 1..teamCount) places the user at exactly
// that slot in the final snake order. When null/omitted, the order is
// randomly shuffled and the user lands wherever the shuffle puts them.
function buildMockDraftOrder(teamCount, pickPosition) {
  var ids = [myMemberId];

  // Other real members first, capped at teamCount - 1 so we never exceed
  // the chosen size.
  members
    .filter(function(m) { return m.id !== myMemberId && !m._isMockBot; })
    .slice(0, teamCount - 1)
    .forEach(function(m) { ids.push(m.id); });

  // Reuse any synthetic bots we already minted on a previous Start click
  // (handles a future "change team count and restart" flow without bloating
  // the members array with duplicates).
  members
    .filter(function(m) { return m._isMockBot; })
    .slice(0, Math.max(0, teamCount - ids.length))
    .forEach(function(m) { ids.push(m.id); });

  // Fill the rest with brand-new bots.
  var nextBotIdx = members.filter(function(m) { return m._isMockBot; }).length + 1;
  while (ids.length < teamCount) {
    var bot = {
      id:               'mock-bot-' + nextBotIdx,
      user_id:          null,
      team_name:        'Bot ' + nextBotIdx,
      is_commissioner:  false,
      _isMockBot:       true
    };
    members.push(bot);
    memberMap[bot.id] = bot;
    ids.push(bot.id);
    nextBotIdx++;
  }

  // Random shuffle so the bot ordering is unpredictable.
  for (var i = ids.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
  }

  // If the user requested a specific slot, swap myMemberId into that
  // slot post-shuffle. Whatever bot was there moves to where the user
  // landed, preserving uniqueness in the array.
  if (typeof pickPosition === 'number' &&
      pickPosition >= 1 && pickPosition <= ids.length) {
    var currentIdx = ids.indexOf(myMemberId);
    var targetIdx  = pickPosition - 1;
    if (currentIdx !== -1 && currentIdx !== targetIdx) {
      var swap = ids[targetIdx];
      ids[targetIdx]  = ids[currentIdx];
      ids[currentIdx] = swap;
    }
  }

  return ids;
}

// One-time setup: mute toggle for the synthesized draft sound effects.
// Wires the speaker button in the top-nav, restores prior mute pref from
// localStorage (handled inside DraftSounds), and keeps the icon in sync.
function setupSoundToggle() {
  var btn = document.getElementById('draftSoundBtn');
  if (!btn || typeof DraftSounds === 'undefined') return;

  function paint() {
    var muted = DraftSounds.isMuted();
    btn.textContent = muted ? '🔇' : '🔊';
    btn.title       = muted ? 'Unmute draft sounds' : 'Mute draft sounds';
    btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
  }

  btn.addEventListener('click', function() {
    DraftSounds.setMuted(!DraftSounds.isMuted());
    paint();
  });
  paint();
}

// One-time setup: pre-draft lobby toggle. The cinematic lobby covers the
// draft room by default during pre-draft, but users want to peek into the
// room early (browse the pool, build their queue). Clicking "Enter draft
// room" dismisses the overlay and reveals a floating "← Lobby" pill so
// they can bounce back without refreshing.
//
// State is purely client-side and reset on reload — the lobby returns by
// default for each new visit until the draft actually starts (at which
// point subscribeToLobbyFlip reloads the page).
function setupLobbyEnterButton() {
  var lobby   = document.getElementById('draftLobby');
  var enterBtn = document.getElementById('draftLobbyEnterBtn');
  var showBtn  = document.getElementById('draftLobbyShowBtn');
  if (!lobby || !enterBtn || !showBtn) return;

  function inPreDraft() {
    return league && !league.draft_started && league.draft_scheduled_at;
  }

  enterBtn.addEventListener('click', function() {
    lobby.hidden = true;
    // Only show the "Lobby" pill while we're still in pre-draft. If the
    // draft started in the middle of the user reading the lobby (page
    // would reload anyway), this is defensive.
    showBtn.hidden = !inPreDraft();
  });

  showBtn.addEventListener('click', function() {
    if (!inPreDraft()) { showBtn.hidden = true; return; }
    // Re-render in case anything changed (presence, schedule) since the
    // lobby was dismissed.
    renderDraftLobby();
    showBtn.hidden = true;
  });
}

// One-time setup: fullscreen draft mode. Adds .draft-page--fullscreen
// to the page root, persists the user's choice to localStorage so the
// next visit lands in the same mode, and wires Esc to exit. Two toggle
// buttons in the DOM:
//   * #draftFullscreenBtn      — sits in the top nav, hidden in fullscreen
//   * #draftFullscreenExitBtn  — floating pill, visible only in fullscreen
// LocalStorage key includes leagueId so different leagues can remember
// different fullscreen preferences.
function setupFullscreenMode() {
  var page = document.getElementById('pageContent');
  if (!page) return;

  var storageKey = 'draft-fullscreen:' + leagueId;
  var toggleBtn  = document.getElementById('draftFullscreenBtn');
  var exitBtn    = document.getElementById('draftFullscreenExitBtn');

  function apply(on) {
    page.classList.toggle('draft-page--fullscreen', !!on);
    if (exitBtn) exitBtn.hidden = !on;
    try { localStorage.setItem(storageKey, on ? '1' : '0'); } catch (_) { /* private mode */ }
    // The room's computed height depends on what chrome is visible above
    // it; rerun the sync helper from draft.html so the board doesn't
    // stay at the previous height.
    if (typeof window.syncDraftRoomHeight === 'function') window.syncDraftRoomHeight();
  }

  function isOn() {
    return page.classList.contains('draft-page--fullscreen');
  }

  if (toggleBtn) toggleBtn.addEventListener('click', function() { apply(!isOn()); });
  if (exitBtn)   exitBtn.addEventListener('click',   function() { apply(false);  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && isOn()) {
      // Don't swallow Escape when a modal is open — those have their own
      // close handlers and should win.
      var modalOpen = document.querySelector(
        '#viewAllOverlay, #wholeRosterModal, #fvBreakdownModal, .fight-card-modal-overlay'
      );
      if (modalOpen) return;
      apply(false);
    }
  });

  // Restore prior choice. Default is off (most users won't have a stored
  // pref on first visit).
  var saved = null;
  try { saved = localStorage.getItem(storageKey); } catch (_) { /* private mode */ }
  if (saved === '1') apply(true);
}

// One-time setup: delayed hover preview card for fighter rows. Pulls
// data from FantasyValue + NextFight + fighterMap to assemble a richer
// preview than what fits in the row, without forcing the user to open
// the full fighter modal. Body-level + position:fixed so it escapes the
// pool's overflow:auto and floats over the layout.
//
// Hover delay: 350ms — long enough that casually scrolling over rows
// doesn't trigger constant popups, short enough that intentional hovers
// feel responsive.
function setupRowPreviewHover() {
  if (document.getElementById('draftRowPreview')) return;

  var preview = document.createElement('div');
  preview.id        = 'draftRowPreview';
  preview.className = 'draft-row-preview';
  preview.hidden    = true;
  document.body.appendChild(preview);

  var hoverTimer = null;
  var activeRow  = null;

  function clearTimer() {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  }

  function hide() {
    clearTimer();
    activeRow = null;
    preview.hidden = true;
  }

  function position(row) {
    var rect = row.getBoundingClientRect();
    preview.hidden = false;
    var pRect = preview.getBoundingClientRect();
    // Default to the right of the row, vertically centered on the row.
    var left = rect.right + 12;
    var top  = rect.top + rect.height / 2 - pRect.height / 2;
    // If right side runs off-screen, flip to the left of the row.
    if (left + pRect.width > window.innerWidth - 12) {
      left = rect.left - pRect.width - 12;
    }
    // Clamp vertically inside the viewport.
    var pad = 12;
    var maxTop = window.innerHeight - pRect.height - pad;
    if (top < pad)    top = pad;
    if (top > maxTop) top = maxTop;
    preview.style.left = left + 'px';
    preview.style.top  = top  + 'px';
  }

  function render(fighter) {
    if (!fighter) return;
    var rankLabel = fighter.is_champion
      ? 'Champion'
      : (fighter.current_rank ? '#' + fighter.current_rank : 'Unranked');
    var divLabel = DIVISION_LABELS[fighter.primary_division] || fighter.primary_division || '';
    var photoHtml = fighter.photo_url
      ? '<img class="draft-row-preview__photo" src="' + escapeHtml(fighter.photo_url) + '" alt="" onerror="this.style.display=\'none\'">'
      : '<div class="draft-row-preview__photo draft-row-preview__photo--placeholder"></div>';
    var record = fighter.record_wins + '-' + fighter.record_losses +
                 (fighter.record_draws ? '-' + fighter.record_draws : '');

    // FV block — score, league rank, recent form. Falls through cleanly
    // when FV hasn't loaded yet or the fighter has no fight history.
    var fvHtml = '';
    if (typeof FantasyValue !== 'undefined' && FantasyValue.scoreFor) {
      var fv      = FantasyValue.scoreFor(fighter.id);
      var rankInfo = FantasyValue.rankFor && FantasyValue.rankFor(fighter.id);
      if (typeof fv === 'number') {
        fvHtml +=
          '<div class="draft-row-preview__fv">' +
            '<span class="draft-row-preview__fv-score">' + fv.toFixed(1) + '</span>' +
            '<span class="draft-row-preview__fv-label">FV</span>' +
            (rankInfo && rankInfo.rank
              ? '<span class="draft-row-preview__fv-rank">#' + rankInfo.rank + ' of ' + rankInfo.total + '</span>'
              : '') +
          '</div>';
      }
      // Form sparkline (same dots as on the row) plus a "Recent form" label
      // so the preview reads as a complete summary on its own.
      var pts = FantasyValue.pointsFor(fighter.id);
      if (pts && pts.recentResults && pts.recentResults.length > 0) {
        var dots = pts.recentResults.map(function(r) {
          var result = typeof r === 'string' ? r : r.result;
          var cls = 'draft-form__dot draft-form__dot--' +
            (result === 'W' ? 'win' : result === 'L' ? 'loss' : result === 'D' ? 'draw' : 'nc');
          return '<span class="' + cls + '" data-detail="' + escapeHtml(formatFormDetail(r) || '') + '"></span>';
        }).join('');
        fvHtml +=
          '<div class="draft-row-preview__form">' +
            '<span class="draft-row-preview__section-label">Recent form</span>' +
            '<span class="draft-form">' + dots + '</span>' +
          '</div>';
      }
      // Stats block — avg + total + last-year points
      if (pts && pts.fightCount > 0) {
        fvHtml +=
          '<div class="draft-row-preview__stats">' +
            '<div class="draft-row-preview__stat">' +
              '<span class="draft-row-preview__stat-label">Avg</span>' +
              '<span class="draft-row-preview__stat-val">' + pts.avgPts.toFixed(1) + '</span>' +
            '</div>' +
            '<div class="draft-row-preview__stat">' +
              '<span class="draft-row-preview__stat-label">Last yr</span>' +
              '<span class="draft-row-preview__stat-val">' + pts.recentPts.toFixed(1) + '</span>' +
            '</div>' +
            '<div class="draft-row-preview__stat">' +
              '<span class="draft-row-preview__stat-label">Fights</span>' +
              '<span class="draft-row-preview__stat-val">' + pts.fightCount + '</span>' +
            '</div>' +
          '</div>';
      }
    }

    // Next fight, if booked
    var nextHtml = '';
    var nf       = fighterNextFight[fighter.id];
    if (nf && typeof NextFight !== 'undefined') {
      nextHtml =
        '<div class="draft-row-preview__next">' +
          '<span class="draft-row-preview__section-label">Next</span>' +
          '<span class="draft-row-preview__next-text">' + escapeHtml(NextFight.formatShort(nf)) + '</span>' +
        '</div>';
    }

    preview.innerHTML =
      '<div class="draft-row-preview__header">' +
        photoHtml +
        '<div class="draft-row-preview__heading">' +
          '<p class="draft-row-preview__name">' + escapeHtml(fighter.name) + '</p>' +
          '<p class="draft-row-preview__meta">' +
            escapeHtml(divLabel) + ' · ' + escapeHtml(rankLabel) + ' · ' + escapeHtml(record) +
          '</p>' +
        '</div>' +
      '</div>' +
      fvHtml +
      nextHtml;
  }

  // Delegated mouseover — only fires on enter into a new row (mouseover
  // bubbles so leaf-element hovers count too, but we dedup via activeRow).
  document.addEventListener('mouseover', function(e) {
    var row = e.target && e.target.closest ? e.target.closest('.lineup-roster-row') : null;
    if (!row) return;

    // Only treat draft surfaces as previewable (pool, view-all modal,
    // my-roster). Skips lineup/waivers pages that share the row class.
    var inDraftSurface = row.closest('#fighterPool, #viewAllOverlay, #myRoster');
    if (!inDraftSurface) return;

    // Look up the fighter id from any of the data attributes the row
    // exposes (name button has data-open-fighter; queue/pick buttons
    // carry their own ids).
    var nameBtn = row.querySelector('[data-open-fighter]');
    var fighterId = nameBtn ? nameBtn.getAttribute('data-open-fighter') : null;
    if (!fighterId) return;

    if (activeRow === row) return; // already previewing this row
    clearTimer();
    activeRow = row;
    hoverTimer = setTimeout(function() {
      var f = fighterMap && fighterMap[fighterId];
      if (!f) return;
      render(f);
      position(row);
    }, 350);
  });

  document.addEventListener('mouseout', function(e) {
    var row = e.target && e.target.closest ? e.target.closest('.lineup-roster-row') : null;
    if (!row) return;
    // Moving to a related descendant of the same row? Stay open.
    var next = e.relatedTarget && e.relatedTarget.closest
      ? e.relatedTarget.closest('.lineup-roster-row') : null;
    if (next === row) return;
    hide();
  });

  // Defensive — any scroll inside the pool/modal moves rows underneath,
  // so the popover would float over wrong rows. Just hide on scroll.
  window.addEventListener('scroll', function() { hide(); }, { passive: true, capture: true });
}

// One-time setup: install a body-level popover element + delegated hover
// handlers that show recent-fight detail on form-sparkline dot hover.
// Body-level because the fighter pool scrolls (overflow:auto), which would
// clip any popover rendered inside a row. Idempotent — safe to call more
// than once.
function setupFormDotHover() {
  if (document.getElementById('draftFormPopover')) return;

  var popover = document.createElement('div');
  popover.id        = 'draftFormPopover';
  popover.className = 'draft-form-popover';
  popover.hidden    = true;
  document.body.appendChild(popover);

  function positionFor(dotEl) {
    var rect = dotEl.getBoundingClientRect();
    // Measure popover AFTER making it visible (display:none = no size).
    popover.hidden = false;
    var pRect      = popover.getBoundingClientRect();
    // Center horizontally over the dot; perch ~8px above.
    var left = rect.left + rect.width  / 2 - pRect.width  / 2;
    var top  = rect.top  - pRect.height - 8;
    // Clamp so we never run off-screen (especially the right edge with a
    // long opponent name).
    var pad  = 8;
    var maxLeft = window.innerWidth  - pRect.width  - pad;
    if (left < pad)     left = pad;
    if (left > maxLeft) left = maxLeft;
    // Flip below the dot if there's no room above (very tall popover edge
    // case shouldn't happen, but defensive).
    if (top < pad) top = rect.bottom + 8;
    popover.style.left = left + 'px';
    popover.style.top  = top  + 'px';
  }

  document.addEventListener('mouseover', function(e) {
    var dot = e.target && e.target.closest ? e.target.closest('.draft-form__dot') : null;
    if (!dot) return;
    var detail = dot.getAttribute('data-detail');
    if (!detail) return;
    popover.textContent = detail;
    positionFor(dot);
  });

  document.addEventListener('mouseout', function(e) {
    var dot = e.target && e.target.closest ? e.target.closest('.draft-form__dot') : null;
    if (!dot) return;
    // Hide unless we're moving to ANOTHER dot — in which case the next
    // mouseover will immediately reposition. Avoids a flicker between
    // adjacent dots.
    var next = e.relatedTarget && e.relatedTarget.closest
      ? e.relatedTarget.closest('.draft-form__dot') : null;
    if (next) return;
    popover.hidden = true;
  });

  // Hide the popover on any scroll so it doesn't hang in mid-air over
  // unrelated content. Cheap — passive listener.
  window.addEventListener('scroll', function() { popover.hidden = true; }, { passive: true, capture: true });
}

// Form sparkline — 5 inline dots showing W/L/D for the fighter's most-recent
// fights (newest on the LEFT, matching how UFC/Tapology display recent form).
// Each dot is hoverable: data-detail carries a one-line summary ("Win vs
// Pereira · Mar 14 · 28.5 pts") that the body-level popover handler reads
// and positions. We resolve opponent ids via fighterMap (already populated
// with all known fighters at init time) so no extra fetches are needed.
function formSparkline(fighter) {
  if (typeof FantasyValue === 'undefined' || !FantasyValue.pointsFor) return '';
  var pts = FantasyValue.pointsFor(fighter.id);
  if (!pts || !pts.recentResults || pts.recentResults.length === 0) return '';

  var dots = '';
  pts.recentResults.forEach(function(r) {
    // Tolerate both the legacy string shape ("W") and the new object shape
    // ({ result, date, opponentId, score }) — defensive in case stale cache
    // entries exist mid-session.
    var result = typeof r === 'string' ? r : r.result;
    var cls = 'draft-form__dot draft-form__dot--' +
      (result === 'W' ? 'win' : result === 'L' ? 'loss' : result === 'D' ? 'draw' : 'nc');

    var detail = formatFormDetail(r);
    var detailAttr = detail ? ' data-detail="' + escapeHtml(detail) + '"' : '';
    dots += '<span class="' + cls + '" aria-label="' + escapeHtml(result) +
            '"' + detailAttr + '></span>';
  });
  return '<span class="draft-form" title="Recent form (newest left)">' + dots + '</span>';
}

// Build the hover-popover text for one recentResults entry. Returns
// something like "Win vs Pereira · Mar 14 · 28.5 pts" — opponent piece
// gets dropped if we can't resolve the id, date drops if missing. Score
// always shows when the entry has it because the FV math relies on it.
function formatFormDetail(entry) {
  if (typeof entry === 'string') return null; // legacy shape, no detail
  if (!entry) return null;

  var resultLabel = entry.result === 'W' ? 'Win'
                  : entry.result === 'L' ? 'Loss'
                  : entry.result === 'D' ? 'Draw'
                  : 'No contest';

  var opp = '';
  if (entry.opponentId && fighterMap && fighterMap[entry.opponentId]) {
    opp = ' vs ' + fighterMap[entry.opponentId].name;
  }

  var dateStr = '';
  if (entry.date) {
    var d = new Date(entry.date);
    if (!isNaN(d.getTime())) {
      dateStr = ' · ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
    }
  }

  var scoreStr = '';
  if (typeof entry.score === 'number' && !isNaN(entry.score)) {
    scoreStr = ' · ' + entry.score.toFixed(1) + ' pts';
  }

  return resultLabel + opp + dateStr + scoreStr;
}

// Core value-tier evaluator — given a fighter and the slot we're comparing
// them against, returns { label, tone } or null. Shared by:
//   * the pool/modal rows (compared against the CURRENT slot)
//   * the draft board cells (compared against the slot the fighter was
//     actually drafted at — i.e., retrospective verdict on the pick)
//
// Thresholds intentionally generous so the badges actually show up in
// pilot-scale leagues. STEAL fires when a fighter's FV rank is at least
// 10 slots better than the comparison slot, VALUE at 5+, REACH at 12+
// worse. With a 120-pick draft and ~200 FV-ranked fighters, this should
// give 3-6 badges visible at any moment instead of "basically never."
function _valueBadgeFor(fighter, pickNum) {
  if (!pickNum) return null;
  if (typeof FantasyValue === 'undefined' || !FantasyValue.rankFor) return null;
  var info = FantasyValue.rankFor(fighter.id);
  if (!info || !info.rank) return null;
  // delta < 0 = fighter ranks higher than the slot (a bargain)
  // delta > 0 = fighter ranks below the slot (overpay)
  var delta = info.rank - pickNum;
  if (delta <= -10) return { label: 'STEAL', tone: 'steal' };
  if (delta <=  -5) return { label: 'VALUE', tone: 'value' };
  if (delta >=  12) return { label: 'REACH', tone: 'reach' };
  return null;
}

// Pool-row badge — only meaningful for undrafted fighters during a live
// draft. Compares each fighter's FV rank to where we are NOW in the draft.
function valuePickBadge(fighter) {
  if (picks.some(function(p) { return p.fighter_id === fighter.id; })) return null;
  if (!league || !league.draft_started) return null;
  var totalPicks = getTotalPicks();
  if (picks.length >= totalPicks) return null;
  return _valueBadgeFor(fighter, getCurrentPickNum());
}

// Board-cell badge — retrospective verdict on an already-made pick.
// Compares the fighter's FV rank to the actual slot they were taken at.
// No live-draft guards needed since picks always have a slot.
function valuePickBadgeForPick(fighter, pickSlot) {
  return _valueBadgeFor(fighter, pickSlot);
}

// STEAL / VALUE / REACH chips were judging picks against FV rank, which
// felt noisy mid-draft and arbitrary post-draft. Both helpers now return
// empty so no badge ever renders. The underlying _valueBadgeFor logic is
// kept above in case we want to surface this signal elsewhere later.
function valuePickBadgeHtml(/* fighter */) {
  return '';
}

function valuePickBadgeForPickHtml(/* fighter, pickSlot */) {
  return '';
}

// Render the "league-rank | FV-score | FV" chip shown on each row.
// Same markup the lineup page uses (lineup-roster-row__fv classes) so the
// styling is shared and the draft inherits any future tweaks automatically.
// Returns '' until FantasyValue resolves — the draft kicks off a re-render
// when it does, so rows quietly fill in the chip then.
function fighterFvChip(fighter) {
  if (typeof FantasyValue === 'undefined' || !FantasyValue.scoreFor) return '';
  var fvScore = FantasyValue.scoreFor(fighter.id);
  if (typeof fvScore !== 'number') return '';
  var fvRankInfo = FantasyValue.rankFor && FantasyValue.rankFor(fighter.id);
  var rankStr    = (fvRankInfo && fvRankInfo.rank) ? '#' + fvRankInfo.rank : '—';
  return (
    '<span class="lineup-roster-row__fv" title="League rank · Fantasy Value score">' +
      '<span class="lineup-roster-row__fv-rank">' + escapeHtml(rankStr) + '</span>' +
      '<span class="lineup-roster-row__fv-divider" aria-hidden="true"></span>' +
      '<span class="lineup-roster-row__fv-val">' + fvScore.toFixed(1) + '</span>' +
      '<span class="lineup-roster-row__fv-label">FV</span>' +
    '</span>'
  );
}

// ========================================================================
// TEAM ACCENT COLORS
// Up to 8 managers per league, each gets a deterministic palette slot
// (tokens.css var(--team-1) through var(--team-8)). Assignment is by
// position in league.draft_order so it stays stable across re-renders.
// ========================================================================
function teamColor(memberId) {
  if (!league || !league.draft_order) return 'var(--border-strong)';
  const idx = league.draft_order.indexOf(memberId);
  if (idx < 0) return 'var(--border-strong)';
  // 1-indexed to match the token names; modulo so 9th+ wrap (shouldn't happen
  // at 8-manager cap, but defensive).
  return 'var(--team-' + ((idx % 8) + 1) + ')';
}

// ========================================================================
// MODULE-LEVEL STATE
// All rendering functions read from these variables rather than taking
// arguments, so any function can trigger a full re-render after a pick.
// ========================================================================
let user, leagueId, league, members, memberMap, myMemberId;
let allFighters, fighterMap;
let picks = [];
let divisionFilter = 'all';
let statusFilter   = 'all';
let sortBy         = 'fantasy_value';
let searchQuery = '';
let picking = false; // blocks a second pick while a request is in flight
let pickTimerInterval = null; // setInterval handle for the countdown

// Personal pre-draft queue — array of { fighter_id, position } sorted by
// position ascending. Auto-cleaned by a Postgres trigger when a fighter
// is drafted; we mirror that with a realtime subscription so the local
// state stays in sync without a manual refetch.
let queue = [];

// Pick-clock fallback anchor. Set to Date.now() whenever a new pick lands
// (locally via makePick or remotely via handleNewPick). Used as a backup
// when the latest pick's server-side created_at isn't available — e.g. the
// draft_picks schema doesn't have a created_at column, or the realtime
// payload arrived without one. Without this, the timer would freeze on
// the previous anchor and never reset between picks.
let pickClockResetAt = null;

// View All modal — independent filter / sort state so the modal can be
// browsed without disturbing the side panel's controls.
let viewAllSearch   = '';
let viewAllSort     = 'fantasy_value';
let viewAllDivision = 'all';
let viewAllStatus   = 'all';

// Next-fight lookup: fighter_id → { event_date, opponent_name, ... }.
// Populated asynchronously after the initial render; missing entries just
// mean "no upcoming fight booked" and the row renders without the line.
let fighterNextFight = {};

// Set of league_member_ids currently connected to the presence channel
// for this draft. Used to render a green/gray status dot next to each
// manager on the board. Empty until the presence channel syncs.
let presentMemberIds = new Set();
let presenceChannel  = null;

// Pick reactions: { pickId: { emoji: { userIds: Set, myReactionId: string|null } } }
// Mirrors the draft_pick_reactions table. The board render reads this to
// show count badges; the click handler reads it to decide insert vs delete.
let pickReactions        = {};
let pickReactionsLoaded  = false;
// Disable the entire reactions UI when the load fails (most likely cause:
// migration 004 hasn't been applied to this Supabase project yet). Lets
// the rest of the draft surface render cleanly without flickering chips
// that try to insert and immediately roll back on a missing-table error.
let pickReactionsEnabled = true;

// Fresh-add marker — "<pickId>:<emoji>" strings that should pop briefly on
// the next render. Cleared automatically ~500ms after marking. Lets us run
// the celebrate animation ONLY on actually-new chips, not every render
// (which fires on every pick + every other reaction change).
let freshReactionKeys = new Set();
function _markFreshReaction(pickId, emoji) {
  var key = pickId + ':' + emoji;
  freshReactionKeys.add(key);
  setTimeout(function() { freshReactionKeys.delete(key); }, 500);
}

// Supported reactions — keep the set small so the UI doesn't bloat. ESPN /
// Yahoo top out around 4-6; we go with 4 that have natural meanings in
// draft context: 🔥 hype / 👀 watching / 😱 shock / 💀 brutal pick.
const PICK_REACTION_EMOJIS = ['🔥', '👀', '😱', '💀'];

// Auto-draft toggle. When true, this client auto-picks the moment it
// becomes the user's turn (no waiting for the clock). Independent from
// the clock-expiry auto-pick, which fires for any picker regardless of
// this toggle. Persisted per league so a user can have it on in one
// league and off in another.
let autoDraftOn = false;
// Pending timer handle for maybeAutoPickNow's deferred autoPick call.
// Used to dedup multiple invocations in the same render cycle — e.g.,
// makePick fires it after a successful pick AND realtime broadcasts
// the same pick a moment later. Without this guard, both paths would
// schedule their own setTimeouts and the second autoPick attempt would
// be wasted (or worse, race the first).
let autoPickTimer = null;

// Mock-draft mode. Activated by ?mock=1 in the URL. In this mode:
//   * Picks live in memory only — no Supabase writes, no realtime.
//   * Every non-user manager is on auto-pick, simulated with a short
//     delay so the user can watch the board fill out.
//   * Commish controls / presence / reactions / activity feed are
//     suppressed since they're meaningless single-player.
// Treated as read-once at init; mutations to URL afterward are ignored.
const isMockMode = new URLSearchParams(window.location.search).get('mock') === '1';
// Counter for synthetic pick ids in mock mode. Real draft uses Postgres
// UUIDs; here we just need uniqueness inside one mock session.
let mockPickIdCounter = 0;
// Timer handle for the next scheduled AI pick. Cleared on user pick so
// we don't double-schedule across renders.
let mockAiTimer = null;
// Manual gate — the mock doesn't pick anything (AI or user) until the
// user clicks "Start mock." Lets them prep their queue first.
let mockStarted = false;

// Sound trigger state. Transition trackers so each sound fires once per
// state change, not every render or every timer tick.
//   wasMyTurn:     last-render value of isMyTurn(); flips false→true plays the
//                  "your turn" chime.
//   lastClockBand: last clock-urgency level we played a sound for. Bands
//                  are 'none' / 'warn' (≤30s) / 'urgent' (≤10s) / 'expired'
//                  (=0). Stays sticky so repeat ticks in the same band
//                  don't re-play.
//   draftDoneSounded: one-shot so the completion sound only plays once.
let wasMyTurn        = false;
let lastClockBand    = 'none';
let draftDoneSounded = false;

// Pick-reveal animation state.
//   initialPicksLoaded: false until the first renderAll() finishes during
//     initDraft, so the initial board paint doesn't animate every existing
//     pick like it just landed.
//   lastAnimatedPickId: dedup so the same pick doesn't trigger the reveal
//     twice (own picks land via makePick AND realtime broadcast).
let initialPicksLoaded   = false;
let lastAnimatedPickId   = null;

// Fetch every fighter row, paginating in 1000-row batches. Supabase's
// default 1000-row cap silently truncates larger SELECTs — the fighters
// table has 6k+ rows, so an unpaginated query was dropping unranked
// fighters (e.g., Bo Nickal) from the draft pool entirely. Same pattern
// waivers.js uses for fight_results.
async function fetchAllFighters() {
  var FIGHTER_COLS = 'id, name, primary_division, current_rank, is_champion, ' +
    'is_sub_champion, sub_title_type, record_wins, record_losses, record_draws, ' +
    'photo_url, country';
  var all  = [];
  var PAGE = 1000;
  var from = 0;
  while (true) {
    var res = await supabaseClient
      .from('fighters')
      .select(FIGHTER_COLS)
      .order('is_champion', { ascending: false })
      .order('current_rank', { nullsFirst: false })
      .range(from, from + PAGE - 1);
    if (res.error || !res.data) break;
    all = all.concat(res.data);
    if (res.data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// ========================================================================
// INIT
// Loads all required data in parallel, then renders and subscribes.
// ========================================================================
async function initDraft() {
  user = await requireAuth();
  if (!user) return;

  leagueId = new URLSearchParams(window.location.search).get('id');
  if (!leagueId) { window.location.href = 'dashboard.html'; return; }

  // Set back link before data arrives so it's ready immediately
  document.getElementById('leagueLink').href = 'league.html?id=' + leagueId;

  // Load all four data sets at the same time to minimise wait.
  // Picks come from `draft_picks` (immutable history), NOT from `rosters` —
  // rosters mutate after the draft ends (trades, drops) and would create
  // gaps on the board. See migrations/003_draft_picks.sql.
  const [leagueRes, membersRes, fightersRes, picksRes] = await Promise.all([
    supabaseClient
      .from('leagues')
      .select('id, name, draft_order, draft_started, draft_completed, draft_started_at, draft_scheduled_at, draft_paused_at, commissioner_id, roster_size, max_managers, pick_timer_seconds, scoring_config')
      .eq('id', leagueId)
      .single(),
    supabaseClient
      .from('league_members')
      .select('id, user_id, team_name, is_commissioner')
      .eq('league_id', leagueId),
    // Paginated — the fighters table has 6k+ rows and Supabase silently
    // caps unpaginated SELECTs at 1000. Without pagination, only the
    // top-ranked / champion fighters land in allFighters and unranked
    // free agents (like Bo Nickal at middleweight) get dropped from
    // search results. See fetchAllFighters() below.
    fetchAllFighters(),
    supabaseClient
      .from('draft_picks')
      .select('*')
      .eq('league_id', leagueId)
      .order('draft_pick')
  ]);

  if (leagueRes.error || !leagueRes.data) {
    window.location.href = 'dashboard.html';
    return;
  }

  league   = leagueRes.data;
  members  = membersRes.data  || [];
  allFighters = fightersRes || [];
  picks    = picksRes.data    || [];

  // Wire the shared "? How it works" modal now that we have the league
  // row. The trigger button is already in the DOM (top-nav); install()
  // registers the content + attaches the click handler. We pass the
  // league row we already loaded so league-primer doesn't re-fetch.
  if (typeof LeaguePrimer !== 'undefined') {
    LeaguePrimer.install(league);
  }

  // Build the member-id lookup map up front; the lobby and live-draft views
  // both need it (lobby uses it to label the draft order list).
  memberMap = {};
  members.forEach(function(m) { memberMap[m.id] = m; });

  // Verify the current user is a member of this league before showing
  // anything (lobby or live). RLS on league_members already gates this on
  // the server, but the client check gives a cleaner UX (redirect vs error).
  const myMember = members.find(function(m) { return m.user_id === user.id; });
  if (!myMember) { window.location.href = 'dashboard.html'; return; }
  myMemberId = myMember.id;

  // ---- Mock-draft bootstrap ------------------------------------------
  // Treat the room as live-in-progress, but rooted in the user's actual
  // league (so member names, team colors, FV scoring, and roster_size
  // all match what the real draft will use). Picks start empty regardless
  // of any real-draft state. Realtime subscriptions and DB writes are
  // skipped further down via isMockMode guards.
  if (isMockMode) {
    league.draft_started   = true;
    league.draft_completed = false;
    league.draft_paused_at = null;
    // Generate a draft order if the league doesn't have one yet — random
    // shuffle of all members so the user gets a realistic snake. If the
    // commissioner has already set an order, we honor it so the mock
    // mirrors what the real draft will look like.
    if (!league.draft_order || league.draft_order.length === 0) {
      league.draft_order = members.map(function(m) { return m.id; }).sort(function() { return Math.random() - 0.5; });
    }
    // Wipe any real picks — mock is always a clean board.
    picks = [];
  }

  // No live draft AND no schedule → nothing to render here, bounce back.
  // Mock mode forces draft_started above so this guard is naturally
  // satisfied for mocks.
  if (!league.draft_started && !league.draft_scheduled_at) {
    window.location.href = 'league.html?id=' + leagueId;
    return;
  }

  // Both pre-draft (scheduled) and live-draft states share the same panels:
  // the fighter pool, the draft board (with empty slots pre-draft), and the
  // user's queue + roster. The only differences are (a) the status bar
  // header text, (b) whether picks can actually be made, and (c) whether
  // we listen for incoming picks vs the start flip.
  fighterMap = {};
  allFighters.forEach(function(f) { fighterMap[f.id] = f; });

  // Populate the division filter dropdown before first render
  populateDivisionFilter();

  // Load the user's draft queue (private — RLS limits this to their own rows).
  // Awaited so the first render shows the queue panel populated.
  await loadQueue();

  // Kick off the fantasy-value / points-map load in the background. Same
  // module the waivers page uses — gives us per-fighter avgPts / totalPts /
  // recentPts and a composite FV score so the draft pool can sort on the
  // same options as free agency. Cached at the module level, so if the
  // user just came from waivers this resolves instantly. Once it arrives
  // we re-render the pool (and the View All modal if it's open) so the
  // new sort metrics actually show.
  if (typeof FantasyValue !== 'undefined') {
    FantasyValue.ensureLoaded(leagueId, league.scoring_config).then(function() {
      renderFighterPool();
      renderBestAvailable();
      if (document.getElementById('viewAllOverlay')) renderViewAllList();
    }).catch(function() { /* ignore — sorts fall back to rank */ });
  }

  // Next-fight lookup — same NextFight module the waivers/lineup pages use.
  // Loaded in the background so first paint isn't blocked. When it arrives
  // we re-render so the "Fights MMM DD vs Opponent" line appears under each
  // row. Missing fighters (no upcoming fight) render normally without it.
  if (typeof NextFight !== 'undefined') {
    var fighterIds = allFighters.map(function(f) { return f.id; });
    NextFight.loadNextFights(fighterIds).then(function(map) {
      fighterNextFight = map || {};
      renderFighterPool();
      if (document.getElementById('viewAllOverlay')) renderViewAllList();
    }).catch(function() { /* ignore — rows just skip the next-fight line */ });
  }

  // Install the form-sparkline hover popover (body-level so it isn't
  // clipped by the pool's overflow:auto). Idempotent / one-time setup.
  setupFormDotHover();

  // Row preview card — same delayed-hover pattern, richer content.
  setupRowPreviewHover();

  // Fullscreen draft mode — restores prior choice from localStorage so
  // returning users land in the mode they left in. Wires the toggle button,
  // floating exit button, and Esc key listener.
  setupFullscreenMode();

  // Pre-draft lobby "Enter draft room" / "Show lobby" toggle. Lets users
  // peek into the room before draft starts (queue fighters, browse pool,
  // etc.) without dismissing the lobby state permanently.
  setupLobbyEnterButton();

  // Auto-draft toggle — wires the button, restores localStorage state,
  // and fires maybeAutoPickNow() on flip-on so the user doesn't have to
  // wait for an external event to trigger the first auto-pick.
  setupAutoDraftToggle();

  // Draft sound effects — wire the mute toggle. The sound module itself
  // is autoplay-policy-aware; first audible play requires a user click,
  // which the act of clicking around the draft naturally provides.
  setupSoundToggle();

  // Reveal the MOCK badge and Restart button when we're in mock mode.
  // No-op in real draft.
  setupMockChrome();

  // Render all three panels. Pre-draft this still works: the board shows
  // empty slots labelled with manager names, the fighter pool shows every
  // fighter as available (no picks yet), and My Roster is empty.
  renderAll();
  // Flip the flag AFTER the first render so subsequent renders (from new
  // picks landing) can fire the reveal animation. The initial paint shouldn't
  // animate the entire existing board.
  initialPicksLoaded = true;

  // Pre-draft we only watch the leagues row (for the start flip + schedule
  // changes) and the personal queue. Live draft additionally subscribes to
  // incoming picks. Splitting these means we don't open a picks channel
  // for nothing during the lobby phase.
  // Mock mode: zero subscriptions. Mock is single-player, in-memory, no
  // realtime, no presence, no reactions. We DO load the queue (so the
  // user's saved queue powers their own auto-pick during mock too).
  subscribeToQueue();
  if (!isMockMode) {
    if (league.draft_started) {
      subscribeToRealtime();
      // Watch the leagues row in live draft too, so all clients see pause /
      // resume / commish-revert state changes in real time. (Pre-draft uses
      // subscribeToLobbyFlip for the start flip.)
      subscribeToLeagueChanges();
      // Reactions only apply to picks that exist, so load + subscribe in
      // live-draft mode. Migration 004 is required; loadPickReactions
      // fails soft if the table doesn't exist yet.
      loadPickReactions().then(function() { renderDraftBoard(); });
      subscribeToReactions();
    } else {
      subscribeToLobbyFlip();
      startPredraftCountdown();
    }
    // Presence channel runs in both pre-draft and live-draft phases — the
    // lobby benefits from seeing who's already arrived just as much as the
    // live room benefits from seeing who's still connected.
    subscribeToPresence();
  }

  // Commissioner-only toolbar: reveal the Pause / Undo / Clear buttons if
  // the viewer is the commish (primary or co-) and the draft has actually
  // started. Pre-draft these actions don't make sense (nothing to pause /
  // undo / clear yet). Hidden in mock mode — they would mutate real DB.
  if (!isMockMode && league.draft_started && isCommish()) {
    initCommishTools();
  }

  // Final check: if it's already our turn on page load AND auto-draft was
  // previously enabled (restored above from localStorage), fire the pick.
  maybeAutoPickNow();

  // Kick off the mock AI loop. If pick #1 belongs to an AI, this schedules
  // it; if it belongs to the user, this is a no-op until they pick.
  if (isMockMode) maybeScheduleNextAiPick();

  // One delegated listener: any element with data-open-fighter opens the
  // fighter modal regardless of which renderer emitted it. Avoids re-wiring
  // after every realtime pick re-render.
  document.addEventListener('click', function(e) {
    // Reactions take priority — they're nested inside the pick cell, which
    // ALSO has data-open-fighter on its inner button. Without this branch,
    // clicking a reaction would open the fighter modal too.
    var reactBtn = e.target.closest('[data-emoji][data-pick-id]');
    if (reactBtn) {
      e.preventDefault();
      e.stopPropagation();
      togglePickReaction(
        reactBtn.getAttribute('data-pick-id'),
        reactBtn.getAttribute('data-emoji')
      );
      return;
    }
    var trigger = e.target.closest('[data-open-fighter]');
    if (!trigger) return;
    if (typeof showFighterModal === 'function') {
      showFighterModal(trigger.getAttribute('data-open-fighter'));
    }
  });

  // Same pattern for team-roster headers — clicking any column header on
  // the draft board opens that team's roster in the whole-roster modal.
  document.addEventListener('click', function(e) {
    var trigger = e.target.closest('[data-open-team-roster]');
    if (!trigger) return;
    showWholeRosterModal(trigger.getAttribute('data-open-team-roster'));
  });

  // Delegated listener for the fighter-modal Draft button. The modal lives
  // outside our normal render tree, so per-render wiring won't catch it —
  // a delegated handler at document level does.
  document.addEventListener('click', function(e) {
    var trigger = e.target.closest('[data-draft-fighter]');
    if (!trigger) return;
    var fighter = fighterMap[trigger.getAttribute('data-draft-fighter')];
    if (!fighter) return;

    // Validate up front so we can give a clear message instead of a silent
    // no-op from inside makePick.
    if (!league.draft_started) {
      alert("The draft hasn't started yet.");
      return;
    }
    if (!isMyTurn()) {
      alert("It's not your pick yet.");
      return;
    }
    if (!canPick(fighter, getMyPickFighters())) {
      alert('No valid roster slot for this fighter.');
      return;
    }
    makePick(fighter);
    if (typeof closeFighterModal === 'function') closeFighterModal();
  });

  // View All button — opens the fullscreen browse modal
  var viewAllBtn = document.getElementById('viewAllBtn');
  if (viewAllBtn) viewAllBtn.addEventListener('click', openViewAll);

  // Whole Roster button — opens the sectioned roster modal for the current
  // user. Wrap the call so the click event isn't passed as the memberId
  // argument; otherwise showWholeRosterModal treats the event object as a
  // truthy member id, can't find it in memberMap, and silently no-ops.
  var viewWholeRosterBtn = document.getElementById('viewWholeRosterBtn');
  if (viewWholeRosterBtn) viewWholeRosterBtn.addEventListener('click', function() {
    showWholeRosterModal();
  });

  // Reveal the page now that everything is ready
  // Clear the inline display:none so CSS's display:flex takes over.
  // Setting 'block' instead would override the flex container and cause
  // .draft-room (flex:1 1 0) to fall back to content-height — which makes
  // the bottom panels collapse to 0 because the board's tall table
  // pushes the room past 100vh.
  document.getElementById('pageContent').style.display = '';
}

// ========================================================================
// SNAKE DRAFT ALGORITHM
// Given a 1-indexed pick number, returns the round and the league_member_id
// of the manager whose turn it is.
// ========================================================================
function getPickInfo(pickNumber) {
  const n = league.draft_order.length;
  const round = Math.ceil(pickNumber / n);
  const posInRound = (pickNumber - 1) % n;
  // Odd rounds go left-to-right, even rounds reverse (snake)
  const index = round % 2 === 1 ? posInRound : n - 1 - posInRound;
  return {
    round: round,
    activeManagerId: league.draft_order[index]
  };
}

function getCurrentPickNum() {
  // Next pick number is always one more than picks made so far
  return picks.length + 1;
}

function getTotalPicks() {
  return league.draft_order.length * league.roster_size;
}

function isMyTurn() {
  if (!league.draft_started || league.draft_completed) return false;
  if (picks.length >= getTotalPicks()) return false;
  return getPickInfo(getCurrentPickNum()).activeManagerId === myMemberId;
}

// ========================================================================
// ROSTER SLOT VALIDATION
// Returns true if the fighter can legally be added to the manager's roster
// given the current picks. Mirrors checkRosterConstruction() in waivers.js
// (the canonical implementation) so the draft enforces identical rules:
//   - 8 men's divisions, ROSTER_SLOTS_PER_DIVISION each
//   - 1 Women's Flex slot pooled across all 3 women's divisions
//   - ROSTER_FLEX_SLOTS any-division flex slots (overflow bucket)
//   - Base total: ROSTER_SIZE_BASE (8 + 1 + 6 = 15 today)
// ========================================================================
function canPick(fighter, currentPickFighters) {
  // Per-division tallies + a separate women's-pool count, same shape as
  // checkRosterConstruction(). Women's fighters never get their own slot —
  // they share the Women's Flex.
  const divCounts   = {};
  let   womensTotal = 0;
  currentPickFighters.forEach(function(f) {
    divCounts[f.primary_division] = (divCounts[f.primary_division] || 0) + 1;
    if (WOMENS_DIVISIONS_KEYS.indexOf(f.primary_division) !== -1) womensTotal++;
  });

  // Count any-flex overflow from men's divisions only (women's are pooled).
  let flexUsed = 0;
  Object.keys(divCounts).forEach(function(div) {
    if (WOMENS_DIVISIONS_KEYS.indexOf(div) !== -1) return;
    flexUsed += Math.max(0, divCounts[div] - ROSTER_SLOTS_PER_DIVISION);
  });
  // ...plus women's overflow beyond the single Women's Flex slot
  flexUsed += Math.max(0, womensTotal - ROSTER_WOMENS_FLEX_SLOTS);

  const isWomens     = WOMENS_DIVISIONS_KEYS.indexOf(fighter.primary_division) !== -1;
  const anyFlexCap   = getAnyFlexSlots(league);
  const divHasRoom   = isWomens
    ? womensTotal < ROSTER_WOMENS_FLEX_SLOTS
    : (divCounts[fighter.primary_division] || 0) < ROSTER_SLOTS_PER_DIVISION;
  const flexHasRoom  = flexUsed < anyFlexCap;
  return divHasRoom || flexHasRoom;
}

// ========================================================================
// MAKE A PICK
// Inserts the pick into the rosters table. The Realtime event fires and
// updates all connected clients including the picker's own screen.
// ========================================================================
// ========================================================================
// AUTO-PICK
// Pick selection used by both (a) clock-expiry auto-pick and (b) the
// per-user auto-draft toggle. Strategy:
//   1. Walk the personal queue in order — first entry that still exists
//      AND isn't already drafted AND fits roster construction.
//   2. Fall back to highest-FV undrafted fighter who fits.
//   3. Last resort (queue empty + FV cache missing): any undrafted
//      fighter who fits.
// Always returns a legal pick (canPick=true) or null.
// ========================================================================
function selectAutoPickFighter() {
  if (!isMyTurn()) return null;

  var myFighters = getMyPickFighters();
  var pickedIds  = new Set(picks.map(function(p) { return p.fighter_id; }));

  // 1) Queue first — user's explicit preferences trump FV.
  for (var i = 0; i < queue.length; i++) {
    var qf = fighterMap[queue[i].fighter_id];
    if (!qf) continue;
    if (pickedIds.has(qf.id)) continue;
    if (!canPick(qf, myFighters)) continue;
    return qf;
  }

  // 2) Highest FV who fits. Build a sorted list once; walk until we find
  //    a legal pick. canPick gating handles "no slot" cases (e.g., my
  //    flyweight slot is full and I'd overflow flex with another flyweight).
  if (typeof FantasyValue !== 'undefined' && FantasyValue.scoreFor) {
    var scored = [];
    for (var j = 0; j < allFighters.length; j++) {
      var f  = allFighters[j];
      if (pickedIds.has(f.id)) continue;
      var fv = FantasyValue.scoreFor(f.id);
      if (typeof fv !== 'number') continue;
      scored.push({ f: f, fv: fv });
    }
    scored.sort(function(a, b) { return b.fv - a.fv; });
    for (var k = 0; k < scored.length; k++) {
      if (canPick(scored[k].f, myFighters)) return scored[k].f;
    }
  }

  // 3) Last resort — any undrafted fighter who fits. Mostly for the case
  //    where the user needs a slot fillable only by an FV-less new signee.
  for (var m = 0; m < allFighters.length; m++) {
    var any = allFighters[m];
    if (pickedIds.has(any.id)) continue;
    if (canPick(any, myFighters)) return any;
  }
  return null;
}

// One-shot auto-pick action. Re-runs the turn / pause / picking guards
// inside makePick, so this is safe to call from multiple paths (timer
// expiry, auto-draft toggle, turn-just-became-mine on realtime).
async function autoPick() {
  if (!isMyTurn() || picking) return;
  if (league && league.draft_paused_at) return;
  var pick = selectAutoPickFighter();
  if (!pick) {
    console.warn('[autopick] could not find a legal fighter to auto-pick');
    return;
  }
  await makePick(pick);
}

// Called from any path that might transition into "it's now my turn" —
// init, handleNewPick, handlePickDelete, auto-draft toggle flip. Fires
// the auto-pick after a short delay so the user sees their turn arrive
// before the pick lands (and renderAll finishes first).
function maybeAutoPickNow() {
  // Idempotent — if a deferred autoPick is already pending, do nothing.
  // Multiple call sites (makePick success path, handleNewPick, toggle-on,
  // init) can all hit this in quick succession; without the guard we'd
  // schedule overlapping setTimeouts and risk racing autoPick attempts.
  if (autoPickTimer != null) return;
  if (!autoDraftOn) return;
  if (!isMyTurn() || picking) return;
  if (league && league.draft_paused_at) return;

  autoPickTimer = setTimeout(function() {
    autoPickTimer = null;
    // Re-check inside the timeout — state may have flipped during the
    // delay (someone else picked, draft paused, user toggled off, etc).
    if (autoDraftOn && isMyTurn() && !picking && !(league && league.draft_paused_at)) {
      autoPick();
    }
  }, 600);
}

// ========================================================================
// MOCK DRAFT
// Single-player practice mode (?mock=1). Picks live in memory; non-user
// managers auto-pick best-available FV. The user picks via the normal
// click handlers — makePick branches on isMockMode and short-circuits
// the DB / realtime path. The AI loop schedules itself recursively after
// every pick (user or AI) and stops once it lands on the user OR the
// draft completes.
// ========================================================================

// Variant of selectAutoPickFighter that picks for ANY manager (not just
// the viewer). Uses the same canPick + FV-best logic minus the queue
// (only the viewer has a queue in mock mode).
function selectAutoPickFighterFor(memberId) {
  var theirFighters = picks
    .filter(function(p) { return p.league_member_id === memberId; })
    .map(function(p) { return fighterMap[p.fighter_id]; })
    .filter(Boolean);

  var pickedIds = new Set(picks.map(function(p) { return p.fighter_id; }));

  // 1) Highest FV who fits this manager's roster construction.
  if (typeof FantasyValue !== 'undefined' && FantasyValue.scoreFor) {
    var scored = [];
    for (var j = 0; j < allFighters.length; j++) {
      var f = allFighters[j];
      if (pickedIds.has(f.id)) continue;
      var fv = FantasyValue.scoreFor(f.id);
      if (typeof fv !== 'number') continue;
      scored.push({ f: f, fv: fv });
    }
    scored.sort(function(a, b) { return b.fv - a.fv; });
    for (var k = 0; k < scored.length; k++) {
      if (canPick(scored[k].f, theirFighters)) return scored[k].f;
    }
  }

  // 2) Last resort — any legal fighter regardless of FV (handles FV-less
  //    fighters in case the cache is incomplete).
  for (var m = 0; m < allFighters.length; m++) {
    var any = allFighters[m];
    if (pickedIds.has(any.id)) continue;
    if (canPick(any, theirFighters)) return any;
  }
  return null;
}

// Insert a pick into the in-memory state without touching the DB. Used
// for both user and AI picks in mock mode. Mirrors what makePick's
// success path does in the real draft (sort by slot, anchor clock,
// renderAll, animate, check for completion).
function mockInsertPick(memberId, fighter) {
  var pickNum  = getCurrentPickNum();
  var round    = getPickInfo(pickNum).round;
  mockPickIdCounter += 1;
  var pick = {
    id:               'mock_' + mockPickIdCounter,
    league_id:        leagueId,
    league_member_id: memberId,
    fighter_id:       fighter.id,
    draft_round:      round,
    draft_pick:       pickNum,
    created_at:       new Date().toISOString()
  };
  picks.push(pick);
  picks.sort(function(a, b) { return a.draft_pick - b.draft_pick; });
  pickClockResetAt = Date.now();
  renderAll();
  animatePickReveal(pick);
  if (picks.length >= getTotalPicks()) {
    handleDraftComplete();
  } else {
    // Mock mode kicks both schedulers: the AI loop for non-user picks,
    // AND the auto-draft loop for user picks. maybeScheduleNextAiPick
    // bails when the next slot is the user's; maybeAutoPickNow bails
    // when it isn't OR when auto-draft is off. Calling both is safe
    // and handles back-to-back user picks at snake reversals.
    maybeScheduleNextAiPick();
    maybeAutoPickNow();
  }
}

// If the next pick belongs to an AI manager, schedule it with a small
// random delay (600-1500ms) so the user can watch the board progress.
// No-op if the next pick is the user's, the draft is complete, or we're
// not in mock mode. Always clears any previously-scheduled timer so we
// don't double-fire across renders.
function maybeScheduleNextAiPick() {
  if (mockAiTimer) { clearTimeout(mockAiTimer); mockAiTimer = null; }
  if (!isMockMode) return;
  // Manual-start gate — no AI activity until the user clicks Start mock.
  if (!mockStarted) return;
  if (picks.length >= getTotalPicks()) return;

  var pickNum = getCurrentPickNum();
  var activeManagerId = getPickInfo(pickNum).activeManagerId;
  if (activeManagerId === myMemberId) return;  // user's turn — wait for click

  var delayMs = 600 + Math.random() * 900;
  mockAiTimer = setTimeout(function() {
    mockAiTimer = null;
    // Re-check the active picker — between schedule and fire, the user
    // could have hit "Reset" or navigated away.
    if (!isMockMode) return;
    if (picks.length >= getTotalPicks()) return;
    if (getCurrentPickNum() !== pickNum) return;  // shouldn't happen, defensive
    var fighter = selectAutoPickFighterFor(activeManagerId);
    if (!fighter) {
      console.warn('[mock] no legal pick found for manager', activeManagerId);
      return;
    }
    mockInsertPick(activeManagerId, fighter);
  }, delayMs);
}

async function makePick(fighter) {
  if (!isMyTurn() || picking) return;

  // Picks are blocked while the commissioner has paused the draft.
  // Surface this so the user gets feedback instead of a silent no-op.
  if (league.draft_paused_at) {
    alert('The draft is paused. Wait for the commissioner to resume.');
    return;
  }

  const myPickFighters = getMyPickFighters();
  if (!canPick(fighter, myPickFighters)) return;

  // ---- Mock mode short-circuit ----------------------------------------
  // No DB, no realtime, no safety timeout — pick is applied to local
  // state immediately and the AI loop kicks off the next non-user pick.
  // Picks are blocked entirely until the user clicks Start mock so the
  // "ready to start" banner can't be bypassed by clicking a fighter.
  if (isMockMode) {
    if (!mockStarted) return;
    mockInsertPick(myMemberId, fighter);
    return;
  }

  // Lock immediately to prevent double-pick while the INSERT is in flight
  picking = true;
  renderFighterPool();

  // Safety net: handleNewPick is what's normally responsible for releasing
  // the lock (it fires off the realtime draft_picks INSERT). If realtime
  // hiccups — channel drops, RLS blocks the select-back, trigger fails —
  // the lock would stay true forever and EVERY future pick attempt would
  // silently bail with no error. After 5s, refetch picks from the DB and
  // resync. If our pick is in there, accept it. If not, release the lock
  // so the user can try again.
  const safetyTimeout = setTimeout(async function() {
    if (!picking) return;  // already cleared by handleNewPick — nothing to do
    console.warn('[draft] pick lock held >5s, resyncing from DB');
    const { data: freshPicks } = await supabaseClient
      .from('draft_picks')
      .select('*')
      .eq('league_id', leagueId)
      .order('draft_pick');
    if (freshPicks) picks = freshPicks;
    picking = false;
    renderAll();
  }, 5000);

  const pickNum = getCurrentPickNum();
  const { round } = getPickInfo(pickNum);

  const { error } = await supabaseClient
    .from('rosters')
    .insert({
      league_member_id: myMemberId,
      league_id:        leagueId,
      fighter_id:       fighter.id,
      acquired_method:  'draft',
      draft_round:      round,
      draft_pick:       pickNum
    });

  if (error) {
    clearTimeout(safetyTimeout);
    console.error('Pick failed:', error.message);
    picking = false;

    // Resync from the DB. We use SELECT * so this works regardless of which
    // optional columns the draft_picks table happens to have — earlier we
    // hit 400s by SELECT-ing a column that didn't exist in this league's
    // schema. The renderers only need a few fields (id, fighter_id,
    // league_member_id, draft_pick, draft_round) and ignore the rest.
    const { data: freshPicks } = await supabaseClient
      .from('draft_picks')
      .select('*')
      .eq('league_id', leagueId)
      .order('draft_pick');
    if (freshPicks) picks = freshPicks;

    // Specifically catch the unique-slot violation. This means our local
    // state was stale: someone (probably us, on an earlier attempt where
    // realtime didn't deliver) already picked at this slot. Tell the user
    // what happened so they don't keep clicking the same fighter.
    if (error.code === '23505' || /duplicate key/i.test(error.message)) {
      alert('That pick slot was already taken. The board has been resynced — try again.');
    } else {
      alert('Pick failed: ' + error.message);
    }
    renderAll();
    return;
  }

  // Don't wait for realtime to confirm our own pick — resync from the DB
  // immediately so the board updates right away. Realtime is still the
  // mechanism by which OTHER managers learn about this pick; for the
  // picker themselves it's just a backup. The safety timeout is now
  // mostly a no-op for the picker (we'll have already cleared the lock
  // before it fires), but stays in place for the rare case where this
  // post-insert refetch also fails. Using SELECT * here for the same
  // schema-tolerance reason as the error branch above.
  clearTimeout(safetyTimeout);

  // OPTIMISTIC PLACEHOLDER. Add our just-inserted pick to local state
  // immediately so picks.length advances even if the SELECT below races
  // with Postgres replication lag and returns a stale snapshot that
  // doesn't include the row we just wrote. Without this, the user can
  // click Draft a second time on the same slot before realtime catches up,
  // triggering a 23505 unique-key violation and the misleading "slot
  // already taken" alert. The synthetic id ("__opt_<pickNum>") never
  // collides with a real UUID; the realtime broadcast + handleNewPick's
  // draft_pick dedup will replace it with the real row when it arrives.
  const optimisticPick = {
    id:               '__opt_' + pickNum,
    league_id:        leagueId,
    league_member_id: myMemberId,
    fighter_id:       fighter.id,
    draft_round:      round,
    draft_pick:       pickNum,
    created_at:       new Date().toISOString()
  };
  if (!picks.some(function(p) { return p.draft_pick === pickNum; })) {
    picks.push(optimisticPick);
    picks.sort(function(a, b) { return a.draft_pick - b.draft_pick; });
  }

  const { data: freshPicks } = await supabaseClient
    .from('draft_picks')
    .select('*')
    .eq('league_id', leagueId)
    .order('draft_pick');
  if (freshPicks) {
    // Merge: take everything fresh, but preserve any LOCAL pick (including
    // our optimistic placeholder) whose slot isn't yet reflected in the
    // fresh data. The next SELECT or realtime broadcast will overwrite the
    // placeholder by draft_pick — see handleNewPick.
    const freshSlots = new Set(freshPicks.map(function(p) { return p.draft_pick; }));
    const localOnly  = picks.filter(function(p) { return !freshSlots.has(p.draft_pick); });
    picks = freshPicks.concat(localOnly).sort(function(a, b) { return a.draft_pick - b.draft_pick; });
  }

  // Local pick-clock anchor — the timer should restart on every pick.
  pickClockResetAt = Date.now();
  picking = false;
  renderAll();
  // Reveal animation for the pick we just inserted. Prefer the fresh row
  // (real id, real created_at) if available; otherwise fall back to the
  // optimistic placeholder. Either way animatePickReveal dedups by id so
  // the realtime broadcast won't double-animate.
  var myFreshPick = picks.find(function(p) { return p.draft_pick === pickNum; });
  if (myFreshPick) animatePickReveal(myFreshPick);

  // Activity feed: draft_pick. Captures round + overall so the line reads
  // "Mike drafted Topuria (R3 · #21)". Best-effort — failures are logged
  // inside LeagueActivity, not surfaced to the drafter.
  if (typeof LeagueActivity !== 'undefined') {
    LeagueActivity.logEvent(leagueId, LeagueActivity.KINDS.DRAFT_PICK, {
      fighter_id:    fighter.id,
      fighter_name:  fighter.name,
      round:         round,
      pick_overall:  pickNum
    }, myMemberId);
  }

  if (picks.length >= getTotalPicks()) {
    handleDraftComplete();
  } else {
    // CRITICAL: keep the auto-draft chain alive after our own pick.
    // Without this, the post-INSERT SELECT merge already adds the pick
    // to local state with its real UUID, so when realtime later
    // broadcasts the same pick, handleNewPick's id-dedup short-circuits
    // and never reaches its own maybeAutoPickNow() call. We'd auto-pick
    // once and stall until the user manually toggled auto-draft off+on.
    // The timer guard inside maybeAutoPickNow makes this safe to call
    // here AND from realtime (whichever fires first wins).
    maybeAutoPickNow();
  }
}

// ========================================================================
// PICK REACTIONS
// Slack-style emoji reactions on draft picks. Persistence: see migration
// 004_draft_pick_reactions.sql. Counts roll up live via realtime so a
// reaction added on one client appears on all others within ~100ms.
// ========================================================================

// Internal helper — add a reaction row to local state. Idempotent: a
// duplicate row (same pick + user + emoji) is a no-op. The reaction id
// is recorded only when it's the viewer's own reaction so the toggle
// path knows what to delete without re-querying. Newly-added (transition
// from no count → count) chips are marked fresh so the pop animation
// fires only on actual additions.
function _localAddReaction(row) {
  if (!pickReactions[row.draft_pick_id]) pickReactions[row.draft_pick_id] = {};
  var slot = pickReactions[row.draft_pick_id];
  var wasNew = !slot[row.emoji] || slot[row.emoji].userIds.size === 0;
  if (!slot[row.emoji]) slot[row.emoji] = { userIds: new Set(), myReactionId: null };
  var alreadyHadUser = slot[row.emoji].userIds.has(row.user_id);
  slot[row.emoji].userIds.add(row.user_id);
  if (user && row.user_id === user.id) slot[row.emoji].myReactionId = row.id;
  // Pop only when the chip transitions from "not visible" to "visible" OR
  // when a new user joins an existing chip. Skip idempotent re-adds (the
  // realtime broadcast for our own optimistic add lands here and we don't
  // want a second pop).
  if (wasNew || !alreadyHadUser) _markFreshReaction(row.draft_pick_id, row.emoji);
}

// Remove a reaction row from local state. Tolerates missing entries (the
// row may have already been removed locally by an optimistic delete).
function _localRemoveReaction(row) {
  if (!pickReactions[row.draft_pick_id]) return;
  var slot = pickReactions[row.draft_pick_id][row.emoji];
  if (!slot) return;
  slot.userIds.delete(row.user_id);
  if (user && row.user_id === user.id) slot.myReactionId = null;
  if (slot.userIds.size === 0) delete pickReactions[row.draft_pick_id][row.emoji];
}

async function loadPickReactions() {
  // Pull every reaction in the league in one shot — the dataset is tiny
  // (8 managers × 4 emojis × N picks = at most a few hundred rows per
  // league, even for a fully reacted draft).
  var res = await supabaseClient
    .from('draft_pick_reactions')
    .select('id, draft_pick_id, user_id, emoji')
    .eq('league_id', leagueId);
  if (res.error) {
    // Most likely the migration hasn't been run yet. Disable the entire
    // reactions UI rather than leaving clickable targets that all roll
    // back with "table not found" errors. Visible warning in the console
    // tells the developer to apply migration 004.
    console.warn('[reactions] load failed (migration 004 not applied?):', res.error.message);
    pickReactionsLoaded  = true;  // mark loaded so we don't keep retrying
    pickReactionsEnabled = false; // suppress the UI everywhere
    renderDraftBoard();
    return;
  }
  pickReactions = {};
  (res.data || []).forEach(_localAddReaction);
  pickReactionsLoaded = true;
}

function subscribeToReactions() {
  supabaseClient
    .channel('draft_reactions_' + leagueId)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'draft_pick_reactions',
      filter: 'league_id=eq.' + leagueId
    }, function(payload) {
      if (payload.eventType === 'INSERT') {
        _localAddReaction(payload.new);
      } else if (payload.eventType === 'DELETE') {
        _localRemoveReaction(payload.old);
      }
      renderDraftBoard();
    })
    .subscribe();
}

// Synthetic pick ids assigned by makePick before the real DB row has been
// confirmed back to the client (see optimisticPick there). Reactions can't
// be associated with these — the FK to draft_picks would fail — so the
// reactions UI suppresses itself for picks in this transitional state and
// togglePickReaction bails early if called.
function isOptimisticPickId(id) {
  return typeof id === 'string' && id.indexOf('__opt_') === 0;
}

// Toggle the current user's reaction on a pick. Click an emoji you already
// reacted with → DELETE that row. Click one you haven't → INSERT a new row.
//
// DELETE filters by the composite (draft_pick_id, user_id, emoji) rather
// than by id so we can toggle off even when our local id is still the
// optimistic placeholder (realtime hasn't delivered the real row yet).
// INSERT trusts a successful return — we DON'T do .select().single() and
// roll back on missing data, because RLS read-after-write returning null
// would otherwise cause the reaction to flash on then immediately off.
// Realtime will deliver the real row with its id; until then the toggle
// path keys off the composite columns regardless.
async function togglePickReaction(pickId, emoji) {
  if (!user || !leagueId) return;
  // Reactions are disabled when the underlying table is missing (most
  // likely cause: migration 004 hasn't been applied to this project).
  // The render path already hides the bar in that state; this is the
  // defensive guard for the click delegation.
  if (!pickReactionsEnabled) return;
  // Optimistic pick ids aren't valid foreign keys yet — the INSERT would
  // fail with 23503 and we'd visibly roll back the optimistic add. Skip
  // until the pick reconciles. The render also suppresses the bar in
  // this state so the user shouldn't see clickable targets anyway.
  if (isOptimisticPickId(pickId)) return;
  var slot = pickReactions[pickId] && pickReactions[pickId][emoji];
  var existing = slot && (slot.userIds.has(user.id));

  if (existing) {
    // Optimistic local removal — realtime broadcast will arrive later and
    // is a no-op via _localRemoveReaction's tolerance.
    _localRemoveReaction({ draft_pick_id: pickId, user_id: user.id, emoji: emoji });
    renderDraftBoard();
    var del = await supabaseClient
      .from('draft_pick_reactions')
      .delete()
      .eq('draft_pick_id', pickId)
      .eq('user_id',       user.id)
      .eq('emoji',         emoji);
    if (del.error) {
      console.warn('[reactions] delete failed:', del.error.message);
      // Roll back the optimistic removal by reloading from the DB.
      await loadPickReactions();
      renderDraftBoard();
    }
    return;
  }

  // Optimistic add. The id placeholder gets replaced when realtime delivers
  // the real row (see handler in subscribeToReactions). We don't .select()
  // back from the INSERT because RLS read filtering could return empty data
  // even when the insert succeeded, which the old code treated as a failure
  // and rolled back — causing the just-added reaction to flicker off.
  var optimistic = {
    id:            '__opt_react_' + pickId + '_' + emoji,
    draft_pick_id: pickId,
    user_id:       user.id,
    emoji:         emoji
  };
  _localAddReaction(optimistic);
  renderDraftBoard();

  var ins = await supabaseClient
    .from('draft_pick_reactions')
    .insert({ league_id: leagueId, draft_pick_id: pickId, user_id: user.id, emoji: emoji });

  if (ins.error) {
    // Unique-key violation (23505) means the row already exists in the DB —
    // probably because realtime delivered our own pre-existing reaction
    // before we knew about it locally. Treat as success: keep the local
    // optimistic state, realtime will reconcile the id shortly.
    if (ins.error.code === '23505') return;
    console.warn('[reactions] insert failed:', ins.error.message);
    _localRemoveReaction(optimistic);
    renderDraftBoard();
  }
}

// Render the reactions overlay for one board cell — existing reactions
// with counts on the bottom-left, plus a "+" picker button on hover that
// reveals the emoji palette. Returns inline HTML (no event wiring; clicks
// are caught by a delegated handler attached once in initDraft).
function renderPickReactionsBar(pickId) {
  var bucket = pickReactions[pickId] || {};
  var entries = [];
  PICK_REACTION_EMOJIS.forEach(function(em) {
    var slot = bucket[em];
    if (slot && slot.userIds.size > 0) {
      var mine = !!slot.myReactionId;
      entries.push({ emoji: em, count: slot.userIds.size, mine: mine });
    }
  });

  // Hidden picker palette — revealed on cell hover via CSS. The "+" toggle
  // is just an entry point; the actual click target is each emoji.
  var palette = '';
  PICK_REACTION_EMOJIS.forEach(function(em) {
    var mine = bucket[em] && bucket[em].myReactionId;
    palette += '<button class="draft-react-palette__btn' + (mine ? ' draft-react-palette__btn--mine' : '') +
                '" data-pick-id="' + escapeHtml(pickId) + '" data-emoji="' + escapeHtml(em) +
                '" aria-label="React with ' + em + '" type="button">' + em + '</button>';
  });

  var countsHtml = entries.map(function(e) {
    var fresh   = freshReactionKeys.has(pickId + ':' + e.emoji);
    var classes = 'draft-react-count' +
                  (e.mine  ? ' draft-react-count--mine'  : '') +
                  (fresh   ? ' draft-react-count--fresh' : '');
    return '<button class="' + classes +
           '" data-pick-id="' + escapeHtml(pickId) + '" data-emoji="' + escapeHtml(e.emoji) +
           '" aria-label="Toggle ' + e.emoji + ' reaction" type="button">' +
             '<span class="draft-react-count__emoji">' + e.emoji + '</span>' +
             '<span class="draft-react-count__num">' + e.count + '</span>' +
           '</button>';
  }).join('');

  return (
    '<div class="draft-react-bar">' +
      '<div class="draft-react-counts">' + countsHtml + '</div>' +
      '<div class="draft-react-palette" aria-hidden="false">' + palette + '</div>' +
    '</div>'
  );
}

// ========================================================================
// PRESENCE
// Supabase Realtime presence channel — each connected client tracks
// themselves with their league_member_id, and every other client receives
// a `sync` event with the full roster of currently-present members. The
// board renderer reads `presentMemberIds` to paint each column header
// with a green (online) or gray (offline) dot.
//
// Connect from anywhere — pre-draft lobby and live draft both benefit.
// ========================================================================
function subscribeToPresence() {
  // Idempotent — don't open a second channel if init runs twice (e.g.,
  // hot reload during development).
  if (presenceChannel) return;

  // Channel name is shared across all clients in the league but distinct
  // from the picks channel so the two don't share rate limits.
  presenceChannel = supabaseClient.channel('draft_presence_' + leagueId, {
    config: { presence: { key: myMemberId } }
  });

  presenceChannel
    .on('presence', { event: 'sync' }, function() {
      // state is { memberId: [{ ...metadata... }, ...] }. We only care
      // about which member ids are represented, not the per-tab metadata.
      var state = presenceChannel.presenceState();
      presentMemberIds = new Set(Object.keys(state));
      renderDraftBoard();
      renderDraftLobby();
    })
    .on('presence', { event: 'join' }, function() {
      var state = presenceChannel.presenceState();
      presentMemberIds = new Set(Object.keys(state));
      renderDraftBoard();
      renderDraftLobby();
    })
    .on('presence', { event: 'leave' }, function() {
      var state = presenceChannel.presenceState();
      presentMemberIds = new Set(Object.keys(state));
      renderDraftBoard();
      renderDraftLobby();
    })
    .subscribe(async function(status) {
      // Announce our own presence once the channel is fully subscribed.
      // Calling track before SUBSCRIBED is a no-op so the timing matters.
      if (status === 'SUBSCRIBED') {
        await presenceChannel.track({
          member_id:    myMemberId,
          user_id:      user && user.id,
          connected_at: Date.now()
        });
      }
    });
}

// ========================================================================
// REALTIME SUBSCRIPTION
// Listens for new rows inserted into the rosters table for this league.
// ========================================================================
function subscribeToRealtime() {
  // Listen on draft_picks (immutable record), not rosters. The trigger
  // sync_draft_pick_trigger inserts into draft_picks whenever a roster
  // row lands with draft metadata, so this fires once per pick.
  // We listen on '*' (INSERT/UPDATE/DELETE) so the commissioner's "Undo
  // last pick" action — which deletes a draft_picks row — propagates to
  // every client too.
  supabaseClient
    .channel('draft_room_' + leagueId)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'draft_picks',
      filter: 'league_id=eq.' + leagueId
    }, function(payload) {
      if (payload.eventType === 'INSERT')      handleNewPick(payload);
      else if (payload.eventType === 'DELETE') handlePickDelete(payload);
    })
    .subscribe();
}

// Removes a deleted pick from local state and re-renders. Triggered by
// the commissioner's Undo Last Pick action via the leagues realtime
// channel above.
function handlePickDelete(payload) {
  const oldPick = payload.old;
  if (!oldPick || !oldPick.id) return;
  picks = picks.filter(function(p) { return p.id !== oldPick.id; });
  // Treat the undo as a fresh anchor for the now-active pick so the timer
  // restarts from full duration for whoever's back on the clock.
  pickClockResetAt = Date.now();
  // Releasing the lock matters here too: if we were the one who just
  // picked and our pick got reverted, we want to be able to pick again.
  picking = false;
  renderAll();
  // A commissioner undo can push the active slot back to us. If we have
  // auto-draft on, we'd want it to re-fire.
  maybeAutoPickNow();
}

// ========================================================================
// PICK REVEAL ANIMATION
// Triggers when a fresh pick lands — locates the cell in the board grid,
// flashes the reveal animation (cell scale + glow + photo fade-in), and
// if the pick belongs to the current viewer, spawns a confetti burst at
// the cell's center. Dedups via lastAnimatedPickId so own picks (which
// arrive via both makePick's SELECT path AND realtime broadcast) only
// animate once.
// ========================================================================
function animatePickReveal(pick) {
  if (!initialPicksLoaded) return;
  if (!pick || !pick.id) return;
  if (lastAnimatedPickId === pick.id) return;
  lastAnimatedPickId = pick.id;

  // Sound effects ride on the same dedup as the cell animation, so own
  // picks (which fire via both makePick + realtime) don't double up.
  if (typeof DraftSounds !== 'undefined') {
    if (pick.league_member_id === myMemberId) DraftSounds.yourPickMade();
    else                                       DraftSounds.pickMade();
  }

  // The board re-renders synchronously inside renderAll() before we get
  // here, so the new cell is already in the DOM. We tag each board cell
  // with the pick number it represents to avoid fragile nth-child math.
  // (Adding the attribute happens in renderDraftBoard below.)
  var cell = document.querySelector('.draft-board__cell[data-pick-num="' + pick.draft_pick + '"]');
  if (!cell) return;

  // Re-applying the same class doesn't restart a CSS animation; toggling
  // off → forcing a reflow → toggling on does. The reflow read of
  // offsetWidth is the standard trick.
  cell.classList.remove('draft-board__cell--just-picked');
  // eslint-disable-next-line no-unused-expressions
  cell.offsetWidth;
  cell.classList.add('draft-board__cell--just-picked');
  setTimeout(function() {
    cell.classList.remove('draft-board__cell--just-picked');
  }, 900);

  // No extra celebration effect — the cell scale-up + photo crossfade
  // above is sufficient feedback for own picks. Keeping the room calm.
}

function handleNewPick(payload) {
  const newPick = payload.new;

  // Guard against duplicate events (Realtime can occasionally fire twice)
  if (picks.find(function(p) { return p.id === newPick.id; })) return;

  // Dedup by slot too — replaces any optimistic placeholder makePick added
  // before realtime delivered the real row. Without this, both the
  // placeholder (id "__opt_N") and the real row (real UUID) would land in
  // picks and getCurrentPickNum() would skip ahead by one.
  picks = picks.filter(function(p) { return p.draft_pick !== newPick.draft_pick; });

  picks.push(newPick);
  // Keep sorted by pick number so getCurrentPickNum() stays correct
  picks.sort(function(a, b) { return a.draft_pick - b.draft_pick; });

  // Stamp the local pick-clock anchor so the timer resets even when the
  // payload's created_at is missing or stale.
  pickClockResetAt = Date.now();

  // Release the pick lock so the next manager can pick
  picking = false;

  renderAll();
  // Reveal animation for the pick that just landed via realtime.
  animatePickReveal(newPick);

  if (picks.length >= getTotalPicks()) {
    handleDraftComplete();
  } else {
    // Turn may have just transitioned to us — if auto-draft is on, fire
    // a pick after a brief delay so the user sees their turn arrive first.
    maybeAutoPickNow();
  }
}

// ========================================================================
// DRAFT COMPLETE
// ========================================================================
async function handleDraftComplete() {
  // Mock mode: don't touch the real league row. We still want the local
  // "Draft Complete" UI state + the arpeggio so the user sees the mock
  // finished, but the DB stays untouched.
  if (!isMockMode) {
    // Persist the completed flag so league.html shows the right state
    await supabaseClient
      .from('leagues')
      .update({ draft_completed: true })
      .eq('id', leagueId);
  }

  league.draft_completed = true;
  renderHeader();

  // One-shot completion arpeggio. Guarded so the sound doesn't replay if
  // handleDraftComplete fires more than once (e.g., from the realtime
  // path after the local makePick has already triggered it).
  if (!draftDoneSounded && typeof DraftSounds !== 'undefined') {
    DraftSounds.draftDone();
    draftDoneSounded = true;
  }
}

// ========================================================================
// RENDER ALL PANELS
// Called after every pick to keep all three panels in sync.
// ========================================================================
function renderAll() {
  renderHeader();
  renderFighterPool();
  renderBestAvailable();
  renderDraftBoard();
  renderMyRoster();
  renderRosterNeeds();
  renderQueue();
  renderNextPickIndicator();
  renderPickActivityFeed();
  // If the View All modal is open, refresh it too so newly drafted fighters
  // disappear from its list in real time.
  if (document.getElementById('viewAllOverlay')) renderViewAllList();
}

// ========================================================================
// NEXT-PICK INDICATOR
// "Your next pick: 4.3 · in 5 picks · ~7:30" — always visible in the
// status strip while the draft is live and it's not currently your turn.
// Lets the user keep tabs on their slot without scanning the board.
// ========================================================================
function renderNextPickIndicator() {
  var el      = document.getElementById('draftNextPick');
  var valueEl = document.getElementById('draftNextPickValue');
  if (!el || !valueEl) return;

  var totalPicks = getTotalPicks();
  if (!league || !league.draft_started || picks.length >= totalPicks) {
    el.hidden = true; return;
  }

  // Find my next pick number — the smallest pick >= current pick whose
  // active manager is me. Scan up to totalPicks; if I have no more picks
  // (already maxed out) hide the strip.
  var current = getCurrentPickNum();
  var myNextPick = null;
  for (var p = current; p <= totalPicks; p++) {
    if (getPickInfo(p).activeManagerId === myMemberId) { myNextPick = p; break; }
  }
  if (myNextPick === null) { el.hidden = true; return; }

  var picksUntil = myNextPick - current;
  var n          = league.draft_order.length;
  var round      = Math.ceil(myNextPick / n);
  var posInRound = ((myNextPick - 1) % n) + 1;
  var pickLabel  = round + '.' + posInRound;

  // It's my pick RIGHT NOW — the personal banner + status strip already
  // shout this; the strip would be redundant noise. Hide it.
  if (picksUntil === 0) { el.hidden = true; return; }

  // ETA: each pick uses up to pick_timer_seconds. This is a worst-case
  // estimate (picks often resolve faster) but it's what users intuit.
  var perPickSec = league.pick_timer_seconds || 90;
  var etaSec     = picksUntil * perPickSec;
  var etaStr     = formatEta(etaSec);

  el.hidden = false;
  valueEl.innerHTML =
    '<span class="draft-next-pick__num">' + escapeHtml(pickLabel) + '</span>' +
    '<span class="draft-next-pick__sep">·</span>' +
    '<span class="draft-next-pick__count">in ' + picksUntil + ' pick' + (picksUntil === 1 ? '' : 's') + '</span>' +
    '<span class="draft-next-pick__sep">·</span>' +
    '<span class="draft-next-pick__eta">~' + escapeHtml(etaStr) + '</span>';
}

// ========================================================================
// PICK ACTIVITY FEED
// Compact ticker above the board showing the 3 most-recent picks as
// "[team-dot] Team picked Fighter · 0:12 ago". Each entry fades in when
// it first appears so a new pick reads as a fresh arrival, not as a
// static list. Time-ago refreshes every 30s via a long-lived interval.
// ========================================================================
let feedTimestampInterval = null;
// Track which pick IDs the feed has already rendered so the next render
// can add the fade-in class only to newly-arrived entries.
let renderedFeedPickIds   = new Set();

function renderPickActivityFeed() {
  var el = document.getElementById('draftPickFeed');
  if (!el) return;
  if (!league || !league.draft_started || picks.length === 0) {
    el.hidden = true;
    return;
  }

  // Last 3 picks, most recent first. picks is already sorted ascending by
  // draft_pick (see handleNewPick + initial load), so slice from the tail
  // and reverse.
  var recent = picks.slice(-3).reverse();

  var html = '';
  recent.forEach(function(p) {
    var fighter   = fighterMap[p.fighter_id];
    var fighterName = fighter ? fighter.name : 'Unknown';
    var member    = memberMap[p.league_member_id];
    var teamName  = member ? member.team_name : '?';
    var accent    = teamColor(p.league_member_id);
    var isNew     = !renderedFeedPickIds.has(p.id);
    var ago       = relativeTimeAgo(p.created_at);
    html +=
      '<span class="draft-pick-feed__item' + (isNew ? ' draft-pick-feed__item--new' : '') + '" data-pick-id="' + escapeHtml(p.id) + '">' +
        '<span class="draft-pick-feed__dot" style="--team-accent: ' + accent + '" aria-hidden="true"></span>' +
        '<span class="draft-pick-feed__text">' +
          '<strong>' + escapeHtml(teamName) + '</strong> picked ' +
          '<strong>' + escapeHtml(fighterName) + '</strong>' +
          (ago ? ' <span class="draft-pick-feed__ago">· ' + escapeHtml(ago) + '</span>' : '') +
        '</span>' +
      '</span>';
  });
  el.innerHTML = html;
  el.hidden    = false;

  // Refresh the rendered-id set so subsequent renders don't re-fade existing
  // entries. Trim to the last few picks worth so the set doesn't grow
  // unbounded across a long draft.
  recent.forEach(function(p) { renderedFeedPickIds.add(p.id); });
  if (renderedFeedPickIds.size > 50) {
    // Cheap reset — we only need the recent few anyway
    renderedFeedPickIds = new Set(recent.map(function(p) { return p.id; }));
  }

  // Lazy-start the time-ago refresh interval the first time we render. No
  // teardown — the page stays mounted for the life of the draft, and the
  // interval cost is negligible.
  if (!feedTimestampInterval) {
    feedTimestampInterval = setInterval(function() {
      // Only touch the .draft-pick-feed__ago spans so we don't flash the
      // whole feed (and lose the fade-in animations on existing entries).
      var nodes = document.querySelectorAll('.draft-pick-feed__item');
      nodes.forEach(function(node) {
        var pickId = node.getAttribute('data-pick-id');
        var pick   = picks.find(function(p) { return String(p.id) === pickId; });
        if (!pick) return;
        var agoEl = node.querySelector('.draft-pick-feed__ago');
        var ago   = relativeTimeAgo(pick.created_at);
        if (agoEl && ago) agoEl.textContent = '· ' + ago;
      });
    }, 30000);
  }
}

// "just now" / "0:42 ago" / "3m ago" / "1h ago". Returns null if the
// timestamp is missing or unparseable so callers can drop the suffix
// cleanly. Compact units keep the feed reads tight.
function relativeTimeAgo(iso) {
  if (!iso) return null;
  var diffMs = Date.now() - new Date(iso).getTime();
  if (isNaN(diffMs) || diffMs < 0) return null;
  var sec = Math.floor(diffMs / 1000);
  if (sec < 5)    return 'just now';
  if (sec < 60)   return sec + 's ago';
  var min = Math.floor(sec / 60);
  if (min < 60)   return min + 'm ago';
  var hr  = Math.floor(min / 60);
  return hr + 'h ago';
}

// "5:30" / "12:45" / "1h 5m" formatter for the next-pick ETA. Stays
// compact regardless of magnitude so the indicator doesn't reflow.
function formatEta(totalSec) {
  if (totalSec < 60)    return totalSec + 's';
  if (totalSec < 3600)  {
    var m = Math.floor(totalSec / 60);
    var s = totalSec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  var h  = Math.floor(totalSec / 3600);
  var mm = Math.floor((totalSec % 3600) / 60);
  return h + 'h ' + mm + 'm';
}

// ========================================================================
// RENDER HEADER
// ========================================================================
function renderHeader() {
  const totalPicks    = getTotalPicks();
  const currentPickNum = getCurrentPickNum();
  const turnInfoEl    = document.getElementById('turnInfo');
  const pickCounterEl = document.getElementById('pickCounter');

  // Personal turn banner — separate concern, but always re-rendered with
  // the rest of the header so it stays in sync.
  renderDraftBanner();
  // The banner can change height (it's hidden when paused/completed,
  // larger when "your pick", smaller for "up in N picks"). Resync the
  // room height so the bottom panels reclaim the difference.
  if (typeof window.syncDraftRoomHeight === 'function') {
    window.syncDraftRoomHeight();
  }

  // Pre-draft: show a live countdown + the absolute scheduled time. The
  // <span class="draft-status__pre"> is the target the predraft countdown
  // interval updates every second; we re-render the surrounding markup
  // only when renderHeader runs (initial load + lobby state changes).
  // Also render the full-bleed cinematic lobby overlay on top of the
  // draft room — it dominates the screen until the draft actually starts.
  if (!league.draft_started && league.draft_scheduled_at) {
    turnInfoEl.innerHTML =
      '<span class="draft-status__pre">' + escapeHtml(formatCountdown(league.draft_scheduled_at)) + '</span>' +
      ' · Draft starts ' + escapeHtml(formatScheduledLocal(league.draft_scheduled_at));
    pickCounterEl.textContent = '0 / ' + totalPicks + ' picks';
    stopPickTimer();
    renderDraftLobby();
    return;
  }
  // Past pre-draft → ensure the lobby is hidden (handles the realtime
  // start-flip race where renderHeader runs before the page reload).
  var lobbyEl = document.getElementById('draftLobby');
  if (lobbyEl) lobbyEl.hidden = true;

  if (league.draft_completed || picks.length >= totalPicks) {
    turnInfoEl.innerHTML = '<span class="draft-status__complete">Draft Complete</span>';
    pickCounterEl.textContent = '';
    stopPickTimer();
    return;
  }

  // Paused state takes precedence over the turn indicator. Freeze the
  // pick clock too so it doesn't keep ticking down toward zero while
  // the commissioner has stopped the world.
  if (league.draft_paused_at) {
    const { round: pausedRound, activeManagerId: pausedActive } = getPickInfo(currentPickNum);
    const pausedMember = memberMap[pausedActive];
    const pausedTeam   = pausedMember ? pausedMember.team_name : '?';
    turnInfoEl.innerHTML =
      '<span class="draft-status__paused">Draft Paused</span> · ' +
      escapeHtml(pausedTeam) + ' is on the clock · Round ' + pausedRound;
    pickCounterEl.textContent = 'Pick ' + currentPickNum + ' of ' + totalPicks;
    stopPickTimer();
    const valueEl     = document.getElementById('draftTimerValue');
    const containerEl = document.getElementById('draftTimer');
    if (valueEl)     valueEl.textContent = 'PAUSED';
    if (containerEl) containerEl.hidden  = false;
    return;
  }

  const { round, activeManagerId } = getPickInfo(currentPickNum);
  const activeMember = memberMap[activeManagerId];
  const teamName = activeMember ? activeMember.team_name : '?';

  if (activeManagerId === myMemberId) {
    turnInfoEl.innerHTML = '<span class="draft-status__mine">Your pick</span> · Round ' + round;
  } else {
    turnInfoEl.innerHTML =
      '<span class="draft-status__team">' + escapeHtml(teamName) + '</span> is on the clock · Round ' + round;
  }

  pickCounterEl.textContent = 'Pick ' + currentPickNum + ' of ' + totalPicks;

  // Your-turn chime fires on the rising edge only — flag transition from
  // "not my turn" → "my turn". Guarded by initialPicksLoaded so the first
  // render after page load doesn't play the chime even when you happen to
  // already be on the clock.
  var nowMyTurn = activeManagerId === myMemberId;
  if (initialPicksLoaded && nowMyTurn && !wasMyTurn && typeof DraftSounds !== 'undefined') {
    DraftSounds.yourTurn();
  }
  wasMyTurn = nowMyTurn;
  // Reset the clock-band tracker on every new pick so warning sounds
  // re-arm for the next picker.
  lastClockBand = 'none';

  // Restart the pick clock anchored to the current pick's start time.
  startPickTimer();
}

// ========================================================================
// PERSONAL TURN BANNER
// Tall crimson "YOU'RE ON THE CLOCK" when it's the viewer's pick; subtler
// "Up in N picks" indicator otherwise. Hidden during pre-draft (the status
// strip handles the countdown), completion, and pause (the status strip
// shows the paused state).
// ========================================================================
function renderDraftBanner() {
  const bannerEl = document.getElementById('draftBanner');
  const textEl   = document.getElementById('draftBannerText');
  if (!bannerEl || !textEl) return;

  // Hide for any state where a turn-aware banner would be misleading.
  if (!league.draft_started ||
      league.draft_completed ||
      league.draft_paused_at ||
      picks.length >= getTotalPicks()) {
    bannerEl.hidden = true;
    return;
  }

  bannerEl.hidden = false;
  bannerEl.classList.remove('draft-banner--mine', 'draft-banner--waiting', 'draft-banner--ondeck', 'draft-banner--done');

  const picksUntil = picksUntilMyTurn();
  if (picksUntil === 0) {
    // It's the viewer's pick.
    bannerEl.classList.add('draft-banner--mine');
    textEl.textContent = "You're on the clock";
  } else if (picksUntil === -1) {
    // Viewer has no more picks (somehow they ran out before the draft did).
    bannerEl.classList.add('draft-banner--done');
    textEl.textContent = 'You have no more picks';
  } else if (picksUntil === 1) {
    // On deck — call this out a bit louder than the generic "up in N".
    bannerEl.classList.add('draft-banner--ondeck');
    textEl.textContent = 'On deck — you pick next';
  } else {
    bannerEl.classList.add('draft-banner--waiting');
    textEl.textContent = 'Up in ' + picksUntil + ' picks';
  }
}

// Returns the number of picks between now and the viewer's next pick.
// 0 means it's their turn right now. -1 means they have no more picks
// remaining in the draft.
function picksUntilMyTurn() {
  const total   = getTotalPicks();
  const current = getCurrentPickNum();
  for (let p = current; p <= total; p++) {
    if (getPickInfo(p).activeManagerId === myMemberId) {
      return p - current;
    }
  }
  return -1;
}

// ========================================================================
// PICK TIMER
// Counts down from league.pick_timer_seconds, anchored server-side to:
//   * The previous pick's created_at (for picks 2..N)
//   * league.draft_started_at      (for pick 1)
// All clients see the same remaining time (modulo clock skew). The timer
// is informational in v1 — we don't auto-pick on expiry; that's a follow-up.
// ========================================================================

// Returns when the active pick clock started (Date), or null if we can't
// determine — in which case the timer hides itself.
function getActivePickStartedAt() {
  if (picks.length === 0) {
    return league.draft_started_at ? new Date(league.draft_started_at) : null;
  }
  // Sorted by draft_pick asc; the last element is the most recent pick.
  const last = picks[picks.length - 1];
  // Prefer the server-side created_at (consistent across all clients) when
  // present, and fall back to the local reset anchor (updated whenever
  // picks change) so the timer resets even if created_at is missing.
  if (last && last.created_at) return new Date(last.created_at);
  if (pickClockResetAt)        return new Date(pickClockResetAt);
  return league.draft_started_at ? new Date(league.draft_started_at) : null;
}

function startPickTimer() {
  stopPickTimer();
  const containerEl = document.getElementById('draftTimer');
  const valueEl     = document.getElementById('draftTimerValue');
  if (!containerEl || !valueEl) return;

  // No anchor → hide the timer entirely (e.g., legacy league with no
  // draft_started_at and no picks yet).
  const started = getActivePickStartedAt();
  if (!started) { containerEl.hidden = true; return; }

  const totalSec = league.pick_timer_seconds || 90;
  containerEl.hidden = false;

  function tick() {
    const elapsedSec = (Date.now() - started.getTime()) / 1000;
    const remaining  = Math.max(0, Math.ceil(totalSec - elapsedSec));

    valueEl.textContent = formatMmSs(remaining);

    // Drive the conic-gradient progress ring via a CSS custom property.
    // 1.0 = full ring, 0.0 = empty. Sub-second precision so the ring
    // sweeps smoothly even though the text only updates per integer second.
    const progress = Math.max(0, Math.min(1, (totalSec - elapsedSec) / totalSec));
    containerEl.style.setProperty('--timer-progress', progress.toFixed(3));

    // Color states — gold/yellow at 30s, crimson at 10s, "EXPIRED" at 0.
    containerEl.classList.remove('draft-timer--low', 'draft-timer--critical', 'draft-timer--expired');
    if (remaining === 0)        containerEl.classList.add('draft-timer--expired');
    else if (remaining <= 10)   containerEl.classList.add('draft-timer--critical');
    else if (remaining <= 30)   containerEl.classList.add('draft-timer--low');

    // Clock-band sound transitions — play once on entry into each band
    // (warn/urgent/expired). lastClockBand resets in renderHeader on each
    // new pick so the warnings re-arm for the next picker.
    var band = remaining === 0    ? 'expired'
             : remaining <= 10    ? 'urgent'
             : remaining <= 30    ? 'warn'
             :                      'none';
    if (band !== lastClockBand && typeof DraftSounds !== 'undefined') {
      if      (band === 'warn')    DraftSounds.clockWarn();
      else if (band === 'urgent')  DraftSounds.clockUrgent();
      else if (band === 'expired') DraftSounds.clockExpired();
      lastClockBand = band;
    }

    // Clock expired — stop ticking and fire auto-pick. The active picker's
    // own client is responsible for placing the pick. Other clients see
    // the same expiry but isMyTurn() returns false for them, so they no-op.
    // If the active picker is offline, the pick stalls until they return
    // OR the commissioner intervenes — acceptable for friends-and-family
    // scale. selectAutoPickFighter handles canPick gating + queue/FV fallback.
    if (remaining === 0) {
      stopPickTimer();
      if (isMyTurn() && !picking && !(league && league.draft_paused_at)) {
        autoPick();
      }
    }
  }

  tick(); // paint immediately so users don't see "--" for a second
  // 200ms interval — the integer seconds (text) only changes ~every 5 ticks,
  // but the conic-gradient progress ring sweeps smoothly between integer
  // marks instead of jumping in ~1% chunks once per second.
  pickTimerInterval = setInterval(tick, 200);
}

function stopPickTimer() {
  if (pickTimerInterval) {
    clearInterval(pickTimerInterval);
    pickTimerInterval = null;
  }
}

function formatMmSs(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

// ========================================================================
// RENDER FIGHTER POOL
// ========================================================================
function renderFighterPool() {
  const pickedIds      = new Set(picks.map(function(p) { return p.fighter_id; }));
  const myTurn         = isMyTurn() && !picking;
  const myPickFighters = getMyPickFighters();

  // Start with all undrafted fighters
  let fighters = allFighters.filter(function(f) { return !pickedIds.has(f.id); });

  // Apply division filter
  if (divisionFilter !== 'all') {
    fighters = fighters.filter(function(f) { return f.primary_division === divisionFilter; });
  }

  // Apply status filter (undefeated / top tiers / unranked) — same rules as
  // the Free Agency page so the two surfaces feel consistent.
  if (statusFilter === 'undefeated') {
    fighters = fighters.filter(function(f) {
      return f.record_losses === 0 && (f.record_draws || 0) === 0;
    });
  } else if (statusFilter === 'top5') {
    fighters = fighters.filter(function(f) {
      return f.is_champion || (f.current_rank && f.current_rank <= 5);
    });
  } else if (statusFilter === 'top10') {
    fighters = fighters.filter(function(f) {
      return f.is_champion || (f.current_rank && f.current_rank <= 10);
    });
  } else if (statusFilter === 'unranked') {
    fighters = fighters.filter(function(f) {
      return !f.is_champion && !f.current_rank;
    });
  }

  // Apply name search
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    fighters = fighters.filter(function(f) { return f.name.toLowerCase().includes(q); });
  }

  // Sort a copy so the underlying allFighters array order stays stable.
  // Rank is the tiebreaker for every points-based sort: champion first,
  // then ranked, then unranked (999). Mirrors the free-agency sort exactly.
  fighters = fighters.slice().sort(function(a, b) {
    var rankA = a.is_champion ? 0 : (a.current_rank || 999);
    var rankB = b.is_champion ? 0 : (b.current_rank || 999);

    if (sortBy === 'rank') return rankA - rankB;

    if (sortBy === 'fantasy_value') {
      var fva = fighterFvScore(a);
      var fvb = fighterFvScore(b);
      if (fvb !== fva) return fvb - fva;
      return rankA - rankB;
    }

    // avg_pts / total_pts / recent_pts all read from the same points map
    var ptsKey = sortBy === 'total_pts'  ? 'totalPts'
               : sortBy === 'recent_pts' ? 'recentPts'
               : 'avgPts';
    var pa = fighterPtsValue(a, ptsKey);
    var pb = fighterPtsValue(b, ptsKey);
    if (pb !== pa) return pb - pa;
    return rankA - rankB;
  });

  const poolEl = document.getElementById('fighterPool');

  if (fighters.length === 0) {
    poolEl.innerHTML = EmptyState.html({
      kind:    'search',
      title:   'No fighters match',
      body:    'Try clearing the division or status filter.',
      compact: true
    });
    return;
  }

  let html = '';

  fighters.forEach(function(f, idx) {
    // The top row of the (sorted + filtered) pool gets a "BEST" pill,
    // replacing the standalone Best Available strip we used to render.
    // Whoever's first in the user's current sort is their best draft
    // target right now, by definition.
    const bestBadge = idx === 0
      ? '<span class="draft-pool-row__best-badge" title="Best available">BEST</span>'
      : '';
    const valid       = myTurn && canPick(f, myPickFighters);
    const rankLabel   = f.is_champion ? 'C' : (f.current_rank ? '#' + f.current_rank : 'NR');
    const rankClass   = f.is_champion ? 'rank-champion' : (f.current_rank ? 'rank-ranked' : 'rank-unranked');
    const subBadge    = f.is_sub_champion && f.sub_title_type === 'interim'
                          ? '<span class="subrank-badge subrank-interim">INT</span>'
                        : f.is_sub_champion && f.sub_title_type === 'bmf'
                          ? '<span class="subrank-badge subrank-bmf">BMF</span>'
                          : '';
    const divLabel    = DIVISION_LABELS[f.primary_division] || f.primary_division;
    const record      = f.record_wins + '-' + f.record_losses + (f.record_draws ? '-' + f.record_draws : '');
    const photoHtml   = f.photo_url
      ? '<img class="lineup-roster-row__photo" src="' + escapeHtml(f.photo_url) + '" alt="' + escapeHtml(f.name) + '" onerror="this.style.display=\'none\'">'
      : '';

    let rowMods = ' draft-pool-row';
    // Champions get a row-level modifier so the gold-treatment CSS can light
    // up the whole row — photo border, glow on hover, subtle gradient. Same
    // pattern the whole-team-tile uses for its champion accent.
    if (f.is_champion) rowMods += ' draft-pool-row--champion';
    let titleAttr = '';
    let pickBtn   = '';
    if (myTurn && valid) {
      rowMods += ' draft-pool-row--pickable';
      pickBtn  = '<button class="btn-secondary lineup-row-btn draft-pick-btn" data-fighter-id="' + f.id + '">Draft</button>';
    } else if (myTurn && !valid) {
      rowMods += ' draft-pool-row--invalid';
      titleAttr = ' title="No valid roster slot available for this fighter"';
      pickBtn   = '<button class="btn-secondary lineup-row-btn" disabled>No slot</button>';
    }

    // Queue toggle — shown next to the pick button regardless of whose
    // turn it is. If already queued, the button reads "Queued ✕" and
    // removes; otherwise "+ Queue" adds.
    const inQueue = isQueued(f.id);
    const queueBtnLabel = inQueue ? 'Queued &#x2715;' : '+ Queue';
    const queueBtnClass = inQueue
      ? 'btn-ghost lineup-row-btn draft-queue-btn draft-queue-btn--queued'
      : 'btn-ghost lineup-row-btn draft-queue-btn';
    const queueBtn = '<button class="' + queueBtnClass + '" data-queue-fighter-id="' + f.id + '">' +
                       queueBtnLabel +
                     '</button>';

    // Inline --div-accent on the row so the row's left-border and division
    // label can pull from a single variable — keeps the styling DRY despite
    // having 11 different division colors.
    const divAccent = divisionColor(f.primary_division);

    html +=
      '<div class="lineup-roster-row draft-pool-row--divcolor' + rowMods + '" style="--div-accent: ' + divAccent + '"' + titleAttr + '>' +
        '<div class="lineup-roster-row__photo-wrap">' + photoHtml + '</div>' +
        '<span class="lineup-roster-row__rank ' + rankClass + '">' + escapeHtml(rankLabel) + (typeof subBadge === 'string' ? subBadge : '') + '</span>' +
        '<div class="lineup-roster-row__info">' +
          // Name line + inline rank suffix so the rank shows on mobile
          // (matches the lineup/free-agency row convention).
          '<div class="draft-pool-row__name-line">' +
            '<button class="lineup-roster-row__name" data-open-fighter="' + f.id + '">' +
              escapeHtml(f.name) +
            '</button>' +
            '<span class="lineup-roster-row__rank-inline ' + rankClass + '" aria-hidden="true">' +
              '<span class="lineup-roster-row__rank-inline-divider">|</span>' +
              escapeHtml(rankLabel) +
            '</span>' +
            bestBadge +
            valuePickBadgeHtml(f) +
          '</div>' +
          '<div class="draft-pool-row__sub-line">' +
            '<span class="lineup-roster-row__division draft-pool-row__division">' + escapeHtml(divLabel) + '</span>' +
            formSparkline(f) +
            trendChipsHtml(f) +
          '</div>' +
          nextFightLine(f) +
        '</div>' +
        fighterFvChip(f) +
        '<span class="lineup-roster-row__record">' + record + '</span>' +
        // Wrap action buttons in __actions so the mobile grid places
        // them cleanly at col 3 row 2 (instead of auto-flowing into
        // implicit rows beneath the photo).
        '<div class="lineup-roster-row__actions">' +
          queueBtn +
          pickBtn +
        '</div>' +
      '</div>';
  });

  poolEl.innerHTML = html;

  // Wire pick buttons (only present when it's your turn AND the slot is legal)
  poolEl.querySelectorAll('.draft-pick-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const fighter = fighterMap[btn.getAttribute('data-fighter-id')];
      if (fighter) makePick(fighter);
    });
  });

  // Wire queue toggle buttons. Same fighter id either adds or removes
  // depending on whether it's already in the local queue cache.
  poolEl.querySelectorAll('.draft-queue-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const fighterId = btn.getAttribute('data-queue-fighter-id');
      if (isQueued(fighterId)) removeFromQueue(fighterId);
      else                     addToQueue(fighterId);
    });
  });
}

// ========================================================================
// BEST AVAILABLE STRIP
// Pinned to the top of the fighter pool: the highest-FV fighter still on
// the board, always visible regardless of the user's active filter or
// search. Removes the "did I miss someone elite?" anxiety mid-draft.
// Hidden until FV cache loads + the draft is past pre-draft phase.
// ========================================================================
// Best Available is now surfaced as a small "BEST" badge on the top
// fighter row inside renderFighterPool() — the dedicated sticky strip
// was redundant when the same signal can sit on the first row directly.
// This function is left as a no-op so existing call sites in initDraft
// and renderAll keep working without changes.
function renderBestAvailable() {
  var el = document.getElementById('bestAvailable');
  if (el) el.hidden = true;
}

// ========================================================================
// VIEW ALL MODAL
// Fullscreen overlay with the same search / sort / division / status
// controls as the side panel, but laid out as a multi-column grid so the
// user can see many more fighters at once. Independent control state so
// browsing here doesn't change the panel's filters.
// ========================================================================
function openViewAll() {
  // Build the division-filter options from the same constants the panel uses
  var divOptions = '<option value="all">All Divisions</option>';
  WOMENS_DIVISIONS.concat(MENS_DIVISIONS).forEach(function(d) {
    divOptions += '<option value="' + d + '">' + escapeHtml(DIVISION_LABELS[d]) + '</option>';
  });

  // Remove any stale instance
  var existing = document.getElementById('viewAllOverlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'viewAllOverlay';
  overlay.className = 'view-all-overlay';
  overlay.innerHTML =
    '<div class="view-all-modal" role="dialog" aria-modal="true" aria-labelledby="viewAllTitle">' +
      '<div class="view-all-modal__header">' +
        '<h2 class="view-all-modal__title" id="viewAllTitle">All Available Fighters</h2>' +
        '<button class="view-all-modal__close" id="viewAllClose" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="view-all-modal__controls">' +
        '<input type="text" id="viewAllSearchInput" class="waiver-search" placeholder="Search fighters...">' +
        '<select id="viewAllSortInput" class="waiver-filter">' +
          '<option value="fantasy_value">Sort: Fantasy Value</option>' +
          '<option value="avg_pts">Sort: Avg Points</option>' +
          '<option value="total_pts">Sort: Total Points</option>' +
          '<option value="recent_pts">Sort: Points (Last Year)</option>' +
          '<option value="rank">Sort: Rank</option>' +
        '</select>' +
        '<select id="viewAllDivisionInput" class="waiver-filter">' + divOptions + '</select>' +
        '<select id="viewAllStatusInput" class="waiver-filter">' +
          '<option value="all">All Fighters</option>' +
          '<option value="undefeated">Undefeated</option>' +
          '<option value="top5">Top 5</option>' +
          '<option value="top10">Top 10</option>' +
          '<option value="unranked">Unranked</option>' +
        '</select>' +
      '</div>' +
      '<div class="view-all-modal__count" id="viewAllCount"></div>' +
      '<div class="view-all-modal__body" id="viewAllBody"></div>' +
    '</div>';

  document.body.appendChild(overlay);

  // Restore any previous selections (modal can be re-opened mid-session)
  document.getElementById('viewAllSearchInput').value   = viewAllSearch;
  document.getElementById('viewAllSortInput').value     = viewAllSort;
  document.getElementById('viewAllDivisionInput').value = viewAllDivision;
  document.getElementById('viewAllStatusInput').value   = viewAllStatus;

  // Wire close interactions
  document.getElementById('viewAllClose').addEventListener('click', closeViewAll);
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeViewAll();
  });
  document.addEventListener('keydown', _viewAllEscHandler);

  // Wire control changes
  document.getElementById('viewAllSearchInput').addEventListener('input', function() {
    viewAllSearch = this.value.trim();
    renderViewAllList();
  });
  document.getElementById('viewAllSortInput').addEventListener('change', function() {
    viewAllSort = this.value;
    renderViewAllList();
  });
  document.getElementById('viewAllDivisionInput').addEventListener('change', function() {
    viewAllDivision = this.value;
    renderViewAllList();
  });
  document.getElementById('viewAllStatusInput').addEventListener('change', function() {
    viewAllStatus = this.value;
    renderViewAllList();
  });

  renderViewAllList();
}

function closeViewAll() {
  var overlay = document.getElementById('viewAllOverlay');
  if (overlay) overlay.remove();
  document.removeEventListener('keydown', _viewAllEscHandler);
}

function _viewAllEscHandler(e) {
  if (e.key === 'Escape') closeViewAll();
}

function renderViewAllList() {
  var body  = document.getElementById('viewAllBody');
  var count = document.getElementById('viewAllCount');
  if (!body) return;

  var pickedIds      = new Set(picks.map(function(p) { return p.fighter_id; }));
  var myTurn         = isMyTurn() && !picking;
  var myPickFighters = getMyPickFighters();

  // Same filter pipeline as renderFighterPool, but reading viewAll* state
  var fighters = allFighters.filter(function(f) { return !pickedIds.has(f.id); });

  if (viewAllDivision !== 'all') {
    fighters = fighters.filter(function(f) { return f.primary_division === viewAllDivision; });
  }

  if (viewAllStatus === 'undefeated') {
    fighters = fighters.filter(function(f) { return f.record_losses === 0 && (f.record_draws || 0) === 0; });
  } else if (viewAllStatus === 'top5') {
    fighters = fighters.filter(function(f) { return f.is_champion || (f.current_rank && f.current_rank <= 5); });
  } else if (viewAllStatus === 'top10') {
    fighters = fighters.filter(function(f) { return f.is_champion || (f.current_rank && f.current_rank <= 10); });
  } else if (viewAllStatus === 'unranked') {
    fighters = fighters.filter(function(f) { return !f.is_champion && !f.current_rank; });
  }

  if (viewAllSearch) {
    var q = viewAllSearch.toLowerCase();
    fighters = fighters.filter(function(f) { return f.name.toLowerCase().includes(q); });
  }

  fighters = fighters.slice().sort(function(a, b) {
    var rankA = a.is_champion ? 0 : (a.current_rank || 999);
    var rankB = b.is_champion ? 0 : (b.current_rank || 999);

    if (viewAllSort === 'rank') return rankA - rankB;

    if (viewAllSort === 'fantasy_value') {
      var fva = fighterFvScore(a);
      var fvb = fighterFvScore(b);
      if (fvb !== fva) return fvb - fva;
      return rankA - rankB;
    }

    var ptsKey = viewAllSort === 'total_pts'  ? 'totalPts'
               : viewAllSort === 'recent_pts' ? 'recentPts'
               : 'avgPts';
    var pa = fighterPtsValue(a, ptsKey);
    var pb = fighterPtsValue(b, ptsKey);
    if (pb !== pa) return pb - pa;
    return rankA - rankB;
  });

  if (count) {
    count.textContent = fighters.length + ' fighter' + (fighters.length === 1 ? '' : 's');
  }

  if (fighters.length === 0) {
    body.innerHTML =
      '<div style="grid-column: 1 / -1">' +
      EmptyState.html({
        kind:    'search',
        title:   'No fighters match',
        body:    'Try clearing the division or status filter.',
        compact: true
      }) +
      '</div>';
    return;
  }

  var html = '';
  fighters.forEach(function(f) {
    var valid     = myTurn && canPick(f, myPickFighters);
    var rankLabel = f.is_champion ? 'C' : (f.current_rank ? '#' + f.current_rank : 'NR');
    var rankClass = f.is_champion ? 'rank-champion' : (f.current_rank ? 'rank-ranked' : 'rank-unranked');
    var subBadge  = f.is_sub_champion && f.sub_title_type === 'interim'
                      ? '<span class="subrank-badge subrank-interim">INT</span>'
                    : f.is_sub_champion && f.sub_title_type === 'bmf'
                      ? '<span class="subrank-badge subrank-bmf">BMF</span>'
                      : '';
    var divLabel  = DIVISION_LABELS[f.primary_division] || f.primary_division;
    var record    = f.record_wins + '-' + f.record_losses + (f.record_draws ? '-' + f.record_draws : '');
    var photoHtml = f.photo_url
      ? '<img class="lineup-roster-row__photo" src="' + escapeHtml(f.photo_url) + '" alt="' + escapeHtml(f.name) + '" onerror="this.style.display=\'none\'">'
      : '';

    var pickBtn = '';
    if (myTurn && valid) {
      pickBtn = '<button class="btn-secondary lineup-row-btn view-all-pick-btn" data-fighter-id="' + f.id + '">Draft</button>';
    } else if (myTurn && !valid) {
      pickBtn = '<button class="btn-secondary lineup-row-btn" disabled>No slot</button>';
    }

    // Queue toggle — parity with the side panel so the user can queue
    // fighters while browsing in the modal without having to close it.
    // Reuses the .draft-queue-btn class so the global click handler we
    // wire below behaves the same as in the pool.
    var inQueue       = isQueued(f.id);
    var queueBtnLabel = inQueue ? 'Queued &#x2715;' : '+ Queue';
    var queueBtnClass = inQueue
      ? 'btn-ghost lineup-row-btn draft-queue-btn draft-queue-btn--queued'
      : 'btn-ghost lineup-row-btn draft-queue-btn';
    var queueBtn = '<button class="' + queueBtnClass + '" data-queue-fighter-id="' + f.id + '">' +
                     queueBtnLabel +
                   '</button>';

    var rowClass = 'lineup-roster-row';
    if (f.is_champion) rowClass += ' draft-pool-row--champion';

    html +=
      '<div class="' + rowClass + '">' +
        '<div class="lineup-roster-row__photo-wrap">' + photoHtml + '</div>' +
        '<span class="lineup-roster-row__rank ' + rankClass + '">' + rankLabel + (typeof subBadge === 'string' ? subBadge : '') + '</span>' +
        '<div class="lineup-roster-row__info">' +
          '<div class="draft-pool-row__name-line">' +
            '<button class="lineup-roster-row__name" data-open-fighter="' + f.id + '">' + escapeHtml(f.name) + '</button>' +
            valuePickBadgeHtml(f) +
          '</div>' +
          '<div class="draft-pool-row__sub-line">' +
            '<span class="lineup-roster-row__division">' + escapeHtml(divLabel) + '</span>' +
            formSparkline(f) +
            trendChipsHtml(f) +
          '</div>' +
          nextFightLine(f) +
        '</div>' +
        fighterFvChip(f) +
        '<span class="lineup-roster-row__record">' + record + '</span>' +
        queueBtn +
        pickBtn +
      '</div>';
  });

  body.innerHTML = html;

  // Wire pick buttons. data-open-fighter is handled by the global delegated
  // listener attached at init time, so fighter modal opens still work.
  body.querySelectorAll('.view-all-pick-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var fighter = fighterMap[btn.getAttribute('data-fighter-id')];
      if (fighter) {
        makePick(fighter);
        // Close the modal so the user sees the live board update
        closeViewAll();
      }
    });
  });

  // Wire queue toggle buttons inside the modal. Same add-or-remove semantics
  // as the side panel; the modal stays open so the user can keep queueing.
  body.querySelectorAll('.draft-queue-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var fighterId = btn.getAttribute('data-queue-fighter-id');
      if (isQueued(fighterId)) removeFromQueue(fighterId);
      else                     addToQueue(fighterId);
    });
  });
}

// Short division labels used in the mobile draft-board cells. Sized to
// fit alongside a rank/champion marker inside an ~80px column without
// truncation. Women's divisions get a "W-" prefix so the gender stays
// readable when the cell is narrow.
const DIVISION_ABBREV = {
  flyweight:         'FLW',
  bantamweight:      'BW',
  featherweight:     'FW',
  lightweight:       'LW',
  welterweight:      'WW',
  middleweight:      'MW',
  light_heavyweight: 'LHW',
  heavyweight:       'HW',
  strawweight:       'W-SW',
  flyweight_w:       'W-FLW',
  bantamweight_w:    'W-BW'
};
function divisionAbbrev(div) {
  if (!div) return '';
  if (DIVISION_ABBREV[div]) return DIVISION_ABBREV[div];
  // Fallback for unrecognized divisions — strip underscores, uppercase,
  // cap at 6 chars so it doesn't blow up a narrow cell.
  return String(div).replace(/_/g, ' ').toUpperCase().slice(0, 6);
}

// "Alexander Volkanovski" -> "A. Volkanovski". Single-word names pass
// through untouched. Whitespace-only inputs return empty. The mobile
// cell is sized wide enough (~110px) to fit this format for the longest
// UFC names without truncation.
function formatShortName(fullName) {
  if (!fullName) return '';
  var parts = String(fullName).trim().split(/\s+/);
  if (parts.length <= 1) return parts[0] || '';
  return parts[0].charAt(0).toUpperCase() + '. ' + parts.slice(1).join(' ');
}

// ========================================================================
// RENDER DRAFT BOARD
// Grid with rounds as rows and managers as columns. Each cell shows the
// fighter picked at that slot. Snake reversal is reflected in the grid.
// ========================================================================
function renderDraftBoard() {
  const n            = league.draft_order.length;
  const totalRounds  = league.roster_size;
  const totalPicks   = getTotalPicks();
  const currentPickNum = getCurrentPickNum();

  // Preserve the user's scroll position across re-renders. Without this,
  // every realtime pick would yank the board back to the top — frustrating
  // when the user had scrolled down to round 12 to see future picks.
  const boardEl = document.getElementById('draftBoard');
  const oldScrollContainer = boardEl ? boardEl.querySelector('.draft-board') : null;
  const savedScrollTop  = oldScrollContainer ? oldScrollContainer.scrollTop  : 0;
  const savedScrollLeft = oldScrollContainer ? oldScrollContainer.scrollLeft : 0;

  // Pre-build a pick_number -> fighter_id map. Cells render the fighter's
  // name (looked up via fighterMap) and expose data-open-fighter so the
  // delegated click handler opens the fighter modal.
  const pickMap = {};
  picks.forEach(function(p) {
    pickMap[p.draft_pick] = p.fighter_id;
  });

  // Draft board rebuilt as a Sleeper-style grid:
  //   * Manager team names along the top (column headers)
  //   * Each cell is a card with a photo, name, and division/rank meta
  //   * Pick number ("1.1", "2.5"...) lives in the top-right corner
  //   * Tier classes color-tint the background subtly: champion / top5 /
  //     top15 / unranked, so the board reads as "value chart" at a glance
  //   * The whole cell is clickable when a pick has been made (opens the
  //     fighter modal via the existing data-open-fighter delegate)
  // Build the table with an explicit <colgroup>. On mobile the CSS sets
  // a uniform width on .draft-board__col so every column is exactly the
  // same size regardless of team-name length — without colgroup, browsers
  // size columns from the first row's cell content, which lets long
  // headers ("DANA WHITE PRIVILEGE") inflate their column. Desktop CSS
  // leaves .draft-board__col without an explicit width so columns still
  // share viewport width equally.
  let html = '<div class="draft-board"><table class="draft-board__table">';
  html += '<colgroup>';
  for (let i = 0; i < n; i++) {
    html += '<col class="draft-board__col">';
  }
  html += '</colgroup>';
  html += '<thead><tr>';

  // Identify which manager is "on the clock" — used to highlight their entire
  // column so the eye reads the active team at a glance, not just the single
  // current cell. Only meaningful while the draft is live and unpaused.
  const onClockManagerId = (league.draft_started && !league.draft_paused_at && picks.length < totalPicks)
    ? getPickInfo(currentPickNum).activeManagerId
    : null;

  league.draft_order.forEach(function(memberId) {
    const member = memberMap[memberId];
    const isMe   = memberId === myMemberId;
    // Inline --team-accent on the header cell so all descendants (the
    // header's bottom border, the column's pick cells via CSS inheritance)
    // can reference the same color via var(--team-accent).
    const accent = teamColor(memberId);
    let headerClass = 'draft-board__col-header';
    if (isMe)                            headerClass += ' draft-board__col-header--mine';
    if (memberId === onClockManagerId)   headerClass += ' draft-board__col-header--on-clock';
    // Presence dot — green when this member is currently connected to the
    // presence channel, gray otherwise. We always render the dot (gray as
    // default) so the column doesn't reflow when presence transitions.
    var isPresent  = presentMemberIds.has(memberId);
    var presenceCls = 'draft-presence-dot draft-presence-dot--' + (isPresent ? 'on' : 'off');
    var presenceTitle = isPresent ? 'Connected' : 'Offline';
    // data-open-team-roster makes the header clickable; the document-level
    // delegated handler in initDraft opens the per-team roster modal.
    html += '<th class="' + headerClass + '"' +
            ' style="--team-accent: ' + accent + '"' +
            ' data-open-team-roster="' + escapeHtml(memberId) + '"' +
            ' title="View this team\'s roster">';
    html += '<span class="' + presenceCls + '" aria-label="' + presenceTitle + '" title="' + presenceTitle + '"></span>';
    // "YOU" pill on the user's column header so the eye finds their
    // team instantly. Renders before the team name; the cell-level
    // crimson ring carries the same signal down through every row.
    if (isMe) {
      html += '<span class="draft-board__you-badge" aria-label="Your team">YOU</span>';
    }
    html += escapeHtml(member ? member.team_name : '?');
    html += '</th>';
  });
  html += '</tr></thead><tbody>';

  for (let round = 1; round <= totalRounds; round++) {
    html += '<tr>';

    for (let managerIdx = 0; managerIdx < n; managerIdx++) {
      // Map (round, managerIdx) to the absolute pick number.
      // Odd rounds read left-to-right; even rounds read right-to-left.
      const pickNum = round % 2 === 1
        ? (round - 1) * n + managerIdx + 1
        : (round - 1) * n + (n - managerIdx);

      const memberId  = league.draft_order[managerIdx];
      const isMe      = memberId === myMemberId;
      // No "on the clock" highlight pre-draft — the cell at pick #1 isn't
      // an active pick yet, just the slot for whoever drafts first when it
      // starts.
      const isCurrent = league.draft_started && pickNum === currentPickNum && picks.length < totalPicks;
      const positionInRound = ((pickNum - 1) % n) + 1;

      // Determine tier (only relevant for made picks; influences cell tint)
      let tierClass = '';
      const fighter = pickMap[pickNum] ? fighterMap[pickMap[pickNum]] : null;
      if (fighter) {
        if (fighter.is_champion)                                tierClass = ' draft-board__cell--champion';
        else if (fighter.current_rank && fighter.current_rank <= 5)  tierClass = ' draft-board__cell--top5';
        else if (fighter.current_rank && fighter.current_rank <= 15) tierClass = ' draft-board__cell--top15';
        else                                                          tierClass = ' draft-board__cell--unranked';
      }

      let cellClass = 'draft-board__cell';
      if (isMe)                              cellClass += ' draft-board__cell--mine';
      if (memberId === onClockManagerId)     cellClass += ' draft-board__cell--on-clock-col';
      if (pickMap[pickNum]) cellClass += ' draft-board__cell--made' + tierClass;
      else if (isCurrent)   cellClass += ' draft-board__cell--current';
      else                  cellClass += ' draft-board__cell--empty';

      // Each cell carries two custom properties:
      //   --team-accent : the column's team color (used by empty cells so
      //                   the column reads as a colored vertical band)
      //   --div-accent  : the picked fighter's weight-class color (used by
      //                   cells with picks so each card pops by division)
      // CSS picks --div-accent when set, falls back to --team-accent for
      // empty cells so columns stay traceable end-to-end.
      const cellAccent = teamColor(memberId);
      let cellStyle = '--team-accent: ' + cellAccent;
      if (fighter) {
        cellStyle += '; --div-accent: ' + divisionColor(fighter.primary_division);
      }
      html += '<td class="' + cellClass + '" style="' + cellStyle + '" data-pick-num="' + pickNum + '">';
      // "round.position" label in the top-right of every cell. Snake-aware:
      // round 2 reads 2.1, 2.2, ... right-to-left, matching pick order.
      // Suppressed on the on-the-clock cell so it doesn't compete visually
      // with the "On the clock" label.
      if (!isCurrent) {
        html += '<span class="draft-board__pick-num">' + round + '.' + positionInRound + '</span>';
      }

      // Snake-order arrow in the gutter pointing at the next pick. In odd
      // rounds picks flow left→right (→); even rounds flow right→left (←);
      // at the end of every round the snake turns (↓). The final pick gets
      // no arrow since there's nothing after it.
      if (pickNum < totalPicks) {
        const lastInRound = positionInRound === n;
        let arrowDir;
        if (lastInRound)         arrowDir = 'down';
        else if (round % 2 === 1) arrowDir = 'right';
        else                      arrowDir = 'left';
        const arrowGlyph = arrowDir === 'right' ? '&rarr;'
                         : arrowDir === 'left'  ? '&larr;'
                         :                        '&darr;';
        html += '<span class="draft-board__arrow draft-board__arrow--' + arrowDir +
                '" aria-hidden="true">' + arrowGlyph + '</span>';
      }

      if (fighter) {
        const divLabel  = DIVISION_LABELS[fighter.primary_division] || fighter.primary_division;
        const divShort  = divisionAbbrev(fighter.primary_division);
        const rankLabel = fighter.is_champion
          ? 'Champion'
          : (fighter.current_rank ? '#' + fighter.current_rank : 'Unranked');
        const rankShort = fighter.is_champion
          ? 'C'
          : (fighter.current_rank ? '#' + fighter.current_rank : 'NR');
        // Mobile-only "F. LastName" form so the name fills the narrow cell
        // without truncation. CSS swaps between full / short based on width.
        const shortName = formatShortName(fighter.name);
        const photoHtml = fighter.photo_url
          ? '<img class="draft-board__cell-photo" src="' + escapeHtml(fighter.photo_url) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
          : '<div class="draft-board__cell-photo draft-board__cell-photo--placeholder"></div>';

        // Look up the actual draft_picks row to get its UUID — reactions
        // are keyed on draft_pick_id, not on the (league, pick_num) pair.
        // The pickMap value above is the fighter id; we need the pick row id.
        const pickRow = picks.find(function(p) { return p.draft_pick === pickNum; });
        const pickId  = pickRow ? pickRow.id : null;

        // Retrospective value badge — STEAL/VALUE/REACH chip showing how
        // the fighter's FV rank compared to the slot they were taken at.
        // Pinned to the top-left of the cell so it doesn't compete with
        // the pick number (top-right) or the reactions bar (bottom).
        const boardValueBadge = valuePickBadgeForPickHtml(fighter, pickNum);

        // Country flag emoji for the top-left of the cell. Only shows
        // on mobile (CSS-gated) since desktop cells already have the
        // photo for visual identity. typeof check keeps this safe if
        // country-flags.js isn't loaded on a given page.
        const flagGlyph = (typeof countryFlag === 'function')
          ? countryFlag(fighter.country)
          : '';

        html +=
          '<button class="draft-board__pick" data-open-fighter="' + pickMap[pickNum] + '">' +
            photoHtml +
            '<div class="draft-board__pick-info">' +
              '<span class="draft-board__pick-name draft-board__pick-name--full">' + escapeHtml(fighter.name) + '</span>' +
              '<span class="draft-board__pick-name draft-board__pick-name--short">' + escapeHtml(shortName) + '</span>' +
              '<span class="draft-board__pick-meta draft-board__pick-meta--full">' + escapeHtml(divLabel) + ' · ' + rankLabel + '</span>' +
              '<span class="draft-board__pick-meta draft-board__pick-meta--short">' + escapeHtml(divShort) + ' · ' + rankShort + '</span>' +
            '</div>' +
          '</button>' +
          (flagGlyph
            ? '<span class="draft-board__cell-flag" aria-hidden="true">' + flagGlyph + '</span>'
            : '') +
          (boardValueBadge
            ? '<span class="draft-board__cell-value-badge">' + boardValueBadge + '</span>'
            : '') +
          (pickReactionsEnabled && pickId && !isOptimisticPickId(pickId) ? renderPickReactionsBar(pickId) : '');
      } else if (isCurrent) {
        html += '<span class="draft-board__on-clock">On the clock</span>';
      }
      html += '</td>';
    }
    html += '</tr>';
  }

  html += '</tbody></table></div>';
  document.getElementById('draftBoard').innerHTML = html;

  // Restore the saved scroll position on the freshly-injected .draft-board
  // container. We re-query because the previous element was replaced.
  const newScrollContainer = document.getElementById('draftBoard').querySelector('.draft-board');
  if (newScrollContainer) {
    newScrollContainer.scrollTop  = savedScrollTop;
    newScrollContainer.scrollLeft = savedScrollLeft;
  }
}

// ========================================================================
// RENDER MY ROSTER
// Slot progress indicators (pip dots) + list of drafted fighters.
// ========================================================================
function renderMyRoster() {
  const myPickFighters = getMyPickFighters();

  // Slot assignment — same shape as checkRosterConstruction() in waivers.js.
  // Each men's division gets up to ROSTER_SLOTS_PER_DIVISION; all women's
  // divisions share a single Women's Flex slot; the rest spills into the
  // Any-Division Flex bucket (capped at ROSTER_FLEX_SLOTS).
  const inDiv = {};
  MENS_DIVISIONS.forEach(function(d) { inDiv[d] = []; });
  const womensFlex = [];
  const anyFlex    = [];

  myPickFighters.forEach(function(f) {
    var isWomens = WOMENS_DIVISIONS_KEYS.indexOf(f.primary_division) !== -1;
    if (isWomens) {
      if (womensFlex.length < ROSTER_WOMENS_FLEX_SLOTS) womensFlex.push(f);
      else anyFlex.push(f);
    } else if (inDiv[f.primary_division] && inDiv[f.primary_division].length < ROSTER_SLOTS_PER_DIVISION) {
      inDiv[f.primary_division].push(f);
    } else if (inDiv[f.primary_division] !== undefined) {
      anyFlex.push(f);
    }
  });

  document.getElementById('myPickCount').textContent = myPickFighters.length;
  // Keep the "/ N" total in sync with the league's actual roster size so the
  // header reads correctly when the commissioner has tuned it.
  var totalEl = document.getElementById('myRosterTotal');
  if (totalEl) totalEl.textContent = (league && league.roster_size) || ROSTER_SIZE_BASE;

  // Drafted fighters in pick order render FIRST so the user sees who
  // they've actually picked before scanning the slot-fullness dots.
  // The .draft-slots dot grid follows beneath as a summary view.
  let html = '<div class="draft-my-picks">';
  if (myPickFighters.length === 0) {
    html += EmptyState.html({
      kind:    'roster',
      title:   'No picks yet',
      body:    'Your drafted fighters will land here as the draft unfolds.',
      compact: true
    });
  } else {
    myPickFighters.forEach(function(f, idx) {
      const rankLabel = f.is_champion ? 'C' : (f.current_rank ? '#' + f.current_rank : 'NR');
      const rankClass = f.is_champion ? 'rank-champion' : (f.current_rank ? 'rank-ranked' : 'rank-unranked');
      const subBadge  = f.is_sub_champion && f.sub_title_type === 'interim'
                          ? '<span class="subrank-badge subrank-interim">INT</span>'
                        : f.is_sub_champion && f.sub_title_type === 'bmf'
                          ? '<span class="subrank-badge subrank-bmf">BMF</span>'
                          : '';
      const divLabel  = DIVISION_LABELS[f.primary_division] || f.primary_division;
      const photoHtml = f.photo_url
        ? '<img class="lineup-roster-row__photo" src="' + escapeHtml(f.photo_url) + '" alt="' + escapeHtml(f.name) + '" onerror="this.style.display=\'none\'">'
        : '';
      const champClass = f.is_champion ? ' draft-pool-row--champion' : '';
      html +=
        '<div class="lineup-roster-row draft-my-pick' + champClass + '">' +
          '<span class="draft-my-pick__num">' + (idx + 1) + '</span>' +
          '<div class="lineup-roster-row__photo-wrap">' + photoHtml + '</div>' +
          '<span class="lineup-roster-row__rank ' + rankClass + '">' + rankLabel + (typeof subBadge === 'string' ? subBadge : '') + '</span>' +
          '<div class="lineup-roster-row__info">' +
            '<button class="lineup-roster-row__name" data-open-fighter="' + f.id + '">' +
              escapeHtml(f.name) +
            '</button>' +
            '<span class="lineup-roster-row__division">' + escapeHtml(divLabel) + '</span>' +
          '</div>' +
        '</div>';
    });
  }
  html += '</div>';

  // Slot-fullness grid (dots) — summary of what's full vs unfilled.
  html += '<div class="draft-slots">';

  // 8 men's-division rows
  MENS_DIVISIONS.forEach(function(div) {
    html += '<div class="draft-slots__row">';
    html += '<span class="draft-slots__label">' + escapeHtml(DIVISION_LABELS[div]) + '</span>';
    html += '<span class="draft-slots__pips">' + renderPips(inDiv[div], ROSTER_SLOTS_PER_DIVISION) + '</span>';
    html += '</div>';
  });

  // Single Women's Flex row (pools all 3 women's divisions)
  html += '<div class="draft-slots__row">';
  html += '<span class="draft-slots__label">Women\'s Flex</span>';
  html += '<span class="draft-slots__pips">' + renderPips(womensFlex, ROSTER_WOMENS_FLEX_SLOTS) + '</span>';
  html += '</div>';

  // Any-flex pip count scales with the league's roster_size — see
  // getAnyFlexSlots(). Default leagues land on 6; custom leagues
  // (e.g., roster_size = 20) get 11 pips.
  var anyFlexCapDisplay = getAnyFlexSlots(league);
  html += '<div class="draft-slots__row">';
  html += '<span class="draft-slots__label">Any-Division Flex</span>';
  html += '<span class="draft-slots__pips">' + renderPips(anyFlex.slice(0, anyFlexCapDisplay), anyFlexCapDisplay) + '</span>';
  html += '</div>';

  html += '</div>';

  document.getElementById('myRoster').innerHTML = html;
}

// ========================================================================
// ROSTER NEEDS WIDGET
// Compact "Still need: ..." summary above the slot grid, plus a "Top
// remaining" smart suggestion: the highest-FV fighter who'd actually fit
// into one of the unfilled slot categories. The pip grid below gives a
// visual read of slot fullness; this widget gives a textual read AND a
// data-driven next-pick nudge.
// ========================================================================
function renderRosterNeeds() {
  var el = document.getElementById('rosterNeeds');
  if (!el) return;
  if (!league || !league.draft_started) { el.hidden = true; return; }

  // Reuse the same slot assignment renderMyRoster does so the two views
  // never disagree about what's full and what isn't.
  var myFighters = getMyPickFighters();
  var inDiv      = {};
  MENS_DIVISIONS.forEach(function(d) { inDiv[d] = []; });
  var womensFlex = [];
  var anyFlex    = [];
  myFighters.forEach(function(f) {
    var isWomens = WOMENS_DIVISIONS_KEYS.indexOf(f.primary_division) !== -1;
    if (isWomens) {
      if (womensFlex.length < ROSTER_WOMENS_FLEX_SLOTS) womensFlex.push(f);
      else anyFlex.push(f);
    } else if (inDiv[f.primary_division] && inDiv[f.primary_division].length < ROSTER_SLOTS_PER_DIVISION) {
      inDiv[f.primary_division].push(f);
    } else if (inDiv[f.primary_division] !== undefined) {
      anyFlex.push(f);
    }
  });

  // Unfilled per category. Men's divisions are listed individually because
  // each one is a distinct hole; women's flex and any-flex are pooled
  // because they're each a single conceptual slot type. Any-flex cap
  // adapts to league.roster_size via getAnyFlexSlots().
  var unfilledMens = MENS_DIVISIONS.filter(function(d) { return inDiv[d].length < ROSTER_SLOTS_PER_DIVISION; });
  var womensNeed   = Math.max(0, ROSTER_WOMENS_FLEX_SLOTS - womensFlex.length);
  var anyFlexNeed  = Math.max(0, getAnyFlexSlots(league)  - anyFlex.length);

  if (unfilledMens.length === 0 && womensNeed === 0 && anyFlexNeed === 0) {
    // Roster's construction-complete — no more "needs" to surface.
    el.hidden = true;
    return;
  }

  // Build the "Still need" line. Use the short slot label (FLY, BAN, ...)
  // for compactness — long division names would wrap on narrow panels.
  var parts = [];
  if (unfilledMens.length > 0) {
    parts.push(unfilledMens.length + ' men\'s (' + unfilledMens.map(shortSlotLabel).join(', ') + ')');
  }
  if (womensNeed  > 0) parts.push(womensNeed  + ' women\'s flex');
  if (anyFlexNeed > 0) parts.push(anyFlexNeed + ' any-flex');

  // Smart suggestion. Walk the FV-ranked list (highest first) and return
  // the first undrafted fighter who'd be a legal pick on the user's
  // current roster — same canPick() rules as the Draft button.
  var suggestion = '';
  if (typeof FantasyValue !== 'undefined' && FantasyValue.scoreFor) {
    var pickedIds  = new Set(picks.map(function(p) { return p.fighter_id; }));
    // Pull FV-scored fighters, sort by FV desc, find first that fits.
    var scored = [];
    for (var i = 0; i < allFighters.length; i++) {
      var f = allFighters[i];
      if (pickedIds.has(f.id)) continue;
      var s = FantasyValue.scoreFor(f.id);
      if (typeof s === 'number') scored.push({ f: f, s: s });
    }
    scored.sort(function(a, b) { return b.s - a.s; });
    for (var j = 0; j < scored.length; j++) {
      if (canPick(scored[j].f, myFighters)) {
        suggestion = scored[j].f.name + ' (' + scored[j].s.toFixed(1) + ' FV)';
        break;
      }
    }
  }

  el.hidden = false;
  el.innerHTML =
    '<div class="draft-roster-needs__line">' +
      '<span class="draft-roster-needs__label">Needs</span>' +
      '<span class="draft-roster-needs__text">' + escapeHtml(parts.join(' · ')) + '</span>' +
    '</div>' +
    (suggestion
      ? '<div class="draft-roster-needs__line draft-roster-needs__line--suggest">' +
          '<span class="draft-roster-needs__label">Top fit</span>' +
          '<span class="draft-roster-needs__text">' + escapeHtml(suggestion) + '</span>' +
        '</div>'
      : '');
}

// ========================================================================
// WHOLE ROSTER MODAL
// Single-screen sectioned view of every fighter on a team's draft roster.
// memberId is optional — defaults to the current user's roster. Pass any
// member's id (e.g., from a clicked draft-board column header) to view
// their roster instead. Uses the same whole-team-* styles already defined
// for the lineup page so the visual language stays consistent. Click any
// tile to open the existing fighter detail modal.
// ========================================================================
function showWholeRosterModal(memberId) {
  var existing = document.getElementById('wholeRosterModal');
  if (existing) existing.remove();

  var targetMemberId = memberId || myMemberId;
  var targetMember   = memberMap[targetMemberId];
  if (!targetMember) return;
  var isMyRoster     = (targetMemberId === myMemberId);
  var fighters       = picks
    .filter(function(p) { return p.league_member_id === targetMemberId; })
    .map(function(p) { return fighterMap[p.fighter_id]; })
    .filter(Boolean);

  // Group by slot (mirrors renderMyRoster + checkRosterConstruction): each
  // men's division gets one slot, all women's divisions share a single
  // Women's Flex slot, overflow goes to Any-Division Flex.
  var inDiv      = {};
  MENS_DIVISIONS.forEach(function(d) { inDiv[d] = []; });
  var womensFlex = [];
  var anyFlex    = [];

  fighters.forEach(function(f) {
    var isWomens = WOMENS_DIVISIONS_KEYS.indexOf(f.primary_division) !== -1;
    if (isWomens) {
      if (womensFlex.length < ROSTER_WOMENS_FLEX_SLOTS) womensFlex.push(f);
      else anyFlex.push(f);
    } else if (inDiv[f.primary_division] && inDiv[f.primary_division].length < ROSTER_SLOTS_PER_DIVISION) {
      inDiv[f.primary_division].push(f);
    } else if (inDiv[f.primary_division] !== undefined) {
      anyFlex.push(f);
    }
  });

  // Build a single ordered list of slot entries — 8 men's, 1 women's flex,
  // then enough any-flex slots to fit both the league's configured size
  // AND the actual picks (so overflow never gets silently truncated).
  // getAnyFlexSlots() handles the per-league math; the max-with-anyFlex.length
  // guard keeps post-draft trade/waiver inflation visible.
  var rosterTotal      = (league && league.roster_size) || ROSTER_SIZE_BASE;
  var anyFlexSlotCount = Math.max(getAnyFlexSlots(league), anyFlex.length);

  var slotEntries = [];
  MENS_DIVISIONS.forEach(function(div) {
    slotEntries.push({
      slotLabel: shortSlotLabel(div),
      tint:      null,
      fighter:   inDiv[div][0] || null
    });
  });
  for (var w = 0; w < ROSTER_WOMENS_FLEX_SLOTS; w++) {
    slotEntries.push({
      slotLabel:    'W-F',
      tint:         'womens',
      showDivision: true,
      fighter:      womensFlex[w] || null
    });
  }
  for (var a = 0; a < anyFlexSlotCount; a++) {
    slotEntries.push({
      slotLabel:    'ANY',
      tint:         'anyflex',
      showDivision: true,
      fighter:      anyFlex[a] || null
    });
  }

  var cellsHtml = slotEntries.map(renderRosterCell).join('');

  var eyebrowText = isMyRoster ? 'Whole Roster' : 'Team Roster';
  var titleText   = (isMyRoster ? 'My Picks' : escapeHtml(targetMember.team_name)) +
                    ' &middot; ' + fighters.length + ' / ' + rosterTotal;

  var modal = document.createElement('div');
  modal.id = 'wholeRosterModal';
  modal.className = 'fight-card-modal-overlay';
  modal.innerHTML =
    '<div class="fight-card-modal whole-team-modal" role="dialog" aria-modal="true" aria-label="Roster">' +
      '<div class="fight-card-modal__header">' +
        '<div>' +
          '<p class="fight-card-modal__eyebrow">' + eyebrowText + '</p>' +
          '<p class="fight-card-modal__title">' + titleText + '</p>' +
        '</div>' +
        '<button class="fight-card-modal__close" id="closeWholeRosterBtn" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="fight-card-modal__body whole-team-modal__body">' +
        '<div class="draft-roster-grid">' + cellsHtml + '</div>' +
      '</div>' +
    '</div>';

  document.body.appendChild(modal);

  document.getElementById('closeWholeRosterBtn').addEventListener('click', closeWholeRosterModal);
  modal.addEventListener('click', function(e) {
    if (e.target === modal) closeWholeRosterModal();
  });
  document.addEventListener('keydown', handleWholeRosterEscape);

  // Click a tile → open the existing fighter detail modal
  modal.querySelectorAll('[data-roster-tile-id]').forEach(function(tile) {
    tile.addEventListener('click', function() {
      var fid = tile.getAttribute('data-roster-tile-id');
      if (fid && typeof showFighterModal === 'function') showFighterModal(fid);
    });
  });
}

function closeWholeRosterModal() {
  var modal = document.getElementById('wholeRosterModal');
  if (modal) modal.remove();
  document.removeEventListener('keydown', handleWholeRosterEscape);
}

function handleWholeRosterEscape(e) {
  if (e.key === 'Escape') closeWholeRosterModal();
}

// Short slot label shown in the badge corner — keeps the layout dense while
// still telling the user which slot a tile occupies. Mirrors the abbreviations
// used informally elsewhere (FLY/BAN/.../LHW/HW); women's flex and any-flex
// get their own keys since they aren't divisions per se.
function shortSlotLabel(division) {
  switch (division) {
    case 'flyweight':         return 'FLY';
    case 'bantamweight':      return 'BAN';
    case 'featherweight':     return 'FEA';
    case 'lightweight':       return 'LIG';
    case 'welterweight':      return 'WEL';
    case 'middleweight':      return 'MID';
    case 'light_heavyweight': return 'LHW';
    case 'heavyweight':       return 'HW';
    default:                  return '';
  }
}

// One cell in the dense roster grid. Either a filled tile (with the same
// .whole-team-tile look the lineup modal uses) plus a slot-type badge in the
// top-right corner, or a dashed empty placeholder carrying the same badge
// so the user can still read what slot is unfilled.
function renderRosterCell(entry) {
  var badgeClass = 'draft-roster-tile__slot-badge';
  if (entry.tint === 'womens')  badgeClass += ' draft-roster-tile__slot-badge--womens';
  if (entry.tint === 'anyflex') badgeClass += ' draft-roster-tile__slot-badge--anyflex';
  var badgeHtml = '<span class="' + badgeClass + '">' + escapeHtml(entry.slotLabel) + '</span>';

  if (!entry.fighter) {
    return (
      '<div class="draft-roster-empty" aria-hidden="true">' +
        badgeHtml +
      '</div>'
    );
  }

  var f          = entry.fighter;
  var rankLabel  = f.is_champion ? 'C' : (f.current_rank ? '#' + f.current_rank : 'NR');
  var rawDiv     = DIVISION_LABELS[f.primary_division] || f.primary_division || '';
  // Strip the gender prefix — the slot badge already telegraphs it.
  var divLabel   = rawDiv.replace(/^Men's\s+/, '').replace(/^Women's\s+/, '');
  var photoHtml  = f.photo_url
    ? '<img class="whole-team-tile__photo" src="' + escapeHtml(f.photo_url) + '" alt="" onerror="this.style.display=\'none\'">'
    : '<div class="whole-team-tile__photo-placeholder"></div>';

  var classes = 'whole-team-tile';
  if (f.is_champion) classes += ' whole-team-tile--champion';

  return (
    '<button class="' + classes + '" data-roster-tile-id="' + f.id + '" type="button">' +
      '<div class="whole-team-tile__photo-wrap">' +
        photoHtml +
        '<span class="whole-team-tile__rank">' + escapeHtml(rankLabel) + '</span>' +
        badgeHtml +
      '</div>' +
      '<div class="whole-team-tile__info">' +
        '<p class="whole-team-tile__name" title="' + escapeHtml(f.name) + '">' + escapeHtml(f.name) + '</p>' +
        (entry.showDivision
          ? '<p class="whole-team-tile__div">' + escapeHtml(divLabel) + '</p>'
          : '') +
      '</div>' +
    '</button>'
  );
}

// Returns the fighter objects for the current user's picks, in pick order
function getMyPickFighters() {
  return picks
    .filter(function(p) { return p.league_member_id === myMemberId; })
    .map(function(p) { return fighterMap[p.fighter_id]; })
    .filter(Boolean);
}

// Renders dot indicators for a slot category. Each dot reflects the tier
// of the fighter occupying that slot, or shows an empty/outline state if
// the slot isn't filled:
//   champion   → gold
//   ranked     → crimson
//   unranked   → muted gray fill
//   empty slot → hollow outline
// Lets you scan your roster and instantly see slot strength per division.
function renderPips(fighters, total) {
  let html = '';
  for (let i = 0; i < total; i++) {
    const f = fighters[i];
    let cls = 'pip';
    if (!f)                       cls += ' pip-empty';
    else if (f.is_champion)       cls += ' pip-tier-champion';
    else if (f.current_rank)      cls += ' pip-tier-ranked';
    else                          cls += ' pip-tier-unranked';
    html += '<span class="' + cls + '"></span>';
  }
  return html;
}

// ========================================================================
// POPULATE DIVISION FILTER DROPDOWN
// ========================================================================
function populateDivisionFilter() {
  const select = document.getElementById('divisionFilter');

  // Women's divisions first, then men's
  WOMENS_DIVISIONS.concat(MENS_DIVISIONS).forEach(function(div) {
    const opt = document.createElement('option');
    opt.value = div;
    opt.textContent = DIVISION_LABELS[div];
    select.appendChild(opt);
  });

  select.addEventListener('change', function() {
    divisionFilter = this.value;
    renderFighterPool();
  });

  document.getElementById('fighterSearch').addEventListener('input', function() {
    searchQuery = this.value.trim();
    renderFighterPool();
  });

  document.getElementById('statusFilter').addEventListener('change', function() {
    statusFilter = this.value;
    renderFighterPool();
  });

  document.getElementById('sortBy').addEventListener('change', function() {
    sortBy = this.value;
    renderFighterPool();
  });
}

// ========================================================================
// DRAFT QUEUE
// Personal pre-draft list of fighters this user wants to target. Reads
// from / writes to public.draft_queue. Auto-cleaned by a Postgres trigger
// on draft_picks insert; we mirror that with a realtime subscription so
// the UI reflects "fighter X just got drafted, removing from your queue"
// without a manual refresh.
// ========================================================================

async function loadQueue() {
  const { data, error } = await supabaseClient
    .from('draft_queue')
    .select('fighter_id, position')
    .eq('league_member_id', myMemberId)
    .order('position');
  if (error) {
    console.warn('[queue] load failed:', error.message);
    queue = [];
    return;
  }
  queue = data || [];
}

function isQueued(fighterId) {
  return queue.some(function(q) { return q.fighter_id === fighterId; });
}

// Insert at the end of the queue. Position = max(existing) + 1 so we
// don't collide with existing rows. The DB unique key (member, fighter)
// prevents a double-add.
async function addToQueue(fighterId) {
  if (isQueued(fighterId)) return;
  // Skip if the fighter has already been drafted (shouldn't happen
  // because we hide the toggle in that case, but defensive)
  if (picks.some(function(p) { return p.fighter_id === fighterId; })) return;

  const nextPos = queue.length === 0
    ? 1
    : (queue[queue.length - 1].position + 1);

  const { error } = await supabaseClient.from('draft_queue').insert({
    league_id:        leagueId,
    league_member_id: myMemberId,
    fighter_id:       fighterId,
    position:         nextPos
  });
  if (error) {
    console.warn('[queue] add failed:', error.message);
    return;
  }
  // Optimistic local update — realtime will eventually mirror, but the
  // user expects immediate feedback when they click.
  queue.push({ fighter_id: fighterId, position: nextPos });
  renderFighterPool();
  renderQueue();
  // Keep the View All modal button label in sync when the queue was toggled
  // from inside the modal. No-op if the modal isn't open.
  if (document.getElementById('viewAllOverlay')) renderViewAllList();
}

async function removeFromQueue(fighterId) {
  const { error } = await supabaseClient
    .from('draft_queue')
    .delete()
    .eq('league_member_id', myMemberId)
    .eq('fighter_id', fighterId);
  if (error) {
    console.warn('[queue] remove failed:', error.message);
    return;
  }
  queue = queue.filter(function(q) { return q.fighter_id !== fighterId; });
  renderFighterPool();
  renderQueue();
  if (document.getElementById('viewAllOverlay')) renderViewAllList();
}

// Move a queue entry up (delta -1) or down (delta +1). Does this by
// swapping positions with the adjacent neighbor. We update both rows
// in two sequential UPDATEs — small race window if the user clicks
// twice rapidly, but acceptable for a personal queue.
async function reorderQueue(fighterId, delta) {
  const idx = queue.findIndex(function(q) { return q.fighter_id === fighterId; });
  if (idx === -1) return;
  const target = idx + delta;
  if (target < 0 || target >= queue.length) return;

  const a = queue[idx];
  const b = queue[target];

  // Swap positions in the DB via two updates. We assign each to a
  // temporary high value first to avoid the (member, position) collisions
  // — but since there's no unique constraint on position itself, we can
  // just swap directly.
  const errA = (await supabaseClient.from('draft_queue').update({ position: b.position })
    .eq('league_member_id', myMemberId).eq('fighter_id', a.fighter_id)).error;
  const errB = (await supabaseClient.from('draft_queue').update({ position: a.position })
    .eq('league_member_id', myMemberId).eq('fighter_id', b.fighter_id)).error;
  if (errA || errB) {
    console.warn('[queue] reorder failed:', errA || errB);
    // Reload to be safe — local state may be inconsistent.
    await loadQueue();
    renderQueue();
    return;
  }

  // Swap locally
  const tmp = a.position; a.position = b.position; b.position = tmp;
  queue.sort(function(x, y) { return x.position - y.position; });
  renderQueue();
}

// Render the queue panel. Called from renderAll so it stays in sync with
// every other render path (pick made, queue changed, etc.).
function renderQueue() {
  const listEl  = document.getElementById('queueList');
  const countEl = document.getElementById('queueCount');
  const hintEl  = document.getElementById('queueHint');
  if (!listEl) return;

  countEl.textContent = queue.length;
  hintEl.textContent  = queue.length === 0
    ? 'Empty'
    : (isMyTurn() ? 'Your pick — draft from queue or pool' : 'Queued for upcoming picks');

  if (queue.length === 0) {
    listEl.innerHTML = EmptyState.html({
      kind:    'roster',
      title:   'Queue is empty',
      body:    'Add fighters here while waiting for your turn. They auto-clear when drafted.',
      compact: true
    });
    return;
  }

  const myTurn         = isMyTurn() && !picking;
  const myPickFighters = getMyPickFighters();

  let html = '';
  queue.forEach(function(q, idx) {
    const f = fighterMap[q.fighter_id];
    if (!f) return; // fighter not in cache (shouldn't happen)

    const rankLabel = f.is_champion ? 'C' : (f.current_rank ? '#' + f.current_rank : 'NR');
    const rankClass = f.is_champion ? 'rank-champion' : (f.current_rank ? 'rank-ranked' : 'rank-unranked');
    const subBadge  = f.is_sub_champion && f.sub_title_type === 'interim'
                        ? '<span class="subrank-badge subrank-interim">INT</span>'
                      : f.is_sub_champion && f.sub_title_type === 'bmf'
                        ? '<span class="subrank-badge subrank-bmf">BMF</span>'
                        : '';
    const divLabel  = DIVISION_LABELS[f.primary_division] || f.primary_division;

    // When it's my turn AND the fighter is a legal pick, the queue row
    // gets a "Pick" shortcut that drafts them straight from the queue.
    let pickShortcut = '';
    if (myTurn && canPick(f, myPickFighters)) {
      pickShortcut = '<button class="btn-primary lineup-row-btn draft-queue-pick-btn" ' +
                       'data-queue-pick-id="' + f.id + '">Pick</button>';
    }

    const upDisabled   = idx === 0                  ? ' disabled' : '';
    const downDisabled = idx === queue.length - 1   ? ' disabled' : '';

    html +=
      '<div class="lineup-roster-row draft-queue-row">' +
        '<span class="draft-queue-row__pos">' + (idx + 1) + '</span>' +
        '<span class="lineup-roster-row__rank ' + rankClass + '">' + escapeHtml(rankLabel) + (typeof subBadge === 'string' ? subBadge : '') + '</span>' +
        '<div class="lineup-roster-row__info">' +
          '<button class="lineup-roster-row__name" data-open-fighter="' + f.id + '">' +
            escapeHtml(f.name) +
          '</button>' +
          '<span class="lineup-roster-row__division">' + escapeHtml(divLabel) + '</span>' +
        '</div>' +
        '<div class="draft-queue-row__controls">' +
          '<button class="draft-queue-row__arrow" data-queue-up="' + f.id + '"' + upDisabled + ' aria-label="Move up">&#9650;</button>' +
          '<button class="draft-queue-row__arrow" data-queue-down="' + f.id + '"' + downDisabled + ' aria-label="Move down">&#9660;</button>' +
        '</div>' +
        pickShortcut +
        '<button class="draft-queue-row__remove" data-queue-remove="' + f.id + '" aria-label="Remove from queue">&times;</button>' +
      '</div>';
  });

  listEl.innerHTML = html;

  // Wire row interactions
  listEl.querySelectorAll('[data-queue-up]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      reorderQueue(btn.getAttribute('data-queue-up'), -1);
    });
  });
  listEl.querySelectorAll('[data-queue-down]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      reorderQueue(btn.getAttribute('data-queue-down'), +1);
    });
  });
  listEl.querySelectorAll('[data-queue-remove]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      removeFromQueue(btn.getAttribute('data-queue-remove'));
    });
  });
  listEl.querySelectorAll('.draft-queue-pick-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const fighter = fighterMap[btn.getAttribute('data-queue-pick-id')];
      if (fighter) makePick(fighter);
    });
  });
}

// Subscribe to changes on draft_queue for THIS user. Insert + delete are
// the only events we care about. RLS ensures we only see our own rows.
// The trigger that auto-removes on pick will fire deletes here; we react
// by trimming the local cache.
function subscribeToQueue() {
  supabaseClient
    .channel('draft_queue_' + leagueId + '_' + myMemberId)
    .on('postgres_changes', {
      event:  '*',
      schema: 'public',
      table:  'draft_queue',
      filter: 'league_member_id=eq.' + myMemberId
    }, function(payload) {
      // INSERT: append if not already present (we do optimistic adds locally)
      // DELETE: drop the matching row.
      // UPDATE: update position; re-sort.
      if (payload.eventType === 'INSERT') {
        const row = payload.new;
        if (!queue.some(function(q) { return q.fighter_id === row.fighter_id; })) {
          queue.push({ fighter_id: row.fighter_id, position: row.position });
          queue.sort(function(a, b) { return a.position - b.position; });
        }
      } else if (payload.eventType === 'DELETE') {
        const row = payload.old;
        queue = queue.filter(function(q) { return q.fighter_id !== row.fighter_id; });
      } else if (payload.eventType === 'UPDATE') {
        const row = payload.new;
        const item = queue.find(function(q) { return q.fighter_id === row.fighter_id; });
        if (item) {
          item.position = row.position;
          queue.sort(function(a, b) { return a.position - b.position; });
        }
      }
      renderQueue();
      renderFighterPool();
    })
    .subscribe();
}

// ========================================================================
// PRE-DRAFT (LOBBY) STATE
// When the draft is scheduled but not yet started, the room renders just
// like an active draft — empty board, all fighters available, queue
// editable — except the status bar shows a countdown instead of a turn
// indicator, and pick attempts alert "draft hasn't started yet."
// ========================================================================

let predraftCountdownInterval = null;

// Updates the .draft-status__pre span (rendered by renderHeader) once
// per second so the countdown ticks. We update only the text node, not
// the whole turnInfo, to avoid flashing the surrounding text.
function startPredraftCountdown() {
  stopPredraftCountdown();
  predraftCountdownInterval = setInterval(function() {
    const el       = document.querySelector('.draft-status__pre');
    const lobbyEl  = document.getElementById('draftLobbyCountdown');
    // turnInfo moved past pre-draft state AND the lobby is gone too →
    // nothing more to update, stop ticking.
    if (!el && !lobbyEl) {
      stopPredraftCountdown();
      return;
    }
    const text = formatCountdown(league.draft_scheduled_at);
    if (el)      el.textContent      = text;
    if (lobbyEl) lobbyEl.textContent = text;
  }, 1000);
}

// ========================================================================
// CINEMATIC PRE-DRAFT LOBBY
// Full-bleed overlay shown while the draft is scheduled but not yet
// started. Big countdown, league name, draft order with team avatars.
// The countdown text is updated by startPredraftCountdown so we don't
// need a second interval here. Re-renders idempotently on every header
// pass — cheap because the DOM is small (8 avatars + some text).
// ========================================================================
function renderDraftLobby() {
  var el = document.getElementById('draftLobby');
  if (!el || !league) return;

  // Populate header bits
  var nameEl = document.getElementById('draftLobbyLeagueName');
  if (nameEl) nameEl.textContent = league.name || 'Draft Room';

  var countdownEl = document.getElementById('draftLobbyCountdown');
  if (countdownEl) countdownEl.textContent = formatCountdown(league.draft_scheduled_at);

  var schedEl = document.getElementById('draftLobbyScheduled');
  if (schedEl) schedEl.textContent = formatScheduledLocal(league.draft_scheduled_at);

  // "8 managers · 17 rounds · 90s per pick" — rules summary footer
  var rulesEl = document.getElementById('draftLobbyRules');
  if (rulesEl) {
    var n          = (league.draft_order && league.draft_order.length) || 0;
    var rounds     = league.roster_size || ROSTER_SIZE_BASE;
    var perPickSec = league.pick_timer_seconds || 90;
    rulesEl.textContent =
      n + ' manager' + (n === 1 ? '' : 's') + ' · ' +
      rounds + ' rounds · ' +
      perPickSec + 's per pick';
  }

  // Draft-order grid. Each tile = pick number · initials avatar (team
  // accent) · team name. League.draft_order is the authoritative source —
  // members may include people not on the order list (rare, but possible
  // if commissioner added someone after locking the order).
  var orderEl = document.getElementById('draftLobbyOrder');
  if (orderEl) {
    var html = '';
    (league.draft_order || []).forEach(function(memberId, idx) {
      var member = memberMap[memberId];
      var name   = member ? member.team_name : '?';
      var accent = teamColor(memberId);
      var isMe   = memberId === myMemberId;
      var initials = (name || '?').split(/\s+/).map(function(w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
      var isPresent = presentMemberIds.has(memberId);
      var presenceCls = 'draft-presence-dot draft-presence-dot--' + (isPresent ? 'on' : 'off');
      html +=
        '<div class="draft-lobby-pick' + (isMe ? ' draft-lobby-pick--mine' : '') + '" style="--team-accent: ' + accent + '">' +
          '<span class="draft-lobby-pick__num">' + (idx + 1) + '</span>' +
          '<span class="draft-lobby-pick__avatar">' + escapeHtml(initials) +
            '<span class="' + presenceCls + ' draft-lobby-pick__presence" title="' + (isPresent ? 'Connected' : 'Offline') + '"></span>' +
          '</span>' +
          '<span class="draft-lobby-pick__name">' + escapeHtml(name) + '</span>' +
        '</div>';
    });
    orderEl.innerHTML = html;
  }

  el.hidden = false;
}

function stopPredraftCountdown() {
  if (predraftCountdownInterval) {
    clearInterval(predraftCountdownInterval);
    predraftCountdownInterval = null;
  }
}

// Watch the leagues row so the room reacts to schedule changes and to
// the draft actually starting. Three transitions to handle:
//   * draft_started flips true → reload to enter the live draft cleanly
//     (picks subscription, queue mirror trigger, etc. all get a fresh start)
//   * draft_scheduled_at changes (commish edited it) → update local state
//     and re-render the header so the new time shows
//   * draft_scheduled_at cleared while still not started → bounce back to
//     the league page (no schedule = nothing to show in the room)
function subscribeToLobbyFlip() {
  supabaseClient
    .channel('lobby_' + leagueId)
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'leagues',
      filter: 'id=eq.' + leagueId
    }, function(payload) {
      const updated = payload.new;

      if (updated.draft_started) {
        window.location.reload();
        return;
      }

      if (updated.draft_scheduled_at !== league.draft_scheduled_at) {
        league.draft_scheduled_at = updated.draft_scheduled_at;
        if (!league.draft_scheduled_at) {
          window.location.href = 'league.html?id=' + leagueId;
          return;
        }
        renderHeader();
      }
    })
    .subscribe();
}

// "Mon, Apr 28 at 7:30 PM" in the viewer's local timezone. Mirrors the
// helper of the same name in league.js — kept here so draft.js doesn't
// have to depend on league.js being loaded.
function formatScheduledLocal(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const datePart = d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric'
  });
  const timePart = d.toLocaleTimeString(undefined, {
    hour: 'numeric', minute: '2-digit'
  });
  return datePart + ' at ' + timePart;
}

// "Starts in 1d 2h 3m 4s" / "Starts in 12s" / "Starting..."
function formatCountdown(iso) {
  const target = new Date(iso).getTime();
  const diffMs = target - Date.now();
  if (diffMs <= 0) return 'Starting...';

  const totalSec = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSec / 86400);
  const hrs  = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  let parts = [];
  if (days > 0)                          parts.push(days + 'd');
  if (days > 0 || hrs  > 0)              parts.push(hrs  + 'h');
  if (days > 0 || hrs  > 0 || mins > 0)  parts.push(mins + 'm');
  parts.push(secs + 's');
  return 'Starts in ' + parts.join(' ');
}

// ========================================================================
// COMMISSIONER CONTROLS
// Pause/resume, undo last pick, clear board. Visible to the primary
// commissioner and any co-commissioner. The destructive actions go through
// SECURITY DEFINER RPCs (see sql/2026-04-26_draft_commish_controls.sql) so
// the deletes can bypass RLS while still being authorized server-side.
// ========================================================================

// True if the viewing user is the primary commissioner OR a co-commissioner.
function isCommish() {
  if (!members || !user) return false;
  if (league.commissioner_id === user.id) return true;
  const myMember = members.find(function(m) { return m.user_id === user.id; });
  return !!(myMember && myMember.is_commissioner);
}

function initCommishTools() {
  const tools = document.getElementById('draftCommishTools');
  if (!tools) return;
  tools.hidden = false;

  document.getElementById('commishPauseBtn').addEventListener('click', toggleDraftPause);
  document.getElementById('commishUndoBtn').addEventListener('click', undoLastPick);
  document.getElementById('commishClearBtn').addEventListener('click', clearDraftBoard);

  // Initial label sync (in case we loaded into a paused draft)
  refreshCommishToolbar();

  // The toolbar just took ~38px of vertical space — resync the room
  // height so the bottom panels shrink to fit.
  if (typeof window.syncDraftRoomHeight === 'function') {
    window.syncDraftRoomHeight();
  }
}

// Updates the Pause/Resume button label based on current pause state.
// Called on init and after every leagues UPDATE delivered via realtime.
function refreshCommishToolbar() {
  const pauseBtn = document.getElementById('commishPauseBtn');
  if (!pauseBtn) return;
  pauseBtn.textContent = league.draft_paused_at ? 'Resume Draft' : 'Pause Draft';
}

async function toggleDraftPause() {
  const pausing = !league.draft_paused_at;
  const btn = document.getElementById('commishPauseBtn');
  btn.disabled = true;

  const { error } = await supabaseClient
    .from('leagues')
    .update({ draft_paused_at: pausing ? new Date().toISOString() : null })
    .eq('id', leagueId);

  btn.disabled = false;
  if (error) {
    alert('Error toggling pause: ' + error.message);
    return;
  }
  // Realtime will fire on the leagues UPDATE and call refreshCommishToolbar
  // for everyone, but we also update local state immediately for snappy UI.
  league.draft_paused_at = pausing ? new Date().toISOString() : null;
  refreshCommishToolbar();
  renderHeader();
}

async function undoLastPick() {
  if (picks.length === 0) {
    alert('No picks to undo yet.');
    return;
  }
  // Show the most recent pick in the prompt so the commish knows what
  // they're about to undo.
  const lastPick = picks[picks.length - 1];
  const fighter  = fighterMap[lastPick.fighter_id];
  const member   = memberMap[lastPick.league_member_id];
  const desc     = (fighter ? fighter.name : 'Unknown') +
                   ' (drafted by ' + (member ? member.team_name : 'unknown') + ')';
  if (!confirm('Undo last pick — ' + desc + '?')) return;

  const btn = document.getElementById('commishUndoBtn');
  btn.disabled = true;
  btn.textContent = 'Undoing...';

  const { error } = await supabaseClient.rpc('revert_last_draft_pick', {
    p_league_id: leagueId
  });

  btn.disabled = false;
  btn.textContent = 'Undo Last Pick';

  if (error) {
    alert('Error reverting pick: ' + error.message);
    return;
  }
  // The DELETE on draft_picks fires realtime, which calls handlePickDelete
  // for everyone. Local state updates there.
}

async function clearDraftBoard() {
  // Two-step confirmation since this wipes the whole board. The second
  // prompt asks for the league name to make accidental clears very hard.
  if (!confirm('Clear the entire draft board? This deletes every pick and cannot be undone.')) return;
  const typed = prompt('Type the league name to confirm: "' + league.name + '"');
  if (typed === null) return;
  if (typed.trim() !== league.name) {
    alert('League name did not match. Aborted.');
    return;
  }

  const btn = document.getElementById('commishClearBtn');
  btn.disabled = true;
  btn.textContent = 'Clearing...';

  const { error } = await supabaseClient.rpc('clear_draft_board', {
    p_league_id: leagueId
  });

  btn.disabled = false;
  btn.textContent = 'Clear Board';

  if (error) {
    alert('Error clearing board: ' + error.message);
    return;
  }
  // We just deleted every draft_picks row. Each delete fires realtime, but
  // bulk deletes can be flaky to track row-by-row, so resync from the DB
  // directly to be safe.
  const { data: freshPicks } = await supabaseClient
    .from('draft_picks')
    .select('*')
    .eq('league_id', leagueId)
    .order('draft_pick');
  picks = freshPicks || [];
  league.draft_completed = false;
  picking = false;
  renderAll();
}

// ========================================================================
// LEAGUES REALTIME (live draft)
// Watches the leagues row for pause/resume/clear changes during an active
// draft. Pre-draft uses subscribeToLobbyFlip for the start flip; this is
// the equivalent for the live phase.
// ========================================================================
function subscribeToLeagueChanges() {
  supabaseClient
    .channel('league_live_' + leagueId)
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'leagues',
      filter: 'id=eq.' + leagueId
    }, function(payload) {
      const updated = payload.new;
      const wasPaused = !!league.draft_paused_at;
      const isPaused  = !!updated.draft_paused_at;
      league.draft_paused_at = updated.draft_paused_at;
      league.draft_completed = updated.draft_completed;

      // Re-render header so the timer reflects pause state, and update
      // the commish toolbar label if the viewer is a commish.
      refreshCommishToolbar();
      renderHeader();

      // If draft_completed flipped (rare during live, but the clear-board
      // RPC un-completes it), re-render the whole room.
      if (wasPaused !== isPaused) {
        renderFighterPool();
      }
    })
    .subscribe();
}

// ========================================================================
// HELPERS
// ========================================================================
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

initDraft();
