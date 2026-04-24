// ========================================================================
// LEAGUE SETTINGS PAGE LOGIC
// Loads league data for the current ?id= league, pre-fills the form, and
// lets the commissioner save changes. Non-commissioners see a read-only
// view of the same fields. Non-members are redirected to dashboard.html.
// Depends on supabaseClient (supabase-config.js) and requireAuth (auth-guard.js).
// ========================================================================

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function initSettings() {
  const user = await requireAuth();
  if (!user) return;

  const leagueId = new URLSearchParams(window.location.search).get('id');
  if (!leagueId) {
    window.location.href = 'dashboard.html';
    return;
  }

  // Wire the back link now that we have the ID
  document.getElementById('backToLeague').href = 'league.html?id=' + leagueId;

  // Fetch league row
  const { data: league, error: leagueError } = await supabaseClient
    .from('leagues')
    .select('id, name, format, draft_format, season_start_date, invite_code, commissioner_id, max_managers, roster_size, draft_started')
    .eq('id', leagueId)
    .single();

  if (leagueError || !league) {
    window.location.href = 'dashboard.html';
    return;
  }

  // Confirm this user is actually a member (RLS may not catch all cases)
  const { data: membership } = await supabaseClient
    .from('league_members')
    .select('id')
    .eq('league_id', leagueId)
    .eq('user_id', user.id)
    .single();

  if (!membership) {
    window.location.href = 'dashboard.html';
    return;
  }

  const isCommissioner = league.commissioner_id === user.id;

  document.getElementById('pageContent').style.display = 'block';
  document.title = league.name + ' Settings - Knockdown Fantasy';
  document.getElementById('leagueName').textContent = league.name;

  // Pre-fill form fields with current league values
  document.getElementById('inputName').value        = league.name;
  document.getElementById('inputFormat').value      = league.format || 'season';
  document.getElementById('inputDraftFormat').value = league.draft_format || 'snake';
  document.getElementById('inputMaxManagers').value = league.max_managers || 8;
  document.getElementById('inputRosterSize').value  = league.roster_size  || 20;

  if (league.season_start_date) {
    // Date input expects YYYY-MM-DD; Supabase returns it in that format already
    document.getElementById('inputStartDate').value = league.season_start_date.slice(0, 10);
  }

  // Lock draft-related fields once the draft has started
  if (league.draft_started) {
    document.getElementById('inputDraftFormat').disabled = true;
    document.getElementById('inputRosterSize').disabled  = true;
    document.getElementById('draftFormatHint').style.display = '';
    document.getElementById('rosterSizeHint').style.display  = '';
  }

  if (isCommissioner) {
    // Show invite code
    document.getElementById('inviteSection').style.display = '';
    document.getElementById('inviteCodeDisplay').textContent = league.invite_code;

    document.getElementById('copyInviteBtn').addEventListener('click', function() {
      navigator.clipboard.writeText(league.invite_code).then(function() {
        document.getElementById('copyInviteBtn').textContent = 'Copied!';
        setTimeout(function() {
          document.getElementById('copyInviteBtn').textContent = 'Copy';
        }, 2000);
      });
    });

    // Show danger zone
    document.getElementById('dangerSection').style.display = '';

    document.getElementById('deleteLeagueBtn').addEventListener('click', async function() {
      if (!confirm('Delete ' + league.name + '? This cannot be undone.')) return;
      if (!confirm('Are you sure? All rosters, draft history, and scores will be lost.')) return;

      const btn = document.getElementById('deleteLeagueBtn');
      btn.disabled = true;
      btn.textContent = 'Deleting...';

      const { error } = await supabaseClient
        .from('leagues')
        .delete()
        .eq('id', leagueId);

      if (error) {
        showMessage('Error deleting league: ' + error.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Delete League';
        return;
      }

      window.location.href = 'dashboard.html';
    });

  } else {
    // Non-commissioner: make all inputs read-only and hide the save button
    ['inputName', 'inputFormat', 'inputDraftFormat', 'inputStartDate', 'inputMaxManagers', 'inputRosterSize'].forEach(function(id) {
      document.getElementById(id).disabled = true;
    });
    document.getElementById('saveSection').style.display = 'none';
    document.getElementById('memberNote').style.display  = '';
  }

  // Save handler (commissioner only — button is hidden for members)
  document.getElementById('settingsForm').addEventListener('submit', async function(e) {
    e.preventDefault();

    const btn = document.getElementById('saveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    const updates = {
      name:              document.getElementById('inputName').value.trim(),
      format:            document.getElementById('inputFormat').value,
      season_start_date: document.getElementById('inputStartDate').value || null,
      max_managers:      parseInt(document.getElementById('inputMaxManagers').value, 10),
    };

    // Only include draft-locked fields if the draft hasn't started yet
    if (!league.draft_started) {
      updates.draft_format = document.getElementById('inputDraftFormat').value;
      updates.roster_size  = parseInt(document.getElementById('inputRosterSize').value, 10);
    }

    const { error } = await supabaseClient
      .from('leagues')
      .update(updates)
      .eq('id', leagueId);

    if (error) {
      showMessage('Error saving settings: ' + error.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Save Changes';
      return;
    }

    // Reflect the new name in the header without a reload
    document.getElementById('leagueName').textContent = updates.name;
    document.title = updates.name + ' Settings - Knockdown Fantasy';

    btn.disabled = false;
    btn.textContent = 'Save Changes';
    showMessage('Settings saved.', 'success');
  });
}

function showMessage(text, type) {
  const el = document.getElementById('settingsMessage');
  el.textContent = text;
  el.className = 'settings-message settings-message--' + type;
  el.style.display = 'block';
  setTimeout(function() { el.style.display = 'none'; }, 4000);
}

initSettings();
