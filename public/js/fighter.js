// ========================================================================
// FIGHTER PROFILE PAGE
// Shows a single fighter's card, career stats, fight history with fantasy
// scores, and their next booked fight.
//
// URL params:
//   ?id=FIGHTER_UUID         — required, the fighter to display
//   ?league=LEAGUE_UUID      — optional, used for the back-navigation link
// ========================================================================

// Card position multipliers (must match score-event.js)
const CARD_MULTIPLIERS = {
  main_event:   1.2,
  co_main:      1.1,
  prelim:       1.0,
  early_prelim: 1.0
};

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

// Human-readable labels for fight outcome codes
const OUTCOME_LABELS = {
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
// INIT
// ========================================================================
async function initFighter() {
  const user = await requireAuth();
  if (!user) return;

  const params   = new URLSearchParams(window.location.search);
  const fighterId = params.get('id');
  const leagueId  = params.get('league');

  if (!fighterId) { window.location.href = 'dashboard.html'; return; }

  // Set back link: go to the league lineup page if we came from a league,
  // otherwise fall back to the previous browser history entry
  const backLink = document.getElementById('backLink');
  if (leagueId) {
    backLink.href = 'lineup.html?id=' + leagueId;
    backLink.textContent = '← Back to Lineup';
  } else {
    backLink.href = 'javascript:history.back()';
  }

  // Fetch fighter details and their fight results in parallel
  const [fighterRes, fightsRes] = await Promise.all([
    supabaseClient
      .from('fighters')
      .select('id, name, nickname, primary_division, current_rank, is_champion, record_wins, record_losses, record_draws, photo_url, country')
      .eq('id', fighterId)
      .single(),

    supabaseClient
      .from('fight_results')
      .select('*, event:ufc_events(id, name, event_date)')
      .or('fighter_a_id.eq.' + fighterId + ',fighter_b_id.eq.' + fighterId)
      .order('created_at', { ascending: false })
  ]);

  if (fighterRes.error || !fighterRes.data) {
    document.getElementById('pageContent').innerHTML = '<p style="padding:2rem">Fighter not found.</p>';
    document.getElementById('pageContent').style.display = 'block';
    return;
  }

  const fighter = fighterRes.data;
  const fights  = fightsRes.data || [];

  document.title = fighter.name + ' - Knockdown Fantasy';

  // Fetch opponent names for all fights (the fighter who is NOT the current one)
  let opponentMap = {};
  if (fights.length > 0) {
    const opponentIds = fights.map(function(f) {
      return f.fighter_a_id === fighterId ? f.fighter_b_id : f.fighter_a_id;
    });
    // Deduplicate
    const uniqueIds = opponentIds.filter(function(id, i, arr) {
      return arr.indexOf(id) === i;
    });

    const { data: opponentData } = await supabaseClient
      .from('fighters')
      .select('id, name')
      .in('id', uniqueIds);

    (opponentData || []).forEach(function(o) { opponentMap[o.id] = o.name; });
  }

  document.getElementById('pageContent').style.display = 'block';

  renderFighterHero(fighter, fights, fighterId);
  renderFightHistory(fights, fighterId, opponentMap);
  renderNextFight();
}

// ========================================================================
// FIGHTER HERO
// Full-width banner with the fighter card on the left and bio/stats on the
// right. Reuses the existing .fighter-card and .league-header styling.
// ========================================================================
function renderFighterHero(fighter, fights, fighterId) {
  const el       = document.getElementById('fighterHero');
  const divLabel = DIVISION_LABELS[fighter.primary_division] || fighter.primary_division;
  const record   = fighter.record_wins + '-' + fighter.record_losses +
                   (fighter.record_draws ? '-' + fighter.record_draws : '');

  const rankLabel = fighter.is_champion ? 'C'
    : (fighter.current_rank ? '#' + fighter.current_rank : 'NR');
  const rankSub   = fighter.is_champion ? 'CHAMP' : 'RANK';

  const tierClass = fighter.is_champion ? 'fighter-card--champion'
    : (fighter.current_rank && fighter.current_rank <= 5  ? 'fighter-card--top5'
    : (fighter.current_rank && fighter.current_rank <= 15 ? 'fighter-card--top15' : ''));

  const photoHtml = fighter.photo_url
    ? '<img class="fighter-card__photo" src="' + fighter.photo_url + '" alt="' + escapeHtml(fighter.name) + '" onerror="this.style.display=\'none\'">'
    : '<div class="fighter-card__photo-placeholder"></div>';

  const champBadge = fighter.is_champion
    ? '<span class="fighter-card__badge-champ">Champ</span>' : '';

  // Compute career fantasy totals from fight history
  const careerPts = fights.reduce(function(sum, f) {
    var isA = f.fighter_a_id === fighterId;
    return sum + computeFighterScore(f, isA).total;
  }, 0);

  // Finish count (wins by KO/TKO or submission)
  const finishes = fights.filter(function(f) {
    return f.winner_id === fighterId &&
           (f.outcome === 'ko_tko' || f.outcome === 'submission');
  }).length;

  el.innerHTML =
    '<div class="fighter-hero">' +
      '<div class="fighter-hero__inner">' +

        // Left: fighter card
        '<div class="fighter-hero__card">' +
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
            '</div>' +
          '</div>' +
        '</div>' +

        // Right: bio + career stats
        '<div class="fighter-hero__bio">' +
          (fighter.nickname ? '<p class="fighter-hero__nickname">"' + escapeHtml(fighter.nickname) + '"</p>' : '') +
          '<h1 class="fighter-hero__name">' + escapeHtml(fighter.name) + '</h1>' +
          '<p class="fighter-hero__division">' + escapeHtml(divLabel) + '</p>' +
          (fighter.country ? '<p class="fighter-hero__country">' + escapeHtml(fighter.country) + '</p>' : '') +
          '<div class="fighter-hero__stats">' +
            '<div class="fighter-hero__stat">' +
              '<span class="fighter-hero__stat-val">' + record + '</span>' +
              '<span class="fighter-hero__stat-label">Record</span>' +
            '</div>' +
            '<div class="fighter-hero__stat">' +
              '<span class="fighter-hero__stat-val">' + finishes + '</span>' +
              '<span class="fighter-hero__stat-label">Finishes</span>' +
            '</div>' +
            '<div class="fighter-hero__stat">' +
              '<span class="fighter-hero__stat-val">' + fights.length + '</span>' +
              '<span class="fighter-hero__stat-label">UFC Fights</span>' +
            '</div>' +
            '<div class="fighter-hero__stat">' +
              '<span class="fighter-hero__stat-val">' + careerPts.toFixed(1) + '</span>' +
              '<span class="fighter-hero__stat-label">Career Pts</span>' +
            '</div>' +
          '</div>' +
        '</div>' +

      '</div>' +
    '</div>';
}

// ========================================================================
// FIGHT HISTORY
// Table of every recorded fight result with computed fantasy scores.
// ========================================================================
function renderFightHistory(fights, fighterId, opponentMap) {
  const el = document.getElementById('fightHistory');

  document.getElementById('fightCount').textContent =
    '(' + fights.length + ')';

  if (fights.length === 0) {
    el.innerHTML = '<p class="draft-empty">No fight results recorded yet.</p>';
    return;
  }

  const rows = fights.map(function(fight) {
    const isA        = fight.fighter_a_id === fighterId;
    const score      = computeFighterScore(fight, isA);
    const opponentId = isA ? fight.fighter_b_id : fight.fighter_a_id;
    const opponent   = opponentMap[opponentId] || 'Unknown';

    // Determine result label and CSS class
    var resultLabel, resultClass;
    if (fight.outcome === 'no_contest') {
      resultLabel = 'NC'; resultClass = 'fight-result--nc';
    } else if (fight.winner_id === fighterId) {
      resultLabel = 'W';  resultClass = 'fight-result--win';
    } else if (fight.outcome === 'draw') {
      resultLabel = 'D';  resultClass = 'fight-result--draw';
    } else {
      resultLabel = 'L';  resultClass = 'fight-result--loss';
    }

    const method    = OUTCOME_LABELS[fight.outcome] || fight.outcome || '-';
    const round     = fight.end_round ? 'R' + fight.end_round : '-';
    const eventName = fight.event ? escapeHtml(fight.event.name) : '-';
    const eventDate = fight.event && fight.event.event_date
      ? formatDate(fight.event.event_date) : '';

    // Highlight exceptional scores (25+ pts)
    const ptsClass = score.total >= 25 ? ' fight-history-pts--high'
                   : score.total >= 10 ? ' fight-history-pts--mid' : '';

    return (
      '<tr class="fight-history-row">' +
        '<td class="fight-history-event">' +
          '<span class="fight-history-event__name">' + eventName + '</span>' +
          (eventDate ? '<span class="fight-history-event__date">' + eventDate + '</span>' : '') +
        '</td>' +
        '<td class="fight-history-opponent">' + escapeHtml(opponent) + '</td>' +
        '<td><span class="fight-result ' + resultClass + '">' + resultLabel + '</span></td>' +
        '<td class="fight-history-method">' + escapeHtml(method) + '</td>' +
        '<td class="fight-history-round">' + round + '</td>' +
        '<td class="fight-history-pts' + ptsClass + '">' + score.total.toFixed(1) + '</td>' +
      '</tr>'
    );
  }).join('');

  el.innerHTML =
    '<table class="fight-history-table">' +
      '<thead>' +
        '<tr>' +
          '<th>Event</th>' +
          '<th>Opponent</th>' +
          '<th>Result</th>' +
          '<th>Method</th>' +
          '<th>Round</th>' +
          '<th>Pts</th>' +
        '</tr>' +
      '</thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table>';
}

// ========================================================================
// NEXT FIGHT
// Placeholder until fight card data is seeded into ufc_events.
// ========================================================================
function renderNextFight() {
  document.getElementById('nextFight').innerHTML =
    '<p class="draft-empty">No upcoming fight booked yet.</p>';
}

// ========================================================================
// COMPUTE FIGHTER SCORE (v1.2)
// Copied from score-event.js — must be kept in sync with that file.
// Takes a fight_results row and isA (true = this fighter was fighter_a).
// ========================================================================
function computeFighterScore(fight, isA) {
  const prefix   = isA ? 'fighter_a_' : 'fighter_b_';
  const fighterId = isA ? fight.fighter_a_id : fight.fighter_b_id;

  const sigStrikes   = fight[prefix + 'sig_strikes']     || 0;
  const takedowns    = fight[prefix + 'takedowns']       || 0;
  const reversals    = fight[prefix + 'reversals']       || 0;
  const knockdowns   = fight[prefix + 'knockdowns']      || 0;
  const controlSec   = fight[prefix + 'control_seconds'] || 0;
  const potn         = !!fight[prefix + 'potn'];
  const opponentRank = fight[prefix + 'opponent_rank'];

  const isWinner = fight.winner_id === fighterId;
  const isDraw   = fight.outcome === 'draw';

  // Base stats
  const base = (sigStrikes * 0.1) + (takedowns * 1) + (reversals * 1) +
               (knockdowns * 2) + (controlSec * 0.01);

  // Win bonus
  let winBonus = 0;
  if (isWinner) {
    const isFinish = fight.outcome === 'ko_tko' || fight.outcome === 'submission';
    if (isFinish) {
      if      (fight.end_round === 1) winBonus = 18;
      else if (fight.end_round === 2) winBonus = 14;
      else if (fight.end_round === 3) winBonus = 9;
      else                            winBonus = 8;
      if (fight.end_round === 1 && fight.end_time_seconds != null && fight.end_time_seconds < 60) {
        winBonus += 5;
      }
    } else if (fight.outcome === 'decision_u' || fight.outcome === 'decision_s' ||
               fight.outcome === 'decision_m' || fight.outcome === 'dq') {
      winBonus = 6;
    }
  } else if (isDraw) {
    winBonus = 3;
  }

  // Title bonus
  let titleBonus = 0;
  if (isWinner && fight.title_type !== 'none') {
    if (fight.title_type === 'divisional') {
      titleBonus = fight.is_title_defense ? 5 : 10;
    } else if (fight.title_type === 'interim' || fight.title_type === 'bmf') {
      titleBonus = fight.is_title_defense ? 3 : 5;
    }
  }

  // Ranked opponent bonus
  let rankedOppBonus = 0;
  if (isWinner && opponentRank != null) {
    if      (opponentRank <= 5)  rankedOppBonus = 4;
    else if (opponentRank <= 10) rankedOppBonus = 2;
    else if (opponentRank <= 15) rankedOppBonus = 1;
  }

  const potnBonus = potn ? 6 : 0;
  const fotnBonus = fight.fight_of_the_night ? 4 : 0;
  const multiplier = CARD_MULTIPLIERS[fight.card_position] || 1.0;
  const subtotal   = base + winBonus + titleBonus + rankedOppBonus + potnBonus + fotnBonus;

  return { total: Math.round(subtotal * multiplier * 100) / 100 };
}

// ========================================================================
// HELPERS
// ========================================================================

function formatDate(dateStr) {
  if (!dateStr) return '';
  var d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  var div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

initFighter();
