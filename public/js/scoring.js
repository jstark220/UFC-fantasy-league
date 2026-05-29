// ========================================================================
// SCORING ENGINE — pure functions, single source of truth
//
// Inputs: a fight_results row + a scoring_config JSONB (from leagues table).
// Output: per-fighter score object with total + breakdown.
//
// Designed to run in either context:
//   * Browser — attaches to window.Scoring
//   * Node    — exports via module.exports (so a future API-ingestion
//               script can require this same file unchanged)
//
// No DOM access, no Supabase calls, no globals beyond the module's own
// SCORING_DEFAULTS_V1_2 constant. Pure data → number transform.
// ========================================================================

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    // Node — used by a future API ingestion service
    module.exports = factory();
  } else {
    // Browser
    root.Scoring = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  // -----------------------------------------------------------------------
  // v1.2 defaults — keys match leagues.scoring_config JSONB.
  // Used as the fallback whenever a league's scoring_config is null,
  // missing, or missing a specific key.
  // -----------------------------------------------------------------------
  var SCORING_DEFAULTS_V1_2 = {
    // Base scoring (per fight)
    sig_strike:               0.1,
    takedown:                 1,
    knockdown:                2,
    control_per_sec:          0.01,

    // Win bonuses
    finish_r1:                18,
    finish_r2:                14,
    finish_r3:                9,
    finish_r4_r5:             8,
    decision:                 6,
    quick_win_bonus:          5,    // extra +5 if R1 finish under 60s
    draw_points:              3,

    // Title & ranked-opponent wins.
    // Title bonus and ranked-opponent bonus do NOT stack — a winner gets
    // whichever is higher, not both. See computeFighterScore for the max-of
    // logic and the champion-as-top-5 treatment.
    //
    // Win vs defense are unified by default — same bonus regardless of
    // whether a champion is winning a vacant belt or defending their own.
    // is_title_defense is still auto-detected by ingestFightResults.js so
    // leagues can opt back into the distinction by overriding these keys
    // in their scoring_config JSONB (e.g. set defense values to 8 / 5).
    divisional_title_win:     12,
    divisional_title_defense: 12,
    bmf_interim_win:          8,
    bmf_interim_defense:      8,
    top5_win:                 8,
    top10_win:                5,
    top15_win:                3,

    // Performance bonuses (Fight of the Night / Performance of the Night)
    // were removed from the scoring system entirely — they were a weak idea
    // and ESPN (our data source) doesn't expose them anyway.

    // Card-position multipliers
    main_event_mult:          1.2,
    co_main_mult:             1.1
  };

  // Look up a config value, falling back to v1.2 if the league's config
  // is missing or doesn't define this key. Lets leagues override partially.
  function get(scoringConfig, key) {
    if (scoringConfig != null && scoringConfig[key] != null) {
      return Number(scoringConfig[key]);
    }
    return SCORING_DEFAULTS_V1_2[key];
  }

  // Tolerates both 'co_main' (used by fighter modal) and 'co_main_event'
  // (used by the score-event form) — same multiplier either way.
  function multiplierFor(cardPosition, cfg) {
    if (cardPosition === 'main_event')                            return get(cfg, 'main_event_mult');
    if (cardPosition === 'co_main_event' || cardPosition === 'co_main') return get(cfg, 'co_main_mult');
    return 1.0;
  }

  // -----------------------------------------------------------------------
  // computeFighterScore
  //
  // Computes one fighter's total points from a single fight.
  //
  // Args:
  //   fight          — a fight_results row, with both fighter_a_* and
  //                    fighter_b_* prefixed columns plus shared fields
  //                    (outcome, winner_id, end_round, end_time_seconds,
  //                    title_type, is_title_defense, card_position).
  //   isA            — true if computing for fighter A, false for B
  //   scoringConfig  — JSONB from leagues.scoring_config; null/undefined
  //                    falls back entirely to v1.2 defaults
  //
  // Returns: { fighterId, total, base_points, win_bonus, title_bonus,
  //            ranked_opp_bonus, card_multiplier, scoring_detail }
  // -----------------------------------------------------------------------
  function computeFighterScore(fight, isA, scoringConfig) {
    var cfg    = scoringConfig || null;
    var prefix = isA ? 'fighter_a_' : 'fighter_b_';

    var sigStrikes   = fight[prefix + 'sig_strikes']      || 0;
    var takedowns    = fight[prefix + 'takedowns']        || 0;
    var knockdowns   = fight[prefix + 'knockdowns']       || 0;
    var controlSec   = fight[prefix + 'control_seconds']  || 0;
    var opponentRank = fight[prefix + 'opponent_rank'];   // null if unranked

    var fighterId = isA ? fight.fighter_a_id : fight.fighter_b_id;
    var isWinner  = fight.winner_id === fighterId;
    var isDraw    = fight.outcome === 'draw';

    // ---- Base stats ----
    var base = (sigStrikes * get(cfg, 'sig_strike'))
             + (takedowns  * get(cfg, 'takedown'))
             + (knockdowns * get(cfg, 'knockdown'))
             + (controlSec * get(cfg, 'control_per_sec'));

    // ---- Win bonus ----
    var winBonus = 0;
    if (isWinner) {
      var round    = fight.end_round;
      var timeSec  = fight.end_time_seconds;
      var isFinish = fight.outcome === 'ko_tko' || fight.outcome === 'submission';

      if (isFinish) {
        if      (round === 1) winBonus = get(cfg, 'finish_r1');
        else if (round === 2) winBonus = get(cfg, 'finish_r2');
        else if (round === 3) winBonus = get(cfg, 'finish_r3');
        else                  winBonus = get(cfg, 'finish_r4_r5');
        // Quick-win bonus: R1 finish inside 60 seconds
        if (round === 1 && timeSec != null && timeSec < 60) {
          winBonus += get(cfg, 'quick_win_bonus');
        }
      } else if (
        fight.outcome === 'decision_u' || fight.outcome === 'decision_s' ||
        fight.outcome === 'decision_m' || fight.outcome === 'dq'
      ) {
        winBonus = get(cfg, 'decision');
      }
    } else if (isDraw) {
      winBonus = get(cfg, 'draw_points');
    }

    // ---- Title bonus (winner only) ----
    var titleBonus = 0;
    if (isWinner && fight.title_type && fight.title_type !== 'none') {
      if (fight.title_type === 'divisional') {
        titleBonus = fight.is_title_defense
          ? get(cfg, 'divisional_title_defense')
          : get(cfg, 'divisional_title_win');
      } else if (fight.title_type === 'interim' || fight.title_type === 'bmf') {
        titleBonus = fight.is_title_defense
          ? get(cfg, 'bmf_interim_defense')
          : get(cfg, 'bmf_interim_win');
      }
    }

    // ---- Ranked-opponent bonus (winner only) ----
    // Champions have current_rank=null in our DB, so their opponent_rank
    // also comes through as null. But champions ARE top-5 talent — beating
    // the champion should give the same opponent-quality bonus as beating
    // the #1 contender. Infer this from the fight context: if it's a
    // divisional title fight and the opponent had null rank, the opponent
    // was the defending champion.
    var rankedOppBonus = 0;
    if (isWinner) {
      var effectiveRank = opponentRank;
      if (effectiveRank == null
          && fight.title_type
          && fight.title_type !== 'none'
          && !fight.is_title_defense) {
        // We're the challenger who just won the belt (divisional / interim /
        // BMF). The opponent was the title holder, so their stored
        // opponent_rank is null. Treat them as top-5 talent for this bonus.
        effectiveRank = 1;
      }
      if (effectiveRank != null) {
        if      (effectiveRank <= 5)  rankedOppBonus = get(cfg, 'top5_win');
        else if (effectiveRank <= 10) rankedOppBonus = get(cfg, 'top10_win');
        else if (effectiveRank <= 15) rankedOppBonus = get(cfg, 'top15_win');
      }
    }

    // Matchup bonus is the larger of title vs ranked-opponent — they do NOT
    // stack. Zero out the smaller one so the breakdown UI only shows the one
    // that actually counted toward the score.
    if (titleBonus >= rankedOppBonus) {
      rankedOppBonus = 0;
    } else {
      titleBonus = 0;
    }

    // ---- Card-position multiplier ----
    var multiplier = multiplierFor(fight.card_position, cfg);

    var subtotal = base + winBonus + titleBonus + rankedOppBonus;
    var total    = Math.round(subtotal * multiplier * 100) / 100;  // 2 decimals

    return {
      fighterId:        fighterId,
      total:            total,
      base_points:      Math.round(base * 100) / 100,
      win_bonus:        winBonus,
      title_bonus:      titleBonus,
      ranked_opp_bonus: rankedOppBonus,
      card_multiplier:  multiplier,
      scoring_detail: {
        sig_strikes:      sigStrikes,
        takedowns:        takedowns,
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

  return {
    computeFighterScore:   computeFighterScore,
    SCORING_DEFAULTS_V1_2: SCORING_DEFAULTS_V1_2
  };

}));
