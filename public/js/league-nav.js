// ========================================================================
// LEAGUE NAV
// Shared renderer for the page-nav tabs that live in .league-header__actions
// on every league-context page (league hub, lineup, waivers, trades,
// standings, score-event). Used to be inline string concat in 5 different
// files; centralized so the icon-stack design only needs to be authored once.
//
// Usage:
//   LeagueNav.render({
//     leagueId:        'abc-123',         // required
//     active:          'standings',       // which tab is current (null = none)
//     showLineup:      true,              // hide before draft starts on league.html
//     showScoreEvent:  false,             // commissioner-only on league.html
//     lineupAsPrimary: false              // league.html highlights Lineup as a CTA
//   }) -> string of HTML
//
// Active state and the league-hub "primary CTA" state both render visually
// crimson, but only one of them is set at a time.
// ========================================================================

(function (root) {

  // ---- Icons (20px, 1.75 stroke, monochrome currentColor) ---------------
  // Inline SVG so we don't pay a network hop, and the icon color tracks
  // the link's `color:` for active/hover states.
  var ICONS = {
    leagueHome:
      '<svg class="nav-tab__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M3 11 12 4l9 7" />' +
        '<path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9" />' +
      '</svg>',
    standings:
      '<svg class="nav-tab__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M7 4h10v4a5 5 0 0 1-10 0V4z" />' +
        '<path d="M17 5h2a2 2 0 0 1 2 2v1a3 3 0 0 1-3 3" />' +
        '<path d="M7 5H5a2 2 0 0 0-2 2v1a3 3 0 0 0 3 3" />' +
        '<path d="M9 20h6" /><path d="M12 13v7" />' +
      '</svg>',
    freeAgency:
      '<svg class="nav-tab__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<circle cx="11" cy="11" r="6" />' +
        '<path d="m20 20-4.3-4.3" />' +
      '</svg>',
    trades:
      '<svg class="nav-tab__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M4 9h13" /><path d="m14 6 3 3-3 3" />' +
        '<path d="M20 15H7"  /><path d="m10 18-3-3 3-3" />' +
      '</svg>',
    lineup:
      '<svg class="nav-tab__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="5" y="4" width="14" height="17" rx="2" />' +
        '<path d="M9 4v2h6V4" />' +
        '<path d="M9 11h6" /><path d="M9 15h6" /><path d="M9 19h3" />' +
      '</svg>',
    scoreEvent:
      '<svg class="nav-tab__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M5 21V4" />' +
        '<path d="M5 5h11l-2 3 2 3H5" />' +
      '</svg>',
    draftRoom:
      // Play-in-circle — reads as "live event in progress." The play
      // triangle gets a filled override so it pops clearly inside the
      // outline circle, even at small sizes.
      '<svg class="nav-tab__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="9" />' +
        '<path d="m10 8 6 4-6 4z" fill="currentColor" stroke="none" />' +
      '</svg>'
  };

  // Build one tab. `state` is 'active' | 'primary' | 'idle'.
  // `badge` is optional: a positive integer (renders count) or `true` (dot).
  function tab(href, key, label, state, badge) {
    var stateClass = state === 'active'  ? ' nav-tab--active'
                   : state === 'primary' ? ' nav-tab--primary'
                   : '';
    var badgeHtml = '';
    if (badge === true) {
      badgeHtml = '<span class="nav-tab__badge nav-tab__badge--dot" aria-hidden="true"></span>';
    } else if (typeof badge === 'number' && badge > 0) {
      var shown = badge > 9 ? '9+' : String(badge);
      badgeHtml =
        '<span class="nav-tab__badge" aria-label="' + badge + ' new">' + shown + '</span>';
    }
    return (
      '<a href="' + href + '" class="nav-tab' + stateClass + '" data-nav-key="' + key + '">' +
        '<span class="nav-tab__icon-wrap">' +
          ICONS[key] +
          badgeHtml +
        '</span>' +
        '<span class="nav-tab__label">' + label + '</span>' +
      '</a>'
    );
  }

  // Catalog of every tab the helper knows how to render. Pages opt in by
  // listing keys in `tabs`. Default order matches the visual rhythm we
  // want everywhere: Standings → Free Agency → Trades → Lineup → Score Event.
  var TAB_HREF = {
    leagueHome: function (id) { return 'league.html?id='      + encodeURIComponent(id); },
    standings:  function (id) { return 'standings.html?id='   + encodeURIComponent(id); },
    freeAgency: function (id) { return 'waivers.html?id='     + encodeURIComponent(id); },
    trades:     function (id) { return 'trades.html?id='      + encodeURIComponent(id); },
    lineup:     function (id) { return 'lineup.html?id='      + encodeURIComponent(id); },
    // score-event uses ?league= rather than ?id= for historical reasons.
    scoreEvent: function (id) { return 'score-event.html?league=' + encodeURIComponent(id); },
    draftRoom:  function (id) { return 'draft.html?id='       + encodeURIComponent(id); }
  };
  var TAB_LABEL = {
    leagueHome: 'League Home',
    standings:  'Standings',
    freeAgency: 'Free Agency',
    trades:     'Trades',
    lineup:     'Roster',
    scoreEvent: 'Score Event',
    draftRoom:  'Draft Room'
  };
  var DEFAULT_TABS = ['leagueHome', 'standings', 'freeAgency', 'trades', 'lineup'];

  function render(opts) {
    opts = opts || {};
    var leagueId = opts.leagueId;
    var active   = opts.active  || null;
    var primary  = opts.primary || null;   // CTA highlight when no tab is active
    var tabs     = opts.tabs    || DEFAULT_TABS;
    var badges   = opts.badges  || {};     // { trades: 3, freeAgency: true, ... }

    function stateOf(key) {
      if (active  === key) return 'active';
      if (primary === key) return 'primary';
      return 'idle';
    }

    var inner = '';
    for (var i = 0; i < tabs.length; i++) {
      var key = tabs[i];
      if (!TAB_HREF[key]) continue;  // unknown key — skip silently
      inner += tab(TAB_HREF[key](leagueId), key, TAB_LABEL[key], stateOf(key), badges[key]);
    }
    // Wrap in the segmented-bar container so the tabs sit inside a single
    // rounded outer frame with hairline internal dividers.
    return '<div class="nav-tabs">' + inner + '</div>';
  }

  // -----------------------------------------------------------------------
  // fetchBadges — queries Supabase for the count of items each tab might
  // want to advertise. Currently:
  //   trades  -> count of pending incoming trade offers (recipient = me)
  // Returns a badges object suitable for passing to render({ badges }).
  // Safe to call from any league-context page; returns empty {} on error
  // so a query problem never breaks the nav.
  // -----------------------------------------------------------------------
  async function fetchBadges(leagueId, memberId) {
    if (!leagueId || !memberId || typeof supabaseClient === 'undefined') return {};
    var out = {};
    try {
      var res = await supabaseClient
        .from('trades')
        .select('id', { count: 'exact', head: true })
        .eq('league_id',    leagueId)
        .eq('recipient_id', memberId)
        .eq('status',       'proposed');
      if (!res.error && res.count > 0) out.trades = res.count;
    } catch (e) { /* fall through to empty {} */ }
    return out;
  }

  // -----------------------------------------------------------------------
  // renderInto — convenience for pages that want badges. Does the initial
  // render synchronously (so the nav appears immediately), then fires a
  // background badge fetch and re-renders if any counts came back.
  //   container: a DOM element OR an id string
  //   opts:      same as render(), plus `memberId` to enable badge fetch
  // -----------------------------------------------------------------------
  function renderInto(container, opts) {
    var el = typeof container === 'string'
      ? document.getElementById(container)
      : container;
    if (!el) return;
    el.innerHTML = render(opts);
    if (!opts || !opts.memberId) return;
    fetchBadges(opts.leagueId, opts.memberId).then(function (badges) {
      if (!badges || Object.keys(badges).length === 0) return;
      // Re-render with badges merged in.
      var merged = {};
      for (var k in opts) merged[k] = opts[k];
      merged.badges = badges;
      el.innerHTML = render(merged);
    });
  }

  root.LeagueNav = {
    render:      render,
    renderInto:  renderInto,
    fetchBadges: fetchBadges
  };
})(typeof window !== 'undefined' ? window : this);
