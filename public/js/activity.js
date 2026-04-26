// ========================================================================
// LEAGUE ACTIVITY FEED
// ========================================================================
// Two responsibilities, exposed on window.LeagueActivity:
//
//   1. logEvent(leagueId, kind, data, actorMemberId)
//      Fire-and-forget writer. Called from mutation paths (drops, claims,
//      trades, draft, score-push, etc.) right after the underlying DB
//      action succeeds. Errors are logged to console and swallowed —
//      we never want activity logging to break user-facing flows.
//
//   2. renderFeed(rootEl, leagueId, options)
//      Fetches the latest N events for a league and renders them as a
//      vertical list. Used by the embedded card on league.html and the
//      standalone activity.html page. Member name resolution joins the
//      league_members table at read time so renames propagate.
//
// Data convention: when writing events, denormalize fighter names into
// `data.*` strings so the feed is a true log of what happened at the
// time. If a fighter is renamed later, the historical entry stays
// faithful to the moment.
//
// Depends on: window.supabaseClient (supabase-config.js).
// ========================================================================

(function (root) {

  // -----------------------------------------------------------------------
  // Constants — kept narrow on purpose. v1 ships these; new kinds added
  // here when we wire new mutations into the feed.
  // -----------------------------------------------------------------------
  var KINDS = {
    DROP:             'drop',
    CLAIM_WON:        'claim_won',
    CLAIM_LOST:       'claim_lost',
    TRADE_PROPOSED:   'trade_proposed',
    TRADE_ACCEPTED:   'trade_accepted',
    TRADE_REJECTED:   'trade_rejected',
    MEMBER_JOINED:    'member_joined',
    MEMBER_PROMOTED:  'member_promoted',
    MEMBER_DEMOTED:   'member_demoted',
    DRAFT_PICK:       'draft_pick',
    EVENT_SCORED:     'event_scored'
  };

  // -----------------------------------------------------------------------
  // logEvent — best-effort write. Never throws; never returns a value the
  // caller is expected to check. Mutation paths use it as fire-and-forget:
  //
  //   await supabaseClient.from('roster_drops').insert(...);
  //   LeagueActivity.logEvent(leagueId, 'drop', { fighter_name, ... }, myMemberId);
  //
  // If RLS rejects the insert (e.g., the user isn't a member of this
  // league for some reason), we log to console and move on — no toast,
  // no rollback.
  // -----------------------------------------------------------------------
  function logEvent(leagueId, kind, data, actorMemberId) {
    if (!leagueId || !kind) return Promise.resolve();
    var row = {
      league_id:        leagueId,
      kind:             String(kind),
      data:             data || {},
      actor_member_id:  actorMemberId || null
    };
    // Use bare `supabaseClient` (not `root.supabaseClient`). Top-level
    // `const` declarations don't attach to window in a regular script,
    // so free reference is the only way to reach the shared client.
    return supabaseClient
      .from('league_events')
      .insert(row)
      .then(function(res) {
        if (res.error) console.warn('[activity] logEvent failed:', res.error.message, row);
      })
      .catch(function(err) {
        console.warn('[activity] logEvent threw:', err);
      });
  }

  // -----------------------------------------------------------------------
  // renderFeed — fetch + render the latest events for a league.
  //
  // options: { limit: 50, kinds: ['drop', 'trade_accepted'], emptyMessage }
  //   limit          : default 50, capped server-side via .limit()
  //   kinds          : optional filter, only events whose kind is in this
  //                    array are returned
  //   emptyMessage   : optional override for the empty-state copy
  // -----------------------------------------------------------------------
  async function renderFeed(rootEl, leagueId, options) {
    if (!rootEl) return;
    options = options || {};
    var limit = options.limit || 50;

    rootEl.classList.add('activity-feed');
    rootEl.innerHTML = '<p class="activity-feed__loading">Loading activity...</p>';

    // Build the base query — join league_members so we can render the
    // actor's current team name without a second round-trip.
    var query = supabaseClient
      .from('league_events')
      .select('id, kind, data, created_at, actor_member_id, league_members(team_name)')
      .eq('league_id', leagueId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (options.kinds && options.kinds.length > 0) {
      query = query.in('kind', options.kinds);
    }

    var res = await query;

    if (res.error) {
      rootEl.innerHTML = '<p class="activity-feed__error">Could not load activity. ' +
                         escapeHtml(res.error.message) + '</p>';
      return;
    }

    var events = res.data || [];

    if (events.length === 0) {
      var msg = options.emptyMessage ||
                'Nothing has happened yet. Drops, claims, and trades will show up here.';
      rootEl.innerHTML = '<p class="activity-feed__empty">' + escapeHtml(msg) + '</p>';
      return;
    }

    var html = '<ul class="activity-feed__list">';
    events.forEach(function(ev) {
      html += renderEventRow(ev);
    });
    html += '</ul>';

    rootEl.innerHTML = html;
  }

  // -----------------------------------------------------------------------
  // renderEventRow — one <li> for a single event. Builds the human
  // sentence from `data` based on `kind`. Falls back to a generic line
  // if a kind is unrecognized so future writers can't break the renderer.
  // -----------------------------------------------------------------------
  function renderEventRow(ev) {
    var when      = formatRelativeTime(ev.created_at);
    var actorName = (ev.league_members && ev.league_members.team_name) ||
                    ev.data.actor_team_name || 'Unknown manager';
    var d         = ev.data || {};

    var icon, headline;

    switch (ev.kind) {
      case KINDS.DROP:
        icon = 'arrow-down';
        var dropSource = d.source === 'auto'  ? ' (auto-drop)' :
                         d.source === 'claim' ? ' (replaced via claim)' : '';
        headline = '<strong>' + escapeHtml(actorName) + '</strong> dropped ' +
                   '<strong>' + escapeHtml(d.fighter_name || 'a fighter') + '</strong>' +
                   dropSource;
        break;

      case KINDS.CLAIM_WON:
        icon = 'check';
        headline = '<strong>' + escapeHtml(actorName) + '</strong> won a waiver claim for ' +
                   '<strong>' + escapeHtml(d.fighter_name || 'a fighter') + '</strong>';
        if (d.dropped_fighter_name) {
          headline += ', dropping ' + escapeHtml(d.dropped_fighter_name);
        }
        break;

      case KINDS.CLAIM_LOST:
        icon = 'x';
        headline = '<strong>' + escapeHtml(actorName) + '</strong>\'s claim for ' +
                   '<strong>' + escapeHtml(d.fighter_name || 'a fighter') + '</strong>' +
                   ' was passed over';
        if (d.won_by_team_name) {
          headline += ' — ' + escapeHtml(d.won_by_team_name) + ' had higher priority';
        }
        break;

      case KINDS.TRADE_PROPOSED:
        icon = 'arrows';
        headline = '<strong>' + escapeHtml(actorName) + '</strong> proposed a trade to ' +
                   '<strong>' + escapeHtml(d.recipient_team_name || 'another manager') + '</strong>';
        break;

      case KINDS.TRADE_ACCEPTED:
        icon = 'check';
        var tradeSummary = formatTradeSummary(d);
        headline = '<strong>' + escapeHtml(actorName) + '</strong> accepted a trade';
        if (tradeSummary) headline += ': ' + tradeSummary;
        break;

      case KINDS.TRADE_REJECTED:
        icon = 'x';
        headline = '<strong>' + escapeHtml(actorName) + '</strong> rejected a trade from ' +
                   '<strong>' + escapeHtml(d.proposer_team_name || 'another manager') + '</strong>';
        break;

      case KINDS.MEMBER_JOINED:
        icon = 'plus';
        headline = '<strong>' + escapeHtml(actorName) + '</strong> joined the league';
        break;

      case KINDS.MEMBER_PROMOTED:
        icon = 'star';
        headline = '<strong>' + escapeHtml(actorName) + '</strong> promoted ' +
                   '<strong>' + escapeHtml(d.target_team_name || 'a manager') + '</strong>' +
                   ' to co-commissioner';
        break;

      case KINDS.MEMBER_DEMOTED:
        icon = 'arrow-down';
        headline = '<strong>' + escapeHtml(actorName) + '</strong> removed co-commissioner from ' +
                   '<strong>' + escapeHtml(d.target_team_name || 'a manager') + '</strong>';
        break;

      case KINDS.DRAFT_PICK:
        icon = 'star';
        var roundStr = d.round != null ? 'R' + d.round : '';
        var pickStr  = d.pick_overall != null ? '#' + d.pick_overall : '';
        var pickInfo = [roundStr, pickStr].filter(Boolean).join(' · ');
        headline = '<strong>' + escapeHtml(actorName) + '</strong> drafted ' +
                   '<strong>' + escapeHtml(d.fighter_name || 'a fighter') + '</strong>';
        if (pickInfo) headline += ' <span class="activity-feed__meta">(' + pickInfo + ')</span>';
        break;

      case KINDS.EVENT_SCORED:
        icon = 'trophy';
        headline = 'Scores posted for <strong>' +
                   escapeHtml(d.event_name || 'an event') + '</strong>';
        break;

      default:
        // Unknown kind — render a minimal line so the feed never errors out
        icon = 'dot';
        headline = '<strong>' + escapeHtml(actorName) + '</strong> — ' +
                   escapeHtml(ev.kind);
    }

    return (
      '<li class="activity-feed__row activity-feed__row--' + icon + '">' +
        '<span class="activity-feed__icon" aria-hidden="true">' + iconSvg(icon) + '</span>' +
        '<div class="activity-feed__body">' +
          '<p class="activity-feed__headline">' + headline + '</p>' +
          '<p class="activity-feed__when">' + escapeHtml(when) + '</p>' +
        '</div>' +
      '</li>'
    );
  }

  // -----------------------------------------------------------------------
  // formatTradeSummary — turn the offered/requested arrays into a short
  // "X for Y" string. Both sides may have multiple fighters.
  // -----------------------------------------------------------------------
  function formatTradeSummary(d) {
    var offered   = (d.offered_fighter_names || []).filter(Boolean);
    var requested = (d.requested_fighter_names || []).filter(Boolean);
    if (offered.length === 0 && requested.length === 0) return '';
    var leftStr  = offered.length   ? offered.join(', ')   : '(nothing)';
    var rightStr = requested.length ? requested.join(', ') : '(nothing)';
    return escapeHtml(leftStr) + ' for ' + escapeHtml(rightStr);
  }

  // -----------------------------------------------------------------------
  // formatRelativeTime — "3m ago", "2h ago", "yesterday", "Apr 18".
  // Keeps the feed scan-able without a date column.
  // -----------------------------------------------------------------------
  function formatRelativeTime(iso) {
    if (!iso) return '';
    var then = new Date(iso);
    var now  = new Date();
    var sec  = Math.max(0, Math.floor((now - then) / 1000));
    if (sec < 60)        return sec + 's ago';
    var min = Math.floor(sec / 60);
    if (min < 60)        return min + 'm ago';
    var hr = Math.floor(min / 60);
    if (hr < 24)         return hr + 'h ago';
    var day = Math.floor(hr / 24);
    if (day === 1)       return 'yesterday';
    if (day < 7)         return day + 'd ago';
    // Older than a week: absolute month/day, year if not this year
    var sameYear = then.getFullYear() === now.getFullYear();
    var opts = sameYear
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' };
    return then.toLocaleDateString('en-US', opts);
  }

  // -----------------------------------------------------------------------
  // iconSvg — minimal inline icons. Inline so we don't need a sprite file
  // or external icon font. Each is monochrome and uses currentColor.
  // -----------------------------------------------------------------------
  function iconSvg(name) {
    var paths = {
      'arrow-down': '<path d="M8 3v9m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
      'check':      '<path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
      'x':          '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
      'arrows':     '<path d="M3 6h8m0 0L8 3m3 3L8 9M13 10H5m0 0l3-3m-3 3l3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
      'plus':       '<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>',
      'star':       '<path d="M8 2l1.8 3.7 4.1.6-3 2.9.7 4.1L8 11.4 4.4 13.3l.7-4.1-3-2.9 4.1-.6L8 2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/>',
      'trophy':     '<path d="M5 3h6v3a3 3 0 01-6 0V3zM5 4H3v1a2 2 0 002 2M11 4h2v1a2 2 0 01-2 2M6 11h4v2H6z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
      'dot':        '<circle cx="8" cy="8" r="2" fill="currentColor"/>'
    };
    var inner = paths[name] || paths.dot;
    return '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' + inner + '</svg>';
  }

  // -----------------------------------------------------------------------
  // escapeHtml — local copy so this module has no dependencies on whatever
  // page-level escapeHtml might or might not be defined.
  // -----------------------------------------------------------------------
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    var div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  root.LeagueActivity = {
    KINDS:       KINDS,
    logEvent:    logEvent,
    renderFeed:  renderFeed
  };

}(typeof self !== 'undefined' ? self : this));
