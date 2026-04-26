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
      .select('id, name, nickname, primary_division, current_rank, is_champion, record_wins, record_losses, record_draws, photo_url, country, date_of_birth')
      .eq('id', fighterId)
      .single(),

    supabaseClient
      .from('fight_results')
      .select('*, event:ufc_events(id, name, event_date)')
      .or('fighter_a_id.eq.' + fighterId + ',fighter_b_id.eq.' + fighterId)
      .order('created_at', { ascending: false })
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

  if (fighterRes.error || !fighterRes.data) {
    document.querySelector('#fighterModal .fighter-modal').innerHTML =
      '<div class="fighter-modal__loading">Fighter not found.' +
      '<br><button class="btn-ghost" style="margin-top:1rem" onclick="closeFighterModal()">Close</button></div>';
    return;
  }

  var fighter = fighterRes.data;
  var fights  = fightsRes.data || [];

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
      queueBtn.innerHTML = nowQueued ? 'Queued &#x2715;' : '+ Queue';
      queueBtn.classList.toggle('fighter-modal__queue-btn--queued', nowQueued);
    });
  }

  // Wire click + keyboard handlers on every Pts cell so the per-fight
  // score breakdown row beneath each fight can expand/collapse. Scoped
  // to the fighter-modal node so it only finds toggles inside the modal.
  var modalRoot = document.querySelector('#fighterModal .fighter-modal');
  if (modalRoot) ScoreBreakdown.wireToggles(modalRoot);
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
  var rankSub   = fighter.is_champion ? 'CHAMP' : 'RANK';
  var tierClass = fighter.is_champion                                  ? 'fighter-card--champion'
                : (fighter.current_rank && fighter.current_rank <= 5)  ? 'fighter-card--top5'
                : (fighter.current_rank && fighter.current_rank <= 15) ? 'fighter-card--top15' : '';

  // Career stats
  var careerPts = fights.reduce(function(sum, f) {
    return sum + _modalComputeScore(f, f.fighter_a_id === fighterId).total;
  }, 0);
  var finishes = fights.filter(function(f) {
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
        '<p class="fighter-card__division">' + _mEsc(divLabel) + '</p>' +
        '<p class="fighter-card__name">' + _mEsc(fighter.name) + '</p>' +
        '<p class="fighter-card__record">' + record + '</p>' +
      '</div>' +
    '</div>';

  // Fight history rows
  var historyHtml = '';
  if (fights.length === 0) {
    historyHtml = '<p class="draft-empty" style="padding:var(--space-4)">No fight results recorded yet.</p>';
  } else {
    var rows = fights.map(function(fight, idx) {
      var isA      = fight.fighter_a_id === fighterId;
      var score    = _modalComputeScore(fight, isA);
      var oppId    = isA ? fight.fighter_b_id : fight.fighter_a_id;
      var oppName  = opponentMap[oppId] || 'Unknown';

      var resultLabel, resultClass;
      if (fight.outcome === 'no_contest') {
        resultLabel = 'NC'; resultClass = 'fight-result--nc';
      } else if (fight.winner_id === fighterId) {
        resultLabel = 'W'; resultClass = 'fight-result--win';
      } else if (fight.outcome === 'draw') {
        resultLabel = 'D'; resultClass = 'fight-result--draw';
      } else {
        resultLabel = 'L'; resultClass = 'fight-result--loss';
      }

      var method    = FIGHTER_MODAL_OUTCOME_LABELS[fight.outcome] || fight.outcome || '-';
      var round     = fight.end_round ? 'R' + fight.end_round : '-';
      var eventName = fight.event ? _mEsc(fight.event.name) : '-';
      var eventDate = fight.event && fight.event.event_date
        ? _modalFormatDate(fight.event.event_date) : '';
      var ptsClass  = score.total >= 25 ? ' fight-history-pts--high'
                    : score.total >= 10 ? ' fight-history-pts--mid' : '';

      // Per-fight score breakdown HTML — rendered into a hidden detail row
      // beneath the fight, surfaced when the user clicks the Pts cell.
      // Shared with the standalone fighter page via score-breakdown.js.
      var breakdownHtml = ScoreBreakdown.buildHtml(score, fight, _modalScoringConfig);

      // Modal IDs are scoped with "m" prefix to avoid collisions with any
      // breakdown table the host page might also render.
      var key = 'm' + idx;

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
          '<td class="fight-history-pts' + ptsClass + '" data-breakdown-toggle="' + key + '" tabindex="0" role="button" aria-expanded="false">' +
            '<span class="fight-history-pts__val">' + score.total.toFixed(1) + '</span>' +
            '<span class="fight-history-pts__chevron" aria-hidden="true">&#9656;</span>' +
          '</td>' +
        '</tr>' +
        '<tr class="fight-history-detail" data-breakdown-target="' + key + '" hidden>' +
          '<td colspan="6">' + breakdownHtml + '</td>' +
        '</tr>'
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
          (fighter.country ? '<p class="fighter-modal__country">' + _mEsc(fighter.country) + '</p>' : '') +
          (function() {
            var age = _modalAgeFromDob(fighter.date_of_birth);
            return '<p class="fighter-modal__country">Age ' + (age != null ? age : '[age]') + '</p>';
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
            var html = '';
            var canDraft = tradeCtx.draftActive
                        && !tradeCtx.ownerMemberId
                        && typeof window.makePick === 'function';
            if (canDraft) {
              html += '<button class="btn-primary fighter-modal__draft-btn" ' +
                        'id="fighterModalDraftBtn" data-draft-fighter="' +
                        _mEsc(fighterId) + '">Draft Fighter</button>';
            }
            var canQueue = !tradeCtx.ownerMemberId
                        && !tradeCtx.draftCompleted
                        && typeof window.addToQueue === 'function'
                        && typeof window.isQueued === 'function';
            if (canQueue) {
              var alreadyQueued = window.isQueued(fighterId);
              var label = alreadyQueued ? 'Queued &#x2715;' : '+ Queue';
              var queuedClass = alreadyQueued ? ' fighter-modal__queue-btn--queued' : '';
              html += '<button class="btn-secondary fighter-modal__queue-btn' + queuedClass + '" ' +
                        'id="fighterModalQueueBtn" data-queue-fighter="' +
                        _mEsc(fighterId) + '">' + label + '</button>';
            }
            if (tradeCtx.ownerMemberId && tradeCtx.draftCompleted) {
              html += '<button class="btn-secondary fighter-modal__trade-btn" ' +
                        'id="fighterModalTradeBtn">Propose Trade</button>';
            }
            // Wrap any CTAs in a flex row so multiple buttons sit side-by-side
            // instead of stacking inside the hero's flex column.
            return html ? '<div class="fighter-modal__cta-row">' + html + '</div>' : '';
          })() +
        '</div>' +
      '</div>' +

      // Career stat tiles
      '<div class="fighter-modal__stats">' +
        _statTile(record, 'Record') +
        _statTile(String(finishes), 'Finishes') +
        _statTile(String(fights.length), 'UFC Fights') +
        _statTile(careerPts.toFixed(1), 'Career Pts') +
      '</div>' +

      // Fight history
      '<div class="fighter-modal__body">' +
        '<p class="fighter-modal__section-label">Fight History ' +
          '<span style="opacity:.5;font-size:.85em">(' + fights.length + ')</span>' +
        '</p>' +
        historyHtml +
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

// Whole-year age from a YYYY-MM-DD birth date. Returns null if missing/unparseable.
function _modalAgeFromDob(dob) {
  if (!dob) return null;
  var birth = new Date(dob);
  if (isNaN(birth.getTime())) return null;
  var today = new Date();
  var age   = today.getFullYear() - birth.getFullYear();
  var m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}
