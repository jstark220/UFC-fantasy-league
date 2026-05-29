// ========================================================================
// SCORE BREAKDOWN — shared helper for rendering the per-fight points
// breakdown UI used by the standalone fighter page (fighter.js) and the
// fighter modal (fighter-modal.js).
//
// Single source of truth for breakdown HTML so the two pages can't drift.
// Depends on Scoring (window.Scoring from scoring.js) for the v1.2 defaults
// when a league override is missing for a particular key.
//
// Two functions:
//   buildHtml(score, fight, scoringConfig)
//     -> string of HTML representing the breakdown card. Caller decides
//        where to mount it (typically inside a hidden detail <tr>).
//
//   wireToggles(rootEl)
//     -> finds every [data-breakdown-toggle] inside rootEl and wires it
//        to expand/collapse the matching [data-breakdown-target] element.
//        Idempotent — calling twice is fine, the second pass does nothing.
//
// Usage pattern (in a fight history table):
//   <tr>
//     ...
//     <td class="..." data-breakdown-toggle="42" tabindex="0" role="button">
//       30.5 <span class="...__chevron">&#9656;</span>
//     </td>
//   </tr>
//   <tr data-breakdown-target="42" hidden>
//     <td colspan="6">{{ScoreBreakdown.buildHtml(score, fight, cfg)}}</td>
//   </tr>
//   ScoreBreakdown.wireToggles(tableEl);
// ========================================================================

