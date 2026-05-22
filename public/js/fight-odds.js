// ========================================================================
// FIGHT ODDS LOOKUP
// Given a list of fighter IDs, returns a map of fighter_id → odds info
// for their next upcoming fight. Currently sourced from Polymarket via the
// fight_odds table (populated by fetchPolymarketOdds.js).
//
// Each entry: { fighterProb, opponentProb, source, marketUrl, fetchedAt }
//   - fighterProb: implied win probability for THIS fighter (0..1)
//   - opponentProb: implied win prob for their opponent (sums to ~1)
//   - source: 'polymarket' (room for other sources later)
//   - marketUrl: direct link to the market page on polymarket.com
//
// Used by the lineup, waivers, fighter modal, and fight card so every
// surface that lists a fighter can show their current betting odds.
// ========================================================================

(function (root) {
  /**
   * Fetch fight odds for a batch of fighters. Only returns entries for
   * fighters whose NEXT upcoming fight has odds in the fight_odds table.
   * @param {string[]} fighterIds — UUIDs from the fighters table
   */
  async function loadFightOdds(fighterIds) {
    if (!fighterIds || fighterIds.length === 0) return {};
    if (typeof supabaseClient === 'undefined') return {};

    const todayISO = new Date().toISOString().split('T')[0];

    // Pull every odds row whose fight is at a future event. With ~25 active
    // UFC markets globally and one row per fight, this is small enough to
    // fetch in one go — same approach as next-fight.js.
    const { data: oddsRows, error } = await supabaseClient
      .from('fight_odds')
      .select(`
        fight_id, source, fighter_a_prob, fighter_b_prob,
        fighter_a_token_id, fighter_b_token_id,
        market_url, fetched_at,
        fight:fight_results!inner(
          id, fighter_a_id, fighter_b_id,
          event:ufc_events!inner(event_date)
        )
      `)
      .gte('fight.event.event_date', todayISO);

    if (error) {
      console.warn('FightOdds.loadFightOdds query failed:', error.message);
      return {};
    }

    const wanted = new Set(fighterIds);
    const result = {};
    for (const row of oddsRows || []) {
      const fight = row.fight;
      if (!fight) continue;
      // Map both fighters to their perspective on this fight's odds.
      if (wanted.has(fight.fighter_a_id)) {
        result[fight.fighter_a_id] = {
          fighterProb:    Number(row.fighter_a_prob),
          opponentProb:   Number(row.fighter_b_prob),
          fighterTokenId: row.fighter_a_token_id || null,
          source:         row.source,
          marketUrl:      row.market_url,
          fetchedAt:      row.fetched_at,
        };
      }
      if (wanted.has(fight.fighter_b_id)) {
        result[fight.fighter_b_id] = {
          fighterProb:    Number(row.fighter_b_prob),
          opponentProb:   Number(row.fighter_a_prob),
          fighterTokenId: row.fighter_b_token_id || null,
          source:         row.source,
          marketUrl:      row.market_url,
          fetchedAt:      row.fetched_at,
        };
      }
    }
    return result;
  }

  // Compact percentage display ("64%") for tight rows.
  function formatProbShort(prob) {
    if (prob == null || isNaN(prob)) return '';
    return Math.round(prob * 100) + '%';
  }

  // Color treatment: favorites get the Polymarket blue, underdogs get
  // a muted treatment. The threshold matches typical bookmaker "favorite"
  // convention (any side over 50%).
  function probClass(prob) {
    if (prob == null) return '';
    return prob >= 0.5 ? 'fight-odds--favorite' : 'fight-odds--underdog';
  }

  // Renders a single inline odds chip ("65% via Polymarket") for use in
  // detail surfaces like the fighter modal or fight card. Returns '' when
  // there's no odds data.
  function chipHtml(odds, opts) {
    if (!odds || odds.fighterProb == null) return '';
    opts = opts || {};
    const pct = formatProbShort(odds.fighterProb);
    const klass = probClass(odds.fighterProb);
    const branding = opts.showBrand !== false
      ? '<span class="fight-odds__brand">Polymarket</span>'
      : '';
    // Embed the CLOB token so the global popover handler can attach a
    // hover chart — same treatment as inlineHtml. Without a token the
    // chip is still informative; the popover just won't open.
    const tokenAttr = odds.fighterTokenId
      ? ' data-fight-odds-token="' + odds.fighterTokenId + '"'
      : '';
    return (
      '<a class="fight-odds ' + klass + '" ' +
        (odds.marketUrl ? 'href="' + odds.marketUrl + '" target="_blank" rel="noopener" title="View market on Polymarket"' : '') +
        tokenAttr +
        '>' +
        '<span class="fight-odds__pct">' + pct + '</span>' +
        branding +
      '</a>'
    );
  }

  // Inline rendering for tight rows. Always Polymarket-blue (favorite or
  // underdog) so the chip reads as a single branded signal rather than two
  // different states. Format: "65% to win on Polymarket".
  function inlineHtml(odds) {
    if (!odds || odds.fighterProb == null) return '';
    const pct = formatProbShort(odds.fighterProb);
    // Underdog gets the orange treatment so the user can see at a glance
    // that this fighter is below 50%. Favorite stays Polymarket blue.
    const klass = probClass(odds.fighterProb);
    // When we know the CLOB token, embed it on the chip so the global hover
    // handler (installPopoverOnce) can lazily fetch + show the price-history
    // chart in a tooltip. Without a token, the chip is still informative —
    // just no hover chart.
    const tokenAttr = odds.fighterTokenId
      ? ' data-fight-odds-token="' + odds.fighterTokenId + '" tabindex="0"'
      : '';
    return (
      '<span class="fight-odds fight-odds--inline ' + klass + '" title="Polymarket implied probability"' + tokenAttr + '>' +
        '<span class="fight-odds__dot"></span>' +
        '<span class="fight-odds__pct">' + pct + '</span>' +
        '<span class="fight-odds__inline-suffix">to win on Polymarket</span>' +
      '</span>'
    );
  }

  // Fetch the percentage-over-time series for a single CLOB token from
  // Polymarket. Returns an array of { t, p } points (t = unix seconds,
  // p = implied probability 0..1) or null on any failure. The CLOB API is
  // public + CORS-enabled so this is callable directly from the browser.
  //
  // interval: '1h' | '6h' | '1d' | '1w' | '1m' | 'max'
  // fidelity: minutes between samples (60 = hourly)
  async function loadPriceHistory(tokenId, interval, fidelity) {
    if (!tokenId) return null;
    interval = interval || '1w';
    fidelity = fidelity || 60;
    var url = 'https://clob.polymarket.com/prices-history' +
              '?market='   + encodeURIComponent(tokenId) +
              '&interval=' + encodeURIComponent(interval) +
              '&fidelity=' + encodeURIComponent(fidelity);
    try {
      var res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      var json = await res.json();
      var hist = (json && json.history) || [];
      // Defensive: ensure numeric and sorted ascending by time.
      hist = hist
        .map(function (pt) { return { t: Number(pt.t), p: Number(pt.p) }; })
        .filter(function (pt) { return !isNaN(pt.t) && !isNaN(pt.p); })
        .sort(function (a, b) { return a.t - b.t; });
      return hist.length > 0 ? hist : null;
    } catch (_e) {
      return null;
    }
  }

  // Renders a compact SVG line chart of the probability-over-time history.
  // Hand-rolled so we don't pull in a charting library. Styled in
  // Polymarket blue; viewBox is normalized so CSS can scale it freely.
  //
  // opts: { width, height, showAxis }
  function chartSvg(history, opts) {
    if (!history || history.length < 2) return '';
    opts = opts || {};
    var W = opts.width  || 320;
    var H = opts.height || 80;
    var PAD_X = 4;
    var PAD_Y = 6;

    var tMin = history[0].t;
    var tMax = history[history.length - 1].t;
    var tSpan = Math.max(1, tMax - tMin);

    // Y axis is always 0..1 (probability) so the visual reads as
    // "how confident the market is" rather than a zoomed-in slice.
    function x(pt) { return PAD_X + ((pt.t - tMin) / tSpan) * (W - PAD_X * 2); }
    function y(pt) { return PAD_Y + (1 - pt.p)            * (H - PAD_Y * 2); }

    var dLine = history.map(function (pt, i) {
      return (i === 0 ? 'M' : 'L') + x(pt).toFixed(1) + ' ' + y(pt).toFixed(1);
    }).join(' ');

    // Closed area below the line — gives the chart its filled-shape feel.
    var first = history[0];
    var last  = history[history.length - 1];
    var dArea = dLine +
                ' L' + x(last).toFixed(1)  + ' ' + (H - PAD_Y).toFixed(1) +
                ' L' + x(first).toFixed(1) + ' ' + (H - PAD_Y).toFixed(1) + ' Z';

    // 50% reference line — anchors the eye and signals favorite vs underdog.
    var midY = (PAD_Y + (H - PAD_Y * 2) / 2).toFixed(1);

    // Last-point dot, so the current odds are visually emphasized.
    var lastX = x(last).toFixed(1);
    var lastY = y(last).toFixed(1);

    var firstPct = Math.round(first.p * 100);
    var lastPct  = Math.round(last.p  * 100);
    var delta    = lastPct - firstPct;
    var deltaStr = (delta > 0 ? '+' : '') + delta + '%';

    return (
      '<div class="fight-odds-chart">' +
        '<div class="fight-odds-chart__header">' +
          '<span class="fight-odds-chart__title">Polymarket — last 7 days</span>' +
          '<span class="fight-odds-chart__delta ' +
            (delta > 0 ? 'fight-odds-chart__delta--up' : (delta < 0 ? 'fight-odds-chart__delta--down' : '')) +
          '">' + deltaStr + '</span>' +
        '</div>' +
        '<svg class="fight-odds-chart__svg" viewBox="0 0 ' + W + ' ' + H + '" ' +
             'preserveAspectRatio="none" aria-hidden="true">' +
          '<line class="fight-odds-chart__mid" x1="' + PAD_X + '" y1="' + midY +
            '" x2="' + (W - PAD_X) + '" y2="' + midY + '"></line>' +
          '<path class="fight-odds-chart__area" d="' + dArea + '"></path>' +
          '<path class="fight-odds-chart__line" d="' + dLine + '"></path>' +
          '<circle class="fight-odds-chart__dot" cx="' + lastX + '" cy="' + lastY + '" r="3"></circle>' +
        '</svg>' +
        '<div class="fight-odds-chart__footer">' +
          '<span>' + firstPct + '%</span>' +
          '<span>' + lastPct  + '%</span>' +
        '</div>' +
      '</div>'
    );
  }

  // ----- Hover popover --------------------------------------------------
  // Any inline chip with a data-fight-odds-token attribute (rendered by
  // inlineHtml when we have a CLOB token) gets a hover popover that shows
  // the same SVG chart used in the fighter modal. Lazy — history is only
  // fetched on first hover and then cached by token.

  // Map<tokenId, Promise<history>> — dedupes refetches across hovers.
  const _historyCache = new Map();
  function _fetchHistoryCached(tokenId) {
    if (!_historyCache.has(tokenId)) {
      _historyCache.set(tokenId, loadPriceHistory(tokenId));
    }
    return _historyCache.get(tokenId);
  }

  let _popoverEl    = null;  // the floating element
  let _popoverChip  = null;  // the chip it's anchored to (so leave events know)

  function _ensurePopoverEl() {
    if (_popoverEl) return _popoverEl;
    _popoverEl = document.createElement('div');
    _popoverEl.className = 'fight-odds-popover';
    _popoverEl.setAttribute('role', 'tooltip');
    // Cancel hide when the cursor enters the popover itself, so the user
    // can move into it without it disappearing.
    _popoverEl.addEventListener('mouseenter', function () {
      if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
    });
    _popoverEl.addEventListener('mouseleave', _scheduleHide);
    document.body.appendChild(_popoverEl);
    return _popoverEl;
  }

  // Position the popover near the chip. Prefer above; flip below if there
  // isn't room. Uses fixed positioning so it escapes overflow:hidden parents.
  function _positionPopover(chip, pop) {
    const rect = chip.getBoundingClientRect();
    const popW = pop.offsetWidth;
    const popH = pop.offsetHeight;
    const vw   = window.innerWidth;
    const vh   = window.innerHeight;
    const gap  = 8;

    // Horizontal — center on chip, clamp to viewport with an 8px margin.
    let left = rect.left + rect.width / 2 - popW / 2;
    left = Math.max(8, Math.min(left, vw - popW - 8));

    // Vertical — above by default, flip below if it would overflow the top.
    let top = rect.top - popH - gap;
    let arrow = 'bottom';
    if (top < 8) {
      top   = rect.bottom + gap;
      arrow = 'top';
    }
    if (top + popH > vh - 8) {
      // Either direction overflows — pin to bottom of viewport.
      top = Math.max(8, vh - popH - 8);
    }

    pop.style.left = left.toFixed(0) + 'px';
    pop.style.top  = top.toFixed(0)  + 'px';
    pop.setAttribute('data-arrow', arrow);
  }

  let _showTimer = null;
  let _hideTimer = null;
  const SHOW_DELAY = 120; // ms — avoid flicker on accidental passes
  const HIDE_DELAY = 150;

  function _scheduleShow(chip) {
    if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
    if (_showTimer) clearTimeout(_showTimer);
    _showTimer = setTimeout(function () { _showPopover(chip); }, SHOW_DELAY);
  }

  function _scheduleHide() {
    if (_showTimer) { clearTimeout(_showTimer); _showTimer = null; }
    if (_hideTimer) clearTimeout(_hideTimer);
    _hideTimer = setTimeout(_hidePopover, HIDE_DELAY);
  }

  function _showPopover(chip) {
    const token = chip.getAttribute('data-fight-odds-token');
    if (!token) return;
    const pop = _ensurePopoverEl();
    _popoverChip = chip;
    pop.classList.add('fight-odds-popover--loading');
    pop.classList.add('fight-odds-popover--visible');
    pop.innerHTML = '<div class="fight-odds-popover__loading">Loading odds history…</div>';
    _positionPopover(chip, pop);

    _fetchHistoryCached(token).then(function (hist) {
      // Guard: cursor may have moved off before the fetch resolved.
      if (_popoverChip !== chip) return;
      pop.classList.remove('fight-odds-popover--loading');
      if (!hist || hist.length < 2) {
        pop.innerHTML = '<div class="fight-odds-popover__empty">No price history yet</div>';
      } else {
        pop.innerHTML = chartSvg(hist);
      }
      _positionPopover(chip, pop);
    });
  }

  function _hidePopover() {
    if (!_popoverEl) return;
    _popoverEl.classList.remove('fight-odds-popover--visible');
    _popoverChip = null;
  }

  function installPopoverOnce() {
    if (root.__fightOddsPopoverInstalled) return;
    root.__fightOddsPopoverInstalled = true;

    document.addEventListener('mouseenter', function (e) {
      const target = e.target;
      if (!target || target.nodeType !== 1) return;
      // mouseenter doesn't bubble — use the capture phase + closest check.
      const chip = target.closest && target.closest('.fight-odds[data-fight-odds-token]');
      if (!chip) return;
      _scheduleShow(chip);
    }, true);

    document.addEventListener('mouseleave', function (e) {
      const target = e.target;
      if (!target || target.nodeType !== 1) return;
      const chip = target.closest && target.closest('.fight-odds[data-fight-odds-token]');
      if (!chip) return;
      _scheduleHide();
    }, true);

    // Keyboard support — focus shows, blur hides. Lets keyboard users see
    // the chart without a mouse.
    document.addEventListener('focusin', function (e) {
      const chip = e.target && e.target.closest && e.target.closest('.fight-odds[data-fight-odds-token]');
      if (chip) _showPopover(chip);
    });
    document.addEventListener('focusout', function (e) {
      const chip = e.target && e.target.closest && e.target.closest('.fight-odds[data-fight-odds-token]');
      if (chip) _scheduleHide();
    });

    // Reposition / hide on scroll so the tooltip doesn't float orphaned
    // when the user scrolls the page (rosters can be inside tables).
    window.addEventListener('scroll', _hidePopover, true);
    window.addEventListener('resize', _hidePopover);
  }

  // Install as soon as the DOM is ready — safe to call before any chips
  // exist since the handler is delegated.
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', installPopoverOnce);
    } else {
      installPopoverOnce();
    }
  }

  root.FightOdds = {
    loadFightOdds:    loadFightOdds,
    loadPriceHistory: loadPriceHistory,
    formatProbShort:  formatProbShort,
    chipHtml:         chipHtml,
    inlineHtml:       inlineHtml,
    chartSvg:         chartSvg,
  };
})(typeof window !== 'undefined' ? window : this);
