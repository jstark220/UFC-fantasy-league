// ========================================================================
// WAIVERS PAGE LOGIC
// Lets managers claim free-agent fighters and drop roster fighters.
// Commissioner sees a full claim queue and a "Process All Claims" button
// that runs claims in priority order (lower priority number = picks first).
//
// URL param: ?id=LEAGUE_UUID
// Depends on supabaseClient (supabase-config.js) and requireAuth (auth-guard.js).
// ========================================================================

const DIVISION_LABELS = {
  strawweight:       "Women's Strawweight",
  flyweight_w:       "Women's Flyweight",
  bantamweight_w:    "Women's Bantamweight",
  flyweight:         "Men's Flyweight",
  bantamweight:      "Men's Bantamweight",
  featherweight:     "Men's Featherweight",
  lightweight:       "Men's Lightweight",
  welterweight:      "Men's Welterweight",
  middleweight:      "Men's Middleweight",
  light_heavyweight: "Men's Light Heavyweight",
  heavyweight:       "Men's Heavyweight"
};

// Module-level state
let user, leagueId, league, members, myMember, myMemberId, isCommissioner;
let allFighters    = [];  // full fighters table
let availableFighters = []; // fighters not on any roster in this league
let myRoster       = [];  // fighter objects on the current user's roster
let myClaims       = [];  // the current user's waiver_claims rows
let pendingAllClaims = []; // all pending claims in the league (commissioner view)
let claimingFighter = null; // the fighter the modal is currently targeting

// ========================================================================
// INIT
// ========================================================================
async function initWaivers() {
  user = await requireAuth();
  if (!user) return;

  leagueId = new URLSearchParams(window.location.search).get('id');
  if (!leagueId) { window.location.href = 'dashboard.html'; return; }

  document.getElementById('leagueLink').href = 'league.html?id=' + leagueId;

  const [leagueRes, membersRes, fightersRes, rostersRes, claimsRes] = await Promise.all([
    supabaseClient
      .from('leagues')
      .select('id, name, commissioner_id, draft_started')
      .eq('id', leagueId)
      .single(),
    supabaseClient
      .from('league_members')
      .select('id, user_id, team_name, waiver_priority')
      .eq('league_id', leagueId),
    supabaseClient
      .from('fighters')
      .select('id, name, primary_division, current_rank, is_champion, record_wins, record_losses, record_draws')
      .order('name'),
    // All roster rows for this league (just need fighter_ids to find available fighters)
    supabaseClient
      .from('rosters')
      .select('fighter_id, league_member_id')
      .eq('league_id', leagueId),
    // All claims for this league (used by both member view and commissioner view)
    supabaseClient
      .from('waiver_claims')
      .select('*')
      .eq('league_id', leagueId)
      .order('priority')
      .order('submitted_at')
  ]);

  if (leagueRes.error || !leagueRes.data) {
    window.location.href = 'dashboard.html';
    return;
  }

  league  = leagueRes.data;
  members = membersRes.data || [];

  myMember = members.find(function(m) { return m.user_id === user.id; });
  if (!myMember) { window.location.href = 'dashboard.html'; return; }
  myMemberId    = myMember.id;
  isCommissioner = league.commissioner_id === user.id;

  allFighters = fightersRes.data || [];

  // Build the set of fighter IDs currently owned in this league
  const allRosters = rostersRes.data || [];
  const ownedIds   = new Set(allRosters.map(function(r) { return r.fighter_id; }));

  // Available = all fighters minus owned
  availableFighters = allFighters.filter(function(f) { return !ownedIds.has(f.id); });

  // My roster fighters
  const myRosterIds = allRosters
    .filter(function(r) { return r.league_member_id === myMemberId; })
    .map(function(r) { return r.fighter_id; });
  myRoster = allFighters.filter(function(f) { return myRosterIds.includes(f.id); });

  // Split claims: mine vs. all pending (for commissioner)
  const allClaims = claimsRes.data || [];
  myClaims         = allClaims.filter(function(c) { return c.league_member_id === myMemberId; });
  pendingAllClaims = allClaims.filter(function(c) { return c.status === 'pending'; });

  document.title = 'Waivers - ' + league.name;
  document.getElementById('leagueName').textContent = league.name;

  wireUpTabs();
  wireUpModal();
  wireUpSearch();

  renderAvailableFighters();
  renderMyClaims();

  if (isCommissioner) {
    document.getElementById('commissionerSection').style.display = 'block';
    renderProcessingQueue();
    document.getElementById('processBtn').addEventListener('click', processWaivers);
  }

  document.getElementById('pageContent').style.display = 'block';
}

