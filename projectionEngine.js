// ============================================================================
// projectionEngine.js
// Pure functions that compute a fighter's projected fantasy points for a
// single upcoming fight. No DB calls — callers assemble the inputs.
//
// The projection is:
//   E[total] = (E[base] + E[win bonus] + E[matchup bonus]) × multiplier
//
//   E[base]         = recency-weighted avg of past base points (sig strikes +
//                     takedowns + knockdowns + control), with shrinkage toward
//                     the division average for fighters with thin history.
//
//   E[win bonus]    = P(win) × Σ P(method) × method_bonus, where method is
//                     {R1 finish, R2 finish, R3 finish, R4/R5 finish, Decision}.
//                     The +5 quick-win bonus rolls into R1 finish via the
//                     fighter's historical sub-60s R1 finish rate.
//
//   E[matchup]      = P(win) × max(title_bonus_for_this_fight,
//                                  rank_bonus_for_this_fight).
//                     Title and rank do NOT stack (matches scoring.js).
//
//   multiplier      = 1.2 main event, 1.1 co-main, 1.0 otherwise.
//
// FotN is excluded from projections — too noisy to predict per-fighter,
// and it nets out to a few tenths of a point across a roster. PotN was
// removed from the scoring system entirely.
// ============================================================================

const Scoring = require('./public/js/scoring.js');

// --- Tuning knobs ----------------------------------------------------------

// Shrinkage: a fighter's personal stats get full weight at this many fights,
// linearly blended with the division average below that. Bayesian-ish.
const FULL_WEIGHT_FIGHTS = 10;

// Recency: last N fights get extra weight in the base-points average.
const RECENT_WINDOW   = 5;
const RECENT_WEIGHT   = 2;
const OLDER_WEIGHT    = 1;

// --- Fighter history extraction --------------------------------------------

// Given an array of completed fight_results rows for ONE fighter, returns
// the per-fighter stats needed for projection:
//   { baseAvg, finishProfile, fightCount, winCount }
//
// fights[i] must include the fighter_a_* / fighter_b_* columns plus shared
// fields, the same shape Scoring.computeFighterScore expects.
function computeFighterHistory(fights, fighterId) {
  const completed = fights.filter(f => !!f.outcome);
  if (completed.length === 0) {
    return {
      baseAvg:       0,
      finishProfile: null,
      fightCount:    0,
      winCount:      0
    };
  }

  // Sort by event date ascending so we can identify the most-recent N for
  // recency weighting. Fights without an event date sink to the front (they
  // get the lower weight) — defensive only; should not happen in practice.
  const sorted = completed.slice().sort((a, b) => {
    const dA = a.event && a.event.event_date ? a.event.event_date : '';
    const dB = b.event && b.event.event_date ? b.event.event_date : '';
    return dA < dB ? -1 : 1;
  });

  const cutoffIdx = Math.max(0, sorted.length - RECENT_WINDOW);

  // ---- Base points (recency-weighted average) ----
  let totalWeight     = 0;
  let weightedBaseSum = 0;
  for (let i = 0; i < sorted.length; i++) {
    const fight = sorted[i];
    const isA   = fight.fighter_a_id === fighterId;
    const score = Scoring.computeFighterScore(fight, isA, null);
    const w     = (i >= cutoffIdx) ? RECENT_WEIGHT : OLDER_WEIGHT;
    weightedBaseSum += score.base_points * w;
    totalWeight     += w;
  }
  const baseAvg = totalWeight > 0 ? weightedBaseSum / totalWeight : 0;

  // ---- Finish profile (from wins only) ----
  // Distribution over {r1_finish, r2_finish, r3_finish, r45_finish, decision},
  // plus pQuickGivenR1Finish = % of R1 finishes that ended <60s (drives the
  // +5 quick-win bonus).
  const wins = sorted.filter(f => f.winner_id === fighterId);
  let r1F = 0, r2F = 0, r3F = 0, r45F = 0, dec = 0, r1Quick = 0;
  for (const fight of wins) {
    const isFinish = fight.outcome === 'ko_tko' || fight.outcome === 'submission';
    if (isFinish) {
      const r = fight.end_round;
      if      (r === 1) {
        r1F++;
        if (fight.end_time_seconds != null && fight.end_time_seconds < 60) r1Quick++;
      }
      else if (r === 2) r2F++;
      else if (r === 3) r3F++;
      else              r45F++;
    } else if (
      fight.outcome === 'decision_u' || fight.outcome === 'decision_s' ||
      fight.outcome === 'decision_m' || fight.outcome === 'dq'
    ) {
      dec++;
    }
    // Draws and no-contests aren't wins, can't appear here.
  }
  const totalWins = wins.length;
  let finishProfile = null;
  if (totalWins > 0) {
    finishProfile = {
      pR1Finish:           r1F  / totalWins,
      pR2Finish:           r2F  / totalWins,
      pR3Finish:           r3F  / totalWins,
      pR45Finish:          r45F / totalWins,
      pDecision:           dec  / totalWins,
      pQuickGivenR1Finish: r1F > 0 ? r1Quick / r1F : 0
    };
  }

  return {
    baseAvg:       baseAvg,
    finishProfile: finishProfile,
    fightCount:    completed.length,
    winCount:      totalWins
  };
}

