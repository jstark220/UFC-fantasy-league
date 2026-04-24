// ========================================================================
// TRADES PAGE LOGIC
// Lets managers propose fighter swaps and respond to incoming offers.
// trade_details JSONB format: { proposer_gives: [uuid,...], recipient_gives: [uuid,...] }
// Status flow: proposed -> accepted | rejected | cancelled
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

let user, leagueId, league, members, myMemberId;
let allFighters  = {};   // id -> fighter object
let allRosters   = [];   // all roster rows { fighter_id, league_member_id }
let myTrades     = [];   // all trades where I'm proposer or recipient
let giving       = new Set();    // fighter IDs I'm offering
let receiving    = new Set();    // fighter IDs I want back

// ========================================================================
// INIT
// ========================================================================
async function initTrades() {
  user = await requireAuth();
  if (!user) return;

  leagueId = new URLSearchParams(window.location.search).get('id');
  if (!leagueId) { window.location.href = 'dashboard.html'; return; }

  document.getElementById('leagueLink').href = 'league.html?id=' + leagueId;

  const [leagueRes, membersRes, fightersRes, rostersRes, tradesRes] = await Promise.all([
    supabaseClient.from('leagues').select('id, name, commissioner_id').eq('id', leagueId).single(),
    supabaseClient.from('league_members').select('id, user_id, team_name').eq('league_id', leagueId),
    supabaseClient.from('fighters').select('id, name, primary_division, current_rank, is_champion').order('name'),
    supabaseClient.from('rosters').select('fighter_id, league_member_id').eq('league_id', leagueId),
    // RLS ensures only trades where the user is proposer or recipient are returned
    supabaseClient
      .from('trades')
      .select('*')
      .eq('league_id', leagueId)
      .order('proposed_at', { ascending: false })
  ]);

  if (leagueRes.error || !leagueRes.data) { window.location.href = 'dashboard.html'; return; }

  league  = leagueRes.data;
  members = membersRes.data || [];

  const myMember = members.find(function(m) { return m.user_id === user.id; });
  if (!myMember) { window.location.href = 'dashboard.html'; return; }
  myMemberId = myMember.id;

  // Build fighter lookup map
  (fightersRes.data || []).forEach(function(f) { allFighters[f.id] = f; });

  allRosters = rostersRes.data || [];
  myTrades   = tradesRes.data || [];

  document.title = 'Trades - ' + league.name;
  document.getElementById('leagueName').textContent = league.name;

  wireUpTabs();
  populatePartnerSelect();
  renderIncoming();
  renderSent();
  updateIncomingBadge();

  document.getElementById('pageContent').style.display = 'block';
}

// ========================================================================
// TAB SWITCHING
// ========================================================================
function wireUpTabs() {
  document.querySelector('.trade-tab-bar').addEventListener('click', function(e) {
    var btn = e.target.closest('.trade-tab-btn');
    if (!btn) return;

    document.querySelectorAll('.trade-tab-btn').forEach(function(b) {
      b.classList.toggle('tab-active', b === btn);
    });

    var tab = btn.getAttribute('data-tab');
    document.getElementById('proposeTab').style.display  = tab === 'propose'  ? 'block' : 'none';
    document.getElementById('incomingTab').style.display = tab === 'incoming' ? 'block' : 'none';
    document.getElementById('sentTab').style.display     = tab === 'sent'     ? 'block' : 'none';
  });
}

// ========================================================================
// PARTNER SELECT
// Populates the dropdown with other managers. Selecting one loads both
// rosters for the two-column picker.
// ========================================================================
function populatePartnerSelect() {
  var select = document.getElementById('partnerSelect');

  members.forEach(function(m) {
    if (m.id === myMemberId) return;  // can't trade with yourself
    var opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.team_name;
    select.appendChild(opt);
  });

  select.addEventListener('change', function() {
    giving.clear();
    receiving.clear();
    if (!this.value) {
      document.getElementById('rosterPicker').style.display = 'none';
      return;
    }
    renderRosterPicker(this.value);
    document.getElementById('rosterPicker').style.display = 'block';
  });

  document.getElementById('proposeBtn').addEventListener('click', proposeTrade);
}

