// ========================================================================
// CHAT NAV — global Chat link + unread badge
// ========================================================================
// Injects a "Chat" button into the top nav of every league-context page,
// auto-wiring its target URL and an unread-count badge that combines
// group messages and DMs.
//
// This script intentionally has no dependencies beyond what every
// authenticated page already loads:
//   * supabaseClient (from supabase-config.js)
//   * a top-nav with a .top-nav__links container in the DOM
//
// It does NOT depend on auth-guard.js completing first — it gracefully
// no-ops if there's no signed-in user yet. requireAuth() handles the
// actual redirect on each page.
//
// Skips itself on chat.html (already there) and any page without a
// ?id=<league_uuid> (or score-event's legacy ?league=) URL parameter.
// ========================================================================

(function () {
  // Don't inject on the chat page — it's the destination
  if (window.location.pathname.endsWith('/chat.html')) return;

  // Find a league id in the URL. score-event.html uses ?league= rather
  // than ?id= for historical reasons; tolerate both so this script
  // works there without per-page branching.
  const params = new URLSearchParams(window.location.search);
  const leagueId = params.get('id') || params.get('league');
  if (!leagueId) return;

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  ready(async function() {
    const linksEl = document.querySelector('.top-nav__links');
    if (!linksEl) return;

    // Build the link. Primary-styled so it reads as a CTA, but smaller
    // than the .btn-primary defaults via .top-nav__chat overrides.
    const link = document.createElement('a');
    link.href = 'chat.html?id=' + encodeURIComponent(leagueId);
    link.className = 'btn-primary top-nav__chat';
    link.innerHTML =
      'Chat' +
      '<span class="top-nav__chat-badge" id="topNavChatBadge" hidden></span>';

    // Insert at the START of the links container so it sits to the left
    // of the page's existing back-link / context links. That makes the
    // Chat affordance the leftmost thing the eye lands on after the logo.
    linksEl.insertBefore(link, linksEl.firstChild);

    // Populate the unread badge in the background. This is best-effort —
    // any error leaves the badge hidden and the link still works.
    try {
      await refreshUnreadBadge(leagueId);
    } catch (err) {
      console.warn('[chat-nav] unread fetch failed:', err);
    }
  });

  // ----------------------------------------------------------------------
  // refreshUnreadBadge — sums (a) group messages I haven't seen and
  // (b) DMs to me I haven't seen on a per-thread basis. Caps at "9+" so
  // the badge stays visually compact in a tight nav bar.
  // ----------------------------------------------------------------------
  async function refreshUnreadBadge(leagueId) {
    if (typeof supabaseClient === 'undefined') return;

    // Fetch my membership row to get my member id and the two last-seen
    // fields. If I'm not a member of this league, bail silently.
    const { data: userResp } = await supabaseClient.auth.getUser();
    const user = userResp && userResp.user;
    if (!user) return;

    const { data: member } = await supabaseClient
      .from('league_members')
      .select('id, chat_last_seen_at, dm_last_seen_at')
      .eq('league_id', leagueId)
      .eq('user_id',   user.id)
      .maybeSingle();
    if (!member) return;

    // Fire the two queries in parallel:
    //   1. Group unread count via a head-only count query (no payload).
    //   2. Per-thread DM rows so we can count using the JSONB last-seen map.
    const groupCutoff = member.chat_last_seen_at || '1970-01-01T00:00:00Z';
    const [groupRes, dmRes] = await Promise.all([
      supabaseClient
        .from('league_messages')
        .select('id', { count: 'exact', head: true })
        .eq('league_id', leagueId)
        .is('recipient_id', null)
        .gt('created_at', groupCutoff)
        .neq('member_id', member.id),
      supabaseClient
        .from('league_messages')
        .select('member_id, created_at')
        .eq('league_id', leagueId)
        .eq('recipient_id', member.id)
    ]);

    let total = (groupRes.count || 0);

    const dmSeen = member.dm_last_seen_at || {};
    (dmRes.data || []).forEach(function(m) {
      const cutoff = dmSeen[m.member_id] || '1970-01-01T00:00:00Z';
      if (new Date(m.created_at) > new Date(cutoff)) total++;
    });

    const badge = document.getElementById('topNavChatBadge');
    if (!badge) return;
    if (total === 0) { badge.hidden = true; return; }
    badge.textContent = total > 9 ? '9+' : String(total);
    badge.hidden = false;
  }
})();