// Aggregate a division's stats from a list of (fight_row, fighterId) pairs —
// i.e. every fighter's perspective on every fight they participated in in
// that division. Used as the prior we shrink personal stats toward.
function computeDivisionAggregate(fighterPerspectives) {
  if (fighterPerspectives.length === 0) {
    return {
      baseAvg: 14,  // safe v1.2 baseline
      finishProfile: {
        pR1Finish:           0.10,
        pR2Finish:           0.10,
        pR3Finish:           0.05,
        pR45Finish:          0.02,
        pDecision:           0.73,
        pQuickGivenR1Finish: 0.10
      }
    };
  }
  let baseSum = 0, baseN = 0;
  let r1F = 0, r2F = 0, r3F = 0, r45F = 0, dec = 0, r1Quick = 0, winN = 0;
  for (const { fight, fighterId } of fighterPerspectives) {
    const isA   = fight.fighter_a_id === fighterId;
    const score = Scoring.computeFighterScore(fight, isA, null);
    baseSum += score.base_points;
    baseN++;
    if (fight.winner_id === fighterId) {
      const isFinish = fight.outcome === 'ko_tko' || fight.outcome === 'submission';
      if (isFinish) {
        const r = fight.end_round;
        if      (r === 1) {
          r1F++;
          if (fight.end_time_seconds != null && fight.end_time_seconds < 60) r1Quick++;
        }
        else if (r === 2) r2F++;
        else if (r === 3) r3F++;
        else              r45F++;
      } else if (
        fight.outcome === 'decision_u' || fight.outcome === 'decision_s' ||
        fight.outcome === 'decision_m' || fight.outcome === 'dq'
      ) {
        dec++;
      }
      winN++;
    }
  }
  return {
    baseAvg: baseN > 0 ? baseSum / baseN : 14,
    finishProfile: winN > 0 ? {
      pR1Finish:           r1F  / winN,
      pR2Finish:           r2F  / winN,
      pR3Finish:           r3F  / winN,
      pR45Finish:          r45F / winN,
      pDecision:           dec  / winN,
      pQuickGivenR1Finish: r1F > 0 ? r1Quick / r1F : 0
    } : null
  };
}

// Blend personal stats with division stats based on sample size.
//   alpha = min(1, fightCount / FULL_WEIGHT_FIGHTS)
//   blended = alpha * personal + (1 - alpha) * division
function blendWithDivision(personal, division) {
  const n = personal.fightCount;
  const alpha = Math.min(1, n / FULL_WEIGHT_FIGHTS);

  const baseAvg = alpha * personal.baseAvg + (1 - alpha) * division.baseAvg;

  // Finish profile blend — but only blend with division if the fighter has
  // any wins at all. If 0 wins, use division entirely.
  const personalProfile = personal.finishProfile;
  const divisionProfile = division.finishProfile;
  let finishProfile;
  if (!personalProfile) {
    finishProfile = divisionProfile;
  } else if (!divisionProfile) {
    finishProfile = personalProfile;
  } else {
    // Shrink win-count separately — finish distribution is wins-only, so
    // even an experienced fighter with few wins should shrink toward
    // division.
    const winAlpha = Math.min(1, personal.winCount / FULL_WEIGHT_FIGHTS);
    finishProfile = {
      pR1Finish:           winAlpha * personalProfile.pR1Finish           + (1 - winAlpha) * divisionProfile.pR1Finish,
      pR2Finish:           winAlpha * personalProfile.pR2Finish           + (1 - winAlpha) * divisionProfile.pR2Finish,
      pR3Finish:           winAlpha * personalProfile.pR3Finish           + (1 - winAlpha) * divisionProfile.pR3Finish,
      pR45Finish:          winAlpha * personalProfile.pR45Finish          + (1 - winAlpha) * divisionProfile.pR45Finish,
      pDecision:           winAlpha * personalProfile.pDecision           + (1 - winAlpha) * divisionProfile.pDecision,
      pQuickGivenR1Finish: winAlpha * personalProfile.pQuickGivenR1Finish + (1 - winAlpha) * divisionProfile.pQuickGivenR1Finish
    };
  }
  return { baseAvg, finishProfile };
}

// --- Bonus expectations ----------------------------------------------------

