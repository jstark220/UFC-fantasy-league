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

// ========================================================================
// INIT
// ========================================================================
async function initChat() {
  const user = await requireAuth();
  if (!user) return;

  const params = new URLSearchParams(window.location.search);
  leagueId = params.get('id');
  if (!leagueId) {
    window.location.href = 'dashboard.html';
    return;
  }

  document.getElementById('leagueBackLink').href = 'league.html?id=' + leagueId;

  const [leagueRes, membersRes] = await Promise.all([
    supabaseClient.from('leagues').select('id, name').eq('id', leagueId).single(),
    supabaseClient.from('league_members')
      .select('id, user_id, team_name, chat_last_seen_at, dm_last_seen_at')
      .eq('league_id', leagueId)
  ]);

  if (leagueRes.error || !leagueRes.data) {
    window.location.href = 'dashboard.html';
    return;
  }

  const league  = leagueRes.data;
  const members = membersRes.data || [];

  myMember = members.find(function(m) { return m.user_id === user.id; });
  if (!myMember) { window.location.href = 'dashboard.html'; return; }

  members.forEach(function(m) { memberMap[m.id] = m; });
  otherMembers = members
    .filter(function(m) { return m.id !== myMember.id; })
    .sort(function(a, b) { return (a.team_name || '').localeCompare(b.team_name || ''); });

  document.title = league.name + ' Chat - Knockdown Fantasy';
  document.getElementById('leagueName').textContent = league.name + ' — Chat';

  // Decide initial active thread from the URL — default group.
  const threadParam = params.get('thread');
  if (threadParam && threadParam !== 'group' && memberMap[threadParam]) {
    activeThread = { kind: 'dm', otherMemberId: threadParam };
  }

  // Reveal the page now that we know the user can see it
  document.getElementById('pageContent').style.display = '';

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
}

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

  const [groupRes, ...dmResults] = await Promise.all([groupPromise].concat(dmPromises));

  threadCache['group'] = (groupRes.data || []).slice().reverse();

  otherMembers.forEach(function(other, idx) {
    const res = dmResults[idx];
    threadCache['dm:' + other.id] = (res && res.data ? res.data : []).slice().reverse();
  });
}

// ========================================================================
// REALTIME
// Subscribe to all INSERTs on league_messages for this league. RLS will
// only deliver group messages + DMs the user is a party to, so we don't
// have to filter again here. But we DO need to route the new row into the
// right thread cache.
// ========================================================================
function subscribeRealtime() {
  realtimeChannel = supabaseClient
    .channel('league_chat_' + leagueId)
    .on('postgres_changes', {
      event:  'INSERT',
      schema: 'public',
      table:  'league_messages',
      filter: 'league_id=eq.' + leagueId
    }, function(payload) {
      handleIncomingMessage(payload.new);
    })
    .subscribe();
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
  const el = document.getElementById('chatSidebar');

  // ----- League Chat row -----
  const groupCache = threadCache['group'] || [];
  const groupUnread = countUnread(groupCache, myMember.chat_last_seen_at);
  const groupLast   = groupCache.length > 0 ? groupCache[groupCache.length - 1] : null;
  const groupActive = activeThread.kind === 'group';

  let html = '<div class="chat-sidebar__section">';
  html += '<div class="chat-sidebar__section-label">Channels</div>';
  html += renderThreadRow({
    key:      'group',
    name:     'League Chat',
    sub:      groupCache.length === 0 ? 'No messages yet' : truncate(groupLast.body, 32),
    when:     groupLast ? formatTimeShort(groupLast.created_at) : '',
    unread:   groupUnread,
    active:   groupActive
  });
  html += '</div>';

  // ----- Direct messages -----
  if (otherMembers.length > 0) {
    html += '<div class="chat-sidebar__section">';
    html += '<div class="chat-sidebar__section-label">Direct Messages</div>';

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

  // Reflect in the URL so refresh keeps the same thread open
  const url = new URL(window.location);
  url.searchParams.set('thread', activeThread.kind === 'group' ? 'group' : activeThread.otherMemberId);
  history.replaceState(null, '', url);

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
  const titleEl = document.getElementById('chatHeaderTitle');
  const subEl   = document.getElementById('chatHeaderSub');
  if (activeThread.kind === 'group') {
    titleEl.textContent = 'League Chat';
    subEl.textContent   = otherMembers.length + 1 + ' managers';
  } else {
    const other = memberMap[activeThread.otherMemberId];
    titleEl.textContent = other ? other.team_name : 'Direct Message';
    subEl.textContent   = 'Direct message';
  }

  // Composer placeholder
  const inputEl = document.getElementById('chatInput');
  if (activeThread.kind === 'group') {
    inputEl.placeholder = 'Send a message to the league...';
  } else {
    const other = memberMap[activeThread.otherMemberId];
    inputEl.placeholder = 'Message ' + (other ? other.team_name : 'manager') + '...';
  }

  // Message list
  const cache = threadCache[activeThreadKey()] || [];
  const el = document.getElementById('chatMessages');

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
    html += renderMessage(m);
  });

  el.innerHTML = html;
}

function appendMessage(row) {
  const el = document.getElementById('chatMessages');

  if (el.querySelector('.chat-state')) el.innerHTML = '';

  const lastDayDivider = el.querySelector('.chat-divider:last-of-type');
  const newDay = dayKeyFor(row.created_at);
  const lastDay = lastDayDivider ? lastDayDivider.getAttribute('data-day') : null;

  if (lastDay !== newDay) {
    el.insertAdjacentHTML('beforeend',
      '<div class="chat-divider" data-day="' + escapeHtml(newDay) + '">' +
        escapeHtml(dayLabel(row.created_at)) +
      '</div>'
    );
  }

  el.insertAdjacentHTML('beforeend', renderMessage(row));
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

// ========================================================================
// SEND
// ========================================================================
function wireComposer() {
  const form  = document.getElementById('chatForm');
  const input = document.getElementById('chatInput');
  const btn   = document.getElementById('chatSendBtn');

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
    const t = new Date(cache[i].created_at).getTime();
    if (t <= cutoff) break;
    // Don't count messages I sent myself as unread
    if (cache[i].member_id !== myMember.id) count++;
  }
  return count;
}

function isPinnedToBottom() {
  const el = document.getElementById('chatMessages');
  if (!el) return true;
  return (el.scrollHeight - el.clientHeight - el.scrollTop) < 80;
}

function scrollToBottom() {
  const el = document.getElementById('chatMessages');
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

initChat();
