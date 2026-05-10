// ========================================================================
// CHAT UNREAD BADGE
// ========================================================================
// The popup widget (chat-widget.js) owns the chat affordance — a permanent
// crimson bar pinned bottom-right of every league-context page. This
// script's only remaining job is to populate that bar's unread count
// (#chatPopupBadge) on page load. Best-effort: any error leaves the badge
// hidden and the popup keeps working.
//
// Skips itself on chat.html and on pages without a league id in the URL.
// ========================================================================

(function () {
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
    try {
      await refreshUnreadBadge(leagueId);
    } catch (err) {
      console.warn('[chat-nav] unread fetch failed:', err);
    }
  });

  // ----------------------------------------------------------------------
  // refreshUnreadBadge — sums (a) group messages I haven't seen and
  // (b) DMs to me I haven't seen on a per-thread basis. Caps at "9+" so
  // the badge stays visually compact.
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

    const badge = document.getElementById('chatPopupBadge');
    if (!badge) return;
    if (total === 0) { badge.hidden = true; return; }
    badge.textContent = total > 9 ? '9+' : String(total);
    badge.hidden = false;
  }
})();
