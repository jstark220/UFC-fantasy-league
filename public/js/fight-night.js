// ========================================================================
// FIGHT NIGHT HUB (fight-night.html?id=LEAGUE[&event=EVENT][&simulate=live])
//
// The live second-screen page: event hero, IN THE OCTAGON (current fight
// with live stat bars), up next, the full card, the league race (Event /
// Season toggle), My Corner, and the round-by-round feed.
//
// Architecture (see FIGHT_NIGHT_HUB_PLAN.md):
//   - ALL data flows through FightNightStore (fight-night-store.js); every
//     DOM region renders from the store. Nothing else touches the DOM.
//   - Feeds: initial fetch + full refetches (token-gated, wholesale),
//     realtime patches (two channels: fight_results + scores), a 60s
//     token poll fallback, and a localStorage snapshot for instant paint.
//   - hubNow() is a server-corrected clock (Date header offset) — lock
//     detection and the PREVIEW/LIVE/FINAL machine never trust the phone.
//   - Moments fire only for live-observed transitions (store via:'live').
// ========================================================================

/* global requireAuth, supabaseClient, EventOverrides, FightRows,
          FightNightStore, Scoring, FightOdds, Projections, EmptyState,
          LeagueNav, showFighterModal, eventCurrentUntil, isNumberedEvent,
          getStarterCountForEvent, wpDateInEt, formatEtDateTime */

