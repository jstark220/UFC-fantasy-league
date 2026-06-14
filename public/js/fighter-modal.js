// ========================================================================
// FIGHTER MODAL
// Shows a fighter's profile in an overlay modal. Can be included on any
// page that needs it. Call showFighterModal(fighterId) to open.
//
// Depends on: supabaseClient (supabase-config.js), escapeHtml if already
// defined on the page (falls back to an inline version if not).
// ========================================================================

// Most recently fetched league.scoring_config — captured per-modal-open and
// passed to the shared Scoring engine. Null is fine; the engine falls back
// to v1.2 defaults.
var _modalScoringConfig = null;
// Polymarket odds for this fighter's next fight, when available. Loaded
// alongside the main fetch in showFighterModal and consumed by the hero
// 'Next fight' line via FightOdds.chipHtml.
var _modalFightOdds = null;
// Projected fantasy points for this fighter's next fight (if it has odds —
// projections only exist for fights with Polymarket data).
var _modalProjection = null;
// Fantasy value composite score + global rank for THIS fighter. Computed
// from every completed fight in the DB via FantasyValue.ensureLoaded.
var _modalFvScore = null;
var _modalFvRank  = null;

var FIGHTER_MODAL_DIVISION_LABELS = {
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

var FIGHTER_MODAL_OUTCOME_LABELS = {
  ko_tko:     'KO/TKO',
  submission: 'Submission',
  decision_u: 'Decision (U)',
  decision_s: 'Decision (S)',
  decision_m: 'Decision (M)',
  dq:         'DQ',
  no_contest: 'No Contest',
  draw:       'Draw'
};

// ========================================================================
// OPEN MODAL
// ========================================================================
async function showFighterModal(fighterId) {
  // Remove any existing instance
  var existing = document.getElementById('fighterModal');
  if (existing) existing.remove();

  // Create a loading state overlay immediately so the user gets feedback
  var overlay = document.createElement('div');
  overlay.id = 'fighterModal';
  overlay.className = 'fighter-modal-overlay';
  overlay.innerHTML =
    '<div class="fighter-modal" role="dialog" aria-modal="true">' +
      '<div class="fighter-modal__loading">Loading fighter...</div>' +
    '</div>';
  document.body.appendChild(overlay);

  // Close on overlay click
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeFighterModal();
  });
  document.addEventListener('keydown', _fighterModalEscapeHandler);

  // If this page is in league context (most pages are: ?id=LEAGUE_ID), look
  // up whether the fighter is currently rostered. Drives the Propose Trade
  // CTA — only shown when the fighter is on someone's roster in this league.
  var pageLeagueId = new URLSearchParams(window.location.search).get('id');

  // Fetch fighter + fights (+ optional ownership) in parallel
  var fetchPromises = [
    supabaseClient
      .from('fighters')
      .select('id, name, nickname, primary_division, current_rank, is_champion, is_sub_champion, sub_title_type, record_wins, record_losses, record_draws, photo_url, country, age')
      .eq('id', fighterId)
      .single(),

    supabaseClient
      .from('fight_results')
      .select('*, event:ufc_events(id, name, event_date)')
      .or('fighter_a_id.eq.' + fighterId + ',fighter_b_id.eq.' + fighterId)
  ];

  if (pageLeagueId) {
    fetchPromises.push(
      supabaseClient
        .from('rosters')
        .select('league_member_id')
        .eq('league_id', pageLeagueId)
        .eq('fighter_id', fighterId)
        .maybeSingle(),
      // We also need the league's draft state so we can swap CTAs:
      //   * during an active draft → "Draft" button (only appears on the
      //     draft page, where window.makePick exists)
      //   * after the draft        → "Propose Trade" button
      //   * never both at once
      supabaseClient
        .from('leagues')
        .select('draft_started, draft_completed, scoring_config')
        .eq('id', pageLeagueId)
        .single()
    );
  }

  var results = await Promise.all(fetchPromises);

  var fighterRes   = results[0];
  var fightsRes    = results[1];
  var ownershipRes = results[2] || null;
  var leagueRes    = results[3] || null;
  var ownerMemberId   = (ownershipRes && ownershipRes.data) ? ownershipRes.data.league_member_id : null;
  var draftCompleted  = !!(leagueRes && leagueRes.data && leagueRes.data.draft_completed);
  var draftActive     = !!(leagueRes && leagueRes.data && leagueRes.data.draft_started && !leagueRes.data.draft_completed);

  // Stash this league's scoring_config in module scope so the score-rendering
  // helpers below can use it without re-threading it through every call.
  // Null when the modal is opened on a page without league context — the
  // engine's null-safe path falls back to v1.2 defaults.
  _modalScoringConfig = (leagueRes && leagueRes.data && leagueRes.data.scoring_config) || null;

  // Load Polymarket odds + projected points for this fighter. Both are
  // small lookups (single-row equiv) and quick enough to await before
  // rendering. Fantasy Value is heavier (loads every completed fight in
  // the DB to compute the league mean) — kicked off in parallel but its
  // result is patched into the rendered modal *after* paint.
  _modalFightOdds  = null;
  _modalProjection = null;
  _modalFvScore    = null;
  _modalFvRank     = null;
  var fvLoadPromise = (typeof FantasyValue !== 'undefined')
    ? FantasyValue.ensureLoaded(pageLeagueId, _modalScoringConfig).catch(function () { return null; })
    : Promise.resolve(null);
  // League team that rosters this fighter (null = free agent / no league
  // context). Fetched in parallel below so it adds no latency, and kept
  // separate from the rosters/CTA logic above so it can never break the
  // Propose Trade button.
  var ownerTeamName = null;
  try {
    var [oddsMap, projMap, teamRes] = await Promise.all([
      typeof FightOdds   !== 'undefined' ? FightOdds.loadFightOdds([fighterId]) : {},
      typeof Projections !== 'undefined' ? Projections.load([fighterId])        : {},
      ownerMemberId
        ? supabaseClient.from('league_members').select('team_name').eq('id', ownerMemberId).maybeSingle()
        : Promise.resolve(null)
    ]);
    _modalFightOdds  = oddsMap[fighterId] || null;
    _modalProjection = projMap[fighterId] || null;
    ownerTeamName    = (teamRes && teamRes.data) ? teamRes.data.team_name : null;
  } catch (_e) { /* all optional */ }

  if (fighterRes.error || !fighterRes.data) {
    document.querySelector('#fighterModal .fighter-modal').innerHTML =
      '<div class="fighter-modal__loading">Fighter not found.' +
      '<br><button class="btn-ghost" style="margin-top:1rem" onclick="closeFighterModal()">Close</button></div>';
    return;
  }

  var fighter = fighterRes.data;
  var fights  = fightsRes.data || [];

  // Sort newest first by event date (PostgREST can't easily order by a joined table column)
  fights.sort(function(a, b) {
    var dA = a.event && a.event.event_date ? new Date(a.event.event_date).getTime() : 0;
    var dB = b.event && b.event.event_date ? new Date(b.event.event_date).getTime() : 0;
    return dB - dA;
  });

  // Fetch opponent names
  var opponentMap = {};
  if (fights.length > 0) {
    var opponentIds = fights.map(function(f) {
      return f.fighter_a_id === fighterId ? f.fighter_b_id : f.fighter_a_id;
    }).filter(function(id, i, arr) { return arr.indexOf(id) === i; });

    var opRes = await supabaseClient.from('fighters').select('id, name').in('id', opponentIds);
    (opRes.data || []).forEach(function(o) { opponentMap[o.id] = o.name; });
  }

  // Replace loading state with real content
  document.querySelector('#fighterModal .fighter-modal').outerHTML =
    buildFighterModalHtml(fighter, fights, fighterId, opponentMap, {
      leagueId:        pageLeagueId,
      ownerMemberId:   ownerMemberId,
      ownerTeamName:   ownerTeamName,
      draftCompleted:  draftCompleted,
      draftActive:     draftActive
    });

  // Re-query since we replaced the element
  document.getElementById('closeFighterModalBtn').addEventListener('click', closeFighterModal);

  // Wire the Propose Trade button (only present when ownerMemberId is known)
  var tradeBtn = document.getElementById('fighterModalTradeBtn');
  if (tradeBtn) {
    tradeBtn.addEventListener('click', function() {
      var url = 'trades.html?id=' + encodeURIComponent(pageLeagueId) +
                '&withFighter=' + encodeURIComponent(fighterId);
      window.location.href = url;
    });
  }

  // Wire the Queue toggle button (only present on the draft page).
  // Async because addToQueue / removeFromQueue both await a Supabase call;
  // we update the button label after the call resolves so the visible
  // state matches the actual queue.
  var queueBtn = document.getElementById('fighterModalQueueBtn');
  if (queueBtn) {
    queueBtn.addEventListener('click', async function() {
      var id = queueBtn.getAttribute('data-queue-fighter');
      queueBtn.disabled = true;
      if (window.isQueued(id)) {
        await window.removeFromQueue(id);
      } else {
        await window.addToQueue(id);
      }
      queueBtn.disabled = false;
      var nowQueued = window.isQueued(id);
      var nextIcon = nowQueued
        ? '<svg class="modal-cta__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M4 7h11" /><path d="M4 12h11" /><path d="M4 17h7" />' +
            '<circle cx="18" cy="17" r="4" /><path d="m16 17 1.5 1.5L20 16" />' +
          '</svg>'
        : '<svg class="modal-cta__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M4 7h11" /><path d="M4 12h11" /><path d="M4 17h7" />' +
            '<circle cx="18" cy="17" r="4" /><path d="M16 17h4" /><path d="M18 15v4" />' +
          '</svg>';
      queueBtn.innerHTML = nextIcon + '<span>' + (nowQueued ? 'Queued' : 'Queue') + '</span>';
      queueBtn.classList.toggle('modal-cta--queued', nowQueued);
    });
  }

  // Wire click + keyboard handlers on every Pts cell so the per-fight
  // score breakdown row beneath each fight can expand/collapse. Scoped
  // to the fighter-modal node so it only finds toggles inside the modal.
  var modalRoot = document.querySelector('#fighterModal .fighter-modal');
  if (modalRoot) ScoreBreakdown.wireToggles(modalRoot);

  // Fetch the Polymarket price-history series and render the chart into
  // the placeholder. Async + non-blocking so the modal paints first; if
  // the fetch fails (CORS, network, no data), the slot stays empty.
  var chartSlot = document.getElementById('fighterModalOddsChart');
  if (chartSlot && _modalFightOdds && _modalFightOdds.fighterTokenId && typeof FightOdds !== 'undefined') {
    FightOdds.loadPriceHistory(_modalFightOdds.fighterTokenId).then(function (hist) {
      // Guard: user may have closed/reopened the modal before this resolved.
      if (!document.body.contains(chartSlot)) return;
      if (!hist || hist.length < 2) return;
      chartSlot.innerHTML = FightOdds.chartSvg(hist);
    });
  }

  // Fantasy Value populates asynchronously — when the FV cache load
  // finishes, swap the loading placeholder for the real tile and wire its
  // click handler. If the load failed or the fighter has no FV entry
  // (e.g., no completed fights in the DB), leave the placeholder hidden.
  fvLoadPromise.then(function (fvCache) {
    var slot = document.getElementById('fighterModalFvSlot');
    if (!slot || !document.body.contains(slot)) return;  // modal closed
    if (!fvCache || typeof FantasyValue === 'undefined') { slot.style.display = 'none'; return; }
    _modalFvScore = FantasyValue.scoreFor(fighterId);
    _modalFvRank  = FantasyValue.rankFor(fighterId);
    if (_modalFvScore == null) { slot.style.display = 'none'; return; }
    slot.outerHTML = _fvStatTile(_modalFvScore, _modalFvRank, fighter);
    var fvBtn = document.querySelector('#fighterModal [data-fv-breakdown]');
    if (fvBtn) {
      fvBtn.addEventListener('click', function () {
        FantasyValue.showBreakdownModal(fighter);
      });
    }
  });

  // Fight History / News tabs. News is fetched lazily the first time its
  // tab is opened, so the common case (history) costs no extra query.
  _wireFighterModalTabs(fighter);
}

