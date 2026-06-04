// ========================================================================
// FIGHT PROJECTIONS LOOKUP
// Given a list of fighter IDs, returns a map of fighter_id → projected
// fantasy points for their next upcoming fight. Source: fighter_projections
// table, refreshed hourly by fetchPolymarketOdds.js → recomputeProjections.js
//
// Each entry:
//   { projectedPoints, basePts, winBonusPts, rankBonusPts,
//     titleBonusPts, multiplier, pWinUsed, computedAt }
//
// Projections only exist for fights with Polymarket odds — so fighters
// without odds won't have an entry. Callers should treat a missing entry
// as "no projection yet" and skip rendering rather than showing zero.
// ========================================================================

(function (root) {
  async function load(fighterIds) {
    if (!fighterIds || fighterIds.length === 0) return {};
    if (typeof supabaseClient === 'undefined') return {};

    const todayISO = new Date().toISOString().split('T')[0];

    // Inner join + event-date filter ensures we never return a projection
    // for a fight that already happened (defensive — recomputeProjections
    // doesn't write rows for completed fights, but stale rows from before
    // the fight occurred could linger until the next sync).
    // NOTE: do NOT filter with .in('fighter_id', fighterIds) — callers pass
    // the whole fighter table (~6k ids on the waivers page), which overflows
    // the request URL and makes the query fail silently. Upcoming projections
    // are a small set (one per booked fight), so fetch them all via the
    // event-date filter and narrow to the requested fighters in JS — same
    // approach FightOdds.loadFightOdds uses.
    const { data, error } = await supabaseClient
      .from('fighter_projections')
      .select(`
        fighter_id, fight_id, projected_points,
        base_pts, win_bonus_pts, rank_bonus_pts, title_bonus_pts,
        multiplier, p_win_used, p_win_source, fights_sampled, computed_at,
        fight:fight_results!inner(
          id, outcome,
          event:ufc_events!inner(event_date)
        )
      `)
      .gte('fight.event.event_date', todayISO);

    if (error) {
      console.warn('Projections.load query failed:', error.message);
      return {};
    }

    const wanted = new Set(fighterIds);
    const result = {};
    for (const row of (data || [])) {
      if (!wanted.has(row.fighter_id)) continue;     // not a fighter we asked for
      if (row.fight && row.fight.outcome) continue;  // skip completed
      result[row.fighter_id] = {
        projectedPoints: Number(row.projected_points),
        basePts:         Number(row.base_pts),
        winBonusPts:     Number(row.win_bonus_pts),
        rankBonusPts:    Number(row.rank_bonus_pts),
        titleBonusPts:   Number(row.title_bonus_pts),
        multiplier:      Number(row.multiplier),
        pWinUsed:        row.p_win_used != null ? Number(row.p_win_used) : null,
        pWinSource:      row.p_win_source,
        fightsSampled:   row.fights_sampled,
        computedAt:      row.computed_at,
      };
    }
    return result;
  }

  // Module-level cache: fighter_id -> { projection, fighter, opponentName,
  // eventName }. Populated by pillHtml/badgeHtml as callers pass context.
  // Used by the global click handler to open the breakdown modal without
  // needing the caller to wire each pill individually.
  const _ctxByFighterId = {};

  function _cacheContext(opts, proj) {
    if (!opts || !opts.fighterId) return;
    _ctxByFighterId[opts.fighterId] = {
      projection:   proj,
      fighter:      { id: opts.fighterId, name: opts.fighterName || '' },
      opponentName: opts.opponentName || '',
      eventName:    opts.eventName    || ''
    };
  }

  // Compact inline pill — "PROJ 24.7". Used in lineup/waiver rows where
  // space is tight. Returns '' when there's no projection.
  //
  // opts: { fighterId, fighterName, opponentName, eventName } — passing
  // fighterId makes the pill clickable (opens the breakdown modal). Omit
  // it to render a non-clickable span (e.g., contexts where click would
  // conflict with something else).
  function pillHtml(proj, opts) {
    if (!proj || proj.projectedPoints == null || isNaN(proj.projectedPoints)) return '';
    opts = opts || {};
    _cacheContext(opts, proj);

    const val = proj.projectedPoints.toFixed(1);
    const tip = opts.fighterId
      ? 'Click for breakdown'
      : 'Projected: ' + val + ' pts  ·  ' +
        'base ' + proj.basePts.toFixed(1) +
        ' + win ' + proj.winBonusPts.toFixed(1) +
        ' + matchup ' + proj.rankBonusPts.toFixed(1) +
        (proj.multiplier !== 1 ? '  ×' + proj.multiplier + ' card' : '');

    // Always render as <span> — pills are sometimes nested inside a
    // .fight-row__side <button>, and nested <button> elements are invalid
    // HTML (the browser auto-closes the outer one, which silently breaks
    // the surrounding layout). role="button" + tabindex keeps it
    // keyboard-accessible.
    const clickable = !!opts.fighterId;
    const extra     = clickable
      ? ' role="button" tabindex="0" data-projection-breakdown="1" data-projection-fighter-id="' + opts.fighterId + '"'
      : '';
    return (
      '<span class="fight-projection' +
            (clickable ? ' fight-projection--clickable' : '') +
            '" title="' + tip + '"' + extra + '>' +
        '<span class="fight-projection__label">PROJ</span>' +
        '<span class="fight-projection__val">' + val + '</span>' +
      '</span>'
    );
  }

  // Larger badge for the fighter modal — same data, more breathing room.
  // Same opts shape as pillHtml. Renders clickable when fighterId provided.
  function badgeHtml(proj, opts) {
    if (!proj || proj.projectedPoints == null || isNaN(proj.projectedPoints)) return '';
    opts = opts || {};
    _cacheContext(opts, proj);

    const val = proj.projectedPoints.toFixed(1);
    // Allow callers to force non-clickable via opts.clickable=false.
    const clickable = opts.clickable !== false && !!opts.fighterId;
    // Same span-not-button trick as pillHtml — avoids nested button issues
    // when this lands inside another clickable element.
    const extra = clickable
      ? ' role="button" tabindex="0" data-projection-breakdown="1" data-projection-fighter-id="' + opts.fighterId + '" title="See where this projection comes from"'
      : '';
    return (
      '<span class="fight-projection fight-projection--badge' +
            (clickable ? ' fight-projection--clickable' : '') + '"' + extra + '>' +
        '<span class="fight-projection__label">Projected</span>' +
        '<span class="fight-projection__val">' + val + '</span>' +
        '<span class="fight-projection__unit">pts</span>' +
      '</span>'
    );
  }

  // ----- Breakdown modal --------------------------------------------------
  // Explains "where does this 24.7 come from?" — shows the components stored
  // in fighter_projections, plus the inputs that drove them (P(win) source,
  // sample size, card position, opponent rank). Mirrors the FV breakdown.

  function _escapeHtml(str) {
    if (str === null || str === undefined) return '';
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

  function _cardLabel(multiplier) {
    if (multiplier >= 1.2)  return 'Main event';
    if (multiplier >= 1.1)  return 'Co-main';
    return 'Main card';
  }

  function _sourceLabel(src) {
    if (src === 'polymarket')      return 'Polymarket implied probability';
    if (src === 'rank_heuristic')  return 'Rank-based heuristic (no live market)';
    return 'Default';
  }

  // Render the breakdown overlay. Caller provides everything we can't get
  // from the projection row itself (fighter name, opponent name, etc.).
  //   opts = { projection, fighter, opponentName, eventName }
  function showBreakdownModal(opts) {
    opts = opts || {};
    const proj    = opts.projection;
    const fighter = opts.fighter;
    if (!proj || !fighter) return;

    const existing = document.getElementById('projectionBreakdownModal');
    if (existing) existing.remove();

    const baseSubtotal       = proj.basePts + proj.winBonusPts + proj.rankBonusPts;
    const winBonusGivenWin   = proj.pWinUsed > 0 ? proj.winBonusPts / proj.pWinUsed : 0;
    const matchupGivenWin    = proj.pWinUsed > 0 ? proj.rankBonusPts / proj.pWinUsed : 0;
    const cardLabel          = _cardLabel(proj.multiplier);

    // Sample-size note. The engine blends personal stats with the division
    // average using shrinkage, fully personal at ~10 fights.
    let sampleNote;
    if (proj.fightsSampled == null) sampleNote = 'Sample size unknown';
    else if (proj.fightsSampled === 0) sampleNote = '0 past fights — using division average';
    else if (proj.fightsSampled < 3)   sampleNote = proj.fightsSampled + ' past fight' + (proj.fightsSampled === 1 ? '' : 's') + ' — heavy division blend';
    else if (proj.fightsSampled < 10)  sampleNote = proj.fightsSampled + ' past fights — partial division blend';
    else                                sampleNote = proj.fightsSampled + ' past fights — full personal weight';

    function row(label, value, note, highlight) {
      const valueStr = typeof value === 'number' ? value.toFixed(1) : String(value);
      return '<div class="fv-breakdown-row' + (highlight ? ' fv-breakdown-row--total' : '') + '">' +
        '<span class="fv-breakdown-row__label">' + _escapeHtml(label) + '</span>' +
        (note ? '<span class="fv-breakdown-row__note">' + _escapeHtml(note) + '</span>' : '<span></span>') +
        '<span class="fv-breakdown-row__value">' + _escapeHtml(valueStr) + '</span>' +
      '</div>';
    }

    const matchupContext = opts.opponentName
      ? 'vs ' + opts.opponentName + (opts.eventName ? ' · ' + opts.eventName : '')
      : (opts.eventName || '');

    const overlay = document.createElement('div');
    overlay.id = 'projectionBreakdownModal';
    overlay.className = 'move-flex-modal-overlay';
    overlay.innerHTML =
      '<div class="move-flex-modal" role="dialog" aria-modal="true" style="max-width:460px">' +
        '<div class="move-flex-modal__header">' +
          '<p class="move-flex-modal__title">Where this projection comes from</p>' +
          '<button class="move-flex-modal__close" id="closeProjBreakdownBtn" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="move-flex-modal__body">' +
          '<p class="move-flex-fighter-name" style="margin-bottom:var(--space-1)">' +
            _escapeHtml(fighter.name) +
          '</p>' +
          (matchupContext
            ? '<p style="font-size:var(--text-caption);color:var(--text-tertiary);margin-bottom:var(--space-4)">' +
                _escapeHtml(matchupContext) +
              '</p>'
            : '<div style="margin-bottom:var(--space-4)"></div>') +

          '<p class="fv-breakdown-section">Inputs</p>' +
          '<div class="fv-breakdown-table">' +
            row('P(win)',         Math.round(proj.pWinUsed * 100) + '%', _sourceLabel(proj.pWinSource)) +
            row('Sample size',    proj.fightsSampled, sampleNote) +
            row('Card position',  '×' + proj.multiplier, cardLabel) +
          '</div>' +

          '<p class="fv-breakdown-section" style="margin-top:var(--space-4)">Components</p>' +
          '<div class="fv-breakdown-table">' +
            row('Base activity',  proj.basePts,       'Sig strikes, takedowns, knockdowns, control') +
            row('Win bonus',      '+' + proj.winBonusPts.toFixed(1),
                                   'P(win) × ' + winBonusGivenWin.toFixed(1) + ' = ' + proj.winBonusPts.toFixed(1)) +
            row('Matchup bonus',  '+' + proj.rankBonusPts.toFixed(1),
                                   'P(win) × ' + matchupGivenWin.toFixed(1) + ' (opponent rank / title)') +
            row('Subtotal',       baseSubtotal,       'Sum of the three above') +
            row('Card multiplier', '×' + proj.multiplier, cardLabel + ' boost') +
          '</div>' +

          '<div class="fv-breakdown-table" style="margin-top:var(--space-4)">' +
            row('Projected points', proj.projectedPoints, '', true) +
          '</div>' +

          '<p style="font-size:var(--text-caption);color:var(--text-tertiary);margin-top:var(--space-4);line-height:1.5">' +
            'Win and matchup bonuses are expectations — they activate only on a win, so we scale the full value by P(win). ' +
            'The base activity number is a recency-weighted average of this fighter\'s past base scoring, shrunk toward the ' +
            'division average for fighters with thin history.' +
          '</p>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    document.getElementById('closeProjBreakdownBtn').addEventListener('click', function () { overlay.remove(); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
    });
  }

  // Single delegated click handler — works for any pill or badge anywhere
  // on the page, as long as the caller passed fighterId to pill/badgeHtml.
  // stopPropagation so a click on a pill inside a clickable row doesn't
  // also fire the row's "open fighter modal" handler.
  function _installClickHandlerOnce() {
    if (root.__projectionClickInstalled) return;
    root.__projectionClickInstalled = true;

    function trigger(e) {
      const target = e.target && e.target.closest
        ? e.target.closest('[data-projection-breakdown]')
        : null;
      if (!target) return;
      const fid = target.getAttribute('data-projection-fighter-id');
      if (!fid) return;
      const ctx = _ctxByFighterId[fid];
      if (!ctx) return;
      e.stopPropagation();
      e.preventDefault();
      showBreakdownModal(ctx);
    }

    document.addEventListener('click', trigger);
    // The pill is a <span role="button"> (to avoid nested-button issues),
    // so it needs explicit keyboard activation — buttons get this for free
    // but spans don't.
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const target = e.target && e.target.closest
        ? e.target.closest('[data-projection-breakdown]')
        : null;
      if (!target) return;
      trigger(e);
    });
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _installClickHandlerOnce);
    } else {
      _installClickHandlerOnce();
    }
  }

  root.Projections = {
    load:               load,
    pillHtml:           pillHtml,
    badgeHtml:          badgeHtml,
    showBreakdownModal: showBreakdownModal,
  };
})(typeof window !== 'undefined' ? window : this);
