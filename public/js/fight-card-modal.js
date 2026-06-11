// ========================================================================
// FIGHT CARD MODAL — shared module
//
// Opens a centered modal listing every fight on a UFC event's card. Used
// from the league page's "View fight card" button and other surfaces that
// want a quick card preview without taking the user into the lineup page.
//
// Bout-row rendering lives in fight-rows.js (FightRows.shape / .rowHtml),
// shared with the Fight Night Hub so both surfaces render identically.
// fight-rows.js must be loaded before this file.
//
// Public API:
//   FightCardModal.show(eventId, opts)
//     eventId    — uuid of the ufc_events row
//     opts.leagueId    — optional league uuid. When provided, fetches
//                        league_event_overrides and merges them so the
//                        modal shows this league's (possibly customized)
//                        event name / date / venue.
//     opts.rosterIds   — optional Set/Object of fighter ids on the
//                        viewer's roster (drives YOURS highlight)
//     opts.starterIds  — optional Set/Object of fighter ids in starter
//                        slots for the event (drives STARTER highlight)
//
// Optional deps: FightOdds, Projections, Scoring, EventOverrides,
// showFighterModal — feature-gated on `typeof X !== 'undefined'`.
// ========================================================================

(function (root) {
  function escapeHtml(str) {
    if (str == null) return '';
    var d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

  // ---- Data loaders ------------------------------------------------------

  async function fetchEvent(eventId) {
    var res = await supabaseClient
      .from('ufc_events')
      .select('id, name, full_name, event_date, venue')
      .eq('id', eventId)
      .single();
    return res.data || null;
  }

  async function fetchFights(eventId) {
    var res = await supabaseClient
      .from('fight_results')
      .select(
        'id, fighter_a_id, fighter_b_id, weight_class, card_position, ' +
        'fight_order, title_type, is_title_defense, outcome, winner_id, ' +
        'end_round, end_time_seconds, ' +
        // per-fighter stats so a decided bout can be scored client-side
        'fighter_a_sig_strikes, fighter_a_takedowns, fighter_a_knockdowns, fighter_a_control_seconds, fighter_a_opponent_rank, ' +
        'fighter_b_sig_strikes, fighter_b_takedowns, fighter_b_knockdowns, fighter_b_control_seconds, fighter_b_opponent_rank'
      )
      .eq('event_id', eventId);
    return res.data || [];
  }

  async function fetchFighters(ids) {
    if (!ids.length) return {};
    var res = await supabaseClient
      .from('fighters')
      .select('id, name, photo_url, current_rank, is_champion, is_sub_champion, sub_title_type, country, record_wins, record_losses, record_draws')
      .in('id', ids);
    var map = {};
    (res.data || []).forEach(function (f) { map[f.id] = f; });
    return map;
  }

  // This league's scoring_config, so decided bouts score by the league's own
  // rules. Returns null on any miss (computeFighterScore then uses defaults).
  async function fetchScoringConfig(leagueId) {
    try {
      var res = await supabaseClient.from('leagues').select('scoring_config').eq('id', leagueId).maybeSingle();
      return (res && res.data) ? res.data.scoring_config : null;
    } catch (e) { return null; }
  }

  // ---- Modal lifecycle ---------------------------------------------------

  function escapeListener(e) {
    if (e.key === 'Escape') close();
  }

  function close() {
    var modal = document.getElementById('fightCardModal');
    if (modal) modal.remove();
    document.removeEventListener('keydown', escapeListener);
  }

  async function show(eventId, opts) {
    opts = opts || {};
    if (typeof supabaseClient === 'undefined') return;
    if (!eventId) return;

    // Strip any prior instance and lock-up
    var existing = document.getElementById('fightCardModal');
    if (existing) existing.remove();

    // Place a transient placeholder so users get instant feedback that
    // the click registered, even if the data fetch takes a moment.
    var placeholder = document.createElement('div');
    placeholder.id = 'fightCardModal';
    placeholder.className = 'fight-card-modal-overlay';
    placeholder.innerHTML =
      '<div class="fight-card-modal" role="dialog" aria-modal="true">' +
        '<div class="fight-card-modal__body" style="padding:var(--space-6)">' +
          '<p class="draft-empty">Loading card…</p>' +
        '</div>' +
      '</div>';
    document.body.appendChild(placeholder);

    // Fire data fetches in parallel
    var eventP  = fetchEvent(eventId);
    var fightsP = fetchFights(eventId);
    // When a leagueId is provided, also fetch this league's override for
    // the event so the modal shows commissioner-customized name/date/etc.
    var overrideP = (opts.leagueId && typeof EventOverrides !== 'undefined')
      ? EventOverrides.fetchForLeague(supabaseClient, opts.leagueId, [eventId])
      : Promise.resolve({});
    var event       = await eventP;
    var rawFights   = await fightsP;
    var overrideMap = await overrideP;

    if (!event) { close(); return; }
    // Merge the override (no-op when none exists).
    if (typeof EventOverrides !== 'undefined') {
      event = EventOverrides.merge(event, overrideMap[event.id]);
    }

    // Collect fighter ids and load details + odds/projections
    var idSet = new Set();
    rawFights.forEach(function (f) {
      if (f.fighter_a_id) idSet.add(f.fighter_a_id);
      if (f.fighter_b_id) idSet.add(f.fighter_b_id);
    });
    var ids = Array.from(idSet);

    var promises = [fetchFighters(ids)];
    promises.push(typeof FightOdds   !== 'undefined' ? FightOdds.loadFightOdds(ids) : Promise.resolve({}));
    promises.push(typeof Projections !== 'undefined' ? Projections.load(ids)        : Promise.resolve({}));
    // League scoring_config so a decided bout is scored with this league's rules
    // (falls back to defaults when there's no league context / config).
    promises.push(opts.leagueId ? fetchScoringConfig(opts.leagueId) : Promise.resolve(null));
    var results = await Promise.all(promises);
    var fighterMap = results[0], oddsMap = results[1], projMap = results[2], scoringCfg = results[3];

    // Once a fight is decided, compute each fighter's earned fantasy points so
    // the row shows the SCORE in place of the now-irrelevant projection. Updates
    // each time the modal is reopened as live stats come in.
    var scoreMap = {};
    if (typeof Scoring !== 'undefined') {
      rawFights.forEach(function (f) {
        if (!f.outcome) return; // not decided yet — keep the projection
        if (f.fighter_a_id) scoreMap[f.fighter_a_id] = Scoring.computeFighterScore(f, true,  scoringCfg).total;
        if (f.fighter_b_id) scoreMap[f.fighter_b_id] = Scoring.computeFighterScore(f, false, scoringCfg).total;
      });
    }

    var fights = FightRows.shape(rawFights, fighterMap);

    // Group main card vs prelims
    var hasOrder = fights.some(function (f) { return f.fightOrder != null; });
    var mainCard, prelims;
    if (hasOrder) {
      mainCard = fights.filter(function (f) { return f.fightOrder != null && f.fightOrder <= 5; });
      prelims  = fights.filter(function (f) { return f.fightOrder == null || f.fightOrder > 5; });
    } else {
      mainCard = fights.slice(0, 5);
      prelims  = fights.slice(5);
    }

    var rowOpts = {
      oddsMap:    oddsMap,
      projMap:    projMap,
      scoreMap:   scoreMap,
      rosterIds:  opts.rosterIds  || null,
      starterIds: opts.starterIds || null
    };

    var sectionsHtml = '';
    if (fights.length === 0) {
      sectionsHtml = EmptyState.html({
        kind:    'events',
        title:   'Card not announced',
        body:    'Fights for this event haven\'t been published yet. Check back closer to fight week.',
        compact: true
      });
    } else {
      if (mainCard.length > 0) {
        sectionsHtml +=
          '<div class="fight-card-section">' +
            '<p class="fight-card-section__label">Main Card</p>' +
            mainCard.map(function (f) { return FightRows.rowHtml(f, event.name, rowOpts); }).join('') +
          '</div>';
      }
      if (prelims.length > 0) {
        sectionsHtml +=
          '<div class="fight-card-section">' +
            '<p class="fight-card-section__label">Prelims</p>' +
            prelims.map(function (f) { return FightRows.rowHtml(f, event.name, rowOpts); }).join('') +
          '</div>';
      }
    }

    // Swap placeholder → real content. Replace innerHTML so the same
    // overlay element stays mounted and we don't fight the user's eye
    // with a flash of remount.
    var modal = document.getElementById('fightCardModal');
    if (!modal) return;  // user may have already dismissed
    modal.innerHTML =
      '<div class="fight-card-modal" role="dialog" aria-modal="true" aria-label="Fight Card">' +
        '<div class="fight-card-modal__header">' +
          '<div>' +
            '<p class="fight-card-modal__eyebrow">Fight Card</p>' +
            '<p class="fight-card-modal__title">' + escapeHtml(event.name) + '</p>' +
          '</div>' +
          '<button class="fight-card-modal__close" id="closeFightCardBtn" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="fight-card-modal__body">' + sectionsHtml + '</div>' +
      '</div>';

    document.getElementById('closeFightCardBtn').addEventListener('click', close);
    modal.addEventListener('click', function (e) {
      if (e.target === modal) close();
    });
    modal.querySelectorAll('[data-open-fighter]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var fid = btn.getAttribute('data-open-fighter');
        if (fid && typeof showFighterModal === 'function') showFighterModal(fid);
      });
    });
    document.addEventListener('keydown', escapeListener);
  }

  root.FightCardModal = { show: show, close: close };
})(typeof window !== 'undefined' ? window : this);