function closeFighterModal() {
  var modal = document.getElementById('fighterModal');
  if (modal) modal.remove();
  document.removeEventListener('keydown', _fighterModalEscapeHandler);
}

function _fighterModalEscapeHandler(e) {
  if (e.key === 'Escape') closeFighterModal();
}

// ========================================================================
// BUILD MODAL HTML
// ========================================================================
function buildFighterModalHtml(fighter, fights, fighterId, opponentMap, tradeCtx) {
  // tradeCtx: { leagueId, ownerMemberId } — when ownerMemberId is non-null,
  // the fighter is currently rostered and can be the subject of a trade.
  tradeCtx = tradeCtx || {};
  var divLabel  = FIGHTER_MODAL_DIVISION_LABELS[fighter.primary_division] || fighter.primary_division;
  var record    = fighter.record_wins + '-' + fighter.record_losses +
                  (fighter.record_draws ? '-' + fighter.record_draws : '');
  var rankLabel = fighter.is_champion ? 'C'
                : (fighter.current_rank ? '#' + fighter.current_rank : 'NR');
  // Sub-label: prefer interim/BMF status over the generic "RANK" label for
  // fighters who hold a secondary title (e.g. Gaethje as interim LW).
  var rankSub   = fighter.is_champion                                       ? 'CHAMP'
                : (fighter.is_sub_champion && fighter.sub_title_type === 'interim') ? 'INTERIM'
                : (fighter.is_sub_champion && fighter.sub_title_type === 'bmf')     ? 'BMF'
                : 'RANK';
  var tierClass = fighter.is_champion                                  ? 'fighter-card--champion'
                : (fighter.current_rank && fighter.current_rank <= 5)  ? 'fighter-card--top5'
                : (fighter.current_rank && fighter.current_rank <= 15) ? 'fighter-card--top15' : '';

  // Career stats — exclude upcoming fights (outcome is null)
  var completedFights = fights.filter(function(f) { return !!f.outcome; });
  var careerPts = completedFights.reduce(function(sum, f) {
    return sum + _modalComputeScore(f, f.fighter_a_id === fighterId).total;
  }, 0);
  var finishes = completedFights.filter(function(f) {
    return f.winner_id === fighterId &&
           (f.outcome === 'ko_tko' || f.outcome === 'submission');
  }).length;

  // Full fighter card (same component used everywhere in the app)
  var photoHtml = fighter.photo_url
    ? '<img class="fighter-card__photo" src="' + _mEsc(fighter.photo_url) +
      '" alt="' + _mEsc(fighter.name) + '" onerror="this.style.display=\'none\'">'
    : '<div class="fighter-card__photo-placeholder"></div>';
  var champBadge = fighter.is_champion ? '<span class="fighter-card__badge-champ">Champ</span>' : '';

  var cardHtml =
    '<div class="fighter-card ' + tierClass + '">' +
      '<div class="fighter-card__photo-wrap">' + photoHtml + '</div>' +
      '<div class="fighter-card__rating">' +
        '<span class="fighter-card__rating-num">' + rankLabel + '</span>' +
        '<span class="fighter-card__rating-label">' + rankSub + '</span>' +
      '</div>' +
      champBadge +
      '<div class="fighter-card__info">' +
        '<p class="fighter-card__division">' +
          ((typeof countryFlag === 'function' && countryFlag(fighter.country)) ? countryFlag(fighter.country) + ' ' : '') +
          _mEsc(divLabel) +
          (fighter.age != null ? ' · Age ' + fighter.age : '') +
        '</p>' +
        '<p class="fighter-card__name">' + _mEsc(fighter.name) + '</p>' +
        '<p class="fighter-card__record">' + record + '</p>' +
      '</div>' +
    '</div>';

  // Fight history rows
  var historyHtml = '';
  if (fights.length === 0) {
    historyHtml = EmptyState.html({
      kind:    'standings',
      title:   'No fights logged',
      body:    'Fight history will appear here once results are recorded.',
      compact: true
    });
  } else {
    var rows = fights.map(function(fight, idx) {
      var isA      = fight.fighter_a_id === fighterId;
      var score    = _modalComputeScore(fight, isA);
      var oppId    = isA ? fight.fighter_b_id : fight.fighter_a_id;
      var oppName  = opponentMap[oppId] || 'Unknown';

      // A fight with no outcome hasn't happened yet
      var isUpcoming = !fight.outcome;

      var resultLabel, resultClass;
      if (isUpcoming) {
        resultLabel = 'Upcoming'; resultClass = 'fight-result--upcoming';
      } else if (fight.outcome === 'no_contest') {
        resultLabel = 'NC'; resultClass = 'fight-result--nc';
      } else if (fight.winner_id === fighterId) {
        resultLabel = 'W'; resultClass = 'fight-result--win';
      } else if (fight.outcome === 'draw') {
        resultLabel = 'D'; resultClass = 'fight-result--draw';
      } else {
        resultLabel = 'L'; resultClass = 'fight-result--loss';
      }

      var method    = isUpcoming ? '-' : (FIGHTER_MODAL_OUTCOME_LABELS[fight.outcome] || fight.outcome || '-');
      var round     = (!isUpcoming && fight.end_round) ? 'R' + fight.end_round : '-';
      var eventName = fight.event ? _mEsc(fight.event.name) : '-';
      var eventDate = fight.event && fight.event.event_date
        ? _modalFormatDate(fight.event.event_date) : '';

      // Modal IDs are scoped with "m" prefix to avoid collisions with any
      // breakdown table the host page might also render.
      var key = 'm' + idx;

      // Upcoming fights have no stats yet — show "-" in the pts cell instead
      // of 0.0 so it's clear no score has been calculated.
      var ptsCellHtml;
      var ptsCellHtml, detailRow;
      if (isUpcoming) {
        ptsCellHtml = '<td class="fight-history-pts" style="color:var(--text-tertiary)">-</td>';
        detailRow   = '';
      } else {
        var ptsClass      = score.total >= 25 ? ' fight-history-pts--high'
                          : score.total >= 10 ? ' fight-history-pts--mid' : '';
        var breakdownHtml = ScoreBreakdown.buildHtml(score, fight, _modalScoringConfig);
        ptsCellHtml =
          '<td class="fight-history-pts' + ptsClass + '" data-breakdown-toggle="' + key + '" tabindex="0" role="button" aria-expanded="false">' +
            '<span class="fight-history-pts__val">' + score.total.toFixed(1) + '</span>' +
            '<span class="fight-history-pts__chevron" aria-hidden="true">&#9656;</span>' +
          '</td>';
        detailRow =
          '<tr class="fight-history-detail" data-breakdown-target="' + key + '" hidden>' +
            '<td colspan="6">' + breakdownHtml + '</td>' +
          '</tr>';
      }

      return (
        '<tr class="fight-history-row">' +
          '<td class="fight-history-event">' +
            '<span class="fight-history-event__name">' + eventName + '</span>' +
            (eventDate ? '<span class="fight-history-event__date">' + eventDate + '</span>' : '') +
          '</td>' +
          '<td class="fight-history-opponent">' + _mEsc(oppName) + '</td>' +
          '<td><span class="fight-result ' + resultClass + '">' + resultLabel + '</span></td>' +
          '<td class="fight-history-method">' + _mEsc(method) + '</td>' +
          '<td class="fight-history-round">' + round + '</td>' +
          ptsCellHtml +
        '</tr>' +
        detailRow
      );
    }).join('');

    historyHtml =
      '<table class="fight-history-table">' +
        '<thead><tr>' +
          '<th>Event</th><th>Opponent</th><th>Result</th>' +
          '<th>Method</th><th>Rnd</th><th>Pts</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>';
  }

  return (
    '<div class="fighter-modal" role="dialog" aria-modal="true">' +

      // Hero: fighter card on the left, name/bio on the right
      '<div class="fighter-modal__hero">' +
        '<button class="fighter-modal__close" id="closeFighterModalBtn" aria-label="Close">&times;</button>' +
        cardHtml +
        '<div class="fighter-modal__hero-info">' +
          (fighter.nickname ? '<p class="fighter-modal__nickname">"' + _mEsc(fighter.nickname) + '"</p>' : '') +
          '<h2 class="fighter-modal__name">' + _mEsc(fighter.name) + '</h2>' +
          (function() {
            // League ownership chip: who has this fighter rostered. Only shown
            // in a league context; "Free agent" when nobody owns them. Text,
            // not team color, so it reads clearly without a legend.
            if (!tradeCtx.leagueId) return '';
            if (tradeCtx.ownerTeamName) {
              // Inner label + team name, shared by the link and non-link forms.
              var ownerInner = '<span class="fighter-modal__owner-label">Rostered by</span>' +
                               '<span class="fighter-modal__owner-team">' + _mEsc(tradeCtx.ownerTeamName) + '</span>';
              // When we know which member owns this fighter, make the chip a link
              // to that team's roster (the same view-mode page standings uses).
              if (tradeCtx.ownerMemberId) {
                return '<a class="fighter-modal__owner fighter-modal__owner--link" ' +
                         'href="lineup.html?id=' + encodeURIComponent(tradeCtx.leagueId) +
                         '&member=' + encodeURIComponent(tradeCtx.ownerMemberId) + '">' +
                         ownerInner +
                       '</a>';
              }
              return '<p class="fighter-modal__owner">' + ownerInner + '</p>';
            }
            return '<p class="fighter-modal__owner fighter-modal__owner--fa">Free agent</p>';
          })() +
          (function() {
            // Country (with flag) and age on a single line. Each piece is
            // optional — falls through when missing instead of showing
            // placeholders.
            var flag    = (typeof countryFlag === 'function') ? countryFlag(fighter.country) : '';
            var country = fighter.country ? (flag ? flag + ' ' : '') + _mEsc(fighter.country) : '';
            var ageStr  = fighter.age != null ? 'Age ' + fighter.age : '';
            if (!country && !ageStr) return '';
            var sep = (country && ageStr) ? ' · ' : '';
            return '<p class="fighter-modal__country">' + country + sep + ageStr + '</p>';
          })() +
          (function() {
            // Next-fight line — derived from the fights list we already have
            // (no extra query). Earliest fight where outcome is null and the
            // event date is today or later.
            var todayISO = new Date().toISOString().split('T')[0];
            var upcoming = fights
              .filter(function(f) { return !f.outcome && f.event && f.event.event_date && f.event.event_date >= todayISO; })
              .sort(function(a, b) { return a.event.event_date < b.event.event_date ? -1 : 1; });
            if (upcoming.length === 0) return '';
            var nf = upcoming[0];
            var oppId = nf.fighter_a_id === fighterId ? nf.fighter_b_id : nf.fighter_a_id;
            var oppName = opponentMap[oppId] || 'TBD';
            var d = new Date(nf.event.event_date + 'T12:00:00');
            var dStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            // Polymarket odds chip (when available) — full branded version
            // with "POLYMARKET" wordmark since the modal has space for it.
            var oddsChip = (typeof FightOdds !== 'undefined' && _modalFightOdds)
              ? FightOdds.chipHtml(_modalFightOdds, { showBrand: true })
              : '';
            // Projection badge — clickable to show the breakdown modal.
            // We hand the matchup context to Projections so its delegated
            // click handler can populate the breakdown without a separate
            // wiring step in this file.
            var projBadge = (typeof Projections !== 'undefined' && _modalProjection)
              ? Projections.badgeHtml(_modalProjection, {
                  fighterId:    fighter.id,
                  fighterName:  fighter.name,
                  opponentName: oppName,
                  eventName:    nf.event && nf.event.name ? nf.event.name : ''
                })
              : '';
            // Chart container — populated asynchronously after render
            // (the CLOB price-history fetch shouldn't block modal paint).
            // Shown only when we have a token for this fighter.
            var hasToken = !!(_modalFightOdds && _modalFightOdds.fighterTokenId);
            var chartSlot = hasToken
              ? '<div class="fighter-modal__odds-chart" id="fighterModalOddsChart"></div>'
              : '';
            return '<p class="fighter-modal__next-fight">' +
                     '<span class="fighter-modal__next-fight-label">Next fight</span> ' +
                     _mEsc(dStr) + ' · ' + _mEsc(nf.event.name) + ' · vs ' + _mEsc(oppName) +
                     (oddsChip ? ' ' + oddsChip : '') +
                     (projBadge ? ' ' + projBadge : '') +
                   '</p>' +
                   chartSlot;
          })() +
          // CTAs — multiple may show at once.
          //
          //   Draft (during active draft, only on the draft page where
          //   window.makePick is exposed): visible for unowned fighters.
          //
          //   Queue toggle (pre-draft and during active draft, only on
          //   the draft page where window.addToQueue is exposed):
          //   visible for unowned fighters until the draft completes.
          //
          //   Propose Trade (after draft completes): visible for fighters
          //   on someone's roster.
          (function() {
            // Inline SVG icons — 16px line-art that picks up currentColor
            // so the active/queued/primary states tint cleanly.
            var ICONS = {
              draft:
                '<svg class="modal-cta__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                  '<path d="M12 4v12" /><path d="m7 11 5 5 5-5" /><path d="M4 20h16" />' +
                '</svg>',
              queueAdd:
                '<svg class="modal-cta__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                  '<path d="M4 7h11" /><path d="M4 12h11" /><path d="M4 17h7" />' +
                  '<circle cx="18" cy="17" r="4" /><path d="M16 17h4" /><path d="M18 15v4" />' +
                '</svg>',
              queueChecked:
                '<svg class="modal-cta__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                  '<path d="M4 7h11" /><path d="M4 12h11" /><path d="M4 17h7" />' +
                  '<circle cx="18" cy="17" r="4" /><path d="m16 17 1.5 1.5L20 16" />' +
                '</svg>',
              trade:
                '<svg class="modal-cta__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                  '<path d="M4 9h13" /><path d="m14 6 3 3-3 3" />' +
                  '<path d="M20 15H7"  /><path d="m10 18-3-3 3-3" />' +
                '</svg>'
            };

            var html = '';
            // Primary action priority: Draft (during draft) > Trade (post-draft).
            // The "primary" crimson treatment is reserved for the most
            // important action in the current context — at most one button
            // in the row should ever wear it.
            var canDraft = tradeCtx.draftActive
                        && !tradeCtx.ownerMemberId
                        && typeof window.makePick === 'function';
            if (canDraft) {
              html += '<button class="modal-cta modal-cta--primary" data-cta="draft" ' +
                        'id="fighterModalDraftBtn" data-draft-fighter="' +
                        _mEsc(fighterId) + '">' +
                        ICONS.draft + '<span>Draft Fighter</span>' +
                      '</button>';
            }
            var canQueue = !tradeCtx.ownerMemberId
                        && !tradeCtx.draftCompleted
                        && typeof window.addToQueue === 'function'
                        && typeof window.isQueued === 'function';
            if (canQueue) {
              var alreadyQueued = window.isQueued(fighterId);
              var label = alreadyQueued ? 'Queued' : 'Queue';
              var queuedClass = alreadyQueued ? ' modal-cta--queued' : '';
              var qIcon = alreadyQueued ? ICONS.queueChecked : ICONS.queueAdd;
              html += '<button class="modal-cta' + queuedClass + '" data-cta="queue" ' +
                        'id="fighterModalQueueBtn" data-queue-fighter="' +
                        _mEsc(fighterId) + '">' +
                        qIcon + '<span>' + label + '</span>' +
                      '</button>';
            }
            if (tradeCtx.ownerMemberId && tradeCtx.draftCompleted) {
              // Post-draft, Propose Trade is the row's primary action.
              html += '<button class="modal-cta modal-cta--primary" data-cta="trade" ' +
                        'id="fighterModalTradeBtn">' +
                        ICONS.trade + '<span>Propose Trade</span>' +
                      '</button>';
            }
            return html ? '<div class="fighter-modal__cta-row">' + html + '</div>' : '';
          })() +
        '</div>' +
      '</div>' +

      // Career stat tiles
      '<div class="fighter-modal__stats">' +
        _statTile(record, 'Record') +
        _statTile(String(finishes), 'Finishes') +
        _statTile(String(completedFights.length), 'UFC Fights') +
        _statTile(careerPts.toFixed(1), 'Career Pts') +
        _statTile(completedFights.length > 0 ? (careerPts / completedFights.length).toFixed(1) : '—', 'Avg Pts') +
        // Fantasy Value tile — rendered as a loading placeholder, then
        // populated asynchronously once FantasyValue.ensureLoaded resolves.
        // The wrapping element has a stable id so the post-render handler
        // can find and replace it.
        '<div class="fighter-modal__stat fighter-modal__stat--fv-slot" id="fighterModalFvSlot">' +
          '<span class="fighter-modal__stat-val" style="opacity:.4">—</span>' +
          '<span class="fighter-modal__stat-label">Fantasy Value</span>' +
          '<span class="fighter-modal__stat-sub" style="opacity:.4">loading…</span>' +
        '</div>' +
      '</div>' +

      // Fight history + News, as two tabs. News loads lazily the first time
      // its tab is opened (see _wireFighterModalTabs / _loadFighterNews).
      '<div class="fighter-modal__body">' +
        '<div class="fighter-modal__tabs" role="tablist">' +
          '<button class="fighter-modal__tab fighter-modal__tab--active" type="button" data-modal-tab="history">' +
            'Fight History <span class="fighter-modal__tab-count">' + fights.length + '</span>' +
          '</button>' +
          '<button class="fighter-modal__tab" type="button" data-modal-tab="news">News</button>' +
        '</div>' +
        '<div data-modal-panel="history">' + historyHtml + '</div>' +
        '<div data-modal-panel="news" hidden>' +
          '<p class="draft-empty">Loading news&hellip;</p>' +
        '</div>' +
      '</div>' +

    '</div>'
  );
}

