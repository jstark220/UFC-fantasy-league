// ========================================================================
// FANTASY VALUE
// Composite per-fighter score (base score × activity + rank bonus +
// consistency + streak + SoS) used to rank fighters across the entire DB.
//
// Originally lived inline in waivers.js. Extracted here so the fighter
// modal (and any other surface) can show the same number without
// duplicating the algorithm.
//
// Inputs: every completed fight_result + the league's scoring_config (or
// null for v1.2 defaults). Same data the waivers page already loads —
// this module caches it so other pages don't pay the load cost more than
// once per session.
//
// Public API:
//   FantasyValue.ensureLoaded(leagueId, scoringConfig) -> Promise<cache>
//   FantasyValue.scoreFor(fighterId)        -> number | null
//   FantasyValue.rankFor(fighterId)         -> { rank, total } | null
//   FantasyValue.pointsFor(fighterId)       -> pts breakdown | null
//   FantasyValue.showBreakdownModal(fighter)
//   FantasyValue.buildPointsMap(fightResults, scoringConfig)  // pure
//   FantasyValue.computeFantasyValue(fighter, pts)            // pure
// ========================================================================

(function (root) {

  // -------- Pure: build per-fighter points map ----------------------------
  // Lifted verbatim from waivers.js so behavior matches. "Recent" means the
  // last 12 months of today (the fighter's activity multiplier).
  function buildPointsMap(fightResults, scoringConfig) {
    var map = {};
    var oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    // Pass 1: collect raw fight scores per fighter. No-contests excluded
    // (eye-poke / accidental DQ shouldn't pull either fighter's avg).
    fightResults.forEach(function (fight) {
      if (fight.outcome === 'no_contest') return;
      var eventDate = fight.event && fight.event.event_date
        ? new Date(fight.event.event_date + 'T12:00:00') : null;
      var isRecent = eventDate && eventDate >= oneYearAgo;

      [true, false].forEach(function (isA) {
        var fighterId = isA ? fight.fighter_a_id : fight.fighter_b_id;
        if (!fighterId) return;
        var score = Scoring.computeFighterScore(fight, isA, scoringConfig);

        if (!map[fighterId]) {
          map[fighterId] = {
            totalPts: 0, recentPts: 0, fightCount: 0, recentFightCount: 0,
            _fights: []
          };
        }

        var isWin  = fight.winner_id === fighterId;
        var isDraw = fight.outcome === 'draw';
        var isLoss = !isWin && !isDraw && fight.winner_id != null;

        var oppRankPrefix = isA ? 'fighter_a_' : 'fighter_b_';
        var oppRank = fight[oppRankPrefix + 'opponent_rank'];
        // Title holders had rank=null when they fought — treat as #1 for SoS.
        if (oppRank == null && fight.title_type && fight.title_type !== 'none') {
          oppRank = 1;
        }

        map[fighterId].totalPts   += score.total;
        map[fighterId].fightCount += 1;
        // opponentId — the other side of the fight, captured here so the
        // surfaced recentResults entries can show who the W/L was against
        // without consumers having to re-query fight_results.
        var opponentId = isA ? fight.fighter_b_id : fight.fighter_a_id;
        map[fighterId]._fights.push({
          score: score.total, date: eventDate,
          isWin: isWin, isDraw: isDraw, isLoss: isLoss,
          oppRank: oppRank,
          opponentId: opponentId
        });
        if (isRecent) {
          map[fighterId].recentPts        += score.total;
          map[fighterId].recentFightCount += 1;
        }
      });
    });

    // Pass 2: averages + last-3 avg
    Object.keys(map).forEach(function (id) {
      var e = map[id];
      e.avgPts = e.fightCount > 0 ? e.totalPts / e.fightCount : 0;
      e._fights.sort(function (a, b) {
        return (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0);
      });
      var last3 = e._fights.slice(0, 3);
      e.last3Avg = last3.length > 0
        ? last3.reduce(function (s, f) { return s + f.score; }, 0) / last3.length
        : 0;
    });

    // Pass 3: league mean for Bayesian blend
    var ids = Object.keys(map);
    var leagueMean = ids.length > 0
      ? ids.reduce(function (s, id) { return s + map[id].avgPts; }, 0) / ids.length
      : 10;

    // Pass 4: composite components
    var K = 5;
    Object.keys(map).forEach(function (id) {
      var e = map[id];
      var blendedAvg   = (e.fightCount * e.avgPts + K * leagueMean) / (e.fightCount + K);
      var last3Weight  = 0.45 * Math.min(e.fightCount, 3) / 3;
      var careerWeight = 1 - last3Weight;
      var baseScore    = careerWeight * blendedAvg + last3Weight * e.last3Avg;

      var actMult = e.recentFightCount === 0 ? 0.6
                  : e.recentFightCount === 1 ? 0.85
                  :                            1.0;

      var goodFights = e._fights.filter(function (f) { return f.score > leagueMean; }).length;
      var consistencyBonus = Math.min(goodFights * 0.4, 2.5);

      var winStreak = 0, lossStreak = 0;
      for (var i = 0; i < e._fights.length; i++) {
        var f = e._fights[i];
        if (f.isWin) { if (lossStreak > 0) break; winStreak++; }
        else if (f.isLoss) { if (winStreak > 0) break; lossStreak++; }
        else break;
      }
      var streakBonus = 0;
      if      (winStreak  >= 3) streakBonus =  3;
      else if (winStreak  >= 2) streakBonus =  1.5;
      else if (lossStreak >= 2) streakBonus = -3;
      else if (lossStreak >= 1) streakBonus = -1;

      var sosFights = e._fights.slice(0, 5);
      var sosTotal  = 0;
      for (var k = 0; k < sosFights.length; k++) {
        var r = sosFights[k].oppRank;
        var q = r == null ? 0
              : r <= 1    ? 1.0
              : r <= 5    ? 0.7
              : r <= 10   ? 0.4
              : r <= 15   ? 0.2
              :             0;
        sosTotal += q;
      }
      var sosAvg = sosFights.length > 0 ? sosTotal / sosFights.length : 0;
      var sosBonus = Math.round(sosAvg * 4 * 10) / 10;

      e.blendedAvg       = Math.round(blendedAvg      * 10) / 10;
      e.baseScore        = Math.round(baseScore       * 10) / 10;
      e.activityMult     = actMult;
      e.consistencyBonus = Math.round(consistencyBonus * 10) / 10;
      e.streakBonus      = streakBonus;
      e.winStreak        = winStreak;
      e.lossStreak       = lossStreak;
      e.sosBonus         = sosBonus;
      e.sosAvg           = Math.round(sosAvg * 100) / 100;
      e.sosFightCount    = sosFights.length;
      e.goodFightCount   = goodFights;

      // Preserve a slim outcomes array (last-5, most recent first) so
      // consumers can render a form sparkline with hover details without
      // re-querying every fight_results row. Each entry carries enough to
      // build "Win vs Smith · Mar 14 · 28.5 pts" downstream — opponentId
      // is resolved to a name by whichever surface is rendering (since
      // the consumer already has a fighter lookup table).
      e.recentResults = e._fights.slice(0, 5).map(function(f) {
        return {
          result:     f.isWin ? 'W' : f.isLoss ? 'L' : f.isDraw ? 'D' : 'N',
          date:       f.date ? f.date.toISOString() : null,
          opponentId: f.opponentId || null,
          score:      f.score
        };
      });

      delete e._fights;

      e.totalPts  = Math.round(e.totalPts  * 10) / 10;
      e.recentPts = Math.round(e.recentPts * 10) / 10;
      e.avgPts    = Math.round(e.avgPts    * 10) / 10;
      e.last3Avg  = Math.round(e.last3Avg  * 10) / 10;
    });

    return map;
  }

  // -------- Pure: composite to a single score -----------------------------
  // Pass the fighter row (for rank/champion) and their pts entry.
  function computeFantasyValue(fighter, pts) {
    if (!pts || !pts.baseScore) return 0;
    var rankBonus = fighter.is_champion                                ? 10
                  : (fighter.current_rank && fighter.current_rank <= 5)  ? 6
                  : (fighter.current_rank && fighter.current_rank <= 10) ? 3
                  : (fighter.current_rank && fighter.current_rank <= 15) ? 1
                  :                                                        0;
    return pts.baseScore * pts.activityMult
         + rankBonus
         + pts.consistencyBonus
         + (pts.streakBonus || 0)
         + (pts.sosBonus    || 0);
  }

  // -------- Loaders -------------------------------------------------------
  // Paginated fight_results fetch — the table tops 1k rows, so a single
  // .select() silently drops everything past the first page otherwise.
  async function fetchAllFightResults() {
    var FIGHT_COLS = 'fighter_a_id,fighter_b_id,outcome,winner_id,end_round,' +
      'end_time_seconds,title_type,is_title_defense,card_position,' +
      'fighter_a_sig_strikes,fighter_a_takedowns,fighter_a_knockdowns,fighter_a_control_seconds,' +
      'fighter_a_opponent_rank,' +
      'fighter_b_sig_strikes,fighter_b_takedowns,fighter_b_knockdowns,fighter_b_control_seconds,' +
      'fighter_b_opponent_rank,' +
      'event:ufc_events(event_date)';

    var all = [];
    var PAGE = 1000, from = 0;
    while (true) {
      var res = await supabaseClient
        .from('fight_results')
        .select(FIGHT_COLS)
        .not('outcome', 'is', null)
        // Unique tiebreaker so paginated .range() windows are stable across
        // queries. Without a deterministic ORDER BY, multi-page fetches can
        // repeat or skip rows — here that would double-count or drop fights
        // in the fantasy-value math. (Stable in practice today, but unsafe.)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (res.error || !res.data) break;
      all = all.concat(res.data);
      if (res.data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  }

  async function fetchAllFighters() {
    // Only the fields the FV math + rank bonus need. Paginated like fights.
    var all = [];
    var PAGE = 1000, from = 0;
    while (true) {
      var res = await supabaseClient
        .from('fighters')
        .select('id, name, current_rank, is_champion, is_sub_champion, sub_title_type, is_active')
        // Unique tiebreaker — see fetchAllFightResults above. Keeps the
        // paginated fighter fetch from silently dropping/duplicating rows.
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (res.error || !res.data) break;
      all = all.concat(res.data);
      if (res.data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  }

  // -------- Cache + ensureLoaded ------------------------------------------
  // _cache: { key, pointsMap, fighterMap, fvByFighterId, rankByFighterId, totalRanked }
  var _cache = null;
  var _loading = null;

  // The cache key combines leagueId + a serialized scoringConfig so two
  // leagues with different scoring don't poison each other's numbers.
  function cacheKey(leagueId, scoringConfig) {
    return (leagueId || '_global') + '::' + (scoringConfig ? JSON.stringify(scoringConfig) : 'default');
  }

  async function ensureLoaded(leagueId, scoringConfig) {
    var key = cacheKey(leagueId, scoringConfig);
    if (_cache && _cache.key === key) return _cache;
    if (_loading) return _loading;

    _loading = (async function () {
      var [fights, fighters] = await Promise.all([
        fetchAllFightResults(),
        fetchAllFighters()
      ]);
      var pointsMap  = buildPointsMap(fights, scoringConfig);
      var fighterMap = {};
      for (var i = 0; i < fighters.length; i++) fighterMap[fighters[i].id] = fighters[i];

      // Compute FV for every fighter we have stats for, then rank descending.
      // Fighters with zero pts (0 fights) aren't ranked.
      var scored = [];
      Object.keys(pointsMap).forEach(function (fid) {
        var f = fighterMap[fid];
        if (!f) return;
        var fv = computeFantasyValue(f, pointsMap[fid]);
        if (fv > 0) scored.push({ id: fid, fv: fv });
      });
      scored.sort(function (a, b) { return b.fv - a.fv; });

      var fvByFighterId   = {};
      var rankByFighterId = {};
      scored.forEach(function (s, idx) {
        fvByFighterId[s.id]   = Math.round(s.fv * 10) / 10;
        rankByFighterId[s.id] = idx + 1;
      });

      _cache = {
        key:             key,
        pointsMap:       pointsMap,
        fighterMap:      fighterMap,
        fvByFighterId:   fvByFighterId,
        rankByFighterId: rankByFighterId,
        totalRanked:     scored.length
      };
      _loading = null;
      return _cache;
    })();
    return _loading;
  }

  function scoreFor(fighterId) {
    if (!_cache) return null;
    var v = _cache.fvByFighterId[fighterId];
    return v == null ? null : v;
  }
  function rankFor(fighterId) {
    if (!_cache) return null;
    var r = _cache.rankByFighterId[fighterId];
    return r == null ? null : { rank: r, total: _cache.totalRanked };
  }
  function pointsFor(fighterId) {
    if (!_cache) return null;
    return _cache.pointsMap[fighterId] || null;
  }

  // -------- Breakdown modal (moved from waivers.js) -----------------------
  // Renders the same FV breakdown that waivers showed when you clicked a
  // value chip. Callable from any page now via FantasyValue.showBreakdownModal.
  function _escapeHtml(str) {
    if (str === null || str === undefined) return '';
    var d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

  function showBreakdownModal(fighter) {
    if (!_cache) return;
    var pts = _cache.pointsMap[fighter.id];
    if (!pts) return;

    var existing = document.getElementById('fvBreakdownModal');
    if (existing) existing.remove();

    var rankBonus, rankLabel;
    if (fighter.is_champion) {
      rankBonus = 10; rankLabel = 'Champion';
    } else if (fighter.current_rank && fighter.current_rank <= 5) {
      rankBonus = 6;  rankLabel = 'Top 5 (#' + fighter.current_rank + ')';
    } else if (fighter.current_rank && fighter.current_rank <= 10) {
      rankBonus = 3;  rankLabel = 'Top 10 (#' + fighter.current_rank + ')';
    } else if (fighter.current_rank && fighter.current_rank <= 15) {
      rankBonus = 1;  rankLabel = 'Top 15 (#' + fighter.current_rank + ')';
    } else {
      rankBonus = 0;  rankLabel = fighter.current_rank ? '#' + fighter.current_rank : 'Unranked';
    }

    var streakBonus = pts.streakBonus || 0;
    var streakLabel;
    if      (pts.winStreak  >= 3) streakLabel = pts.winStreak  + '-fight win streak';
    else if (pts.winStreak  >= 2) streakLabel = pts.winStreak  + '-fight win streak';
    else if (pts.lossStreak >= 2) streakLabel = pts.lossStreak + '-fight losing skid';
    else if (pts.lossStreak >= 1) streakLabel = 'Coming off a loss';
    else                          streakLabel = 'No streak';

    var actLabel = pts.recentFightCount === 0 ? '0 fights last 12 months'
                 : pts.recentFightCount === 1 ? '1 fight last 12 months'
                 : pts.recentFightCount + ' fights last 12 months';
    var actMult  = pts.activityMult === 1.0 ? '1.00' : pts.activityMult.toFixed(2);

    var last3Count = Math.min(pts.fightCount, 3);
    var last3Label = last3Count < 3
      ? 'Last ' + last3Count + ' fight' + (last3Count === 1 ? '' : 's') + ' avg'
      : 'Last 3 fights avg';

    var fv = computeFantasyValue(fighter, pts);

    function row(label, value, note, highlight) {
      var valueStr = typeof value === 'number' ? value.toFixed(1) : String(value);
      return '<div class="fv-breakdown-row' + (highlight ? ' fv-breakdown-row--total' : '') + '">' +
        '<span class="fv-breakdown-row__label">' + _escapeHtml(label) + '</span>' +
        (note ? '<span class="fv-breakdown-row__note">' + _escapeHtml(note) + '</span>' : '<span></span>') +
        '<span class="fv-breakdown-row__value">' + _escapeHtml(valueStr) + '</span>' +
      '</div>';
    }

    var overlay = document.createElement('div');
    overlay.id = 'fvBreakdownModal';
    overlay.className = 'move-flex-modal-overlay';
    overlay.innerHTML =
      '<div class="move-flex-modal" role="dialog" aria-modal="true" style="max-width:420px">' +
        '<div class="move-flex-modal__header">' +
          '<p class="move-flex-modal__title">Fantasy Value Score</p>' +
          '<button class="move-flex-modal__close" id="closeFvBtn" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="move-flex-modal__body">' +
          '<p class="move-flex-fighter-name" style="margin-bottom:var(--space-4)">' +
            _escapeHtml(fighter.name) +
          '</p>' +

          '<p class="fv-breakdown-section">Base score</p>' +
          '<div class="fv-breakdown-table">' +
            row('Career avg',  pts.avgPts,     pts.fightCount + ' fight' + (pts.fightCount === 1 ? '' : 's')) +
            row('Adjusted avg', pts.blendedAvg, 'Sample-size correction') +
            row(last3Label,    pts.last3Avg,   'Recent form') +
            row('Base score',  pts.baseScore,  '55% adjusted avg + 45% recent') +
          '</div>' +

          '<p class="fv-breakdown-section" style="margin-top:var(--space-4)">Multipliers &amp; bonuses</p>' +
          '<div class="fv-breakdown-table">' +
            row('Activity',     pts.baseScore * pts.activityMult, actLabel + '  ×' + actMult) +
            row('Consistency',  '+' + pts.consistencyBonus.toFixed(1), pts.goodFightCount + ' above-avg fight' + (pts.goodFightCount === 1 ? '' : 's')) +
            row('Streak',       (streakBonus >= 0 ? '+' : '') + streakBonus.toFixed(1), streakLabel) +
            row('SoS',          '+' + (pts.sosBonus || 0).toFixed(1), 'Opp quality, last ' + pts.sosFightCount + ' fight' + (pts.sosFightCount === 1 ? '' : 's')) +
            row('Rank bonus',   '+' + rankBonus, rankLabel) +
          '</div>' +

          '<div class="fv-breakdown-table" style="margin-top:var(--space-4)">' +
            row('Fantasy Value', fv, '', true) +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    document.getElementById('closeFvBtn').addEventListener('click', function () { overlay.remove(); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
    });
  }

  root.FantasyValue = {
    ensureLoaded:        ensureLoaded,
    scoreFor:            scoreFor,
    rankFor:             rankFor,
    pointsFor:           pointsFor,
    showBreakdownModal:  showBreakdownModal,
    buildPointsMap:      buildPointsMap,
    computeFantasyValue: computeFantasyValue,
    fetchAllFightResults: fetchAllFightResults
  };
})(typeof window !== 'undefined' ? window : this);
