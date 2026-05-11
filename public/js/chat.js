// ========================================================================
// LEAGUE CHAT — group chat + 1-on-1 DMs
//
// URL: chat.html?id=LEAGUE_UUID[&thread=group|MEMBER_UUID]
//   * id     — required, the league
//   * thread — optional active thread:
//                "group" (default)        → league-wide chat
//                <member uuid>            → 1-on-1 DM with that member
//
// Schema: messages live in a single league_messages table.
//   recipient_id IS NULL     → group message
//   recipient_id IS NOT NULL → DM from member_id (sender) to recipient_id.
// RLS already enforces who can read what — we don't have to filter that
// client-side beyond picking the right query for the active thread.
//
// State flow:
//   initChat() loads members + recent messages for both group and every
//   DM thread the user is in (one query each, cheap for ≤8 managers).
//   That gives us per-thread unread counts and "last activity" timestamps
//   for sorting the sidebar.
//
//   Selecting a thread does NOT re-fetch from the network for that thread
//   if we already have its messages cached — we just swap the rendered
//   content. Realtime updates the cache live.
// ========================================================================

// IIFE wrapper — keeps chat.js's module state out of the global scope.
// Without this, top-level `let leagueId` (and the others below) would
// collide with other page scripts that also declare `let leagueId` at
// top level, throwing SyntaxError and blanking the page.
(function () {

// ---------- Module state ----------
let leagueId      = null;
let myMember      = null;       // { id, user_id, team_name, dm_last_seen_at, chat_last_seen_at }
let memberMap     = {};         // member_id -> league_members row
let otherMembers  = [];         // every league member except me, sorted by team_name

// activeThread shape:
//   { kind: 'group' }
//   { kind: 'dm', otherMemberId: <uuid> }
let activeThread  = { kind: 'group' };

// Per-thread message caches, populated on init and kept fresh by realtime.
//   threadCache['group']         → [messages...] (oldest -> newest)
//   threadCache['dm:<memberId>'] → [messages...] for that 1-on-1 thread
let threadCache   = {};

let realtimeChannel = null;

// League activity events that surface inside the group chat thread (not DMs).
// Keep narrow on purpose — the activity.html feed is the full firehose; the
// in-chat view is just the highlights worth interrupting conversation for.
// Add new kinds here when you want them to appear in chat.
const CHAT_EVENT_KINDS = ['drop', 'claim_won', 'trade_accepted'];

// ---- DOM scoping ----
// rootEl scopes all chat-internal DOM lookups so the same code can drive
// chat.html (rootEl = document) or a popup widget injected anywhere on
// another page (rootEl = the popup container). Page-chrome lookups
// (leagueBackLink, leagueName, pageContent) stay on document — those are
// chat.html-specific and the widget callers don't pass them.
let rootEl  = null;
let syncUrl = false;  // when true, switchThread mirrors the active thread into ?thread=

function $$(sel) {
  return rootEl ? rootEl.querySelector(sel) : document.querySelector(sel);
}

// ========================================================================
// INIT
// Three entry points:
//   * initChat()                    — chat.html standalone page (auto-runs at bottom of file)
//   * initChatWidget(leagueId, container)
//                                   — popup widget on any page (called by chat-widget.js)
//   * initChatCore(opts)            — shared loader; both entry points call this
// ========================================================================

async function initChatCore(opts) {
  const user = await requireAuth();
  if (!user) return false;

  if (!opts.leagueId) {
    if (opts.onAbort) opts.onAbort('missing-league');
    return false;
  }

  leagueId = opts.leagueId;
  rootEl   = opts.rootEl   || null;
  syncUrl  = !!opts.syncUrl;

  const [leagueRes, membersRes] = await Promise.all([
    supabaseClient.from('leagues').select('id, name').eq('id', leagueId).single(),
    supabaseClient.from('league_members')
      .select('id, user_id, team_name, chat_last_seen_at, dm_last_seen_at')
      .eq('league_id', leagueId)
  ]);

  if (leagueRes.error || !leagueRes.data) {
    if (opts.onAbort) opts.onAbort('league-load-failed');
    return false;
  }

  const league  = leagueRes.data;
  const members = membersRes.data || [];

  myMember = members.find(function(m) { return m.user_id === user.id; });
  if (!myMember) {
    if (opts.onAbort) opts.onAbort('not-a-member');
    return false;
  }

  memberMap = {};
  members.forEach(function(m) { memberMap[m.id] = m; });
  otherMembers = members
    .filter(function(m) { return m.id !== myMember.id; })
    .sort(function(a, b) { return (a.team_name || '').localeCompare(b.team_name || ''); });

  if (opts.onLeagueLoaded) opts.onLeagueLoaded(league);

  // Resolve initial active thread. The page entry point passes a URL param;
  // the widget passes a value from localStorage.
  if (opts.initialThread && opts.initialThread !== 'group' && memberMap[opts.initialThread]) {
    activeThread = { kind: 'dm', otherMemberId: opts.initialThread };
  } else {
    activeThread = { kind: 'group' };
  }

  wireComposer();

  // Initial load — fetch group + every DM thread in parallel. Each query
  // returns at most 100 messages. For 8 managers max that's at most
  // 8 round trips, all parallel. Could be optimized with a single query
  // OR'ing the thread predicates, but at this scale it's fine.
  await loadAllThreads();

  renderSidebar();
  renderActiveThread();
  scrollToBottom();

  subscribeRealtime();

  // Mark active thread as seen — clears its unread badge.
  await markActiveThreadSeen();

  document.addEventListener('visibilitychange', function() {
    if (!document.hidden) markActiveThreadSeen();
  });

  return true;
}

// Entry point for chat.html — reads URL params, sets page chrome.
async function initChat() {
  const params = new URLSearchParams(window.location.search);
  const lid = params.get('id');
  if (!lid) { window.location.href = 'dashboard.html'; return; }

  document.getElementById('leagueBackLink').href = 'league.html?id=' + lid;

  await initChatCore({
    leagueId:      lid,
    rootEl:        null,                      // global doc lookups
    syncUrl:       true,
    initialThread: params.get('thread'),
    onAbort:       function() { window.location.href = 'dashboard.html'; },
    onLeagueLoaded: function(league) {
      document.title = league.name + ' Chat - Knockdown Fantasy';
      document.getElementById('leagueName').textContent = league.name + ' — Chat';
      document.getElementById('pageContent').style.display = '';
    }
  });
}

// Entry point for the popup widget — invoked by chat-widget.js after it
// has injected the chat DOM into a container element. No page chrome is
// touched. Returns the same boolean as initChatCore so the caller can
// react to load failures (e.g., display an error in the popup).
async function initChatWidget(leagueId, container, opts) {
  opts = opts || {};
  return await initChatCore({
    leagueId:      leagueId,
    rootEl:        container,
    syncUrl:       false,
    initialThread: opts.initialThread || null,
    onAbort:       opts.onAbort || null
  });
}

// Expose the widget entry point so chat-widget.js can call it.
window.initChatWidget = initChatWidget;

// ========================================================================
// LOAD ALL THREADS — initial fetch
// ========================================================================
async function loadAllThreads() {
  // Group chat
  const groupPromise = supabaseClient
    .from('league_messages')
    .select('id, member_id, recipient_id, body, created_at')
    .eq('league_id', leagueId)
    .is('recipient_id', null)
    .order('created_at', { ascending: false })
    .limit(100);

  // Recent league activity that surfaces in group chat (drops/claims/trades).
  // Cap matches the message limit so the chat stays balanced — events don't
  // crowd out actual conversation.
  const eventsPromise = supabaseClient
    .from('league_events')
    .select('id, kind, data, actor_member_id, created_at')
    .eq('league_id', leagueId)
    .in('kind', CHAT_EVENT_KINDS)
    .order('created_at', { ascending: false })
    .limit(100);

  // Each DM thread — ALL messages where (member_id=me AND recipient=other)
  // OR (member_id=other AND recipient=me). We can do this in one query per
  // pair using `or()` syntax.
  const dmPromises = otherMembers.map(function(other) {
    return supabaseClient
      .from('league_messages')
      .select('id, member_id, recipient_id, body, created_at')
      .eq('league_id', leagueId)
      .or(
        '(and(member_id.eq.' + myMember.id + ',recipient_id.eq.' + other.id + ')),' +
        '(and(member_id.eq.' + other.id    + ',recipient_id.eq.' + myMember.id + '))'
      )
      .order('created_at', { ascending: false })
      .limit(100);
  });

  const [groupRes, eventsRes, ...dmResults] = await Promise.all(
    [groupPromise, eventsPromise].concat(dmPromises)
  );

  // Merge group messages + events into a single time-ordered cache. Events
  // are tagged with _kind = 'event' so the renderer can dispatch styling.
  const groupMsgs = (groupRes.data || []).slice();
  const events    = (eventsRes.data || []).map(function(ev) {
    return Object.assign({ _kind: 'event' }, ev);
  });
  const merged    = groupMsgs.concat(events).sort(function(a, b) {
    return new Date(a.created_at) - new Date(b.created_at);
  });
  threadCache['group'] = merged;

  otherMembers.forEach(function(other, idx) {
    const res = dmResults[idx];
    threadCache['dm:' + other.id] = (res && res.data ? res.data : []).slice().reverse();
  });
}

// ========================================================================
// REALTIME
// Two separate channels — one for chat messages, one for activity events.
// Splitting by table is more reliable than chaining multiple .on() calls
// on a single channel; in practice Supabase has been known to drop one of
// the subscriptions when two tables share a channel. RLS handles
// visibility, so we just route incoming rows into the right cache.
// ========================================================================
function subscribeRealtime() {
  realtimeChannel = supabaseClient
    .channel('league_messages_' + leagueId)
    .on('postgres_changes', {
      event:  'INSERT',
      schema: 'public',
      table:  'league_messages',
      filter: 'league_id=eq.' + leagueId
    }, function(payload) {
      handleIncomingMessage(payload.new);
    })
    .subscribe();

  supabaseClient
    .channel('league_events_' + leagueId)
    .on('postgres_changes', {
      event:  'INSERT',
      schema: 'public',
      table:  'league_events',
      filter: 'league_id=eq.' + leagueId
    }, function(payload) {
      if (CHAT_EVENT_KINDS.indexOf(payload.new.kind) === -1) return;
      handleIncomingEvent(payload.new);
    })
    .subscribe();
}

// Activity events always belong to the group thread — they're league-wide
// announcements, not DMs. Renders inline alongside chat messages.
function handleIncomingEvent(row) {
  const cache = threadCache['group'] || (threadCache['group'] = []);
  if (cache.some(function(m) { return m._kind === 'event' && m.id === row.id; })) return;

  const tagged = Object.assign({ _kind: 'event' }, row);
  cache.push(tagged);

  if (activeThread.kind === 'group') {
    const wasAtBottom = isPinnedToBottom();
    appendItem(tagged);
    if (wasAtBottom) scrollToBottom();
  }

  renderSidebar();
}

function handleIncomingMessage(row) {
  const threadKey = threadKeyForMessage(row);
  if (!threadKey) return; // Not relevant to this user (shouldn't happen — RLS filters first)

  // Dedupe — possible if the user sent it themselves and we cached it
  // optimistically. We don't currently cache optimistically, but defensive.
  const cache = threadCache[threadKey] || (threadCache[threadKey] = []);
  if (cache.some(function(m) { return m.id === row.id; })) return;

  cache.push(row);

  // If this row belongs to the currently rendered thread, append it live.
  // Otherwise the sidebar gets a fresh unread count on the next render.
  if (threadKey === activeThreadKey()) {
    const wasAtBottom = isPinnedToBottom();
    appendMessage(row);
    if (wasAtBottom) scrollToBottom();
    if (!document.hidden) markActiveThreadSeen();
  }

  // Always re-render the sidebar so unread counts + "last activity" reflect.
  renderSidebar();
}

// Given a message row, return the thread cache key it belongs to, or null
// if it's somehow not relevant to this user. (Group → 'group';
// DM → 'dm:<the other party's id>'.)
function threadKeyForMessage(row) {
  if (!row.recipient_id) return 'group';
  if (row.member_id    === myMember.id) return 'dm:' + row.recipient_id;
  if (row.recipient_id === myMember.id) return 'dm:' + row.member_id;
  return null;
}

function activeThreadKey() {
  return activeThread.kind === 'group'
    ? 'group'
    : 'dm:' + activeThread.otherMemberId;
}

// ========================================================================
// SIDEBAR
// "League Chat" row at top + one row per other member for DMs. Each row
// shows team name, unread count badge, and a relative timestamp of the
// most recent message in that thread.
// ========================================================================
function renderSidebar() {
  const el = $$('#chatSidebar');
  if (!el) return;

  // ----- League Chat row -----
  const groupCache = threadCache['group'] || [];
  const groupUnread = countUnread(groupCache, myMember.chat_last_seen_at);
  const groupLast   = groupCache.length > 0 ? groupCache[groupCache.length - 1] : null;
  const groupActive = activeThread.kind === 'group';

  // Sub-line for the League Chat row — last message body OR the headline
  // of the latest activity event, whichever is most recent.
  let groupSub;
  if (!groupLast) {
    groupSub = 'No messages yet';
  } else if (groupLast._kind === 'event') {
    groupSub = truncate(formatChatEventPlain(groupLast), 32);
  } else {
    groupSub = truncate(groupLast.body, 32);
  }

  let html = '<div class="chat-sidebar__section">';
  html += '<div class="chat-sidebar__section-label">Channels</div>';
  html += renderThreadRow({
    key:      'group',
    name:     'League Chat',
    sub:      groupSub,
    when:     groupLast ? formatTimeShort(groupLast.created_at) : '',
    unread:   groupUnread,
    active:   groupActive
  });
  html += '</div>';

  // ----- Direct messages -----
  if (otherMembers.length > 0) {
    html += '<div class="chat-sidebar__section">';
    html += '<div class="chat-sidebar__section-label">' +
              '<span>Direct Messages</span>' +
              '<button class="chat-new-dm-btn" id="newDmBtn" type="button" aria-label="New direct message">+ New</button>' +
            '</div>';

    // Sort DM threads by most recent activity desc; threads with no
    // messages fall to the bottom in alpha order.
    const sortable = otherMembers.map(function(other) {
      const cache    = threadCache['dm:' + other.id] || [];
      const lastMsg  = cache.length > 0 ? cache[cache.length - 1] : null;
      const lastSeen = (myMember.dm_last_seen_at && myMember.dm_last_seen_at[other.id]) || null;
      const unread   = countUnread(cache, lastSeen);
      return {
        other:   other,
        cache:   cache,
        lastMsg: lastMsg,
        unread:  unread
      };
    }).sort(function(a, b) {
      const aTime = a.lastMsg ? new Date(a.lastMsg.created_at).getTime() : 0;
      const bTime = b.lastMsg ? new Date(b.lastMsg.created_at).getTime() : 0;
      if (aTime !== bTime) return bTime - aTime;
      return (a.other.team_name || '').localeCompare(b.other.team_name || '');
    });

    sortable.forEach(function(t) {
      const isActive = activeThread.kind === 'dm' && activeThread.otherMemberId === t.other.id;
      html += renderThreadRow({
        key:    'dm:' + t.other.id,
        name:   t.other.team_name,
        sub:    t.cache.length === 0 ? 'No messages yet' :
                ((t.lastMsg.member_id === myMember.id ? 'You: ' : '') + truncate(t.lastMsg.body, 28)),
        when:   t.lastMsg ? formatTimeShort(t.lastMsg.created_at) : '',
        unread: t.unread,
        active: isActive
      });
    });

    html += '</div>';
  }

  el.innerHTML = html;

  // Wire row clicks
  el.querySelectorAll('[data-thread-key]').forEach(function(row) {
    row.addEventListener('click', function() {
      switchThread(row.getAttribute('data-thread-key'));
    });
  });

  const newDmBtn = el.querySelector('#newDmBtn');
  if (newDmBtn) newDmBtn.addEventListener('click', showNewDmPicker);
}

// ========================================================================
// NEW DM PICKER
// Inline overlay that lets the user pick a manager to start a DM with.
// Lives inside the popup container (or .chat-page on standalone) so it
// scopes correctly when multiple chat surfaces could exist.
// ========================================================================
function showNewDmPicker() {
  // Container that the overlay positions against. We target the chat
  // content area (popup body or standalone chat page) — NOT the whole
  // popup — so the bar stays visible/clickable while the picker is up.
  const container = rootEl
    ? (rootEl.querySelector('.chat-popup__body') || rootEl)
    : (document.querySelector('.chat-page') || document.body);

  // Remove any existing picker so re-clicking the button doesn't stack
  const existing = container.querySelector('#chatNewDmPicker');
  if (existing) { existing.remove(); return; }

  const picker = document.createElement('div');
  picker.id = 'chatNewDmPicker';
  picker.className = 'chat-new-dm-picker';
  picker.setAttribute('role', 'dialog');
  picker.setAttribute('aria-modal', 'true');
  picker.setAttribute('aria-label', 'Start a new direct message');

  let listHtml = '';
  otherMembers.forEach(function(m) {
    const initials = (m.team_name || '?')
      .split(/\s+/).map(function(w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
    listHtml +=
      '<button class="chat-new-dm-picker__row" data-other-id="' + escapeHtml(m.id) + '" type="button">' +
        '<span class="chat-new-dm-picker__avatar" aria-hidden="true">' + escapeHtml(initials) + '</span>' +
        '<span class="chat-new-dm-picker__name">' + escapeHtml(m.team_name) + '</span>' +
      '</button>';
  });

  picker.innerHTML =
    '<div class="chat-new-dm-picker__panel">' +
      '<div class="chat-new-dm-picker__header">' +
        '<span class="chat-new-dm-picker__title">Start a new DM</span>' +
        '<button class="chat-new-dm-picker__close" type="button" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="chat-new-dm-picker__list">' + listHtml + '</div>' +
    '</div>';

  container.appendChild(picker);

  function close() {
    picker.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);

  picker.addEventListener('click', function(e) {
    if (e.target === picker) close(); // backdrop click
  });
  picker.querySelector('.chat-new-dm-picker__close').addEventListener('click', close);
  picker.querySelectorAll('[data-other-id]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const otherId = btn.getAttribute('data-other-id');
      close();
      switchThread('dm:' + otherId);
    });
  });
}

function renderThreadRow(opts) {
  return (
    '<button class="chat-thread' + (opts.active ? ' chat-thread--active' : '') + '" ' +
            'data-thread-key="' + escapeHtml(opts.key) + '" type="button">' +
      '<div class="chat-thread__main">' +
        '<span class="chat-thread__name">' + escapeHtml(opts.name) + '</span>' +
        '<span class="chat-thread__sub">'  + escapeHtml(opts.sub)  + '</span>' +
      '</div>' +
      '<div class="chat-thread__meta">' +
        (opts.when   ? '<span class="chat-thread__when">' + escapeHtml(opts.when) + '</span>' : '') +
        (opts.unread > 0
          ? '<span class="chat-thread__badge">' + (opts.unread > 9 ? '9+' : opts.unread) + '</span>'
          : '') +
      '</div>' +
    '</button>'
  );
}

// ========================================================================
// SWITCH THREAD
// ========================================================================
async function switchThread(threadKey) {
  if (threadKey === 'group') {
    activeThread = { kind: 'group' };
  } else if (threadKey.indexOf('dm:') === 0) {
    const memberId = threadKey.slice(3);
    if (!memberMap[memberId]) return;
    activeThread = { kind: 'dm', otherMemberId: memberId };
  } else {
    return;
  }

  // Reflect in the URL so refresh keeps the same thread open. Skipped in
  // widget mode — the popup persists its active thread via localStorage
  // and shouldn't pollute the host page's URL.
  if (syncUrl) {
    const url = new URL(window.location);
    url.searchParams.set('thread', activeThread.kind === 'group' ? 'group' : activeThread.otherMemberId);
    history.replaceState(null, '', url);
  }

  // Notify widget host (if any) so it can persist the active thread.
  if (typeof window.onChatThreadChange === 'function') {
    window.onChatThreadChange(activeThread.kind === 'group' ? 'group' : activeThread.otherMemberId);
  }

  renderSidebar();
  renderActiveThread();
  scrollToBottom();
  await markActiveThreadSeen();
}

// ========================================================================
// RENDER ACTIVE THREAD
// ========================================================================
function renderActiveThread() {
  // Header text
  const titleEl = $$('#chatHeaderTitle');
  const subEl   = $$('#chatHeaderSub');
  if (titleEl && subEl) {
    if (activeThread.kind === 'group') {
      titleEl.textContent = 'League Chat';
      subEl.textContent   = otherMembers.length + 1 + ' managers';
    } else {
      const other = memberMap[activeThread.otherMemberId];
      titleEl.textContent = other ? other.team_name : 'Direct Message';
      subEl.textContent   = 'Direct message';
    }
  }

  // Composer placeholder
  const inputEl = $$('#chatInput');
  if (inputEl) {
    if (activeThread.kind === 'group') {
      inputEl.placeholder = 'Send a message to the league...';
    } else {
      const other = memberMap[activeThread.otherMemberId];
      inputEl.placeholder = 'Message ' + (other ? other.team_name : 'manager') + '...';
    }
  }

  // Message list
  const cache = threadCache[activeThreadKey()] || [];
  const el = $$('#chatMessages');
  if (!el) return;

  if (cache.length === 0) {
    el.innerHTML = '<p class="chat-state">No messages yet. Start the conversation.</p>';
    return;
  }

  let html = '';
  let lastDate = null;
  cache.forEach(function(m) {
    const dayKey = dayKeyFor(m.created_at);
    if (dayKey !== lastDate) {
      html += '<div class="chat-divider" data-day="' + escapeHtml(dayKey) + '">' +
                escapeHtml(dayLabel(m.created_at)) +
              '</div>';
      lastDate = dayKey;
    }
    html += renderItem(m);
  });

  el.innerHTML = html;
}

function appendMessage(row) { appendItem(row); }

function appendItem(item) {
  const el = $$('#chatMessages');
  if (!el) return;

  if (el.querySelector('.chat-state')) el.innerHTML = '';

  const lastDayDivider = el.querySelector('.chat-divider:last-of-type');
  const newDay = dayKeyFor(item.created_at);
  const lastDay = lastDayDivider ? lastDayDivider.getAttribute('data-day') : null;

  if (lastDay !== newDay) {
    el.insertAdjacentHTML('beforeend',
      '<div class="chat-divider" data-day="' + escapeHtml(newDay) + '">' +
        escapeHtml(dayLabel(item.created_at)) +
      '</div>'
    );
  }

  el.insertAdjacentHTML('beforeend', renderItem(item));
}

// Dispatcher — items in the cache are either chat messages (default shape)
// or activity events (tagged with _kind='event' at load/realtime time).
function renderItem(item) {
  if (item && item._kind === 'event') return renderEvent(item);
  return renderMessage(item);
}

function renderMessage(m) {
  const member   = memberMap[m.member_id];
  const isMine   = member && member.id === myMember.id;
  const teamName = member ? member.team_name : 'Unknown';
  const initials = teamName.split(/\s+/).map(function(w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
  const time     = formatTimeShort(m.created_at);
  const safeBody = escapeHtml(m.body).replace(/\n/g, '<br>');

  return (
    '<div class="chat-message' + (isMine ? ' chat-message--mine' : '') + '">' +
      '<div class="chat-message__avatar" aria-hidden="true">' + escapeHtml(initials) + '</div>' +
      '<div class="chat-message__bubble">' +
        '<div class="chat-message__meta">' +
          '<span class="chat-message__name">' + escapeHtml(teamName) + '</span>' +
          '<span class="chat-message__time">' + escapeHtml(time)     + '</span>' +
        '</div>' +
        '<div class="chat-message__body">' + safeBody + '</div>' +
      '</div>' +
    '</div>'
  );
}

// Renders one activity event as a centered system notice. Distinct shape
// from chat-message so the eye treats it as an announcement, not someone
// talking. The headline already escapes its inputs.
function renderEvent(ev) {
  return (
    '<div class="chat-event">' +
      '<span class="chat-event__text">' + formatChatEventHtml(ev) + '</span>' +
      '<span class="chat-event__time">' + escapeHtml(formatTimeShort(ev.created_at)) + '</span>' +
    '</div>'
  );
}

// Compose the HTML headline for an event. Mirrors the wording in
// activity.js's renderEventRow but trimmed to chat tone (single sentence,
// no extra metadata). Returns escaped HTML — safe to drop into innerHTML.
function formatChatEventHtml(ev) {
  const actor = lookupActorName(ev.actor_member_id, ev.data);
  const d = ev.data || {};
  const a = '<strong>' + escapeHtml(actor) + '</strong>';

  switch (ev.kind) {
    case 'drop': {
      const tail = d.source === 'auto'  ? ' (auto-drop)'
                 : d.source === 'claim' ? ' (replaced via claim)'
                 : '';
      return a + ' dropped <strong>' + escapeHtml(d.fighter_name || 'a fighter') + '</strong>' + tail;
    }
    case 'claim_won': {
      let h = a + ' claimed <strong>' + escapeHtml(d.fighter_name || 'a fighter') + '</strong>';
      if (d.dropped_fighter_name) h += ', dropping ' + escapeHtml(d.dropped_fighter_name);
      return h;
    }
    case 'trade_accepted': {
      const offered   = (d.offered_fighter_names   || []).filter(Boolean);
      const requested = (d.requested_fighter_names || []).filter(Boolean);
      let h = a + ' accepted a trade';
      if (offered.length || requested.length) {
        const left  = offered.length   ? offered.join(', ')   : '(nothing)';
        const right = requested.length ? requested.join(', ') : '(nothing)';
        h += ': ' + escapeHtml(left) + ' for ' + escapeHtml(right);
      }
      return h;
    }
    default:
      return a + ' — ' + escapeHtml(ev.kind);
  }
}

// Plain-text version used by the sidebar's "last activity" preview.
function formatChatEventPlain(ev) {
  const actor = lookupActorName(ev.actor_member_id, ev.data);
  const d = ev.data || {};
  switch (ev.kind) {
    case 'drop':           return actor + ' dropped ' + (d.fighter_name || 'a fighter');
    case 'claim_won':      return actor + ' claimed ' + (d.fighter_name || 'a fighter');
    case 'trade_accepted': return actor + ' accepted a trade';
    default:               return actor + ' — ' + ev.kind;
  }
}

function lookupActorName(actorMemberId, data) {
  if (actorMemberId && memberMap[actorMemberId]) return memberMap[actorMemberId].team_name;
  if (data && data.actor_team_name) return data.actor_team_name;
  return 'Someone';
}

// ========================================================================
// SEND
// ========================================================================
function wireComposer() {
  const form  = $$('#chatForm');
  const input = $$('#chatInput');
  const btn   = $$('#chatSendBtn');
  if (!form || !input || !btn) return;

  input.addEventListener('input', function() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  });

  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', async function(e) {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;

    btn.disabled = true;
    const previous = btn.textContent;
    btn.textContent = 'Sending...';

    const insertRow = {
      league_id:    leagueId,
      member_id:    myMember.id,
      body:         body,
      // Null for group, the other member's id for a DM. RLS verifies
      // sender + recipient both belong to the league.
      recipient_id: activeThread.kind === 'dm' ? activeThread.otherMemberId : null
    };

    const { error } = await supabaseClient.from('league_messages').insert(insertRow);

    btn.disabled = false;
    btn.textContent = previous;

    if (error) { alert('Could not send: ' + error.message); return; }

    input.value = '';
    input.style.height = 'auto';
    input.focus();
  });
}