// ========================================================================
// TAB SWITCHING
// ========================================================================
function wireUpTabs() {
  document.querySelector('.waiver-tab-bar').addEventListener('click', function(e) {
    var btn = e.target.closest('.waiver-tab-btn');
    if (!btn) return;

    document.querySelectorAll('.waiver-tab-btn').forEach(function(b) {
      b.classList.toggle('tab-active', b === btn);
    });

    var tab = btn.getAttribute('data-tab');
    document.getElementById('availableSection').style.display  = tab === 'available'  ? 'block' : 'none';
    document.getElementById('myClaimsSection').style.display   = tab === 'my-claims'  ? 'block' : 'none';
  });
}

// ========================================================================
// SEARCH AND FILTER
// ========================================================================
function wireUpSearch() {
  document.getElementById('fighterSearch').addEventListener('input', renderAvailableFighters);
  document.getElementById('divisionFilter').addEventListener('change', renderAvailableFighters);
}

// ========================================================================
// RENDER AVAILABLE FIGHTERS
// Shows all fighters not on any roster, filtered by search/division.
// ========================================================================
function renderAvailableFighters() {
  var query    = document.getElementById('fighterSearch').value.trim().toLowerCase();
  var division = document.getElementById('divisionFilter').value;

  var filtered = availableFighters.filter(function(f) {
    var matchesName = !query || f.name.toLowerCase().includes(query);
    var matchesDiv  = division === 'all' || f.primary_division === division;
    return matchesName && matchesDiv;
  });

  // Build a set of fighter IDs I've already submitted a pending claim for
  var myPendingClaimIds = new Set(
    myClaims
      .filter(function(c) { return c.status === 'pending'; })
      .map(function(c) { return c.fighter_to_add_id; })
  );

  var el = document.getElementById('availableContent');

  if (filtered.length === 0) {
    el.innerHTML = '<p class="waiver-empty">No available fighters match your search.</p>';
    return;
  }

  var html = '<table class="waiver-table"><thead><tr>';
  html += '<th>Rank</th><th>Name</th><th>Division</th><th>Record</th><th class="th-action">Claim</th>';
  html += '</tr></thead><tbody>';

  filtered.forEach(function(f) {
    var rankDisplay = f.is_champion ? 'C' : (f.current_rank ? '#' + f.current_rank : '-');
    var rankClass   = f.is_champion ? 'rank-champion' : (f.current_rank ? 'rank-ranked' : 'rank-unranked');
    var divLabel    = DIVISION_LABELS[f.primary_division] || f.primary_division;
    var record      = f.record_wins + '-' + f.record_losses + '-' + f.record_draws;
    var alreadyClaimed = myPendingClaimIds.has(f.id);

    var btn = alreadyClaimed
      ? '<button class="btn-start" disabled title="You already have a pending claim for this fighter">Claimed</button>'
      : '<button class="btn-claim" data-fighter-id="' + f.id + '">Claim</button>';

    html += '<tr>';
    html += '<td><span class="' + rankClass + '">' + escapeHtml(rankDisplay) + '</span></td>';
    html += '<td>' + escapeHtml(f.name) + '</td>';
    html += '<td>' + escapeHtml(divLabel) + '</td>';
    html += '<td>' + escapeHtml(record) + '</td>';
    html += '<td>' + btn + '</td>';
    html += '</tr>';
  });

  html += '</tbody></table>';
  el.innerHTML = html;

  el.querySelectorAll('.btn-claim[data-fighter-id]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      openClaimModal(btn.getAttribute('data-fighter-id'));
    });
  });
}