(function () {
  'use strict';

  // ---- module state --------------------------------------------------------
  var leagueId = null;
  var eventId = null;
  var user = null;
  var myMemberId = null;
  var simulateLive = false;

  var store = FightNightStore;
  var state = null;            // the store state — single source of truth
  var lastRenderedRev = -1;
  var renderQueued = false;

  var rosterIds = {};          // viewer's rostered fighter ids -> true
  var oddsMap = {};            // fighterId -> odds (module-level, not in store)
  var projMap = {};            // fighterId -> projection

  var serverOffsetMs = 0;      // server time - device time
  var connState = 'live';      // 'live' | 'reconnecting' | 'offline'
  var currentPhase = null;

  var channels = [];
  var pollTimer = null, tickTimer = null;
  var refetchTimer = null, snapshotTimer = null, refetchInFlight = false;

  var ui = {
    mobileTab: 'card',         // 'card' | 'race' | 'feed'
    raceMode: null,            // 'event' | 'season' (null = auto by phase)
    expandedMember: null,
    cardExpanded: null,        // null = auto: open in PREVIEW, collapsed once live
    cornerMember: null         // null = the viewer; else a league_member id
  };

  var REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var prevRacePts = {};        // memberId -> last rendered pts (count-up tween)
  var prevMyBarPts = null;
  var pendingFlash = {};       // fightId -> true (one-shot row flash on live finals)

  var POLL_MS = 60 * 1000;
  var STALE_LOUD_MS = 5 * 60 * 1000;  // mid-LIVE, grey the numbers past this

  function hubNow() { return Date.now() + serverOffsetMs; }

  function escapeHtml(str) {
    if (str == null) return '';
    var d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

  // ---- init ------------------------------------------------------------------
  async function init() {
    user = await requireAuth();
    if (!user) return;

    var params = new URLSearchParams(window.location.search);
    leagueId = params.get('id');
    simulateLive = params.get('simulate') === 'live';
    if (!leagueId) { window.location.href = 'dashboard.html'; return; }
    document.getElementById('leagueLink').href = 'league.html?id=' + leagueId;

    // Server-corrected clock: our own host's Date header (Vercel time).
    try {
      var head = await fetch(window.location.pathname, { method: 'HEAD', cache: 'no-store' });
      var serverDate = new Date(head.headers.get('date')).getTime();
      if (!isNaN(serverDate)) serverOffsetMs = serverDate - Date.now();
    } catch (e) { /* device clock fallback */ }

    var results = await Promise.all([
      supabaseClient.from('leagues').select('id, name, commissioner_id, scoring_config').eq('id', leagueId).single(),
      supabaseClient.from('league_members').select('id, user_id, team_name, is_commissioner').eq('league_id', leagueId),
      supabaseClient.from('ufc_events')
        .select('id, name, full_name, event_date, venue, lineup_lock_time, is_completed, last_scored_at')
        .order('event_date', { ascending: false })
    ]);
    var league = results[0].data;
    var members = results[1].data || [];
    if (!league) { window.location.href = 'dashboard.html'; return; }
    var myMember = members.find(function (m) { return m.user_id === user.id; });
    if (!myMember) { window.location.href = 'dashboard.html'; return; }
    myMemberId = myMember.id;

    document.title = 'Fight Night - ' + league.name;
    document.getElementById('leagueName').textContent = league.name;
    LeagueNav.renderInto('headerActions', {
      leagueId: leagueId, memberId: myMemberId, active: 'fightNight'
    });

    // Event pick: explicit ?event=, else the current card (still inside its
    // Mon-4am-ET window), else the most recent past event.
    var overrides = await EventOverrides.fetchForLeague(supabaseClient, leagueId);
    var events = EventOverrides.mergeAll(results[2].data || [], overrides);
    events.sort(function (a, b) { return String(b.event_date || '').localeCompare(String(a.event_date || '')); });
    var eventParam = params.get('event');
    var event = (eventParam && events.find(function (e) { return e.id === eventParam; })) || pickDefaultEvent(events);
    if (!event) { document.getElementById('pageContent').style.display = 'block'; renderNoEvent(); return; }
    eventId = event.id;

    state = store.create(leagueId, eventId);

    // Viewer roster (drives YOURS rings) — not event-scoped, fetch once.
    var rosterRes = await supabaseClient
      .from('rosters').select('fighter_id')
      .eq('league_id', leagueId).eq('league_member_id', myMemberId);
    (rosterRes.data || []).forEach(function (r) { rosterIds[r.fighter_id] = true; });

    // Instant paint: hydrate the snapshot before any network round trip.
    var snap = loadSnapshot();
    if (snap) dispatch({ type: 'snapshot', snapshot: snap });

    document.getElementById('pageContent').style.display = 'block';
    renderTabs();
    setupDockChat();
    if (state.fetchedAt === 0) renderSkeletons();   // no snapshot -> shimmer, never blank
    scheduleRender();

    await refetchAll(false);

    setupRealtime();
    startPolling();
    startTicker();
    setupWakeHandlers();

    // Photos fade in as they decode (CSS pairs with .img-loaded).
    document.addEventListener('load', function (e) {
      if (e.target && e.target.tagName === 'IMG') e.target.classList.add('img-loaded');
    }, true);

    // Fighter modal from any bout row (FightRows buttons), delegated once.
    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-open-fighter]');
      if (btn && typeof showFighterModal === 'function') {
        showFighterModal(btn.getAttribute('data-open-fighter'));
      }
    });
  }

  // Desktop-only: chat lives permanently docked on the right. The dock DOM
  // is injected here (not in the HTML) so mobile never has duplicate chat
  // element ids competing with the floating popup, which stays the mobile UX.
  function setupDockChat() {
    if (!window.matchMedia('(min-width: 1101px)').matches) return;
    var dock = document.getElementById('hubChatDock');
    if (!dock || typeof window.initChatWidget !== 'function') return;
    dock.innerHTML =
      '<div class="chat-popup__body hub-chat-dock__body">' +
        '<aside class="chat-sidebar" id="chatSidebar"></aside>' +
        '<div class="chat-window">' +
          '<div class="chat-header" id="chatHeader">' +
            '<span class="chat-header__title" id="chatHeaderTitle">League Chat</span>' +
            '<span class="chat-header__sub" id="chatHeaderSub"></span>' +
          '</div>' +
          '<div id="chatMessages" class="chat-messages" aria-live="polite">' +
            '<p class="chat-state">Loading chat...</p>' +
          '</div>' +
          '<form id="chatForm" class="chat-composer" autocomplete="off">' +
            '<textarea id="chatInput" class="chat-composer__input" rows="1" maxlength="2000" placeholder="Send a message..." aria-label="Message"></textarea>' +
            '<button type="submit" class="btn-primary chat-composer__send" id="chatSendBtn">Send</button>' +
          '</form>' +
        '</div>' +
      '</div>';
    window.initChatWidget(leagueId, dock, {}).catch(function () { /* chat stays in loading state */ });

    // Size the dock from its current top edge down to the viewport bottom, so
    // the composer is always visible without scrolling the page — works the
    // same whether the dock sits at hero level (unscrolled) or pinned under
    // the nav (scrolled). rAF-throttled on scroll/resize.
    sizeDock();
    var sizing = false;
    function onScrollResize() {
      if (sizing) return;
      sizing = true;
      requestAnimationFrame(function () { sizing = false; sizeDock(); });
    }
    window.addEventListener('scroll', onScrollResize, { passive: true });
    window.addEventListener('resize', onScrollResize);
  }

  var dockLastTop = -1, dockLastH = -1;
  function sizeDock() {
    var dock = document.getElementById('hubChatDock');
    if (!dock || !window.matchMedia('(min-width: 1101px)').matches) return;
    var nav = document.querySelector('.top-nav');
    var minTop = (nav ? nav.offsetHeight : 64) + 16;
    var hero = document.querySelector('.hub-hero');
    var top = minTop;
    if (hero) {
      var heroTop = hero.getBoundingClientRect().top;     // viewport coords
      if (heroTop > minTop) top = heroTop;                // unscrolled: hang at hero level
    }
    var h = Math.max(320, window.innerHeight - top - 16);
    // write only on real change — once pinned under the nav, this is a no-op
    if (Math.abs(top - dockLastTop) > 0.5) { dock.style.top = top + 'px'; dockLastTop = top; }
    if (Math.abs(h - dockLastH) > 0.5)     { dock.style.height = h + 'px'; dockLastH = h; }
  }

  function pickDefaultEvent(events) {
    if (!events || events.length === 0) return null;
    var now = hubNow();
    var current = events.filter(function (e) {
      var until = (typeof eventCurrentUntil === 'function') ? eventCurrentUntil(e.event_date) : null;
      return until && now < until.getTime();
    });
    if (current.length > 0) return current[current.length - 1];
    return events[0];
  }

  // ---- store plumbing ----------------------------------------------------------
  function dispatch(action) {
    var r = store.apply(state, action);
    state = r.state;
    handleStoreEvents(r.events);
    if (state.rev !== lastRenderedRev) scheduleRender();
    scheduleSnapshotSave();
  }

  function handleStoreEvents(events) {
    events.forEach(function (ev) {
      if (ev.type === 'needsRefetch') scheduleRefetch(500);
      if (ev.type === 'fightFinal' && ev.via === 'live' && document.visibilityState === 'visible') {
        announceFinal(ev.fightId);
        pendingFlash[ev.fightId] = true;
      }
    });
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      lastRenderedRev = state.rev;
      renderAll();
      sizeDock();
      // cached images can decode before the load listener sees them
      document.querySelectorAll('.page-fight-night img').forEach(function (img) {
        if (img.complete) img.classList.add('img-loaded');
      });
    });
  }

  // ---- data loading ---------------------------------------------------------------
  function scheduleRefetch(delayMs) {
    if (refetchTimer) return;
    refetchTimer = setTimeout(function () {
      refetchTimer = null;
      refetchAll(true);
    }, delayMs || 0);
  }

  async function refetchAll(liveObserved) {
    if (refetchInFlight) { scheduleRefetch(800); return; }
    refetchInFlight = true;
    try {
      var memberIds = state.members.length
        ? state.members.map(function (m) { return m.id; })
        : null;

      var queries = [
        supabaseClient.from('ufc_events')
          .select('id, name, full_name, event_date, venue, lineup_lock_time, is_completed, last_scored_at')
          .eq('id', eventId).single(),
        supabaseClient.from('fight_results')
          .select(
            'id, event_id, fighter_a_id, fighter_b_id, weight_class, card_position, ' +
            'fight_order, title_type, is_title_defense, outcome, winner_id, ' +
            'end_round, end_time_seconds, ' +
            'fighter_a_sig_strikes, fighter_a_takedowns, fighter_a_knockdowns, fighter_a_control_seconds, fighter_a_opponent_rank, ' +
            'fighter_b_sig_strikes, fighter_b_takedowns, fighter_b_knockdowns, fighter_b_control_seconds, fighter_b_opponent_rank'
          )
          .eq('event_id', eventId),
        supabaseClient.from('league_members')
          .select('id, user_id, team_name, is_commissioner').eq('league_id', leagueId),
        supabaseClient.from('leagues').select('scoring_config, name').eq('id', leagueId).single(),
        // Season scores for the whole league: pastTotals (excl. this event)
        // computed client-side; tonight's rows feed the live maps.
        supabaseClient.from('scores')
          .select('league_id, event_id, league_member_id, fighter_id, total_points')
          .eq('league_id', leagueId)
      ];
      var r = await Promise.all(queries);
      var eventRow = r[0].data;
      var fights = r[1].data || [];
      var members = r[2].data || [];
      var league = r[3].data;
      var allScores = r[4].data || [];

      // Starters for this event, all members (the race needs everyone's).
      var startersRes = await supabaseClient.from('starter_selections')
        .select('league_member_id, fighter_id')
        .eq('event_id', eventId)
        .in('league_member_id', members.map(function (m) { return m.id; }));
      var starters = startersRes.data || [];

      // Fighter rows for the card.
      var idSet = {};
      fights.forEach(function (f) {
        if (f.fighter_a_id) idSet[f.fighter_a_id] = true;
        if (f.fighter_b_id) idSet[f.fighter_b_id] = true;
      });
      var fighterIds = Object.keys(idSet);
      var fightersRes = fighterIds.length
        ? await supabaseClient.from('fighters')
            .select('id, name, photo_url, current_rank, is_champion, is_sub_champion, sub_title_type, country, record_wins, record_losses, record_draws')
            .in('id', fighterIds)
        : { data: [] };

      // Override-merge the event row for this league's customizations.
      var ovr = await EventOverrides.fetchForLeague(supabaseClient, leagueId, [eventId]);
      var mergedEvent = EventOverrides.merge(eventRow, ovr[eventId]);
      // Keep the token even if an override copy drops it.
      mergedEvent.last_scored_at = eventRow ? eventRow.last_scored_at : null;

      var pastTotals = {}, eventScores = [];
      allScores.forEach(function (s) {
        if (s.event_id === eventId) eventScores.push(s);
        else pastTotals[s.league_member_id] = (pastTotals[s.league_member_id] || 0) + (s.total_points || 0);
      });

      // Odds + projections live outside the store (module maps).
      if (fighterIds.length) {
        var extras = await Promise.all([
          typeof FightOdds !== 'undefined' ? FightOdds.loadFightOdds(fighterIds) : {},
          typeof Projections !== 'undefined' ? Projections.load(fighterIds) : {}
        ]);
        oddsMap = extras[0] || {};
        projMap = extras[1] || {};
      }

      dispatch({
        type: 'refetch',
        liveObserved: !!liveObserved,
        at: hubNow(),
        payload: {
          token: mergedEvent.last_scored_at || null,
          event: mergedEvent,
          league: league,
          fights: fights,
          fighters: fightersRes.data || [],
          scores: eventScores,
          starters: starters,
          members: members,
          pastTotals: pastTotals
        }
      });
      void memberIds;
    } catch (e) {
      console.warn('[hub] refetch failed:', e);
      setConn(navigator.onLine === false ? 'offline' : 'reconnecting');
    } finally {
      refetchInFlight = false;
    }
  }

  // ---- realtime -------------------------------------------------------------------
  function setupRealtime() {
    teardownRealtime();
    // Two SEPARATE channels — Supabase has dropped one subscription when two
    // tables share a channel (see the hard-won note in chat.js).
    var ch1 = supabaseClient
      .channel('hub_fights_' + eventId)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'fight_results', filter: 'event_id=eq.' + eventId },
        function (payload) {
          if (payload.eventType === 'DELETE') { scheduleRefetch(500); return; }
          dispatch({ type: 'fightChange', row: payload.new });
        })
      .subscribe(onChannelStatus);
    var ch2 = supabaseClient
      .channel('hub_scores_' + leagueId)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'scores', filter: 'league_id=eq.' + leagueId },
        function (payload) {
          dispatch({ type: 'scoreChange', eventType: payload.eventType, row: payload.new });
        })
      .subscribe(onChannelStatus);
    channels = [ch1, ch2];
  }

  function teardownRealtime() {
    channels.forEach(function (ch) {
      try { supabaseClient.removeChannel(ch); } catch (e) { /* already gone */ }
    });
    channels = [];
  }

  function onChannelStatus(status) {
    if (status === 'SUBSCRIBED') setConn('live');
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setConn('reconnecting');
  }

  function setConn(next) {
    if (connState === next) return;
    connState = next;
    renderHeroStatus();
  }

  // ---- polling fallback (cheap: one row, refetch only when the token moves) ----
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async function () {
      if (document.visibilityState !== 'visible') return;
      try {
        var res = await supabaseClient.from('ufc_events')
          .select('last_scored_at').eq('id', eventId).single();
        if (res.data) {
          dispatch({ type: 'tokenPoll', token: res.data.last_scored_at });
          if (connState === 'offline') setConn('reconnecting');
        }
      } catch (e) { setConn(navigator.onLine === false ? 'offline' : 'reconnecting'); }
    }, POLL_MS);
  }

  // ---- ticker: countdown, stamp, phase flips (1s, hero-only) ---------------------
  function startTicker() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(function () {
      var phase = computePhase();
      if (phase !== currentPhase) { scheduleRender(); return; }  // PREVIEW->LIVE->FINAL flip
      renderHeroStatus();   // cheap: countdown + stamp only
    }, 1000);
  }

  // ---- wake / degraded handling ----------------------------------------------------
  function setupWakeHandlers() {
    function onWake() {
      if (document.visibilityState !== 'visible') return;
      // iOS kills websockets on lock and throttles timers in background:
      // recompute the state machine immediately, refetch, resubscribe.
      scheduleRender();
      scheduleRefetch(0);
      setupRealtime();
    }
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('pageshow', onWake);
    window.addEventListener('online', function () { setConn('reconnecting'); scheduleRefetch(0); });
    window.addEventListener('offline', function () { setConn('offline'); });
  }

  // ---- snapshot (cache-first paint) ---------------------------------------------------
  function snapshotKey() { return 'hub-' + leagueId + '-' + eventId; }

  function loadSnapshot() {
    try {
      var raw = localStorage.getItem(snapshotKey());
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function scheduleSnapshotSave() {
    if (snapshotTimer) return;
    snapshotTimer = setTimeout(function () {
      snapshotTimer = null;
      try {
        // Multi-tab guard: never overwrite a snapshot built from newer data.
        var existing = loadSnapshot();
        if (existing && existing.fetchedAt > state.fetchedAt) return;
        localStorage.setItem(snapshotKey(), JSON.stringify(store.serialize(state)));
      } catch (e) { /* quota / private mode — snapshot is opportunistic */ }
    }, 2000);
  }

  // ---- phase --------------------------------------------------------------------------
  function effectiveLockMs() {
    var ev = state.event;
    if (!ev) return null;
    if (ev.lineup_lock_time) {
      var t = new Date(ev.lineup_lock_time).getTime();
      if (!isNaN(t)) return t;
    }
    // First-prelim approximation: 5pm ET on event date (same fallback the
    // lineup page uses). wpDateInEt comes from waiver-phase.js.
    if (ev.event_date && typeof wpDateInEt === 'function') {
      var p = String(ev.event_date).split('-');
      return wpDateInEt(Number(p[0]), Number(p[1]), Number(p[2]), 17, 0).getTime();
    }
    return null;
  }

  function computePhase() {
    if (!state || !state.event) return 'PREVIEW';
    if (simulateLive) { currentPhase = 'LIVE'; return 'LIVE'; }
    var until = (typeof eventCurrentUntil === 'function' && state.event.event_date)
      ? eventCurrentUntil(state.event.event_date) : null;
    var phase = store.phaseOf({
      lockMs: effectiveLockMs(),
      untilMs: until ? until.getTime() : null,
      totalFights: store.fightCount(state),
      decidedFights: store.decidedCount(state)
    }, hubNow());
    currentPhase = phase;
    return phase;
  }

  // ---- moments ----------------------------------------------------------------------------
  function announceFinal(fightId) {
    var f = state.fights[fightId];
    if (!f) return;
    var winner = state.fighters[f.winner_id];
    var loserId = f.winner_id === f.fighter_a_id ? f.fighter_b_id : f.fighter_a_id;
    var loser = state.fighters[loserId];
    var method = (f.outcome || '').toUpperCase();
    var mine = state.starters.filter(function (s) {
      return s.league_member_id === myMemberId &&
        (s.fighter_id === f.fighter_a_id || s.fighter_id === f.fighter_b_id);
    });
    if (mine.length) {
      mine.forEach(function (s) {
        var won = s.fighter_id === f.winner_id;
        var me = state.fighters[s.fighter_id];
        var pts = Scoring.computeFighterScore(f, s.fighter_id === f.fighter_a_id,
          state.league && state.league.scoring_config).total;
        showToast(
          '<b>' + (won ? 'WIN' : 'LOSS') + ':</b> ' + escapeHtml(me ? me.name : 'Your starter') +
          (won ? ' defeats ' + escapeHtml(loser ? loser.name : '') : ' falls to ' + escapeHtml(winner ? winner.name : '')) +
          ' · ' + method + (f.end_round ? ' R' + f.end_round : '') +
          ' · <b>+' + pts.toFixed(1) + ' pts</b>',
          won ? 'win' : 'loss'
        );
      });
    }
  }

  // One-shot full-screen lock moment. Session-guarded per event; skipped
  // for reduced-motion users and background tabs.
  function showItsTime() {
    if (REDUCED_MOTION || document.visibilityState !== 'visible') return;
    var key = 'hub-itstime-' + eventId;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch (e) { /* private mode: show it anyway */ }
    var ov = document.createElement('div');
    ov.className = 'hub-itstime';
    ov.innerHTML = '<span class="hub-itstime__text">IT\u2019S TIME</span>';
    document.body.appendChild(ov);
    setTimeout(function () { if (ov.parentNode) ov.parentNode.removeChild(ov); }, 2400);
  }

  function showToast(html, kind) {
    var box = document.getElementById('hubToasts');
    if (!box) return;
    while (box.children.length >= 2) box.removeChild(box.firstChild);
    var el = document.createElement('div');
    el.className = 'hub-toast' + (kind ? ' hub-toast--' + kind : '');
    el.innerHTML = html;
    box.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 5000);
  }

  // ---- rendering -------------------------------------------------------------------------------
  var lastPhaseSeen = null;
  function renderAll() {
    if (!state) return;
    var phase = computePhase();
    // the lock moment: one-shot IT'S TIME takeover on the PREVIEW -> LIVE flip
    if (lastPhaseSeen === 'PREVIEW' && phase === 'LIVE') showItsTime();
    lastPhaseSeen = phase;
    document.body.setAttribute('data-phase', phase.toLowerCase());
    document.body.classList.toggle('hub-stale',
      phase === 'LIVE' && state.fetchedAt > 0 && (hubNow() - state.fetchedAt) > STALE_LOUD_MS);
    renderHero();          // includes the MY CORNER chips zone
    renderWinner(phase);
    renderNow(phase);
    renderUpNext(phase);
    renderCard(phase);
    renderRace(phase);
    renderFeed(phase);
    renderMyBar();
  }

  // Shimmer placeholders so the first paint is never blank cards. Real
  // renders overwrite these the moment any data (snapshot or fetch) lands.
  function renderSkeletons() {
    var hero = document.getElementById('hubHero');
    if (hero) hero.innerHTML =
      '<div class="hub-hero"><div class="hub-hero__info">' +
        '<span class="hub-skel" style="width:120px"></span>' +
        '<span class="hub-skel hub-skel--lg" style="width:280px"></span>' +
        '<span class="hub-skel" style="width:180px"></span>' +
      '</div></div>';
    var lines = '<span class="hub-skel" style="width:60%"></span>' +
                '<span class="hub-skel" style="width:85%"></span>' +
                '<span class="hub-skel" style="width:72%"></span>';
    ['hubCardSection', 'hubRaceSection'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.innerHTML = lines;
    });
  }

  function renderNoEvent() {
    document.getElementById('hubHero').innerHTML = EmptyState.html({
      kind: 'events', title: 'No events yet',
      body: 'Once a UFC card is on the schedule, Fight Night lives here.'
    });
  }

  function fmtAgo(ms) {
    var s = Math.max(0, Math.round((hubNow() - ms) / 1000));
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    return Math.floor(m / 60) + 'h ago';
  }

  function heroStatusHtml(phase) {
    var rightHtml = '';
    if (phase === 'PREVIEW') {
      var lock = effectiveLockMs();
      var diff = lock != null ? lock - hubNow() : null;
      if (diff != null && diff > 0) {
        var d = Math.floor(diff / 86400000), h = Math.floor(diff % 86400000 / 3600000),
            m = Math.floor(diff % 3600000 / 60000), s = Math.floor(diff % 60000 / 1000);
        rightHtml =
          '<span class="hub-status hub-status--preview">Lineups lock in</span>' +
          '<div class="hub-countdown">' + (d > 0 ? d + 'd ' : '') + h + 'h ' + m + 'm ' + (d > 0 ? '' : s + 's') + '</div>';
      } else {
        rightHtml = '<span class="hub-status hub-status--preview">Starting soon</span>';
      }
    } else if (phase === 'LIVE') {
      rightHtml =
        '<span class="hub-status hub-status--live"><span class="hub-live-dot"></span>LIVE</span>' +
        '<div class="hub-hero__sub">' + store.decidedCount(state) + ' of ' + store.fightCount(state) + ' fights final</div>';
    } else {
      rightHtml = '<span class="hub-status hub-status--final">FINAL</span>';
    }
    var stamp = state.fetchedAt > 0 ? 'Updated ' + fmtAgo(state.fetchedAt) : 'Loading…';
    if (simulateLive) stamp += ' · SIMULATION';
    var pill = '';
    if (connState === 'reconnecting') pill = '<div class="hub-reconnect">Reconnecting · last data kept</div>';
    if (connState === 'offline') pill = '<div class="hub-reconnect">Offline · showing last data</div>';
    return rightHtml + '<div class="hub-hero__stamp">' + stamp + '</div>' + pill;
  }

  // Hero shell: event identity (left) · MY CORNER chips (center) · status
  // (right). Only the status zone re-renders on the 1s tick; the corner zone
  // is owned by renderCorner() so chips don't rebuild every second.
  function renderHero() {
    var el = document.getElementById('hubHero');
    if (!el || !state || !state.event) return;
    var ev = state.event;
    var phase = currentPhase || computePhase();
    var tag = (typeof isNumberedEvent === 'function' && isNumberedEvent(ev)) ? 'PPV' : 'FIGHT NIGHT';
    var dateStr = ev.event_date
      ? new Date(ev.event_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      : '';

    // Poster layer: the main event's fighters as low-opacity cutouts
    // anchoring the hero's edges. Falls back gracefully when photos miss.
    var mainEv = null;
    for (var fid in state.fights) {
      var f = state.fights[fid];
      if (f.card_position === 'main_event') { mainEv = f; break; }
      if (!mainEv || (f.fight_order != null && (mainEv.fight_order == null || f.fight_order < mainEv.fight_order))) mainEv = f;
    }
    var cutouts = '';
    if (mainEv) {
      var fa = state.fighters[mainEv.fighter_a_id], fb = state.fighters[mainEv.fighter_b_id];
      if (fa && fa.photo_url) cutouts += '<img class="hub-hero__cutout hub-hero__cutout--l" src="' + escapeHtml(fa.photo_url) + '" alt="" aria-hidden="true" loading="lazy" onerror="this.remove()">';
      if (fb && fb.photo_url) cutouts += '<img class="hub-hero__cutout hub-hero__cutout--r" src="' + escapeHtml(fb.photo_url) + '" alt="" aria-hidden="true" loading="lazy" onerror="this.remove()">';
    }

    el.innerHTML =
      '<div class="hub-hero hub-hero--' + phase.toLowerCase() + '">' +
        '<div class="hub-hero__bg">' + cutouts + '</div>' +
        '<div class="hub-hero__info">' +
          '<p class="hub-hero__eyebrow">' + tag + (dateStr ? ' · ' + escapeHtml(dateStr) : '') + '</p>' +
          '<h2 class="hub-hero__name">' + escapeHtml(ev.name || ev.full_name || 'UFC Event') + '</h2>' +
          (ev.venue ? '<p class="hub-hero__sub">' + escapeHtml(ev.venue) + '</p>' : '') +
        '</div>' +
        '<div class="hub-hero__corner" id="hubHeroCorner"></div>' +
        '<div class="hub-hero__right" id="hubHeroStatus">' + heroStatusHtml(phase) + '</div>' +
      '</div>';
    renderCorner();
  }

  function renderHeroStatus() {
    var el = document.getElementById('hubHeroStatus');
    if (!el || !state || !state.event) return;
    el.innerHTML = heroStatusHtml(currentPhase || computePhase());
  }

  function renderWinner(phase) {
    var el = document.getElementById('hubWinner');
    if (!el) return;
    if (phase !== 'FINAL' || store.fightCount(state) === 0) { el.innerHTML = ''; return; }
    var rows = store.raceRows(state, 'event');
    if (!rows.length || rows[0].eventPts <= 0) { el.innerHTML = ''; return; }
    var top = rows[0];
    el.innerHTML =
      '<div class="hub-winner">' +
        '<p class="hub-winner__eyebrow">Event Winner</p>' +
        '<p class="hub-winner__team">' + escapeHtml(top.member.team_name) + '</p>' +
        '<p class="hub-winner__pts">' + top.eventPts.toFixed(1) + ' pts on the night</p>' +
      '</div>';
  }

  // A bout is "in progress" for live scoring once any stat has landed but no
  // result is in yet. Future bouts read all-zero and decided bouts have an
  // `outcome`, so this cleanly isolates the live fight. (The 2-min cron writes
  // these stats before `outcome`, so the score starts moving as soon as the
  // round's first numbers post — matching the live stat bars in the Octagon.)
  function fightInProgress(f) {
    if (!f || f.outcome) return false;
    return !!(f.fighter_a_sig_strikes || f.fighter_b_sig_strikes ||
              f.fighter_a_takedowns || f.fighter_b_takedowns ||
              f.fighter_a_knockdowns || f.fighter_b_knockdowns ||
              f.fighter_a_control_seconds || f.fighter_b_control_seconds);
  }

  function rowOptsFor() {
    var starterIds = {};
    state.starters.forEach(function (s) {
      if (s.league_member_id === myMemberId) starterIds[s.fighter_id] = true;
    });
    var scoreMap = {};
    var liveSet = {};   // fighterId -> true when the score is live (bout in progress)
    var cfg = state.league && state.league.scoring_config;
    for (var id in state.fights) {
      var f = state.fights[id];
      if (f.outcome) {
        // Decided bout: final earned points (base + win/finish/title bonuses).
        if (f.fighter_a_id) scoreMap[f.fighter_a_id] = Scoring.computeFighterScore(f, true, cfg).total;
        if (f.fighter_b_id) scoreMap[f.fighter_b_id] = Scoring.computeFighterScore(f, false, cfg).total;
      } else if (fightInProgress(f)) {
        // In-progress bout: stats are landing but there's no result yet. Score
        // it LIVE off the running stat line so the number replaces the
        // projection and climbs as the fight unfolds. computeFighterScore yields
        // base points only here (every win/finish/title bonus gates on a winner,
        // which is null mid-fight) — i.e. exactly strikes + takedowns +
        // knockdowns + control, times the card-position multiplier.
        if (f.fighter_a_id) { scoreMap[f.fighter_a_id] = Scoring.computeFighterScore(f, true, cfg).total; liveSet[f.fighter_a_id] = true; }
        if (f.fighter_b_id) { scoreMap[f.fighter_b_id] = Scoring.computeFighterScore(f, false, cfg).total; liveSet[f.fighter_b_id] = true; }
      }
    }
    return { oddsMap: oddsMap, projMap: projMap, scoreMap: scoreMap, liveSet: liveSet, rosterIds: rosterIds, starterIds: starterIds };
  }

  function shapedFights() {
    var raw = [];
    for (var id in state.fights) raw.push(state.fights[id]);
    return FightRows.shape(raw, state.fighters);
  }

  function renderNow(phase) {
    var el = document.getElementById('hubNowSection');
    if (!el) return;
    if (phase !== 'LIVE') { el.style.display = 'none'; return; }
    var cur = store.currentFight(state);
    if (!cur) { el.style.display = 'none'; return; }
    el.style.display = '';

    var shaped = shapedFights().find(function (f) { return f.id === cur.id; });
    var rowHtml = shaped ? FightRows.rowHtml(shaped, state.event && state.event.name, rowOptsFor()) : '';

    // Live stat comparison — ingest writes stats before `outcome`, so these
    // move at cron cadence mid-fight when ESPN provides them.
    var stats = [
      ['STR', cur.fighter_a_sig_strikes, cur.fighter_b_sig_strikes],
      ['TD',  cur.fighter_a_takedowns,   cur.fighter_b_takedowns],
      ['KD',  cur.fighter_a_knockdowns,  cur.fighter_b_knockdowns],
      ['CTRL', cur.fighter_a_control_seconds, cur.fighter_b_control_seconds]
    ];
    var hasStats = stats.some(function (s) { return (s[1] || 0) > 0 || (s[2] || 0) > 0; });
    var barsHtml = '';
    if (hasStats) {
      barsHtml = '<div class="hub-statbars">' + stats.map(function (s) {
        var a = s[1] || 0, b = s[2] || 0, max = Math.max(a, b, 1);
        var fmt = s[0] === 'CTRL'
          ? function (v) { return Math.floor(v / 60) + ':' + String(v % 60).padStart(2, '0'); }
          : function (v) { return String(v); };
        return (
          '<div class="hub-statbar">' +
            '<span class="hub-statbar__val hub-statbar__val--l">' + fmt(a) + '</span>' +
            '<span class="hub-statbar__track hub-statbar__track--l"><span class="hub-statbar__fill" style="width:' + Math.round(a / max * 100) + '%"></span></span>' +
            '<span class="hub-statbar__label">' + s[0] + '</span>' +
            '<span class="hub-statbar__track hub-statbar__track--r"><span class="hub-statbar__fill" style="width:' + Math.round(b / max * 100) + '%"></span></span>' +
            '<span class="hub-statbar__val">' + fmt(b) + '</span>' +
          '</div>'
        );
      }).join('') + '</div>';
    } else {
      barsHtml = '<p class="hub-now__pending">Stats land as the cage-side feed updates (~2 min).</p>';
    }

    el.innerHTML =
      '<p class="hub-section__label">In the Octagon</p>' + rowHtml + barsHtml;
  }

  function renderUpNext(phase) {
    var el = document.getElementById('hubUpNextSection');
    if (!el) return;
    var next = phase === 'LIVE' ? store.upNextFight(state) : null;
    if (!next) { el.style.display = 'none'; return; }
    el.style.display = '';
    var shaped = shapedFights().find(function (f) { return f.id === next.id; });
    el.innerHTML = '<p class="hub-section__label">Up Next</p>' +
      (shaped ? FightRows.rowHtml(shaped, state.event && state.event.name, rowOptsFor()) : '');
  }

  function cardExpandedNow(phase) {
    // Auto: the card IS the content pre-event; once live, the Octagon and
    // the feed carry the page and the full card collapses behind a toggle.
    if (ui.cardExpanded != null) return ui.cardExpanded;
    return phase === 'PREVIEW';
  }

  function renderCard(phase) {
    var el = document.getElementById('hubCardSection');
    if (!el) return;
    var fights = shapedFights();
    var expanded = cardExpandedNow(phase);
    var summary = fights.length
      ? store.decidedCount(state) + ' of ' + fights.length + ' final'
      : '';
    if (phase === 'PREVIEW' && fights.length) summary = fights.length + ' fights';

    var head =
      '<button type="button" class="hub-section__head" id="hubCardToggle" aria-expanded="' + expanded + '">' +
        '<span class="hub-section__label hub-section__label--inhead">The Card</span>' +
        '<span class="hub-section__head-right">' +
          (summary ? '<span class="hub-section__summary">' + summary + '</span>' : '') +
          '<span class="hub-chevron' + (expanded ? ' hub-chevron--open' : '') + '" aria-hidden="true"></span>' +
        '</span>' +
      '</button>';

    var body = '';
    if (expanded) {
      if (!fights.length) {
        body = EmptyState.html({
          kind: 'events', title: 'Card not announced',
          body: 'Fights for this event haven\'t been published yet.', compact: true
        });
      } else {
        var opts = rowOptsFor();
        if (phase === 'LIVE') {
          var curF = store.currentFight(state), nxtF = store.upNextFight(state);
          opts = Object.assign({}, opts, {
            nowFightId: curF && curF.id,
            nextFightId: nxtF && nxtF.id
          });
        }
        var evName = state.event && state.event.name;
        var hasOrder = fights.some(function (f) { return f.fightOrder != null; });
        var mainCard = hasOrder
          ? fights.filter(function (f) { return f.fightOrder != null && f.fightOrder <= 5; })
          : fights.slice(0, 5);
        var prelims = hasOrder
          ? fights.filter(function (f) { return f.fightOrder == null || f.fightOrder > 5; })
          : fights.slice(5);
        if (mainCard.length) {
          body += '<p class="fight-card-section__label">Main Card</p>' +
            mainCard.map(function (f) { return FightRows.rowHtml(f, evName, opts); }).join('');
        }
        if (prelims.length) {
          body += '<p class="fight-card-section__label">Prelims</p>' +
            prelims.map(function (f) { return FightRows.rowHtml(f, evName, opts); }).join('');
        }
      }
    }

    el.innerHTML = head + body;
    // one-shot settle flash on rows that just went final (live-observed only)
    if (!REDUCED_MOTION) {
      Object.keys(pendingFlash).forEach(function (fid) {
        var row = el.querySelector('[data-fight-id="' + fid + '"]');
        if (row) {
          row.classList.add('fight-row--flash');
          setTimeout(function () { row.classList.remove('fight-row--flash'); }, 1700);
        }
      });
    }
    pendingFlash = {};
    var toggle = document.getElementById('hubCardToggle');
    if (toggle) {
      toggle.addEventListener('click', function () {
        ui.cardExpanded = !cardExpandedNow(currentPhase || computePhase());
        renderCard(currentPhase || computePhase());
      });
    }
  }

  function raceModeNow(phase) {
    return ui.raceMode || (phase === 'PREVIEW' ? 'season' : 'event');
  }

  function renderRace(phase) {
    var el = document.getElementById('hubRaceSection');
    if (!el) return;
    var mode = raceModeNow(phase);
    var rows = store.raceRows(state, mode);
    var lockCount = (typeof getStarterCountForEvent === 'function' && state.event)
      ? getStarterCountForEvent(state.event, state.league && state.league.scoring_config)
      : 3;

    var html =
      '<p class="hub-section__label">League Race' +
        '<span class="hub-toggle">' +
          '<button type="button" class="hub-toggle__btn' + (mode === 'event' ? ' hub-toggle__btn--active' : '') + '" data-race-mode="event">Event</button>' +
          '<button type="button" class="hub-toggle__btn' + (mode === 'season' ? ' hub-toggle__btn--active' : '') + '" data-race-mode="season">Season</button>' +
        '</span>' +
      '</p>';

    var leaderVal = rows.length
      ? (mode === 'season' ? rows[0].seasonTotal : rows[0].eventPts)
      : 0;
    rows.forEach(function (r) {
      var isMe = r.member.id === myMemberId;
      var main = mode === 'season' ? r.seasonTotal : r.eventPts;
      var frac = leaderVal > 0 ? Math.max(0, Math.min(1, main / leaderVal)) : 0;
      var sub = mode === 'season'
        ? '+' + r.eventPts.toFixed(1) + ' tonight'
        : r.seasonTotal.toFixed(1) + ' season';
      if (phase === 'PREVIEW') {
        var set = state.starters.filter(function (s) { return s.league_member_id === r.member.id; }).length;
        sub = set + '/' + lockCount + ' set';
      }
      html +=
        '<button type="button" class="hub-race-row' + (isMe ? ' hub-race-row--me' : '') + (r.rank === 1 && main > 0 ? ' hub-race-row--leader' : '') + '" style="--race-frac:' + frac.toFixed(3) + '" data-race-member="' + escapeHtml(r.member.id) + '" aria-expanded="' + (ui.expandedMember === r.member.id) + '" aria-label="' + escapeHtml(r.member.team_name) + ', rank ' + r.rank + '">' +
          '<span class="hub-race-row__rank">' + r.rank + '</span>' +
          '<span class="hub-race-row__team">' + escapeHtml(r.member.team_name) +
            (isMe ? '<span class="hub-race-row__you">you</span>' : '') + '</span>' +
          '<span class="hub-race-row__sub">' + sub + '</span>' +
          '<span class="hub-race-row__pts">' + main.toFixed(1) + '</span>' +
        '</button>';
      if (ui.expandedMember === r.member.id) html += raceDetailHtml(r.member.id);
    });

    // FLIP: capture each row's position before replacing, then animate the
    // slide to its new slot. Points that changed get a count-up tween.
    var prevTops = {};
    if (!REDUCED_MOTION) {
      el.querySelectorAll('[data-race-member]').forEach(function (btn) {
        prevTops[btn.getAttribute('data-race-member')] = btn.getBoundingClientRect().top;
      });
    }
    el.innerHTML = html;
    if (!REDUCED_MOTION) {
      el.querySelectorAll('[data-race-member]').forEach(function (btn) {
        var id = btn.getAttribute('data-race-member');
        var oldTop = prevTops[id];
        if (oldTop == null) return;
        var dy = oldTop - btn.getBoundingClientRect().top;
        if (Math.abs(dy) < 4) return;
        btn.style.transition = 'none';
        btn.style.transform = 'translateY(' + dy + 'px)';
        requestAnimationFrame(function () {
          btn.style.transition = 'transform 340ms cubic-bezier(0.2, 0.8, 0.2, 1)';
          btn.style.transform = '';
          setTimeout(function () { btn.style.transition = ''; }, 380);
        });
      });
      rows.forEach(function (r) {
        var old = prevRacePts[r.member.id];
        if (old != null && Math.abs(old - r.eventPts) > 0.05 && mode === 'event') {
          var btn2 = el.querySelector('[data-race-member="' + r.member.id + '"]');
          var span = btn2 && btn2.querySelector('.hub-race-row__pts');
          if (span) tweenNumber(span, old, r.eventPts, '');
        }
      });
    }
    rows.forEach(function (r) { prevRacePts[r.member.id] = r.eventPts; });
    el.querySelectorAll('[data-race-mode]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        ui.raceMode = btn.getAttribute('data-race-mode');
        renderRace(computePhase());
      });
    });
    el.querySelectorAll('[data-race-member]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-race-member');
        ui.expandedMember = ui.expandedMember === id ? null : id;
        renderRace(computePhase());
      });
    });
  }

  function fighterFight(fighterId) {
    for (var id in state.fights) {
      var f = state.fights[id];
      if (f.fighter_a_id === fighterId || f.fighter_b_id === fighterId) return f;
    }
    return null;
  }

  function starterStatus(fighterId) {
    var f = fighterFight(fighterId);
    var fighter = state.fighters[fighterId];
    var name = fighter ? fighter.name : 'Unknown';
    if (!f) return { name: name, sub: 'Not on this card', pts: null, cls: '' };
    if (f.outcome) {
      var pts = Scoring.computeFighterScore(f, fighterId === f.fighter_a_id,
        state.league && state.league.scoring_config).total;
      var won = f.winner_id === fighterId;
      return {
        name: name,
        sub: (won ? 'W' : f.outcome === 'draw' ? 'D' : 'L') + ' · ' + String(f.outcome).toUpperCase() + (f.end_round ? ' R' + f.end_round : ''),
        pts: pts, cls: won ? 'win' : 'loss'
      };
    }
    var cur = store.currentFight(state);
    if (cur && cur.id === f.id && currentPhase === 'LIVE') {
      return { name: name, sub: 'IN THE OCTAGON', pts: null, cls: '' };
    }
    var proj = projMap[fighterId];
    return { name: name, sub: 'Upcoming' + (proj && proj.projectedPoints != null ? ' · proj ' + Number(proj.projectedPoints).toFixed(1) : ''), pts: null, cls: '' };
  }

  function raceDetailHtml(memberId) {
    var theirs = state.starters.filter(function (s) { return s.league_member_id === memberId; });
    if (!theirs.length) return '<div class="hub-race-detail"><div class="hub-race-detail__row">No starters set</div></div>';
    var html = '<div class="hub-race-detail">';
    theirs.forEach(function (s) {
      var st = starterStatus(s.fighter_id);
      html += '<div class="hub-race-detail__row"><span><b>' + escapeHtml(st.name) + '</b> · ' + escapeHtml(st.sub) + '</span>' +
        '<span class="hub-race-detail__pts">' + (st.pts != null ? st.pts.toFixed(1) : '—') + '</span></div>';
    });
    return html + '</div>';
  }

  // Hover tooltip for a corner chip: the points breakdown. Decided fights
  // show the real scoring components; pending fights with a projection show
  // the projection's component math. CSS reveals it on hover-capable devices.
  function chipTipHtml(fighterId) {
    var f = fighterFight(fighterId);
    var rows = [];
    var title = '';
    if (f && f.outcome) {
      var sc = Scoring.computeFighterScore(f, fighterId === f.fighter_a_id,
        state.league && state.league.scoring_config);
      var d = sc.scoring_detail || {};
      title = 'Score breakdown';
      rows.push(['Strikes · TD · KD', (d.sig_strikes || 0) + ' · ' + (d.takedowns || 0) + ' · ' + (d.knockdowns || 0)]);
      rows.push(['Base points', sc.base_points.toFixed(1)]);
      if (sc.win_bonus)        rows.push(['Win bonus', '+' + sc.win_bonus.toFixed(1)]);
      if (sc.title_bonus)      rows.push(['Title bonus', '+' + sc.title_bonus.toFixed(1)]);
      if (sc.ranked_opp_bonus) rows.push(['Ranked opp', '+' + sc.ranked_opp_bonus.toFixed(1)]);
      if (sc.card_multiplier && sc.card_multiplier !== 1) rows.push(['Card multiplier', '×' + sc.card_multiplier]);
      rows.push(['Total', sc.total.toFixed(1)]);
    } else {
      var pr = projMap[fighterId];
      if (!pr || pr.projectedPoints == null) return '';
      title = 'Projection';
      rows.push(['Base (avg output)', Number(pr.basePts).toFixed(1)]);
      if (pr.winBonusPts)   rows.push(['Win bonus × p(win)', '+' + Number(pr.winBonusPts).toFixed(1)]);
      if (pr.rankBonusPts)  rows.push(['Ranked opp', '+' + Number(pr.rankBonusPts).toFixed(1)]);
      if (pr.titleBonusPts) rows.push(['Title bonus', '+' + Number(pr.titleBonusPts).toFixed(1)]);
      if (pr.multiplier && Number(pr.multiplier) !== 1) rows.push(['Card multiplier', '×' + pr.multiplier]);
      if (pr.pWinUsed != null) rows.push(['Win probability', Math.round(pr.pWinUsed * 100) + '%']);
      rows.push(['Projected', Number(pr.projectedPoints).toFixed(1)]);
    }
    var body = rows.map(function (r, i) {
      var last = i === rows.length - 1;
      return '<span class="hub-chip-tip__row' + (last ? ' hub-chip-tip__row--total' : '') + '">' +
        '<span>' + r[0] + '</span><span>' + r[1] + '</span></span>';
    }).join('');
    return '<span class="hub-chip-tip" aria-hidden="true">' +
      '<span class="hub-chip-tip__title">' + title + '</span>' + body + '</span>';
  }

  function renderCorner() {
    var el = document.getElementById('hubHeroCorner');
    if (!el) return;
    var memberId = ui.cornerMember || myMemberId;
    var isMe = memberId === myMemberId;

    // The label IS a dropdown: "My Corner" by default, or any rival's team —
    // scout anyone's starters without leaving the hero.
    var options = '<option value="' + escapeHtml(myMemberId) + '"' + (isMe ? ' selected' : '') + '>My Corner</option>';
    state.members
      .filter(function (m) { return m.id !== myMemberId; })
      .sort(function (a, b) { return String(a.team_name).localeCompare(String(b.team_name)); })
      .forEach(function (m) {
        options += '<option value="' + escapeHtml(m.id) + '"' + (m.id === memberId ? ' selected' : '') + '>' +
          escapeHtml(m.team_name) + '</option>';
      });
    var selectHtml =
      '<select class="hub-corner-select" id="hubCornerSelect" aria-label="Whose corner to show">' +
        options + '</select>';

    var theirs = state.starters.filter(function (s) { return s.league_member_id === memberId; });
    var body;
    var statsHtml = '';
    if (!theirs.length) {
      body = isMe
        ? '<a class="hub-corner-chip hub-corner-chip--cta" href="lineup.html?id=' + leagueId + '">Set your lineup →</a>'
        : '<span class="hub-corner-chip hub-corner-chip--cta">No starters set</span>';
    } else {
      var total = 0;
      var projTotal = 0;       // actual where decided, projection where pending
      var hasPending = false;
      var hasProj = false;     // at least one pending starter has a real projection
      var hasBanked = false;   // at least one starter has REAL points
      var chips = theirs.map(function (s) {
        var st = starterStatus(s.fighter_id);
        var fighter = state.fighters[s.fighter_id];
        if (st.pts != null) { total += st.pts; projTotal += st.pts; hasBanked = true; }
        else {
          hasPending = true;
          var pr = projMap[s.fighter_id];
          if (pr && pr.projectedPoints != null) { projTotal += Number(pr.projectedPoints); hasProj = true; }
        }
        var photo = fighter && fighter.photo_url
          ? '<img class="hub-corner-chip__photo" src="' + escapeHtml(fighter.photo_url) + '" alt="" loading="lazy" onerror="this.style.visibility=\'hidden\'">'
          : '<span class="hub-corner-chip__photo"></span>';
        var live = st.sub === 'IN THE OCTAGON';
        var ringMod = live ? ' hub-corner-chip--octagon' : (st.cls ? ' hub-corner-chip--' + st.cls : '');
        return (
          '<button type="button" class="hub-corner-chip' + ringMod + '" data-open-fighter="' + escapeHtml(s.fighter_id) + '">' + photo +
            '<span class="hub-corner-chip__text">' +
              '<span class="hub-corner-chip__name">' + escapeHtml(st.name) + '</span>' +
              '<span class="hub-corner-chip__sub' + (live ? ' hub-corner-chip__sub--live' : '') + '">' + escapeHtml(st.sub) + '</span>' +
            '</span>' +
            '<span class="hub-corner-chip__pts' + (st.cls ? ' hub-corner-chip__pts--' + st.cls : '') + '">' +
              (st.pts != null ? st.pts.toFixed(1) : '—') +
            '</span>' +
            chipTipHtml(s.fighter_id) +
          '</button>'
        );
      }).join('');
      // Projected total: decided fighters at their real points, pending ones
      // at their projection. Redundant once everything is decided, so it
      // only shows while at least one starter is still waiting to fight.
      var projChip = (hasPending && hasProj)
        ? '<span class="hub-corner-chip hub-corner-chip--total hub-corner-chip--proj">' +
            '<span class="hub-corner-chip__sub">Proj</span>' +
            '<span class="hub-corner-total-num hub-corner-total-num--proj">' + projTotal.toFixed(1) + '</span>' +
          '</span>'
        : '';
      // "Total 0.0" before anyone has fought is noise — the chip earns its
      // place the moment real points exist.
      var totalChip = hasBanked
        ? '<span class="hub-corner-chip hub-corner-chip--total">' +
            '<span class="hub-corner-chip__sub">Total</span>' +
            '<span class="hub-corner-total-num">' + total.toFixed(1) + '</span>' +
          '</span>'
        : '';
      // pre-lock nag when the viewer's own lineup is incomplete
      var warnChip = '';
      if (isMe && (currentPhase || computePhase()) === 'PREVIEW' &&
          typeof getStarterCountForEvent === 'function' && state.event) {
        var required = getStarterCountForEvent(state.event, state.league && state.league.scoring_config);
        if (theirs.length < required) {
          warnChip = '<a class="hub-corner-chip hub-corner-chip--warn" href="lineup.html?id=' + leagueId + '">' +
            theirs.length + '/' + required + ' set · Finish lineup →</a>';
        }
      }
      // Proj/Total render twice: in the header (visible on MOBILE, where the
      // chips stack vertically) and inline after the chips (visible on
      // DESKTOP, the classic row). CSS picks one per breakpoint.
      if (projChip || totalChip) statsHtml = '<span class="hub-corner-stats">' + projChip + totalChip + '</span>';
      var statsInline = (projChip || totalChip)
        ? '<span class="hub-corner-stats-inline">' + projChip + totalChip + '</span>' : '';
      body = '<span class="hub-corner-chips">' + chips + warnChip + statsInline + '</span>';
    }

    el.innerHTML = '<div class="hub-corner-head">' + selectHtml + statsHtml + '</div>' + body;
    var sel = document.getElementById('hubCornerSelect');
    if (sel) {
      // native selects size to their WIDEST option; shrink to the selected
      // one so the caret hugs the label text. Measure the real rendered
      // width (bold + uppercase + letter-spacing make ch-math undershoot).
      var fit = function () {
        var txt = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '';
        var probe = document.createElement('span');
        probe.textContent = txt;
        probe.style.cssText =
          'position:absolute;visibility:hidden;white-space:pre;' +
          'font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;';
        sel.parentNode.appendChild(probe);
        sel.style.width = (probe.offsetWidth + 26) + 'px';  // + caret & padding
        probe.remove();
      };
      fit();
      sel.addEventListener('change', function () {
        ui.cornerMember = sel.value === myMemberId ? null : sel.value;
        renderCorner();
      });
    }
  }

  function renderFeed(phase) {
    var el = document.getElementById('hubFeedSection');
    if (!el) return;
    var decided = store.runOrder(state).filter(function (f) { return f.outcome; });
    if (phase === 'PREVIEW' && !decided.length) {
      // pre-event: the night's shape, not an empty story box
      var html0 = '<p class="hub-section__label">The Night Ahead</p>';
      var lockMs = effectiveLockMs();
      if (lockMs != null && typeof formatEtDateTime === 'function') {
        html0 += '<div class="hub-feed-row"><span class="hub-feed-row__time">LOCK</span>' +
          '<span class="hub-feed-row__text">Lineups lock at first prelim · <b>' +
          escapeHtml(formatEtDateTime(new Date(lockMs))) + '</b></span></div>';
      }
      var n = store.fightCount(state);
      var mainEv = null;
      for (var fid in state.fights) {
        var ff = state.fights[fid];
        if (ff.card_position === 'main_event') { mainEv = ff; break; }
      }
      if (n > 0) {
        var line = n + ' fights on the card';
        if (mainEv) {
          var a = state.fighters[mainEv.fighter_a_id], b = state.fighters[mainEv.fighter_b_id];
          if (a && b) line += ' · Main event: <b>' + escapeHtml(a.name) + ' vs ' + escapeHtml(b.name) + '</b>';
        }
        html0 += '<div class="hub-feed-row"><span class="hub-feed-row__time">CARD</span>' +
          '<span class="hub-feed-row__text">' + line + '</span></div>';
      }
      html0 += '<div class="hub-feed-row"><span class="hub-feed-row__time">LIVE</span>' +
        '<span class="hub-feed-row__text">Round-by-round results land here, fight by fight.</span></div>';
      el.innerHTML = html0;
      return;
    }
    var html = '<p class="hub-section__label">Round by Round</p>';
    var cfg = state.league && state.league.scoring_config;
    decided.slice().reverse().forEach(function (f) {
      var winner = state.fighters[f.winner_id];
      var loserId = f.winner_id === f.fighter_a_id ? f.fighter_b_id : f.fighter_a_id;
      var loser = state.fighters[loserId];
      var line = '<b>' + escapeHtml(winner ? winner.name : '?') + '</b> def. ' + escapeHtml(loser ? loser.name : '?') +
        ' · ' + escapeHtml(String(f.outcome).toUpperCase()) + (f.end_round ? ' R' + f.end_round : '');
      // fantasy implications: who started the winner
      var beneficiaries = state.starters.filter(function (s) { return s.fighter_id === f.winner_id; });
      if (beneficiaries.length && winner) {
        var pts = Scoring.computeFighterScore(f, f.winner_id === f.fighter_a_id, cfg).total;
        var names = beneficiaries.map(function (s) {
          var m = state.members.find(function (mm) { return mm.id === s.league_member_id; });
          return m ? m.team_name : '?';
        });
        line += ' · +' + pts.toFixed(1) + ' to <b>' + escapeHtml(names.join(', ')) + '</b>';
      }
      html += '<div class="hub-feed-row"><span class="hub-feed-row__time">FINAL</span><span class="hub-feed-row__text">' + line + '</span></div>';
    });
    if (phase !== 'PREVIEW') {
      html += '<div class="hub-feed-row"><span class="hub-feed-row__time">LOCK</span><span class="hub-feed-row__text">Lineups locked at first prelim.</span></div>';
    }
    el.innerHTML = html;
  }

  function renderMyBar() {
    var el = document.getElementById('hubMyBar');
    if (!el) return;
    var phase = currentPhase || computePhase();
    if (phase === 'PREVIEW') {
      // "0.0 pts · 1st" is noise before anyone can score — show the night's
      // projection and lineup readiness instead.
      var mine0 = state.starters.filter(function (s) { return s.league_member_id === myMemberId; });
      var projSum = 0;
      mine0.forEach(function (s) {
        var pr = projMap[s.fighter_id];
        if (pr && pr.projectedPoints != null) projSum += Number(pr.projectedPoints);
      });
      var required0 = (typeof getStarterCountForEvent === 'function' && state.event)
        ? getStarterCountForEvent(state.event, state.league && state.league.scoring_config) : 3;
      el.innerHTML =
        '<span class="hub-mybar__label">You</span>' +
        '<span class="hub-mybar__pts">' + (projSum > 0 ? 'Proj ' + projSum.toFixed(1) : '—') + '</span>' +
        '<span class="hub-mybar__rank">' + mine0.length + '/' + required0 + ' set</span>';
      prevMyBarPts = null;
      updateDocTitle(null);
      return;
    }
    var rows = store.raceRows(state, 'event');
    var mine = rows.find(function (r) { return r.member.id === myMemberId; });
    if (!mine) { el.innerHTML = ''; return; }
    el.innerHTML =
      '<span class="hub-mybar__label">You</span>' +
      '<span class="hub-mybar__pts">' + mine.eventPts.toFixed(1) + ' pts</span>' +
      '<span class="hub-mybar__rank">' + ordinal(mine.rank) + '</span>';
    // tween the sticky bar's number when it moves
    var ptsEl = el.querySelector('.hub-mybar__pts');
    if (!REDUCED_MOTION && ptsEl && prevMyBarPts != null && Math.abs(prevMyBarPts - mine.eventPts) > 0.05) {
      tweenNumber(ptsEl, prevMyBarPts, mine.eventPts, ' pts');
    }
    prevMyBarPts = mine.eventPts;
    updateDocTitle(mine);
  }

  // The browser tab as a scoreboard: "2nd · 71.0 — UFC 330" while LIVE.
  function updateDocTitle(mine) {
    var phase = currentPhase;
    var evName = state.event && (state.event.name || state.event.full_name) || '';
    if (phase === 'LIVE' && mine) {
      document.title = ordinal(mine.rank) + ' · ' + mine.eventPts.toFixed(1) + ' — ' + evName;
    } else if (phase === 'FINAL' && mine) {
      document.title = 'Final ' + ordinal(mine.rank) + ' — ' + evName;
    } else if (state.league) {
      document.title = 'Fight Night - ' + state.league.name;
    }
  }

  // rAF count-up for a numeric textContent (suffix preserved).
  function tweenNumber(el, from, to, suffix) {
    var t0 = performance.now(), dur = 650;
    function frame(t) {
      var p = Math.min(1, (t - t0) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = (from + (to - from) * eased).toFixed(1) + (suffix || '');
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function renderTabs() {
    var el = document.getElementById('hubTabs');
    if (!el) return;
    document.body.setAttribute('data-hub-tab', ui.mobileTab);
    el.innerHTML = ['card', 'race', 'feed'].map(function (t) {
      var label = t === 'card' ? 'Card' : t === 'race' ? 'Race' : 'Feed';
      return '<button type="button" class="hub-tabs__btn' + (ui.mobileTab === t ? ' hub-tabs__btn--active' : '') + '" data-hub-tab-btn="' + t + '" aria-pressed="' + (ui.mobileTab === t) + '">' + label + '</button>';
    }).join('');
    el.querySelectorAll('[data-hub-tab-btn]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        ui.mobileTab = btn.getAttribute('data-hub-tab-btn');
        renderTabs();
      });
    });
  }

  init();
})();