// ========================================================================
// MARK SEEN
// Group thread bumps chat_last_seen_at (existing column, used by the
// league-page badge). DM threads bump dm_last_seen_at[<other_member_id>].
// We update the local myMember copy too so the next sidebar render
// reflects the change without a refetch.
// ========================================================================
async function markActiveThreadSeen() {
  if (!myMember) return;
  const nowIso = new Date().toISOString();

  if (activeThread.kind === 'group') {
    myMember.chat_last_seen_at = nowIso;
    const { error } = await supabaseClient
      .from('league_members')
      .update({ chat_last_seen_at: nowIso })
      .eq('id', myMember.id);
    if (error) console.warn('[chat] markSeen group failed:', error.message);
  } else {
    // Merge into the JSONB map. We do the merge client-side and write
    // the whole object back — fine for ≤7 keys.
    const otherId = activeThread.otherMemberId;
    const map = Object.assign({}, myMember.dm_last_seen_at || {});
    map[otherId] = nowIso;
    myMember.dm_last_seen_at = map;
    const { error } = await supabaseClient
      .from('league_members')
      .update({ dm_last_seen_at: map })
      .eq('id', myMember.id);
    if (error) console.warn('[chat] markSeen dm failed:', error.message);
  }

  // Reflect in the sidebar (active row's badge clears).
  renderSidebar();
}