// ========================================================================
// RENDER MY CLAIMS
// Shows pending claims (with cancel button) and past processed claims.
// ========================================================================
function renderMyClaims() {
  var el = document.getElementById('myClaimsContent');

  if (myClaims.length === 0) {
    el.innerHTML = '<p class="waiver-empty">You have no waiver claims. Go to "Available Fighters" to submit one.</p>';
    return;
  }

  var fighterMap = {};
  allFighters.forEach(function(f) { fighterMap[f.id] = f; });

  var pending = myClaims.filter(function(c) { return c.status === 'pending'; });
  var past    = myClaims.filter(function(c) { return c.status !== 'pending'; });

  var html = '';

  if (pending.length > 0) {
    html += '<h3 class="claims-section-label">Pending Claims</h3>';
    html += '<table class="waiver-table"><thead><tr>';
    html += '<th>Claim</th><th>Drop</th><th>Priority</th><th>Submitted</th><th></th>';
    html += '</tr></thead><tbody>';

    pending.forEach(function(c) {
      var addFighter  = fighterMap[c.fighter_to_add_id];
      var dropFighter = c.fighter_to_drop_id ? fighterMap[c.fighter_to_drop_id] : null;
      var submitted   = c.submitted_at ? new Date(c.submitted_at).toLocaleDateString() : '-';

      html += '<tr>';
      html += '<td>' + escapeHtml(addFighter ? addFighter.name : '?') + '</td>';
      html += '<td>' + escapeHtml(dropFighter ? dropFighter.name : '-') + '</td>';
      html += '<td>' + escapeHtml(String(c.priority)) + '</td>';
      html += '<td>' + escapeHtml(submitted) + '</td>';
      html += '<td><button class="btn-danger btn-sm" data-claim-id="' + c.id + '">Cancel</button></td>';
      html += '</tr>';
    });

    html += '</tbody></table>';
  }

  if (past.length > 0) {
    html += '<h3 class="claims-section-label" style="margin-top:1.5rem;">Past Claims</h3>';
    html += '<table class="waiver-table"><thead><tr>';
    html += '<th>Claimed</th><th>Dropped</th><th>Status</th><th>Reason</th>';
    html += '</tr></thead><tbody>';

    past.forEach(function(c) {
      var addFighter  = fighterMap[c.fighter_to_add_id];
      var dropFighter = c.fighter_to_drop_id ? fighterMap[c.fighter_to_drop_id] : null;
      var statusClass = c.status === 'approved' ? 'badge-approved' :
                        c.status === 'rejected'  ? 'badge-rejected' : 'badge-cancelled';

      html += '<tr>';
      html += '<td>' + escapeHtml(addFighter ? addFighter.name : '?') + '</td>';
      html += '<td>' + escapeHtml(dropFighter ? dropFighter.name : '-') + '</td>';
      html += '<td><span class="waiver-status-badge ' + statusClass + '">' + escapeHtml(c.status) + '</span></td>';
      html += '<td>' + escapeHtml(c.rejection_reason || '-') + '</td>';
      html += '</tr>';
    });

    html += '</tbody></table>';
  }

  el.innerHTML = html;

  el.querySelectorAll('.btn-danger[data-claim-id]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      cancelClaim(btn.getAttribute('data-claim-id'));
    });
  });
}

// ========================================================================
// RENDER PROCESSING QUEUE (COMMISSIONER)
// Shows all pending claims across all managers in priority order.
// ========================================================================
function renderProcessingQueue() {
  var el = document.getElementById('processingContent');

  if (pendingAllClaims.length === 0) {
    el.innerHTML = '<p class="waiver-empty">No pending claims to process.</p>';
    return;
  }

  var fighterMap = {};
  allFighters.forEach(function(f) { fighterMap[f.id] = f; });

  var memberMap = {};
  members.forEach(function(m) { memberMap[m.id] = m; });

  var html = '<table class="waiver-table"><thead><tr>';
  html += '<th>Priority</th><th>Team</th><th>Claim</th><th>Drop</th><th>Submitted</th>';
  html += '</tr></thead><tbody>';

  pendingAllClaims.forEach(function(c) {
    var member     = memberMap[c.league_member_id];
    var addFighter = fighterMap[c.fighter_to_add_id];
    var dropFighter = c.fighter_to_drop_id ? fighterMap[c.fighter_to_drop_id] : null;
    var submitted   = c.submitted_at ? new Date(c.submitted_at).toLocaleDateString() : '-';

    html += '<tr>';
    html += '<td>' + escapeHtml(String(c.priority)) + '</td>';
    html += '<td>' + escapeHtml(member ? member.team_name : '?') + '</td>';
    html += '<td>' + escapeHtml(addFighter ? addFighter.name : '?') + '</td>';
    html += '<td>' + escapeHtml(dropFighter ? dropFighter.name : '-') + '</td>';
    html += '<td>' + escapeHtml(submitted) + '</td>';
    html += '</tr>';
  });

  html += '</tbody></table>';
  el.innerHTML = html;
}