function _statTile(value, label) {
  return (
    '<div class="fighter-modal__stat">' +
      '<span class="fighter-modal__stat-val">' + _mEsc(value) + '</span>' +
      '<span class="fighter-modal__stat-label">' + label + '</span>' +
    '</div>'
  );
}

// Fantasy Value tile — adds a rank subline ("#14 of 624") and is clickable
// to open the FV breakdown modal. The data-* attribute on the wrapper is
// what the click handler downstream binds against.
function _fvStatTile(score, rankInfo, fighter) {
  var sub = rankInfo
    ? '#' + rankInfo.rank + ' of ' + rankInfo.total
    : 'Unranked';
  return (
    '<button class="fighter-modal__stat fighter-modal__stat--fv" ' +
            'type="button" data-fv-breakdown="' + _mEsc(fighter.id) + '" ' +
            'title="See the breakdown">' +
      '<span class="fighter-modal__stat-val">' + _mEsc(score.toFixed(1)) + '</span>' +
      '<span class="fighter-modal__stat-label">Fantasy Value</span>' +
      '<span class="fighter-modal__stat-sub">' + _mEsc(sub) + '</span>' +
    '</button>'
  );
}

// ========================================================================
// NEWS TAB — articles about this fighter
//
// An article counts as "about" a fighter if they're its cover fighter
// (hero_fighter_id) OR their name appears in the headline / summary / body.
// (Phase 2's {{fighter:}} embeds will make this an exact tag.) Reads the
// public `articles` table directly — no dependency on articles.js, and
// works for anonymous viewers since published rows are public-readable.
// ========================================================================
var _FIGHTER_NEWS_CATS = {
  waiver_wire: 'Waiver Wire', rankings: 'Rankings', event_preview: 'Event Preview',
  recap: 'Recap', strategy: 'Strategy'
};
function _fighterNewsCat(id) { return _FIGHTER_NEWS_CATS[id] || 'Analysis'; }