// E[win bonus | win] from a finish profile. Uses v1.2 scoring values.
function expectedWinBonusGivenWin(finishProfile, scoringConfig) {
  const cfg = scoringConfig || null;
  const get = (key) =>
    (cfg && cfg[key] != null) ? Number(cfg[key]) : Scoring.SCORING_DEFAULTS_V1_2[key];

  const r1Bonus  = get('finish_r1');
  const r2Bonus  = get('finish_r2');
  const r3Bonus  = get('finish_r3');
  const r45Bonus = get('finish_r4_r5');
  const decBonus = get('decision');
  const quickB   = get('quick_win_bonus');

  return (
    finishProfile.pR1Finish  * (r1Bonus + finishProfile.pQuickGivenR1Finish * quickB) +
    finishProfile.pR2Finish  *  r2Bonus  +
    finishProfile.pR3Finish  *  r3Bonus  +
    finishProfile.pR45Finish *  r45Bonus +
    finishProfile.pDecision  *  decBonus
  );
}

// Title and rank bonuses do NOT stack (matches scoring.js max-of logic).
// Returns the larger of the two for THIS fight (winner-only — caller
// multiplies by P(win)).
function matchupBonus(fight, opponentCurrentRank, scoringConfig) {
  const cfg = scoringConfig || null;
  const get = (key) =>
    (cfg && cfg[key] != null) ? Number(cfg[key]) : Scoring.SCORING_DEFAULTS_V1_2[key];

  // Title bonus (if fight is for a title)
  let titleBonus = 0;
  if (fight.title_type && fight.title_type !== 'none') {
    if (fight.title_type === 'divisional') {
      titleBonus = fight.is_title_defense
        ? get('divisional_title_defense')
        : get('divisional_title_win');
    } else if (fight.title_type === 'interim' || fight.title_type === 'bmf') {
      titleBonus = fight.is_title_defense
        ? get('bmf_interim_defense')
        : get('bmf_interim_win');
    }
  }

  // Rank bonus (effective rank handles the champion-as-top-5 case)
  let effectiveRank = opponentCurrentRank;
  if (effectiveRank == null
      && fight.title_type
      && fight.title_type !== 'none'
      && !fight.is_title_defense) {
    // Challenger fighting for the belt — opponent is the champ. Treat as
    // top-5 talent (matches scoring.js).
    effectiveRank = 1;
  }
  let rankBonus = 0;
  if (effectiveRank != null) {
    if      (effectiveRank <= 5)  rankBonus = get('top5_win');
    else if (effectiveRank <= 10) rankBonus = get('top10_win');
    else if (effectiveRank <= 15) rankBonus = get('top15_win');
  }

  return Math.max(titleBonus, rankBonus);
}

// --- Card-position multiplier ---------------------------------------------

function multiplierForCardPosition(cardPosition, scoringConfig) {
  const cfg = scoringConfig || null;
  const get = (key) =>
    (cfg && cfg[key] != null) ? Number(cfg[key]) : Scoring.SCORING_DEFAULTS_V1_2[key];
  if (cardPosition === 'main_event')                              return get('main_event_mult');
  if (cardPosition === 'co_main_event' || cardPosition === 'co_main') return get('co_main_mult');
  return 1.0;
}

// --- Main projection ------------------------------------------------------

// Produce the projection for one (fighter, upcoming fight) tuple.
// Inputs:
//   blended    : { baseAvg, finishProfile } — already blended with division
//   fight      : the fight_results row for this upcoming fight, including
//                card_position, title_type, is_title_defense
//   opponentRank : opponent's current_rank (null if unranked)
//   pWin       : P(this fighter wins) in [0,1]
//   pWinSource : 'polymarket' | 'rank_heuristic' | 'default'
//   fightsSampled : how many past fights fed the blended history
function projectFighter(blended, fight, opponentRank, pWin, pWinSource, fightsSampled, scoringConfig) {
  const baseAvg          = blended.baseAvg;
  const expWinBonusGiven = expectedWinBonusGivenWin(blended.finishProfile, scoringConfig);
  const expWinBonus      = pWin * expWinBonusGiven;
  const matchup          = matchupBonus(fight, opponentRank, scoringConfig);
  const expMatchupBonus  = pWin * matchup;
  const multiplier       = multiplierForCardPosition(fight.card_position, scoringConfig);

  const subtotal  = baseAvg + expWinBonus + expMatchupBonus;
  const projected = Math.round(subtotal * multiplier * 100) / 100;

  return {
    projected_points: projected,
    base_pts:         Math.round(baseAvg          * 100) / 100,
    win_bonus_pts:    Math.round(expWinBonus      * 100) / 100,
    rank_bonus_pts:   Math.round(expMatchupBonus  * 100) / 100,  // matchup bonus — name kept for table column
    title_bonus_pts:  0,  // folded into rank_bonus_pts via max-of; kept for schema
    multiplier:       multiplier,
    p_win_used:       Math.round(pWin * 10000) / 10000,
    p_win_source:     pWinSource,
    fights_sampled:   fightsSampled
  };
}

module.exports = {
  computeFighterHistory,
  computeDivisionAggregate,
  blendWithDivision,
  expectedWinBonusGivenWin,
  matchupBonus,
  multiplierForCardPosition,
  projectFighter,

  // Knobs (exported so callers / tests can inspect)
  FULL_WEIGHT_FIGHTS,
  RECENT_WINDOW,
  RECENT_WEIGHT,
  OLDER_WEIGHT
};