// ========================================================================
// ROSTER PICKER
// Shows two columns of checkboxes: your fighters (giving) and their fighters
// (receiving). Updates selection counters as boxes are checked.
// ========================================================================
function renderRosterPicker(partnerId) {
  var myFighterIds      = allRosters.filter(function(r) { return r.league_member_id === myMemberId; }).map(function(r) { return r.fighter_id; });
  var theirFighterIds   = allRosters.filter(function(r) { return r.league_member_id === partnerId; }).map(function(r) { return r.fighter_id; });

  var myFighters    = myFighterIds.map(function(id) { return allFighters[id]; }).filter(Boolean).sort(function(a, b) { return a.name.localeCompare(b.name); });
  var theirFighters = theirFighterIds.map(function(id) { return allFighters[id]; }).filter(Boolean).sort(function(a, b) { return a.name.localeCompare(b.name); });

  document.getElementById('yourRosterList').innerHTML  = buildPickerList(myFighters, 'give');
  document.getElementById('theirRosterList').innerHTML = buildPickerList(theirFighters, 'receive');

  // Wire up checkboxes
  document.querySelectorAll('.trade-checkbox[data-side="give"]').forEach(function(cb) {
    cb.addEventListener('change', function() {
      if (this.checked) giving.add(this.value);
      else giving.delete(this.value);
      document.getElementById('youGiveCount').textContent = '(' + giving.size + ' selected)';
    });
  });

  document.querySelectorAll('.trade-checkbox[data-side="receive"]').forEach(function(cb) {
    cb.addEventListener('change', function() {
      if (this.checked) receiving.add(this.value);
      else receiving.delete(this.value);
      document.getElementById('youReceiveCount').textContent = '(' + receiving.size + ' selected)';
    });
  });
}

function buildPickerList(fighters, side) {
  if (fighters.length === 0) {
    return '<p class="trade-empty-col">No fighters on this roster.</p>';
  }

  var html = '';
  fighters.forEach(function(f) {
    var rank    = f.is_champion ? 'C' : (f.current_rank ? '#' + f.current_rank : '-');
    var rClass  = f.is_champion ? 'rank-champion' : (f.current_rank ? 'rank-ranked' : 'rank-unranked');
    var div     = DIVISION_LABELS[f.primary_division] || f.primary_division;

    html +=
      '<label class="trade-fighter-row">' +
        '<input type="checkbox" class="trade-checkbox" data-side="' + side + '" value="' + f.id + '">' +
        '<span class="' + rClass + ' trade-rank">' + escapeHtml(rank) + '</span>' +
        '<span class="trade-name">' + escapeHtml(f.name) + '</span>' +
        '<span class="trade-div">' + escapeHtml(div) + '</span>' +
      '</label>';
  });
  return html;
}

// ========================================================================
// PROPOSE TRADE
// Validates selections and inserts a trade row with status = proposed.
// ========================================================================
async function proposeTrade() {
  var partnerId = document.getElementById('partnerSelect').value;
  if (!partnerId) { alert('Please select a trade partner.'); return; }
  if (giving.size === 0)   { alert('Select at least one fighter you are giving.'); return; }
  if (receiving.size === 0) { alert('Select at least one fighter you want to receive.'); return; }

  var message = document.getElementById('tradeMessage').value.trim() || null;

  var btn = document.getElementById('proposeBtn');
  btn.disabled = true;
  btn.textContent = 'Sending...';

  var { error } = await supabaseClient.from('trades').insert({
    league_id:    leagueId,
    proposer_id:  myMemberId,
    recipient_id: partnerId,
    trade_details: {
      proposer_gives:  Array.from(giving),
      recipient_gives: Array.from(receiving)
    },
    status:      'proposed',
    message:     message,
    proposed_at: new Date().toISOString()
  });

  btn.disabled = false;
  btn.textContent = 'Send Trade Offer';

  if (error) { alert('Error sending trade: ' + error.message); return; }

  // Reset form
  giving.clear();
  receiving.clear();
  document.getElementById('partnerSelect').value = '';
  document.getElementById('rosterPicker').style.display = 'none';
  document.getElementById('tradeMessage').value = '';
  document.getElementById('youGiveCount').textContent = '(0 selected)';
  document.getElementById('youReceiveCount').textContent = '(0 selected)';

  await refreshTrades();
  alert('Trade offer sent!');
}

// ========================================================================
// RENDER INCOMING
// Shows trades where I'm the recipient and status is proposed.
// ========================================================================
function renderIncoming() {
  var el = document.getElementById('incomingContent');
  var incoming = myTrades.filter(function(t) {
    return t.recipient_id === myMemberId && t.status === 'proposed';
  });

  if (incoming.length === 0) {
    el.innerHTML = '<p class="trade-empty">No incoming trade offers.</p>';
    return;
  }

  var memberMap = {};
  members.forEach(function(m) { memberMap[m.id] = m; });

  var html = '';
  incoming.forEach(function(trade) {
    html += renderTradeCard(trade, memberMap, 'incoming');
  });
  el.innerHTML = html;

  el.querySelectorAll('.btn-accept').forEach(function(btn) {
    btn.addEventListener('click', function() { acceptTrade(btn.getAttribute('data-trade-id')); });
  });
  el.querySelectorAll('.btn-reject').forEach(function(btn) {
    btn.addEventListener('click', function() { respondToTrade(btn.getAttribute('data-trade-id'), 'rejected'); });
  });
}