// Resets each time the modal is rebuilt so a fresh fighter re-fetches.
var _fighterNewsLoaded = false;

function _wireFighterModalTabs(fighter) {
  var modal = document.getElementById('fighterModal');
  if (!modal) return;
  _fighterNewsLoaded = false;
  var tabs = modal.querySelectorAll('[data-modal-tab]');
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      var which = tab.getAttribute('data-modal-tab');
      tabs.forEach(function (t) { t.classList.toggle('fighter-modal__tab--active', t === tab); });
      modal.querySelectorAll('[data-modal-panel]').forEach(function (p) {
        p.hidden = p.getAttribute('data-modal-panel') !== which;
      });
      if (which === 'news' && !_fighterNewsLoaded) {
        _fighterNewsLoaded = true;
        _loadFighterNews(fighter);
      }
    });
  });
}

async function _loadFighterNews(fighter) {
  var panel = document.querySelector('#fighterModal [data-modal-panel="news"]');
  if (!panel) return;

  var name = String(fighter.name || '').trim();
  var rows = [];
  try {
    // hero_fighter_id is the precise match; the name ilikes are the bridge
    // until embeds land. Fighter names have no commas, so the or() filter is
    // safe to build by concatenation.
    var filter = 'hero_fighter_id.eq.' + fighter.id;
    if (name && name.indexOf(',') === -1) {
      filter += ',title.ilike.*' + name + '*' +
                ',dek.ilike.*' + name + '*' +
                ',body_md.ilike.*' + name + '*';
    }
    var res = await supabaseClient
      .from('articles')
      .select('slug, title, dek, category, author_name, published_at')
      .eq('status', 'published')
      .or(filter)
      .order('published_at', { ascending: false })
      .limit(20);
    rows = res.data || [];
  } catch (e) { rows = []; }

  if (!document.body.contains(panel)) return;   // modal closed mid-fetch
  if (!rows.length) {
    panel.innerHTML = '<p class="draft-empty">No articles about ' + _mEsc(fighter.name) + ' yet.</p>';
    return;
  }
  panel.innerHTML = rows.map(function (a) {
    var meta = [];
    if (a.author_name)  meta.push(_mEsc(a.author_name));
    if (a.published_at) meta.push(_modalFormatDate(a.published_at));
    return (
      '<a class="fighter-news__item" href="article.html?slug=' + encodeURIComponent(a.slug) + '">' +
        '<span class="fighter-news__cat">' + _mEsc(_fighterNewsCat(a.category)) + '</span>' +
        '<span class="fighter-news__title">' + _mEsc(a.title) + '</span>' +
        (a.dek ? '<span class="fighter-news__dek">' + _mEsc(a.dek) + '</span>' : '') +
        (meta.length ? '<span class="fighter-news__meta">' + meta.join(' · ') + '</span>' : '') +
      '</a>'
    );
  }).join('');
}

// ========================================================================
// SCORING — delegates to the shared Scoring engine in scoring.js with this
// league's scoring_config (or v1.2 defaults if no league context).
// ========================================================================
function _modalComputeScore(fight, isA) {
  return Scoring.computeFighterScore(fight, isA, _modalScoringConfig);
}

// ========================================================================
// HELPERS
// ========================================================================
function _mEsc(str) {
  if (str === null || str === undefined) return '';
  var d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}

function _modalFormatDate(dateStr) {
  if (!dateStr) return '';
  var d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