// ========================================================================
// CLAIM MODAL
// Opens when a manager clicks "Claim" on a fighter. Shows a drop picker
// (required if at cap, optional otherwise).
// ========================================================================
function wireUpModal() {
  document.getElementById('cancelModalBtn').addEventListener('click', closeClaimModal);
  document.getElementById('confirmClaimBtn').addEventListener('click', submitClaim);

  // Close modal when clicking the dark overlay outside the modal box
  document.getElementById('claimModal').addEventListener('click', function(e) {
    if (e.target === this) closeClaimModal();
  });
}

function openClaimModal(fighterId) {
  claimingFighter = allFighters.find(function(f) { return f.id === fighterId; });
  if (!claimingFighter) return;

  var atCap      = myRoster.length >= 20;
  var divLabel   = DIVISION_LABELS[claimingFighter.primary_division] || claimingFighter.primary_division;
  var rankStr    = claimingFighter.is_champion ? ' (Champion)' :
                   claimingFighter.current_rank ? ' (#' + claimingFighter.current_rank + ')' : '';

  var dropLabel  = atCap
    ? 'Drop (required — you are at the 20-fighter cap)'
    : 'Drop (optional — leave blank to just add)';

  var dropOptions = '<option value="">-- No drop --</option>';
  myRoster.slice().sort(function(a, b) { return a.name.localeCompare(b.name); }).forEach(function(f) {
    var d = DIVISION_LABELS[f.primary_division] || f.primary_division;
    dropOptions += '<option value="' + f.id + '">' + escapeHtml(f.name) + ' (' + escapeHtml(d) + ')</option>';
  });

  document.getElementById('claimModalContent').innerHTML =
    '<div class="claim-fighter-info">' +
      '<p><strong>' + escapeHtml(claimingFighter.name) + '</strong>' + escapeHtml(rankStr) + '</p>' +
      '<p class="claim-fighter-div">' + escapeHtml(divLabel) + '</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label for="dropSelect">' + escapeHtml(dropLabel) + '</label>' +
      '<select id="dropSelect">' + dropOptions + '</select>' +
    '</div>' +
    (atCap ? '<p class="claim-cap-warning">You must select a fighter to drop before your claim can be approved.</p>' : '');

  document.getElementById('claimModal').style.display = 'flex';
}

function closeClaimModal() {
  document.getElementById('claimModal').style.display = 'none';
  claimingFighter = null;
}

