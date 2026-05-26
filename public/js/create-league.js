// ========================================================================
// CREATE LEAGUE PAGE LOGIC
// Generates an invite code, validates the form, and creates a new league
// plus the commissioner's league_members row in one flow.
//
// Lets the commissioner customize every league setting and every scoring
// rule. Defaults for every input come from the v1.2 spec (locked in PRD)
// and are applied via data-default attributes — clicking "Reset all
// scoring to defaults" restores them.
// ========================================================================

// ========================================================================
// SCORING FIELD MAP
// Each entry: id of the <input> in the form → key written into the
// leagues.scoring_config JSONB. The order matches the in-page sections.
// ========================================================================
const SCORING_FIELDS = [
  { id: 's_sig_strike',                key: 'sig_strike' },
  { id: 's_takedown',                  key: 'takedown' },
  { id: 's_knockdown',                 key: 'knockdown' },
  { id: 's_control_per_sec',           key: 'control_per_sec' },
  { id: 's_finish_r1',                 key: 'finish_r1' },
  { id: 's_finish_r2',                 key: 'finish_r2' },
  { id: 's_finish_r3',                 key: 'finish_r3' },
  { id: 's_finish_r4_r5',              key: 'finish_r4_r5' },
  { id: 's_decision',                  key: 'decision' },
  { id: 's_quick_win_bonus',           key: 'quick_win_bonus' },
  { id: 's_draw_points',               key: 'draw_points' },
  { id: 's_divisional_title_win',      key: 'divisional_title_win' },
  { id: 's_divisional_title_defense',  key: 'divisional_title_defense' },
  { id: 's_bmf_interim_win',           key: 'bmf_interim_win' },
  { id: 's_bmf_interim_defense',       key: 'bmf_interim_defense' },
  { id: 's_top5_win',                  key: 'top5_win' },
  { id: 's_top10_win',                 key: 'top10_win' },
  { id: 's_top15_win',                 key: 'top15_win' },
  { id: 's_potn',                      key: 'potn' },
  { id: 's_fotn',                      key: 'fotn' },
  { id: 's_main_event_mult',           key: 'main_event_mult' },
  { id: 's_co_main_mult',              key: 'co_main_mult' },
  // Starter count / event-week TERF expansion size.
  { id: 's_starters_numbered',         key: 'starters_numbered' },
  { id: 's_starters_fight_night',      key: 'starters_fight_night' }
];

