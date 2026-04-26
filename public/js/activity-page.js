// ========================================================================
// ACTIVITY PAGE
// Standalone page that shows the full activity history for a league with
// kind filter chips. URL: activity.html?id=LEAGUE_UUID
//
// Most of the heavy lifting (data fetch, row rendering) is done by
// js/activity.js — this file just wires the URL param, page chrome, and
// the kind filter to LeagueActivity.renderFeed().
// ========================================================================

async function initActivityPage() {
  const user = await requireAuth();
  if (!user) return;

  const leagueId = new URLSearchParams(window.location.search).get('id');
  if (!leagueId) {
    window.location.href = 'dashboard.html';
    return;
  }

  // Confirm the user is a member of this league before loading anything.
  // RLS would block the query anyway, but a clear early redirect beats a
  // confusing empty state.
  const { data: membership, error: memErr } = await supabaseClient
    .from('league_members')
    .select('id')
    .eq('league_id', leagueId)
    .eq('user_id',   user.id)
    .maybeSingle();

  if (memErr || !membership) {
    window.location.href = 'dashboard.html';
    return;
  }

  // Pull the league name for the header
  const { data: league } = await supabaseClient
    .from('leagues')
    .select('name')
    .eq('id', leagueId)
    .single();

  if (league) document.getElementById('leagueName').textContent =
    league.name + ' — Activity';

  // Wire the back-to-league link
  document.getElementById('leagueLink').href = 'league.html?id=' + leagueId;

  // Reveal the page now that we know the user can be here
  document.getElementById('pageContent').style.display = '';

  // Initial load: everything
  var feedEl = document.getElementById('activityFeed');
  await LeagueActivity.renderFeed(feedEl, leagueId, { limit: 100 });

  // Filter chips — clicking "All" clears, clicking any other deselects
  // "All" and re-renders with only that chip's kinds.
  var chips = document.querySelectorAll('.activity-filter__chip');
  chips.forEach(function(chip) {
    chip.addEventListener('click', function() {
      // Toggle active state — single-select for v1
      chips.forEach(function(c) { c.classList.remove('activity-filter__chip--active'); });
      chip.classList.add('activity-filter__chip--active');

      var kindAttr = chip.getAttribute('data-kind');
      if (kindAttr === 'all') {
        LeagueActivity.renderFeed(feedEl, leagueId, { limit: 100 });
      } else {
        LeagueActivity.renderFeed(feedEl, leagueId, {
          limit: 100,
          kinds: kindAttr.split(',')
        });
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', initActivityPage);