// ========================================================================
// SUBMIT CLAIM
// ========================================================================
async function submitClaim() {
  if (!claimingFighter) return;

  var dropId = document.getElementById('dropSelect').value || null;
  var atCap  = myRoster.length >= 20;

  if (atCap && !dropId) {
    alert('You are at the 20-fighter cap. Please select a fighter to drop.');
    return;
  }

  var btn = document.getElementById('confirmClaimBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  var { error } = await supabaseClient
    .from('waiver_claims')
    .insert({
      league_id:          leagueId,
      league_member_id:   myMemberId,
      fighter_to_add_id:  claimingFighter.id,
      fighter_to_drop_id: dropId,
      priority:           myMember.waiver_priority,
      status:             'pending',
      submitted_at:       new Date().toISOString()
    });

  btn.disabled = false;
  btn.textContent = 'Submit Claim';

  if (error) {
    alert('Error submitting claim: ' + error.message);
    return;
  }

  closeClaimModal();
  await refreshData();
}

// ========================================================================
// CANCEL CLAIM
// Sets a pending claim's status to cancelled.
// ========================================================================
async function cancelClaim(claimId) {
  if (!confirm('Cancel this waiver claim?')) return;

  var { error } = await supabaseClient
    .from('waiver_claims')
    .update({ status: 'cancelled' })
    .eq('id', claimId)
    .eq('league_member_id', myMemberId);  // safety: only cancel own claims

  if (error) {
    alert('Error cancelling claim: ' + error.message);
    return;
  }

  await refreshData();
}

// ========================================================================
// PROCESS WAIVERS (COMMISSIONER)
// Runs through all pending claims in priority order. For each claim:
//   1. Check the fighter is still available.
//   2. Check the drop fighter (if specified) is still on the claimant's roster.
//   3. Check cap: if claimant is at 20 and no drop is specified, reject.
//   4. Approve: insert new roster row, delete drop row, mark claim approved.
//   5. Reject: update claim with rejection reason.
// After all claims: successful claimants go to the back of the priority queue.
// ========================================================================
async function processWaivers() {
  if (!isCommissioner) return;

  if (pendingAllClaims.length === 0) {
    alert('No pending claims to process.');
    return;
  }

  if (!confirm('Process all ' + pendingAllClaims.length + ' pending claim(s)? This will update rosters immediately.')) return;

  var btn = document.getElementById('processBtn');
  btn.disabled = true;
  btn.textContent = 'Processing...';

  // Fetch fresh roster data before processing so we have accurate current state
  var { data: freshRosters, error: rosterErr } = await supabaseClient
    .from('rosters')
    .select('id, fighter_id, league_member_id')
    .eq('league_id', leagueId);

  if (rosterErr) {
    alert('Error loading roster data: ' + rosterErr.message);
    btn.disabled = false;
    btn.textContent = 'Process All Claims';
    return;
  }

  // Track which fighters get claimed this cycle so later duplicate claims get rejected
  var claimedThisCycle  = new Set();
  var approvedMemberIds = [];  // members who successfully got a claim through

  for (var i = 0; i < pendingAllClaims.length; i++) {
    var claim = pendingAllClaims[i];

    // Check if another claim for the same fighter already went through this cycle
    if (claimedThisCycle.has(claim.fighter_to_add_id)) {
      await supabaseClient
        .from('waiver_claims')
        .update({
          status:           'rejected',
          rejection_reason: 'Fighter already claimed by a higher-priority team this cycle.',
          processed_at:     new Date().toISOString()
        })
        .eq('id', claim.id);
      continue;
    }

    // Check the fighter is still available (not on any roster)
    var fighterOwned = freshRosters.some(function(r) { return r.fighter_id === claim.fighter_to_add_id; });
    if (fighterOwned) {
      await supabaseClient
        .from('waiver_claims')
        .update({
          status:           'rejected',
          rejection_reason: 'Fighter is already on a roster.',
          processed_at:     new Date().toISOString()
        })
        .eq('id', claim.id);
      continue;
    }

    // Check the drop fighter is still on the claimant's roster
    if (claim.fighter_to_drop_id) {
      var dropOnRoster = freshRosters.some(function(r) {
        return r.fighter_id === claim.fighter_to_drop_id && r.league_member_id === claim.league_member_id;
      });
      if (!dropOnRoster) {
        await supabaseClient
          .from('waiver_claims')
          .update({
            status:           'rejected',
            rejection_reason: 'The fighter you selected to drop is no longer on your roster.',
            processed_at:     new Date().toISOString()
          })
          .eq('id', claim.id);
        continue;
      }
    }

    // Check cap: if at 20 fighters with no drop specified, reject
    var memberRosterSize = freshRosters.filter(function(r) {
      return r.league_member_id === claim.league_member_id;
    }).length;

    if (memberRosterSize >= 20 && !claim.fighter_to_drop_id) {
      await supabaseClient
        .from('waiver_claims')
        .update({
          status:           'rejected',
          rejection_reason: 'At the 20-fighter cap. Must specify a fighter to drop.',
          processed_at:     new Date().toISOString()
        })
        .eq('id', claim.id);
      continue;
    }

    // Add the claimed fighter to the roster
    var { error: addErr } = await supabaseClient
      .from('rosters')
      .insert({
        league_id:        leagueId,
        league_member_id: claim.league_member_id,
        fighter_id:       claim.fighter_to_add_id
      });

    if (addErr) {
      await supabaseClient
        .from('waiver_claims')
        .update({
          status:           'rejected',
          rejection_reason: 'Database error adding fighter: ' + addErr.message,
          processed_at:     new Date().toISOString()
        })
        .eq('id', claim.id);
      continue;
    }

    // Remove the dropped fighter if one was specified
    if (claim.fighter_to_drop_id) {
      await supabaseClient
        .from('rosters')
        .delete()
        .eq('league_id', leagueId)
        .eq('league_member_id', claim.league_member_id)
        .eq('fighter_id', claim.fighter_to_drop_id);

      // Also remove the dropped fighter from the local freshRosters so subsequent
      // cap checks for this member reflect the drop
      freshRosters = freshRosters.filter(function(r) {
        return !(r.fighter_id === claim.fighter_to_drop_id && r.league_member_id === claim.league_member_id);
      });
    }

    // Add the new fighter to local freshRosters so subsequent cap checks are accurate
    freshRosters.push({ fighter_id: claim.fighter_to_add_id, league_member_id: claim.league_member_id });

    // Mark the claim as approved
    await supabaseClient
      .from('waiver_claims')
      .update({
        status:       'approved',
        processed_at: new Date().toISOString()
      })
      .eq('id', claim.id);

    claimedThisCycle.add(claim.fighter_to_add_id);
    if (!approvedMemberIds.includes(claim.league_member_id)) {
      approvedMemberIds.push(claim.league_member_id);
    }
  }

  // Move approved claimants to the back of the priority queue
  // Get the current highest priority number
  var maxPriority = Math.max.apply(null, members.map(function(m) { return m.waiver_priority || 0; }));
  var nextPriority = maxPriority + 1;

  for (var j = 0; j < approvedMemberIds.length; j++) {
    await supabaseClient
      .from('league_members')
      .update({ waiver_priority: nextPriority })
      .eq('id', approvedMemberIds[j]);
    nextPriority++;
  }

  btn.disabled = false;
  btn.textContent = 'Process All Claims';

  alert('Waivers processed. ' + claimedThisCycle.size + ' claim(s) approved.');
  await refreshData();
}

// ========================================================================
// REFRESH DATA
// Re-fetches rosters and claims after any change so the UI stays in sync.
// ========================================================================
async function refreshData() {
  const [rostersRes, claimsRes, membersRes] = await Promise.all([
    supabaseClient
      .from('rosters')
      .select('fighter_id, league_member_id')
      .eq('league_id', leagueId),
    supabaseClient
      .from('waiver_claims')
      .select('*')
      .eq('league_id', leagueId)
      .order('priority')
      .order('submitted_at'),
    supabaseClient
      .from('league_members')
      .select('id, user_id, team_name, waiver_priority')
      .eq('league_id', leagueId)
  ]);

  members = membersRes.data || [];
  myMember = members.find(function(m) { return m.user_id === user.id; });

  const allRosters = rostersRes.data || [];
  const ownedIds   = new Set(allRosters.map(function(r) { return r.fighter_id; }));
  availableFighters = allFighters.filter(function(f) { return !ownedIds.has(f.id); });

  const myRosterIds = allRosters
    .filter(function(r) { return r.league_member_id === myMemberId; })
    .map(function(r) { return r.fighter_id; });
  myRoster = allFighters.filter(function(f) { return myRosterIds.includes(f.id); });

  const allClaims  = claimsRes.data || [];
  myClaims         = allClaims.filter(function(c) { return c.league_member_id === myMemberId; });
  pendingAllClaims = allClaims.filter(function(c) { return c.status === 'pending'; });

  renderAvailableFighters();
  renderMyClaims();
  if (isCommissioner) renderProcessingQueue();
}

// Escapes user-supplied strings before inserting into innerHTML to prevent XSS
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

initWaivers();