// ========================================================================
// INVITE CODE — 6-char uppercase alphanumeric, skipping 0/O and 1/I
// ========================================================================
function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ========================================================================
// DATE HELPER — adds one year to a YYYY-MM-DD string. Handles leap-year
// Feb 29 by rolling back to Feb 28 of the (non-leap) next year. Returns
// '' when the input isn't a valid date string.
// ========================================================================
function addOneYear(dateStr) {
  if (!dateStr) return '';
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const year  = parseInt(m[1], 10) + 1;
  const month = parseInt(m[2], 10);
  let   day   = parseInt(m[3], 10);
  if (month === 2 && day === 29) {
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    if (!isLeap) day = 28;
  }
  return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

// ========================================================================
// MESSAGE BANNER
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
// SCORING DEFAULTS
// Apply data-default attribute values into every scoring input. Used at
// page load and from the "Reset all scoring to defaults" button.
// ========================================================================
function applyScoringDefaults() {
  SCORING_FIELDS.forEach(function(f) {
    const el = document.getElementById(f.id);
    if (el) el.value = el.getAttribute('data-default') || '';
  });
}

// Build a scoring_config object from the current form values.
// Numeric coercion + falls back to data-default if the field somehow blanked.
function readScoringConfig() {
  const cfg = {};
  SCORING_FIELDS.forEach(function(f) {
    const el = document.getElementById(f.id);
    if (!el) return;
    const raw = el.value.trim() === '' ? el.getAttribute('data-default') : el.value;
    const num = parseFloat(raw);
    cfg[f.key] = Number.isFinite(num) ? num : parseFloat(el.getAttribute('data-default'));
  });
  return cfg;
}

// ========================================================================
// COLLAPSIBLE SCORING SECTION
// ========================================================================
function wireScoringToggle() {
  const btn   = document.getElementById('scoringToggle');
  const panel = document.getElementById('scoringPanel');
  if (!btn || !panel) return;

  btn.addEventListener('click', function() {
    const isOpen = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
    panel.hidden = isOpen;
  });

  document.getElementById('scoringResetBtn').addEventListener('click', function() {
    applyScoringDefaults();
  });
}

// ========================================================================
// PAGE INIT
// ========================================================================
async function initCreateLeague() {
  const user = await requireAuth();
  if (!user) return;

  // Pre-fill scoring inputs with v1.2 defaults
  applyScoringDefaults();

  // Wire collapsible scoring section + reset button
  wireScoringToggle();

  // Generate the invite code right away
  let inviteCode = generateInviteCode();
  document.getElementById('inviteCodeDisplay').textContent = inviteCode;

  // Season Start change → auto-fill Season End to one year later, but only
  // if the user hasn't already set an end date. This way picking a start
  // gives a sensible default end without overwriting manual edits.
  document.getElementById('seasonStart').addEventListener('change', function() {
    const endEl = document.getElementById('seasonEnd');
    if (endEl && !endEl.value && this.value) {
      endEl.value = addOneYear(this.value);
    }
  });

  // Copy code button — copies just the 6-char code, handy for SMS where
  // link previews don't render.
  document.getElementById('copyBtn').addEventListener('click', function() {
    navigator.clipboard.writeText(inviteCode).then(function() {
      const copyBtn = document.getElementById('copyBtn');
      copyBtn.textContent = 'Copied!';
      setTimeout(function() { copyBtn.textContent = 'Copy code'; }, 2000);
    });
  });

  // Copy link button — copies the full sharable join URL. Friends who
  // click it land on the join page with the code prefilled; the auth
  // gate forwards them through login/signup and back via ?next= if
  // they're not yet signed in.
  document.getElementById('copyLinkBtn').addEventListener('click', function() {
    const path = window.location.pathname;
    const dir = path.substring(0, path.lastIndexOf('/'));
    const link = window.location.origin + dir + '/join-league.html?code=' + encodeURIComponent(inviteCode);
    navigator.clipboard.writeText(link).then(function() {
      const btn = document.getElementById('copyLinkBtn');
      btn.textContent = 'Copied!';
      setTimeout(function() { btn.textContent = 'Copy link'; }, 2000);
    });
  });

  // Reveal the page now that auth is confirmed
  document.getElementById('pageContent').style.display = '';

  // ---- Form submit ----
  document.getElementById('createForm').addEventListener('submit', async function(event) {
    event.preventDefault();
    hideMessage();

    const leagueName       = document.getElementById('leagueName').value.trim();
    const teamName         = document.getElementById('teamName').value.trim();
    const description      = document.getElementById('description').value.trim() || null;
    const format           = document.getElementById('format').value;
    const draftFmt         = document.getElementById('draftFormat').value;
    const seasonStart      = document.getElementById('seasonStart').value || null;
    const seasonEnd        = document.getElementById('seasonEnd').value   || null;
    const maxManagers      = parseInt(document.getElementById('maxManagers').value, 10) || 8;
    const rosterSize       = parseInt(document.getElementById('rosterSize').value, 10) || 15;
    const startersPerEvent = parseInt(document.getElementById('startersPerEvent').value, 10) || 3;
    // Pick timer — clamp to the same 30–600 range the DB enforces, falling
    // back to the PRD default if the field is somehow blank or outside range.
    let pickTimerSeconds   = parseInt(document.getElementById('pickTimer').value, 10);
    if (isNaN(pickTimerSeconds) || pickTimerSeconds < 30 || pickTimerSeconds > 600) {
      pickTimerSeconds = 90;
    }
    const scoringConfig    = readScoringConfig();
    const submitBtn        = document.getElementById('submitBtn');

    // ---- Client-side validation ----

    // Team name: 3-30 chars, letters/numbers/spaces only
    if (!/^[a-zA-Z0-9 ]{3,30}$/.test(teamName)) {
      showMessage('Team name must be 3-30 characters and contain only letters, numbers, and spaces.', 'error');
      return;
    }

    // Date sanity: end ≥ start
    if (seasonStart && seasonEnd && seasonEnd < seasonStart) {
      showMessage('Season end must be on or after the season start.', 'error');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating...';

    try {
      // Insert payload — every field is sent so the commissioner's choices
      // are honored. The leagues table also has DB-level defaults, so any
      // field omitted here would fall back to v1.2 anyway.
      const buildPayload = function(code) {
        return {
          name:               leagueName,
          commissioner_id:    user.id,
          invite_code:        code,
          description:        description,
          format:             format,
          draft_format:       draftFmt,
          season_start_date:  seasonStart,
          season_end_date:    seasonEnd,
          max_managers:       maxManagers,
          roster_size:        rosterSize,
          starters_per_event: startersPerEvent,
          pick_timer_seconds: pickTimerSeconds,
          scoring_config:     scoringConfig
        };
      };

      // ---- Step 1: insert the league row ----
      let leagueId;
      let firstResult = await supabaseClient
        .from('leagues')
        .insert(buildPayload(inviteCode))
        .select('id')
        .single();

      // Retry once on invite-code collision (extremely rare)
      if (firstResult.error && firstResult.error.code === '23505') {
        inviteCode = generateInviteCode();
        document.getElementById('inviteCodeDisplay').textContent = inviteCode;

        let retryResult = await supabaseClient
          .from('leagues')
          .insert(buildPayload(inviteCode))
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
      const { error: memberError } = await supabaseClient
        .from('league_members')
        .insert({
          league_id:       leagueId,
          user_id:         user.id,
          team_name:       teamName,
          waiver_priority: 1
        });

      if (memberError) throw memberError;

      window.location.href = 'dashboard.html';

    } catch (err) {
      showMessage(err.message, 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create League';
    }
  });
}

initCreateLeague();
