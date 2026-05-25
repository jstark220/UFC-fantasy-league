// ========================================================================
// FIGHT CARD MODAL — shared module
//
// Opens a centered modal listing every fight on a UFC event's card. Used
// from the league page's "View fight card" button, and (eventually) from
// other surfaces where we want a quick card preview without taking the
// user into the lineup page.
//
// Public API:
//   FightCardModal.show(eventId, opts)
//     eventId    — uuid of the ufc_events row
//     opts.rosterIds   — optional Set/Object of fighter ids on the
//                        viewer's roster (drives YOURS pill)
//     opts.starterIds  — optional Set/Object of fighter ids in starter
//                        slots for the event (drives STARTER pill)
//
// Reuses the .fight-card-modal-overlay + .fight-row CSS already defined
// in components.css. Optional deps: FightOdds, Projections, countryFlag,
// showFighterModal — feature-gates each chunk on `typeof X !== 'undefined'`.
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

  // Map ufc_events.weight_class → display label, with sensible fallback
  // for unrecognized values.
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
        'fight_order, title_type, outcome, winner_id, fight_of_the_night'
      )
      .eq('event_id', eventId);
    return res.data || [];
  }

  async function fetchFighters(ids) {
    if (!ids.length) return {};
    var res = await supabaseClient
      .from('fighters')
      .select('id, name, photo_url, current_rank, is_champion, is_sub_champion, sub_title_type, country')
      .in('id', ids);
    var map = {};
    (res.data || []).forEach(function (f) { map[f.id] = f; });
    return map;
  }

  // ---- Render helpers ----------------------------------------------------

  // Compact rank that lives inline with the fighter's name. Same logic
  // as the old sub-line rank but trimmed to fit alongside the name —
  // "Champion" → "CHAMP", "Interim Champion" → "INT" — so long names
  // don't get pushed off the row.
  function inlineRank(f) {
    if (!f) return '';
    if (f.isChampion)                                  return '<span class="fight-row__rank-inline fight-row__rank-inline--champ">CHAMP</span>';
    if (f.isSubChamp && f.subTitleType === 'interim')  return '<span class="fight-row__rank-inline fight-row__rank-inline--interim">INT</span>';
    if (f.isSubChamp && f.subTitleType === 'bmf')      return '<span class="fight-row__rank-inline fight-row__rank-inline--bmf">BMF</span>';
    if (f.currentRank)                                 return '<span class="fight-row__rank-inline">#' + f.currentRank + '</span>';
    return '<span class="fight-row__rank-inline fight-row__rank-inline--unranked">NR</span>';
  }

  function ownershipPill(fid, rosterIds, starterIds) {
    if (starterIds && starterIds[fid]) return '<span class="fight-row__pill fight-row__pill--starter">STARTER</span>';
    if (rosterIds  && rosterIds[fid])  return '<span class="fight-row__pill fight-row__pill--yours">YOURS</span>';
    return '';
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
    // showBrand:true tacks "POLYMARKET" onto the chip — makes the source
    // of the percentage obvious instead of leaving a naked "80%" floating
    // among the other stats.
    var odds = (typeof FightOdds !== 'undefined' && opts.oddsMap[fighter.id])
      ? FightOdds.chipHtml(opts.oddsMap[fighter.id], { showBrand: true })
      : '';
    var proj = (typeof Projections !== 'undefined' && opts.projMap[fighter.id])
      ? Projections.pillHtml(opts.projMap[fighter.id], {
          fighterId:    fighter.id,
          fighterName:  fighter.name,
          opponentName: opponentName || '',
          eventName:    eventName || ''
        })
      : '';
    var ownership = ownershipPill(fighter.id, opts.rosterIds, opts.starterIds);

    // New uniform layout:
    //   Line 1: name + rank + (optional) ownership pill, inline
    //   Lines 2+: chip column — odds chip on top, projection pill beneath
    //
    // Both chips always stack vertically in the same order, so every row
    // reads with the same rhythm regardless of which chips are present.
    return (
      '<button class="fight-row__side ' + sideMod + '" data-open-fighter="' + fighter.id + '" type="button">' +
        photoHtml +
        '<div class="fight-row__text">' +
          '<span class="fight-row__name">' +
            winnerMark + flagHtml + escapeHtml(fighter.name) +
            ' ' + inlineRank(fighter) +
            (ownership ? ' ' + ownership : '') +
          '</span>' +
          '<div class="fight-row__chips">' +
            (odds ? '<span class="fight-row__chip-row">' + odds + '</span>' : '') +
            (proj ? '<span class="fight-row__chip-row">' + proj + '</span>' : '') +
          '</div>' +
        '</div>' +
      '</button>'
    );
  }

  function fightRowHtml(fight, eventName, opts) {
    var badgeHtml = fight.badge
      ? '<span class="fight-row__badge">' + escapeHtml(fight.badge) + '</span>'
      : '';
    var redIsWinner  = fight.outcome && fight.winnerId === fight.redId;
    var blueIsWinner = fight.outcome && fight.winnerId === fight.blueId;
    var redOpp  = fight.blue && fight.blue.name ? fight.blue.name : '';
    var blueOpp = fight.red  && fight.red.name  ? fight.red.name  : '';
    return (
      '<div class="fight-row">' +
        fighterSide(fight.red,  'fight-row__side--red',  redIsWinner,  redOpp,  eventName, opts) +
        '<div class="fight-row__center">' +
          badgeHtml +
          '<span class="fight-row__weight">' + escapeHtml(fight.weightClass) + '</span>' +
          '<span class="fight-row__vs">vs</span>' +
        '</div>' +
        fighterSide(fight.blue, 'fight-row__side--blue', blueIsWinner, blueOpp, eventName, opts) +
      '</div>'
    );
  }

  // Build the structured card array — same shape lineup.js uses.
  function shapeFights(rawFights, fighterMap) {
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
        country:      f.country || null
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
    var event   = await eventP;
    var rawFights = await fightsP;

    if (!event) { close(); return; }

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
    var results = await Promise.all(promises);
    var fighterMap = results[0], oddsMap = results[1], projMap = results[2];

    var fights = shapeFights(rawFights, fighterMap);

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
            mainCard.map(function (f) { return fightRowHtml(f, event.name, rowOpts); }).join('') +
          '</div>';
      }
      if (prelims.length > 0) {
        sectionsHtml +=
          '<div class="fight-card-section">' +
            '<p class="fight-card-section__label">Prelims</p>' +
            prelims.map(function (f) { return fightRowHtml(f, event.name, rowOpts); }).join('') +
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