(function (root) {

  // Look up a config value with v1.2 fallback. Mirrors the same `get()`
  // helper inside scoring.js so a league that overrides only some keys
  // still gets correct multipliers for the unset ones.
  function cfgVal(scoringConfig, key) {
    if (scoringConfig && scoringConfig[key] != null) return Number(scoringConfig[key]);
    return root.Scoring.SCORING_DEFAULTS_V1_2[key];
  }

  // Round a number to 2 decimals and stringify (e.g., 8.5 -> "8.50").
  function fmt2(n) {
    return (Math.round(n * 100) / 100).toFixed(2);
  }

  // Build one row of the breakdown grid: label | formula | points.
  // muted=true dims the row when its value is 0 so non-contributing
  // categories stay visible (auditable) without competing for attention.
  function lineHtml(label, formula, points, opts) {
    var muted = opts && opts.muted ? ' fight-breakdown__line--muted' : '';
    return (
      '<div class="fight-breakdown__line' + muted + '">' +
        '<span class="fight-breakdown__label">' + label + '</span>' +
        '<span class="fight-breakdown__formula">' + formula + '</span>' +
        '<span class="fight-breakdown__pts">' + fmt2(points) + '</span>' +
      '</div>'
    );
  }

  // Main entry: assemble the full breakdown HTML for one fight.
  function buildHtml(score, fight, scoringConfig) {
    var d = score.scoring_detail;

    // Per-stat point contributions so each base-stat line is auditable
    var ssPts   = (d.sig_strikes     || 0) * cfgVal(scoringConfig, 'sig_strike');
    var tdPts   = (d.takedowns       || 0) * cfgVal(scoringConfig, 'takedown');
    var kdPts   = (d.knockdowns      || 0) * cfgVal(scoringConfig, 'knockdown');
    var ctrlPts = (d.control_seconds || 0) * cfgVal(scoringConfig, 'control_per_sec');

    // Subtotal of every component before the card-position multiplier.
    // Performance bonuses (FotN/PotN) are no longer part of scoring.
    var subtotal = score.base_points + score.win_bonus + score.title_bonus +
                   score.ranked_opp_bonus;

    // ---- BASE STATS ----
    var baseLines =
      lineHtml('Sig strikes', d.sig_strikes     + ' &times; ' + cfgVal(scoringConfig, 'sig_strike'),       ssPts,   { muted: ssPts === 0 }) +
      lineHtml('Takedowns',   d.takedowns       + ' &times; ' + cfgVal(scoringConfig, 'takedown'),         tdPts,   { muted: tdPts === 0 }) +
      lineHtml('Knockdowns',  d.knockdowns      + ' &times; ' + cfgVal(scoringConfig, 'knockdown'),        kdPts,   { muted: kdPts === 0 }) +
      lineHtml('Control',     d.control_seconds + 's &times; '+ cfgVal(scoringConfig, 'control_per_sec'),  ctrlPts, { muted: ctrlPts === 0 });

    // ---- WIN BONUS ----
    var winLabel = '—';
    if (score.win_bonus > 0) {
      if (d.is_draw) {
        winLabel = 'Draw';
      } else if (d.outcome === 'ko_tko' || d.outcome === 'submission') {
        winLabel = 'R' + d.end_round + ' finish';
        if (d.end_round === 1 && d.end_time_seconds != null && d.end_time_seconds < 60) {
          winLabel += ' + quick win (<60s)';
        }
      } else {
        winLabel = 'Decision';
      }
    }
    var winLine = lineHtml('Win bonus', winLabel, score.win_bonus, { muted: score.win_bonus === 0 });

    // ---- TITLE BONUS ----
    var titleLabel = '—';
    if (score.title_bonus > 0) {
      var t = fight.title_type;
      var defendingStr = fight.is_title_defense ? 'defense' : 'win';
      if (t === 'divisional')   titleLabel = 'Divisional title ' + defendingStr;
      else if (t === 'interim') titleLabel = 'Interim title '    + defendingStr;
      else if (t === 'bmf')     titleLabel = 'BMF title '        + defendingStr;
    }
    var titleLine = lineHtml('Title bonus', titleLabel, score.title_bonus, { muted: score.title_bonus === 0 });

    // ---- RANKED OPPONENT ----
    var rankLabel = '—';
    if (score.ranked_opp_bonus > 0 && d.opponent_rank != null) {
      if      (d.opponent_rank <= 5)  rankLabel = 'Beat #' + d.opponent_rank + ' (top 5)';
      else if (d.opponent_rank <= 10) rankLabel = 'Beat #' + d.opponent_rank + ' (top 10)';
      else if (d.opponent_rank <= 15) rankLabel = 'Beat #' + d.opponent_rank + ' (top 15)';
    }
    var rankLine = lineHtml('Ranked opp.', rankLabel, score.ranked_opp_bonus, { muted: score.ranked_opp_bonus === 0 });

    // ---- CARD MULTIPLIER ----
    var multLabel;
    if      (fight.card_position === 'main_event')                                       multLabel = 'Main event';
    else if (fight.card_position === 'co_main_event' || fight.card_position === 'co_main') multLabel = 'Co-main';
    else                                                                                 multLabel = 'Main card / prelim';

    return (
      '<div class="fight-breakdown">' +
        '<div class="fight-breakdown__group">' +
          '<div class="fight-breakdown__group-label">Base stats</div>' +
          baseLines +
          '<div class="fight-breakdown__line fight-breakdown__line--subtotal">' +
            '<span class="fight-breakdown__label">Base subtotal</span>' +
            '<span class="fight-breakdown__formula"></span>' +
            '<span class="fight-breakdown__pts">' + fmt2(score.base_points) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="fight-breakdown__group">' +
          '<div class="fight-breakdown__group-label">Bonuses</div>' +
          winLine + titleLine + rankLine +
        '</div>' +
        '<div class="fight-breakdown__group fight-breakdown__group--total">' +
          '<div class="fight-breakdown__line fight-breakdown__line--subtotal">' +
            '<span class="fight-breakdown__label">Subtotal</span>' +
            '<span class="fight-breakdown__formula"></span>' +
            '<span class="fight-breakdown__pts">' + fmt2(subtotal) + '</span>' +
          '</div>' +
          '<div class="fight-breakdown__line">' +
            '<span class="fight-breakdown__label">Card multiplier</span>' +
            '<span class="fight-breakdown__formula">' + multLabel + '</span>' +
            '<span class="fight-breakdown__pts">&times; ' + score.card_multiplier.toFixed(2) + '</span>' +
          '</div>' +
          '<div class="fight-breakdown__line fight-breakdown__line--total">' +
            '<span class="fight-breakdown__label">Total</span>' +
            '<span class="fight-breakdown__formula"></span>' +
            '<span class="fight-breakdown__pts">' + fmt2(score.total) + '</span>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  // Wire click + keyboard handlers on every breakdown toggle inside rootEl.
  // The "wired" flag prevents double-binding if wireToggles is called more
  // than once on the same DOM subtree (e.g., when a table is re-rendered).
  function wireToggles(rootEl) {
    if (!rootEl) return;
    var toggles = rootEl.querySelectorAll('[data-breakdown-toggle]');
    toggles.forEach(function(toggle) {
      if (toggle.dataset.breakdownWired === '1') return;
      toggle.dataset.breakdownWired = '1';

      function flip() {
        var key    = toggle.getAttribute('data-breakdown-toggle');
        var target = rootEl.querySelector('[data-breakdown-target="' + key + '"]');
        if (!target) return;
        var isOpen = !target.hasAttribute('hidden');
        if (isOpen) {
          target.setAttribute('hidden', '');
          toggle.setAttribute('aria-expanded', 'false');
          toggle.classList.remove('is-expanded');
        } else {
          target.removeAttribute('hidden');
          toggle.setAttribute('aria-expanded', 'true');
          toggle.classList.add('is-expanded');
        }
      }

      toggle.addEventListener('click', flip);
      // Cells with role="button" need keyboard activation to be accessible
      toggle.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
      });
    });
  }

  // Expose to the global scope for both pages to consume
  root.ScoreBreakdown = { buildHtml: buildHtml, wireToggles: wireToggles };

}(typeof self !== 'undefined' ? self : this));
