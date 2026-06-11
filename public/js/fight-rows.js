// ========================================================================
// FIGHT ROWS — shared bout-row renderer
//
// Extracted from fight-card-modal.js so the fight card modal and the
// Fight Night Hub (fight-night.js) render bouts identically: same layout,
// same chips (odds / projection / earned score), same YOURS/STARTER
// highlights, same CSS classes (.fight-row* in components.css).
//
// Public API (window.FightRows):
//   FightRows.shape(rawFights, fighterMap)
//     rawFights  — fight_results rows (the modal/hub SELECT shape)
//     fighterMap — { fighter_id: fighters row }
//     returns sorted display fights (fight_order asc, card_position
//     fallback) with red/blue info objects + badge labels.
//   FightRows.rowHtml(fight, eventName, opts)
//     fight — one shaped fight from shape()
//     opts.oddsMap / projMap / scoreMap — per-fighter chip data
//     opts.rosterIds / starterIds      — viewer highlight maps
//   FightRows.divisionLabel(raw) — weight_class -> display label
//
// Optional deps feature-gated exactly like the modal did: FightOdds,
// Projections, countryFlag. Loads before fight-card-modal.js on every
// page that shows fight rows.
// ========================================================================

(function (root) {
  // Division-id → display label. Same set used across the app.
  var DIVISION_LABELS = {
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

  function divisionLabel(raw) {
    if (!raw) return '';
    return DIVISION_LABELS[raw] || raw.replace(/_/g, ' ');
  }

  function escapeHtml(str) {
    if (str == null) return '';
    var d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

  // Card-position ordering for fallback sort when fight_order is null.
  var CARD_POSITION_ORDER = { main_event: 0, co_main: 1, main_card: 2 };

  // Compact rank that lives inline with the fighter's name.
  function inlineRank(f) {
    if (!f) return '';
    if (f.isChampion)                                  return '<span class="fight-row__rank-inline fight-row__rank-inline--champ">CHAMP</span>';
    if (f.isSubChamp && f.subTitleType === 'interim')  return '<span class="fight-row__rank-inline fight-row__rank-inline--interim">INT</span>';
    if (f.isSubChamp && f.subTitleType === 'bmf')      return '<span class="fight-row__rank-inline fight-row__rank-inline--bmf">BMF</span>';
    if (f.currentRank)                                 return '<span class="fight-row__rank-inline">#' + f.currentRank + '</span>';
    return '<span class="fight-row__rank-inline fight-row__rank-inline--unranked">NR</span>';
  }

  // Ownership relative to the viewer: 'starter', 'yours', or ''.
  function ownershipKind(fid, rosterIds, starterIds) {
    if (starterIds && starterIds[fid]) return 'starter';
    if (rosterIds  && rosterIds[fid])  return 'yours';
    return '';
  }

  // Small W-L(-D) record beside the rank. Empty when the caller's select
  // didn't include record columns.
  function recordHtml(f) {
    if (!f || f.recordWins == null || f.recordLosses == null) return '';
    var s = f.recordWins + '-' + f.recordLosses + (f.recordDraws ? '-' + f.recordDraws : '');
    return '<span class="fight-row__record">' + s + '</span>';
  }

  // "Belal Muhammad" -> "B. Muhammad" for the mobile name.
  function abbrevName(name) {
    if (!name) return '';
    var parts = String(name).trim().split(/\s+/);
    if (parts.length < 2) return name;
    return parts[0].charAt(0).toUpperCase() + '. ' + parts.slice(1).join(' ');
  }

  // Earned-fantasy-points chip shown once a bout is decided.
  function scoreChipHtml(pts) {
    var val = (Math.round(pts * 100) / 100).toFixed(1);
    return '<span class="fight-projection fight-projection--final" title="Fantasy points earned">' +
             '<span class="fight-projection__label">PTS</span>' +
             '<span class="fight-projection__val">' + val + '</span>' +
           '</span>';
  }

  function fighterSide(fighter, sideMod, isWinner, opponentName, eventName, opts) {
    if (!fighter || !fighter.id) {
      return '<div class="fight-row__side ' + sideMod + '"><span class="fight-row__name">TBD</span></div>';
    }
    var photoHtml = fighter.photoUrl
      ? '<img class="fight-row__photo" src="' + escapeHtml(fighter.photoUrl) + '" alt="' + escapeHtml(fighter.name) + '" onerror="this.style.display=\'none\'">'
      : '<div class="fight-row__photo fight-row__photo--placeholder"></div>';
    var winnerMark = isWinner ? '<span class="fight-row__winner-mark" title="Winner">✓</span>' : '';
    var flag = (typeof countryFlag === 'function') ? countryFlag(fighter.country) : '';
    var flagHtml = flag ? '<span class="fight-row__flag">' + flag + '</span>' : '';
    var odds = (typeof FightOdds !== 'undefined' && opts.oddsMap && opts.oddsMap[fighter.id])
      ? FightOdds.chipHtml(opts.oddsMap[fighter.id], { showBrand: true })
      : '';
    var scorePts  = opts.scoreMap ? opts.scoreMap[fighter.id] : undefined;
    var hasScore  = scorePts != null;
    var scoreChip = hasScore ? scoreChipHtml(scorePts) : '';
    var proj = (!hasScore && typeof Projections !== 'undefined' && opts.projMap && opts.projMap[fighter.id])
      ? Projections.pillHtml(opts.projMap[fighter.id], {
          fighterId:    fighter.id,
          fighterName:  fighter.name,
          opponentName: opponentName || '',
          eventName:    eventName || ''
        })
      : '';
    var ownKind  = ownershipKind(fighter.id, opts.rosterIds, opts.starterIds);
    var ownClass = ownKind ? ' fight-row__side--' + ownKind : '';

    return (
      '<button class="fight-row__side ' + sideMod + ownClass + '" data-open-fighter="' + fighter.id + '" type="button">' +
        photoHtml +
        '<div class="fight-row__text">' +
          '<span class="fight-row__name">' +
            winnerMark + flagHtml +
            '<span class="fight-row__name-full">' + escapeHtml(fighter.name) + '</span>' +
            '<span class="fight-row__name-abbr">' + escapeHtml(abbrevName(fighter.name)) + '</span>' +
            ' ' + inlineRank(fighter) + recordHtml(fighter) +
          '</span>' +
          '<div class="fight-row__chips">' +
            (odds ? '<span class="fight-row__chip-row">' + odds + '</span>' : '') +
            (scoreChip ? '<span class="fight-row__chip-row">' + scoreChip + '</span>' : '') +
            (proj ? '<span class="fight-row__chip-row">' + proj + '</span>' : '') +
          '</div>' +
        '</div>' +
      '</button>'
    );
  }

  function rowHtml(fight, eventName, opts) {
    opts = opts || {};
    var badgeHtml = fight.badge
      ? '<span class="fight-row__badge">' + escapeHtml(fight.badge) + '</span>'
      : '';
    var pill = '';
    if (opts.nowFightId && opts.nowFightId === fight.id) {
      pill = '<span class="fight-row__livepill fight-row__livepill--now">NOW</span>';
    } else if (opts.nextFightId && opts.nextFightId === fight.id) {
      pill = '<span class="fight-row__livepill">NEXT</span>';
    }
    var redIsWinner  = fight.outcome && fight.winnerId === fight.redId;
    var blueIsWinner = fight.outcome && fight.winnerId === fight.blueId;
    var redOpp  = fight.blue && fight.blue.name ? fight.blue.name : '';
    var blueOpp = fight.red  && fight.red.name  ? fight.red.name  : '';
    return (
      '<div class="fight-row" data-fight-id="' + escapeHtml(fight.id) + '">' +
        '<div class="fight-row__header">' +
          pill + badgeHtml +
          '<span class="fight-row__weight">' + escapeHtml(fight.weightClass) + '</span>' +
        '</div>' +
        '<div class="fight-row__bout">' +
          fighterSide(fight.red,  'fight-row__side--red',  redIsWinner,  redOpp,  eventName, opts) +
          '<div class="fight-row__center"><span class="fight-row__vs">VS</span></div>' +
          fighterSide(fight.blue, 'fight-row__side--blue', blueIsWinner, blueOpp, eventName, opts) +
        '</div>' +
      '</div>'
    );
  }

  // Build the structured card array — same shape lineup.js uses.
  function shape(rawFights, fighterMap) {
    function info(id) {
      var f = fighterMap[id];
      if (!f) return { name: '?' };
      return {
        id:           f.id,
        name:         f.name,
        photoUrl:     f.photo_url || null,
        currentRank:  f.current_rank,
        isChampion:   !!f.is_champion,
        isSubChamp:   !!f.is_sub_champion,
        subTitleType: f.sub_title_type,
        country:      f.country || null,
        recordWins:   f.record_wins != null ? f.record_wins : null,
        recordLosses: f.record_losses != null ? f.record_losses : null,
        recordDraws:  f.record_draws != null ? f.record_draws : null
      };
    }
    return rawFights.map(function (f) {
      var red  = info(f.fighter_a_id);
      var blue = info(f.fighter_b_id);
      return {
        id:           f.id,
        red:          red,
        blue:         blue,
        redId:        f.fighter_a_id,
        blueId:       f.fighter_b_id,
        weightClass:  divisionLabel(f.weight_class),
        cardPosition: f.card_position,
        fightOrder:   f.fight_order,
        outcome:      f.outcome,
        winnerId:     f.winner_id,
        badge:        f.card_position === 'main_event' ? 'Main Event'
                    : f.card_position === 'co_main'    ? 'Co-Main'
                    : f.title_type && f.title_type !== 'none' ? 'Title Fight'
                    : null
      };
    }).sort(function (a, b) {
      if (a.fightOrder != null && b.fightOrder != null) return a.fightOrder - b.fightOrder;
      if (a.fightOrder != null) return -1;
      if (b.fightOrder != null) return 1;
      var oa = CARD_POSITION_ORDER[a.cardPosition] != null ? CARD_POSITION_ORDER[a.cardPosition] : 99;
      var ob = CARD_POSITION_ORDER[b.cardPosition] != null ? CARD_POSITION_ORDER[b.cardPosition] : 99;
      return oa - ob;
    });
  }

  root.FightRows = {
    shape: shape,
    rowHtml: rowHtml,
    divisionLabel: divisionLabel
  };
})(typeof window !== 'undefined' ? window : this);
