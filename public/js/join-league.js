// ========================================================================
// JOIN LEAGUE PAGE LOGIC
// Looks up a league by invite code, runs safety checks, then joins.
// Depends on supabaseClient (supabase-config.js) and requireAuth (auth-guard.js).
// ========================================================================

function showMessage(text, type) {
  const el = document.getElementById('message');
  el.textContent = text;
  el.className = 'message ' + type;
  el.style.display = 'block';
}

function hideMessage() {
  document.getElementById('message').style.display = 'none';
}

async function initJoinLeague() {
  const user = await requireAuth();
  if (!user) return;

  // Reveal the page now that auth is confirmed (template hides it by default
  // to avoid a flash of unauthenticated content)
  const pageContent = document.getElementById('pageContent');
  if (pageContent) pageContent.style.display = '';

  document.getElementById('joinForm').addEventListener('submit', async function(event) {
    event.preventDefault();
    hideMessage();

    const inviteCode = document.getElementById('inviteCode').value.trim().toUpperCase();
    const teamName   = document.getElementById('teamName').value.trim();
    const submitBtn  = document.getElementById('submitBtn');

    // ---- Client-side validation ----

    if (inviteCode.length !== 6) {
      showMessage('Invite code must be exactly 6 characters.', 'error');
      return;
    }

    if (!/^[a-zA-Z0-9 ]{3,30}$/.test(teamName)) {
      showMessage('Team name must be 3-30 characters and contain only letters, numbers, and spaces.', 'error');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Joining...';

    try {
      // ---- Check 1: does a league with this invite code exist? ----
      // .single() returns an error if 0 or 2+ rows match, so we know
      // exactly whether the code is valid
      const { data: league, error: leagueError } = await supabaseClient
        .from('leagues')
        .select('id, name, max_managers')
        .eq('invite_code', inviteCode)
        .single();

      if (leagueError || !league) {
        showMessage('No league found with that code. Check the code and try again.', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Join League';
        return;
      }

      // ---- Check 2: is the league already full? ----
      // count: 'exact' tells Supabase to return the row count in the response header
      const { count, error: countError } = await supabaseClient
        .from('league_members')
        .select('id', { count: 'exact', head: true })
        .eq('league_id', league.id);

      if (count >= league.max_managers) {
        showMessage('This league is full (' + count + '/' + league.max_managers + ' managers).', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Join League';
        return;
      }

      // ---- Check 3: is the user already a member? ----
      const { data: existing, error: existingError } = await supabaseClient
        .from('league_members')
        .select('id')
        .eq('league_id', league.id)
        .eq('user_id', user.id)
        .maybeSingle(); // maybeSingle() returns null (not an error) when no row found

      if (existing) {
        showMessage('You are already a member of this league.', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Join League';
        return;
      }

      // ---- All checks passed: join the league ----
      // waiver_priority = current member count + 1 so each joiner gets
      // a unique incrementing priority (last to join = lowest priority).
      // We .select() the new row so we can log the activity feed entry
      // with the new member's id before navigating away.
      const { data: newMember, error: joinError } = await supabaseClient
        .from('league_members')
        .insert({
          league_id:       league.id,
          user_id:         user.id,
          team_name:       teamName,
          waiver_priority: count + 1
        })
        .select('id')
        .single();

      if (joinError) throw joinError;

      // Activity feed: member_joined. Awaited (not fire-and-forget) so the
      // request lands before the redirect cancels in-flight requests. We
      // pass team_name in `data` for consistency, but the renderer prefers
      // joining league_members at read time so future renames propagate.
      if (typeof LeagueActivity !== 'undefined') {
        await LeagueActivity.logEvent(league.id, LeagueActivity.KINDS.MEMBER_JOINED, {
          team_name: teamName
        }, newMember.id);
      }

      // Joined successfully - go to the league list
      window.location.href = 'dashboard.html';

    } catch (err) {
      showMessage(err.message, 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Join League';
    }
  });
}

initJoinLeague();