// ========================================================================
// RENDER SENT
// Shows all trades I proposed, grouped by status.
// ========================================================================
function renderSent() {
  var el = document.getElementById('sentContent');
  var sent = myTrades.filter(function(t) { return t.proposer_id === myMemberId; });

  if (sent.length === 0) {
    el.innerHTML = '<p class="trade-empty">You have not proposed any trades yet.</p>';
    return;
  }

  var memberMap = {};
  members.forEach(function(m) { memberMap[m.id] = m; });

  var html = '';
  sent.forEach(function(trade) {
    html += renderTradeCard(trade, memberMap, 'sent');
  });
  el.innerHTML = html;

  el.querySelectorAll('.btn-cancel-trade').forEach(function(btn) {
    btn.addEventListener('click', function() { respondToTrade(btn.getAttribute('data-trade-id'), 'cancelled'); });
  });
}

// ========================================================================
// RENDER TRADE CARD
// Shared template for a single trade row used in both Incoming and Sent.
// ========================================================================
function renderTradeCard(trade, memberMap, view) {
  var proposer  = memberMap[trade.proposer_id];
  var recipient = memberMap[trade.recipient_id];
  var details   = trade.trade_details || {};
  var propGives = details.proposer_gives  || [];
  var recGives  = details.recipient_gives || [];

  var proposerGivesNames  = propGives.map(function(id) { return allFighters[id] ? allFighters[id].name : '?'; });
  var recipientGivesNames = recGives.map(function(id)  { return allFighters[id] ? allFighters[id].name : '?'; });

  var statusClass = {
    proposed:  'badge-pending',
    accepted:  'badge-approved',
    rejected:  'badge-rejected',
    cancelled: 'badge-cancelled',
    countered: 'badge-pending'
  }[trade.status] || '';

  var date = trade.proposed_at
    ? new Date(trade.proposed_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : '';

  var html =
    '<div class="trade-card">' +
      '<div class="trade-card-header">' +
        '<span class="trade-teams">' +
          escapeHtml(proposer ? proposer.team_name : '?') +
          ' <span class="trade-arrow">&#8646;</span> ' +
          escapeHtml(recipient ? recipient.team_name : '?') +
        '</span>' +
        '<span class="trade-meta">' +
          '<span class="waiver-status-badge ' + statusClass + '">' + escapeHtml(trade.status) + '</span>' +
          (date ? '<span class="trade-date">' + escapeHtml(date) + '</span>' : '') +
        '</span>' +
      '</div>';

  // Fighter exchange summary
  html +=
    '<div class="trade-exchange">' +
      '<div class="trade-exchange-col">' +
        '<span class="trade-exchange-label">' + escapeHtml(proposer ? proposer.team_name : '?') + ' gives</span>' +
        '<ul class="trade-fighter-list">' +
          proposerGivesNames.map(function(n) { return '<li>' + escapeHtml(n) + '</li>'; }).join('') +
        '</ul>' +
      '</div>' +
      '<div class="trade-exchange-divider">&#8644;</div>' +
      '<div class="trade-exchange-col">' +
        '<span class="trade-exchange-label">' + escapeHtml(recipient ? recipient.team_name : '?') + ' gives</span>' +
        '<ul class="trade-fighter-list">' +
          recipientGivesNames.map(function(n) { return '<li>' + escapeHtml(n) + '</li>'; }).join('') +
        '</ul>' +
      '</div>' +
    '</div>';

  if (trade.message) {
    html += '<p class="trade-message">"' + escapeHtml(trade.message) + '"</p>';
  }

  // Action buttons
  if (view === 'incoming' && trade.status === 'proposed') {
    html +=
      '<div class="trade-card-actions">' +
        '<button class="btn-gold btn-sm btn-accept" data-trade-id="' + trade.id + '">Accept</button>' +
        '<button class="btn-secondary btn-sm btn-reject" data-trade-id="' + trade.id + '">Reject</button>' +
      '</div>';
  } else if (view === 'sent' && trade.status === 'proposed') {
    html +=
      '<div class="trade-card-actions">' +
        '<button class="btn-danger btn-sm btn-cancel-trade" data-trade-id="' + trade.id + '">Cancel Offer</button>' +
      '</div>';
  }

  html += '</div>';
  return html;
}

// ========================================================================
// ACCEPT TRADE
// Swaps fighters between rosters, then marks the trade accepted.
// Operations run sequentially; no DB transaction, so errors mid-swap are
// flagged but partial changes may have occurred (acceptable for MVP).
// ========================================================================
async function acceptTrade(tradeId) {
  var trade = myTrades.find(function(t) { return t.id === tradeId; });
  if (!trade) return;

  var details      = trade.trade_details || {};
  var propGives    = details.proposer_gives  || [];   // go to recipient
  var recGives     = details.recipient_gives || [];   // go to proposer
  var proposerId   = trade.proposer_id;
  var recipientId  = trade.recipient_id;  // = myMemberId

  if (!confirm('Accept this trade? Rosters will update immediately.')) return;

  // --- Remove proposer's fighters from proposer's roster ---
  for (var i = 0; i < propGives.length; i++) {
    var { error } = await supabaseClient.from('rosters')
      .delete()
      .eq('league_id', leagueId)
      .eq('league_member_id', proposerId)
      .eq('fighter_id', propGives[i]);
    if (error) { alert('Error removing fighter from proposer roster: ' + error.message); return; }
  }

  // --- Add proposer's fighters to recipient's roster ---
  for (var i = 0; i < propGives.length; i++) {
    var { error } = await supabaseClient.from('rosters')
      .insert({ league_id: leagueId, league_member_id: recipientId, fighter_id: propGives[i] });
    if (error) { alert('Error adding fighter to your roster: ' + error.message); return; }
  }

  // --- Remove recipient's fighters from recipient's roster ---
  for (var i = 0; i < recGives.length; i++) {
    var { error } = await supabaseClient.from('rosters')
      .delete()
      .eq('league_id', leagueId)
      .eq('league_member_id', recipientId)
      .eq('fighter_id', recGives[i]);
    if (error) { alert('Error removing fighter from your roster: ' + error.message); return; }
  }

  // --- Add recipient's fighters to proposer's roster ---
  for (var i = 0; i < recGives.length; i++) {
    var { error } = await supabaseClient.from('rosters')
      .insert({ league_id: leagueId, league_member_id: proposerId, fighter_id: recGives[i] });
    if (error) { alert('Error adding fighter to proposer roster: ' + error.message); return; }
  }

  // --- Mark trade accepted ---
  var { error: updateErr } = await supabaseClient.from('trades')
    .update({ status: 'accepted', responded_at: new Date().toISOString() })
    .eq('id', tradeId);

  if (updateErr) { alert('Trade executed but status update failed: ' + updateErr.message); return; }

  await refreshTrades();
}

// ========================================================================
// REJECT / CANCEL TRADE
// Just updates the status; no roster changes.
// ========================================================================
async function respondToTrade(tradeId, newStatus) {
  var label = newStatus === 'cancelled' ? 'Cancel this trade offer?' : 'Reject this trade offer?';
  if (!confirm(label)) return;

  var { error } = await supabaseClient.from('trades')
    .update({ status: newStatus, responded_at: new Date().toISOString() })
    .eq('id', tradeId);

  if (error) { alert('Error updating trade: ' + error.message); return; }
  await refreshTrades();
}

// ========================================================================
// REFRESH
// ========================================================================
async function refreshTrades() {
  const [rostersRes, tradesRes] = await Promise.all([
    supabaseClient.from('rosters').select('fighter_id, league_member_id').eq('league_id', leagueId),
    supabaseClient
      .from('trades')
      .select('*')
      .eq('league_id', leagueId)
      .order('proposed_at', { ascending: false })
  ]);

  allRosters = rostersRes.data || [];
  myTrades   = (tradesRes.data || []).filter(function(t) {
    return t.proposer_id === myMemberId || t.recipient_id === myMemberId;
  });

  renderIncoming();
  renderSent();
  updateIncomingBadge();

  // Re-render picker if a partner is currently selected
  var partnerId = document.getElementById('partnerSelect').value;
  if (partnerId) {
    giving.clear();
    receiving.clear();
    document.getElementById('youGiveCount').textContent = '(0 selected)';
    document.getElementById('youReceiveCount').textContent = '(0 selected)';
    renderRosterPicker(partnerId);
  }
}

function updateIncomingBadge() {
  var count = myTrades.filter(function(t) {
    return t.recipient_id === myMemberId && t.status === 'proposed';
  }).length;

  var badge = document.getElementById('incomingBadge');
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

initTrades();