// ========================================================================
// HELPERS
// ========================================================================
function countUnread(cache, lastSeenIso) {
  if (!cache || cache.length === 0) return 0;
  const cutoff = lastSeenIso ? new Date(lastSeenIso).getTime() : 0;
  let count = 0;
  for (let i = cache.length - 1; i >= 0; i--) {
    const item = cache[i];
    const t = new Date(item.created_at).getTime();
    if (t <= cutoff) break;
    // Don't count my own messages or my own activity events as unread.
    // Events have actor_member_id; messages have member_id.
    const isMine = item.member_id === myMember.id ||
                   item.actor_member_id === myMember.id;
    if (!isMine) count++;
  }
  return count;
}

function isPinnedToBottom() {
  const el = $$('#chatMessages');
  if (!el) return true;
  return (el.scrollHeight - el.clientHeight - el.scrollTop) < 80;
}

function scrollToBottom() {
  const el = $$('#chatMessages');
  if (el) el.scrollTop = el.scrollHeight;
}

function truncate(str, n) {
  if (!str) return '';
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function dayKeyFor(iso) {
  return new Date(iso).toISOString().split('T')[0];
}

function dayLabel(iso) {
  const then = new Date(iso);
  const now  = new Date();
  const diffDays = Math.floor((stripTime(now) - stripTime(then)) / (24 * 3600 * 1000));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (then.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return then.toLocaleDateString('en-US', opts);
}

function stripTime(d) {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

function formatTimeShort(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

// Auto-init only on chat.html (where the chat DOM is present at page load).
// On other pages, chat.js is loaded as a dependency and chat-widget.js
// drives initialization via initChatWidget() when the popup opens.
if (document.getElementById('chatSidebar')) {
  initChat();
}

})();
