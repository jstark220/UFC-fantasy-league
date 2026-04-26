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

// Adds one year to a YYYY-MM-DD string. Rolls Feb 29 back to Feb 28 of the
// (non-leap) following year. Returns '' for unparseable input.
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
// SCORING FIELD MAP — same shape as create-league.js. Maps each <input>'s
// id to the key in leagues.scoring_config JSONB.
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
  { id: 's_co_main_mult',              key: 'co_main_mult' }
];

// Pre-fill scoring inputs from a scoring_config object. Falls back to
// data-default for any key the config doesn't have.
function applyScoringValues(scoringConfig) {
  scoringConfig = scoringConfig || {};
  SCORING_FIELDS.forEach(function(f) {
    const el = document.getElementById(f.id);
    if (!el) return;
    const stored = scoringConfig[f.key];
    el.value = (stored != null ? stored : el.getAttribute('data-default')) || '';
  });
}

// Reset every scoring input to its data-default (v1.2 values)
function resetScoringToDefaults() {
  SCORING_FIELDS.forEach(function(f) {
    const el = document.getElementById(f.id);
    if (el) el.value = el.getAttribute('data-default') || '';
  });
}

// Build a scoring_config object from the current form values.
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

  // Fetch league row (include scoring_config so we can populate the
  // scoring inputs from this league's saved values, falling back to v1.2
  // for any key the JSONB is missing)
  const { data: league, error: leagueError } = await supabaseClient
    .from('leagues')
    .select('id, name, format, draft_format, season_start_date, season_end_date, invite_code, commissioner_id, max_managers, roster_size, draft_started, scoring_config')
    .eq('id', leagueId)
    .single();

  if (leagueError || !league) {
    window.location.href = 'dashboard.html';
    return;
  }

  // Confirm this user is actually a member (RLS may not catch all cases)
  // and pull is_commissioner so co-commissioners get the same edit access.
  const { data: membership } = await supabaseClient
    .from('league_members')
    .select('id, user_id, is_commissioner')
    .eq('league_id', leagueId)
    .eq('user_id', user.id)
    .single();

  if (!membership) {
    window.location.href = 'dashboard.html';
    return;
  }

  // True for primary owner OR a co-commissioner. Co-commissioners can
  // edit the same settings the primary can; promoting/demoting other
  // members is gated separately to primary-only.
  const isCommissioner       = Commissioner.memberIsCommissioner(league, membership);
  const isPrimaryCommissioner = Commissioner.isPrimaryCommissioner(league, user.id);

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
  if (league.season_end_date) {
    document.getElementById('inputEndDate').value = league.season_end_date.slice(0, 10);
  }

  // When the commissioner sets a Season Start and the End is still blank,
  // auto-fill End to one year later. Doesn't overwrite a manually entered
  // end date.
  document.getElementById('inputStartDate').addEventListener('change', function() {
    const endEl = document.getElementById('inputEndDate');
    if (endEl && !endEl.value && this.value) {
      endEl.value = addOneYear(this.value);
    }
  });

  // Pre-fill scoring inputs from this league's saved scoring_config
  applyScoringValues(league.scoring_config);

  // Lock draft-related fields once the draft has started
  if (league.draft_started) {
    document.getElementById('inputDraftFormat').disabled = true;
    document.getElementById('inputRosterSize').disabled  = true;
    document.getElementById('draftFormatHint').style.display = '';
    document.getElementById('rosterSizeHint').style.display  = '';
  }

  if (isCommissioner) {
    // Reveal the scoring reset button (only useful for the editor)
    const resetBtn = document.getElementById('scoringResetBtn');
    if (resetBtn) {
      resetBtn.style.display = '';
      resetBtn.addEventListener('click', resetScoringToDefaults);
    }

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

    // Co-commissioner controls — only the PRIMARY owner can promote or
    // demote others. A co-commissioner has the same daily powers but
    // can't manage the role list (keeps the audit trail simple).
    if (isPrimaryCommissioner) {
      document.getElementById('coCommissionerSection').style.display = '';
      // Pass the primary's own member id so activity-feed entries are
      // attributed to them rather than appearing as system events.
      renderCoCommissionerList(leagueId, league, membership.id);
    }

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
    ['inputName', 'inputFormat', 'inputDraftFormat', 'inputStartDate', 'inputEndDate', 'inputMaxManagers', 'inputRosterSize'].forEach(function(id) {
      document.getElementById(id).disabled = true;
    });
    // Lock every scoring input too — members can VIEW the rules but only
    // the commissioner edits.
    SCORING_FIELDS.forEach(function(f) {
      const el = document.getElementById(f.id);
      if (el) el.disabled = true;
    });
    document.getElementById('saveSection').style.display = 'none';
    document.getElementById('memberNote').style.display  = '';
  }

  // Save handler (commissioner only — button is hidden for members)
  document.getElementById('settingsForm').addEventListener('submit', async function(e) {
    e.preventDefault();

    const btn = document.getElementById('saveBtn');

    const seasonStart = document.getElementById('inputStartDate').value || null;
    const seasonEnd   = document.getElementById('inputEndDate').value   || null;

    // Date sanity: end must be on or after start when both are set
    if (seasonStart && seasonEnd && seasonEnd < seasonStart) {
      showMessage('Season end must be on or after the season start.', 'error');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Saving...';

    const updates = {
      name:              document.getElementById('inputName').value.trim(),
      format:            document.getElementById('inputFormat').value,
      season_start_date: seasonStart,
      season_end_date:   seasonEnd,
      max_managers:      parseInt(document.getElementById('inputMaxManagers').value, 10),
      scoring_config:    readScoringConfig()
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

// ========================================================================
// CO-COMMISSIONER LIST
// Primary-only UI to promote/demote other members. Renders one row per
// member (excluding the primary themselves) with a Promote / Demote
// button that flips league_members.is_commissioner.
// ========================================================================
async function renderCoCommissionerList(leagueId, league, actorMemberId) {
  const listEl = document.getElementById('coCommishList');

  async function load() {
    const { data: members, error } = await supabaseClient
      .from('league_members')
      .select('id, user_id, team_name, is_commissioner')
      .eq('league_id', leagueId)
      .order('team_name');

    if (error) {
      listEl.innerHTML = '<li class="co-commish-empty">Could not load members: ' +
        escapeHtml(error.message) + '</li>';
      return;
    }

    // Filter out the primary owner — they can't toggle themselves here.
    const others = (members || []).filter(function(m) {
      return m.user_id !== league.commissioner_id;
    });

    if (others.length === 0) {
      listEl.innerHTML = '<li class="co-commish-empty">No other managers yet.</li>';
      return;
    }

    listEl.innerHTML = others.map(function(m) {
      const isCo = m.is_commissioner === true;
      const btnClass = isCo ? 'btn-secondary' : 'btn-primary';
      const btnLabel = isCo ? 'Demote' : 'Promote';
      return (
        '<li class="co-commish-row">' +
          '<div class="co-commish-row__info">' +
            '<span class="co-commish-row__name">' + escapeHtml(m.team_name) + '</span>' +
            (isCo ? '<span class="badge-co-commissioner">Co-commissioner</span>' : '') +
          '</div>' +
          '<button class="' + btnClass + ' co-commish-row__btn" ' +
                  'data-member-id="' + m.id + '" ' +
                  'data-team-name="' + escapeHtml(m.team_name) + '" ' +
                  'data-action="' + (isCo ? 'demote' : 'promote') + '">' +
            btnLabel +
          '</button>' +
        '</li>'
      );
    }).join('');

    // Wire promote/demote — single handler since the action lives on the
    // button via data-action, so we don't have to track which row was clicked.
    listEl.querySelectorAll('.co-commish-row__btn').forEach(function(btn) {
      btn.addEventListener('click', function() { onToggle(btn); });
    });
  }

  async function onToggle(btn) {
    const memberId  = btn.getAttribute('data-member-id');
    const teamName  = btn.getAttribute('data-team-name');
    const action    = btn.getAttribute('data-action');
    const promoting = action === 'promote';

    const verb  = promoting ? 'Promote'  : 'Demote';
    if (!confirm(verb + ' ' + teamName + (promoting
        ? ' to co-commissioner? They will gain access to settings, scoring, waivers, and trades.'
        : '? They will lose commissioner powers.'
    ))) return;

    btn.disabled = true;
    btn.textContent = promoting ? 'Promoting...' : 'Demoting...';

    const { error } = await supabaseClient
      .from('league_members')
      .update({ is_commissioner: promoting })
      .eq('id', memberId);

    if (error) {
      alert('Error: ' + error.message);
      btn.disabled = false;
      btn.textContent = promoting ? 'Promote' : 'Demote';
      return;
    }

    // Mirror to the activity feed. The actor is the primary commissioner
    // (the only role allowed to call this), and the affected member's id
    // goes into the data payload so future enhancements can render
    // "Stark 1 promoted Stark 2 to co-commissioner".
    if (typeof LeagueActivity !== 'undefined') {
      LeagueActivity.logEvent(
        leagueId,
        promoting ? LeagueActivity.KINDS.MEMBER_PROMOTED : LeagueActivity.KINDS.MEMBER_DEMOTED,
        { target_member_id: memberId, target_team_name: teamName },
        actorMemberId
      );
    }

    // Re-render so labels flip without a full page reload
    await load();
  }

  await load();
}

initSettings();
