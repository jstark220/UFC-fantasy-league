// ========================================================================
// CREATE LEAGUE PAGE LOGIC
// Generates an invite code, validates the form, and creates a new league
// plus the commissioner's league_members row in one flow.
// Depends on supabaseClient (supabase-config.js) and requireAuth (auth-guard.js).
// ========================================================================

// ========================================================================
// INVITE CODE GENERATOR
// Produces a 6-character uppercase alphanumeric code.
// Excludes 0/O and 1/I to avoid verbal ambiguity when sharing the code.
// ========================================================================
function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    // Math.random() gives a float 0-1; multiply by charset length and floor it
    // to get a random index into the characters string
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ========================================================================
// HELPER: SHOW/HIDE MESSAGE BANNER
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

// ========================================================================
// PAGE INIT
// ========================================================================
async function initCreateLeague() {
  const user = await requireAuth();
  if (!user) return;

  // Generate the invite code and display it as soon as the page loads
  let inviteCode = generateInviteCode();
  document.getElementById('inviteCodeDisplay').textContent = inviteCode;

  // Copy button: writes the displayed code to the clipboard
  document.getElementById('copyBtn').addEventListener('click', function() {
    navigator.clipboard.writeText(inviteCode).then(function() {
      document.getElementById('copyBtn').textContent = 'Copied!';
      // Reset button label after 2 seconds
      setTimeout(function() {
        document.getElementById('copyBtn').textContent = 'Copy';
      }, 2000);
    });
  });

  // ---- Form submit ----
  document.getElementById('createForm').addEventListener('submit', async function(event) {
    event.preventDefault();
    hideMessage();

    const leagueName = document.getElementById('leagueName').value.trim();
    const format     = document.getElementById('format').value;
    const draftFmt   = document.getElementById('draftFormat').value;
    const startDate  = document.getElementById('startDate').value || null;
    const teamName   = document.getElementById('teamName').value.trim();
    const submitBtn  = document.getElementById('submitBtn');

    // ---- Client-side validation ----

    // Team name: 3-30 chars, letters/numbers/spaces only
    if (!/^[a-zA-Z0-9 ]{3,30}$/.test(teamName)) {
      showMessage('Team name must be 3-30 characters and contain only letters, numbers, and spaces.', 'error');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating...';

    try {
      // ---- Step 1: insert the league row ----
      // We pass .select('id') so Supabase returns the new row's id,
      // which we need for the league_members insert in step 2.
      // max_managers, roster_size, starters_per_event, scoring_config all
      // use their DB defaults (v1.2 values) so we don't need to pass them.
      let leagueId;
      let firstResult = await supabaseClient
        .from('leagues')
        .insert({
          name:              leagueName,
          commissioner_id:   user.id,
          invite_code:       inviteCode,
          format:            format,
          draft_format:      draftFmt,
          season_start_date: startDate
        })
        .select('id')
        .single();

      // If the invite code collides with an existing one (extremely rare),
      // generate a new code and retry once before giving up
      if (firstResult.error && firstResult.error.code === '23505') {
        inviteCode = generateInviteCode();
        document.getElementById('inviteCodeDisplay').textContent = inviteCode;

        let retryResult = await supabaseClient
          .from('leagues')
          .insert({
            name:              leagueName,
            commissioner_id:   user.id,
            invite_code:       inviteCode,
            format:            format,
            draft_format:      draftFmt,
            season_start_date: startDate
          })
          .select('id')
          .single();

        if (retryResult.error) throw retryResult.error;
        leagueId = retryResult.data.id;
      } else if (firstResult.error) {
        throw firstResult.error;
      } else {
        leagueId = firstResult.data.id;
      }

      // ---- Step 2: add the commissioner as the first league member ----
      // waiver_priority 1 = highest priority; subsequent joiners get incrementing values
      const { error: memberError } = await supabaseClient
        .from('league_members')
        .insert({
          league_id:       leagueId,
          user_id:         user.id,
          team_name:       teamName,
          waiver_priority: 1
        });

      if (memberError) throw memberError;

      // Both inserts succeeded - go to the league list
      window.location.href = 'my-leagues.html';

    } catch (err) {
      showMessage(err.message, 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create League';
    }
  });
}

initCreateLeague();
