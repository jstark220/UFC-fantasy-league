// ========================================================================
// TRADES PAGE
// Lets managers propose fighter swaps and respond to incoming offers.
//
// trade_details JSONB: { proposer_gives: [uuid,...], recipient_gives: [uuid,...] }
// Status flow: proposed → accepted | rejected | cancelled
// URL param: ?id=LEAGUE_UUID
// Depends on supabaseClient, requireAuth, showFighterModal.
// ========================================================================

const TRADE_DIVISION_LABELS = {
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

// Length of the post-acceptance review window before auto-execution.
const TRADE_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

let user, leagueId, league, members, myMemberId, isCommissioner;
let allFighters = {};   // id -> fighter object
let allRosters  = [];   // all roster rows { fighter_id, league_member_id }
let myTrades    = [];   // trades where I'm proposer or recipient
let giving      = new Set();    // fighter IDs I'm offering
let receiving   = new Set();    // fighter IDs I want back

// Pre-fill state — set when ?withFighter= is in the URL (e.g., user clicked
// Propose Trade in the fighter modal). The picker re-applies it after every
// render so changing partners doesn't wipe the selection.
let prefillFighterId = null;

// ========================================================================
// INIT
// ========================================================================
async function initTrades() {
  user = await requireAuth();
  if (!user) return;

  leagueId = new URLSearchParams(window.location.search).get('id');
  if (!leagueId) { window.location.href = 'dashboard.html'; return; }

  document.getElementById('leagueLink').href = 'league.html?id=' + leagueId;

  // Fetch league/members/rosters/trades in parallel. Fighters are fetched
  // separately AFTER we know which fighter_ids are actually on rosters in
  // this league — the fighters table has ~6,000 rows and Supabase's
  // default 1000-row select limit was cutting off any rostered fighter
  // whose name sorted past the alphabetical cutoff. We only need ~160
  // fighters max (8 managers × 20 slots), so an .in() filter on the
  // roster IDs is both correct and faster.
  const [leagueRes, membersRes, rostersRes, tradesRes] = await Promise.all([
    supabaseClient.from('leagues').select('id, name, commissioner_id, scoring_config').eq('id', leagueId).single(),
    supabaseClient.from('league_members').select('id, user_id, team_name, is_commissioner').eq('league_id', leagueId),
    supabaseClient.from('rosters').select('fighter_id, league_member_id').eq('league_id', leagueId),
    supabaseClient.from('trades').select('*').eq('league_id', leagueId).order('proposed_at', { ascending: false })
  ]);

  if (leagueRes.error || !leagueRes.data) { window.location.href = 'dashboard.html'; return; }

  league  = leagueRes.data;
  members = membersRes.data || [];

  const myMember = members.find(function(m) { return m.user_id === user.id; });
  if (!myMember) { window.location.href = 'dashboard.html'; return; }
  myMemberId     = myMember.id;
  // Primary OR co-commissioner — both can force-execute trades and use
  // any other commissioner-only controls on this page.
  isCommissioner = Commissioner.isCommissioner(league, members, user.id);

  allRosters = rostersRes.data || [];
  myTrades   = tradesRes.data || [];

  // Now load only the fighters that appear on rosters. This both avoids
  // the 1000-row select limit and saves bandwidth.
  const rosteredIds = Array.from(new Set(allRosters.map(function(r) { return r.fighter_id; })));
  if (rosteredIds.length > 0) {
    const fightersRes = await supabaseClient
      .from('fighters')
      .select('id, name, primary_division, current_rank, is_champion, is_sub_champion, sub_title_type, record_wins, record_losses, record_draws, photo_url')
      .in('id', rosteredIds);
    (fightersRes.data || []).forEach(function(f) { allFighters[f.id] = f; });
  }

  // Lazy processor: any accepted trade past its 24h review deadline gets
  // executed before we render. Idempotent — only touches rows where
  // executed_at IS NULL.
  await runLazyTradeProcessor();

  document.title = 'Trades - ' + league.name;
  document.getElementById('leagueName').textContent = league.name;

  LeagueNav.renderInto('headerActions', {
    leagueId: leagueId,
    memberId: myMemberId,
    active:   'trades'
  });

  wireUpTabs();
  populatePartnerSelect();
  renderIncoming();
  renderPending();
  renderSent();
  updateTabBadges();

  // Fantasy Value chips on trade cards are populated async — once FV is
  // loaded for the league's scoring config, re-render each tab so the
  // FV chips + value-imbalance indicator appear. Fire-and-forget; a slow
  // FV load just delays the chips, doesn't block the page.
  if (typeof FantasyValue !== 'undefined' && FantasyValue.ensureLoaded) {
    FantasyValue.ensureLoaded(leagueId, league.scoring_config).then(function () {
      renderIncoming();
      renderPending();
      renderSent();
    }).catch(function () { /* swallow — chips just stay absent */ });
  }

  // If we arrived from a "Propose Trade" button in the fighter modal,
  // pre-select the partner (if applicable) and the fighter.
  applyTradePrefill();

  document.getElementById('pageContent').style.display = 'block';
}

// ========================================================================
// PREFILL FROM URL — activated when ?withFighter=FIGHTER_ID is present.
// Sets up the propose form with the target fighter already selected:
//   * If the fighter is on my roster   → mark on the "give" side once a partner is chosen
//   * If on another manager's roster   → auto-select that partner + mark on the "receive" side
//   * If unowned (free agent)          → no-op (silently)
// ========================================================================
function applyTradePrefill() {
  var fighterId = new URLSearchParams(window.location.search).get('withFighter');
  if (!fighterId) return;

  var ownerRow = allRosters.find(function(r) { return r.fighter_id === fighterId; });
  if (!ownerRow) return; // fighter is unowned — nothing to trade

  prefillFighterId = fighterId;

  // Make sure we're on the Propose tab
  var proposeBtn = document.querySelector('.waiver-tab[data-tab="propose"]');
  if (proposeBtn) proposeBtn.click();

  if (ownerRow.league_member_id !== myMemberId) {
    // Other manager owns this fighter — auto-pick them as partner so the
    // picker renders, then re-apply prefill marks the row on the receive side.
    var select = document.getElementById('partnerSelect');
    select.value = ownerRow.league_member_id;
    renderRosterPicker(ownerRow.league_member_id);
    document.getElementById('rosterPicker').style.display = 'block';
  }
  // If it's my own fighter, leave partner unselected. The user picks a
  // partner; once the picker renders, the give-side row gets pre-marked.
}

// ========================================================================
// TAB SWITCHING — reuses the .waiver-tab pattern
// ========================================================================
function wireUpTabs() {
  document.querySelector('.waiver-tabs').addEventListener('click', function(e) {
    var btn = e.target.closest('.waiver-tab');
    if (!btn) return;

    document.querySelectorAll('.waiver-tab').forEach(function(b) {
      b.classList.toggle('waiver-tab--active', b === btn);
    });

    var tab = btn.getAttribute('data-tab');
    document.getElementById('proposeSection').style.display  = tab === 'propose'  ? '' : 'none';
    document.getElementById('incomingSection').style.display = tab === 'incoming' ? '' : 'none';
    document.getElementById('pendingSection').style.display  = tab === 'pending'  ? '' : 'none';
    document.getElementById('sentSection').style.display     = tab === 'sent'     ? '' : 'none';
  });
}

// ========================================================================
// PARTNER SELECT
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
// Two-column list of fighters. Each row toggles between selected/unselected
// on click. Uses the design-system .lineup-roster-row class so cards look
// consistent with the rest of the app.
// ========================================================================
function renderRosterPicker(partnerId) {
  var myFighterIds    = allRosters.filter(function(r) { return r.league_member_id === myMemberId; }).map(function(r) { return r.fighter_id; });
  var theirFighterIds = allRosters.filter(function(r) { return r.league_member_id === partnerId; }).map(function(r) { return r.fighter_id; });

  var sortByRank = function(a, b) {
    var ra = a.is_champion ? 0 : (a.current_rank || 999);
    var rb = b.is_champion ? 0 : (b.current_rank || 999);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  };

  var myFighters    = myFighterIds.map(function(id) { return allFighters[id]; }).filter(Boolean).sort(sortByRank);
  var theirFighters = theirFighterIds.map(function(id) { return allFighters[id]; }).filter(Boolean).sort(sortByRank);

  document.getElementById('yourRosterList').innerHTML  = buildPickerList(myFighters, 'give');
  document.getElementById('theirRosterList').innerHTML = buildPickerList(theirFighters, 'receive');

  // Wire row clicks (whole row toggles)
  document.querySelectorAll('#yourRosterList .trade-pick-row').forEach(function(row) {
    row.addEventListener('click', function() {
      togglePick(row, giving, 'youGiveCount');
    });
  });
  document.querySelectorAll('#theirRosterList .trade-pick-row').forEach(function(row) {
    row.addEventListener('click', function() {
      togglePick(row, receiving, 'youReceiveCount');
    });
  });

  // Wire fighter-name clicks separately so they open the modal instead of
  // toggling. stopPropagation prevents the row click from firing too.
  document.querySelectorAll('.trade-pick-row [data-open-fighter]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      showFighterModal(btn.getAttribute('data-open-fighter'));
    });
  });

  // Re-apply any prefill from the URL — the picker just rebuilt, so any
  // selected state is gone. If `prefillFighterId` is among the rows, mark
  // it as selected on whichever side it appears.
  if (prefillFighterId) {
    var giveRow = document.querySelector(
      '#yourRosterList .trade-pick-row[data-fighter-id="' + prefillFighterId + '"]'
    );
    if (giveRow && !giving.has(prefillFighterId)) {
      togglePick(giveRow, giving, 'youGiveCount');
    }
    var recRow = document.querySelector(
      '#theirRosterList .trade-pick-row[data-fighter-id="' + prefillFighterId + '"]'
    );
    if (recRow && !receiving.has(prefillFighterId)) {
      togglePick(recRow, receiving, 'youReceiveCount');
    }
  }
}

function togglePick(row, set, counterId) {
  var fighterId = row.getAttribute('data-fighter-id');
  if (set.has(fighterId)) {
    set.delete(fighterId);
    row.classList.remove('trade-pick-row--selected');
  } else {
    set.add(fighterId);
    row.classList.add('trade-pick-row--selected');
  }
  document.getElementById(counterId).textContent = '(' + set.size + ' selected)';
}

function buildPickerList(fighters, side) {
  if (fighters.length === 0) {
    return EmptyState.html({
      kind:    'roster',
      title:   'No fighters on this roster',
      compact: true
    });
  }

  var html = '';
  fighters.forEach(function(f) {
    var rankLabel = f.is_champion ? 'C' : (f.current_rank ? '#' + f.current_rank : 'NR');
    var rankClass = f.is_champion ? 'rank-champion' : (f.current_rank ? 'rank-ranked' : 'rank-unranked');
    var subBadge = '';
    if (f.is_sub_champion && f.sub_title_type === 'interim') {
      subBadge = '<span class="subrank-badge subrank-interim">INT</span>';
    } else if (f.is_sub_champion && f.sub_title_type === 'bmf') {
      subBadge = '<span class="subrank-badge subrank-bmf">BMF</span>';
    }
    var divLabel  = TRADE_DIVISION_LABELS[f.primary_division] || f.primary_division;
    var record    = f.record_wins + '-' + f.record_losses + (f.record_draws ? '-' + f.record_draws : '');
    var photoHtml = f.photo_url
      ? '<img class="lineup-roster-row__photo" src="' + escapeHtml(f.photo_url) + '" alt="' + escapeHtml(f.name) + '" onerror="this.style.display=\'none\'">'
      : '';

    html +=
      '<div class="lineup-roster-row trade-pick-row" data-fighter-id="' + f.id + '" data-side="' + side + '">' +
        '<div class="lineup-roster-row__photo-wrap">' + photoHtml + '</div>' +
        '<span class="lineup-roster-row__rank ' + rankClass + '">' + rankLabel + subBadge + '</span>' +
        '<div class="lineup-roster-row__info">' +
          '<button class="lineup-roster-row__name" data-open-fighter="' + f.id + '">' + escapeHtml(f.name) + '</button>' +
          '<span class="lineup-roster-row__division">' + escapeHtml(divLabel) + '</span>' +
        '</div>' +
        '<span class="lineup-roster-row__record">' + record + '</span>' +
        '<span class="trade-pick-indicator" aria-hidden="true">✓</span>' +
      '</div>';
  });
  return html;
}

// ========================================================================
// PROPOSE TRADE
// ========================================================================
async function proposeTrade() {
  var partnerId = document.getElementById('partnerSelect').value;
  if (!partnerId) { alert('Please select a trade partner.'); return; }
  if (giving.size === 0)    { alert('Select at least one fighter you are giving.'); return; }
  if (receiving.size === 0) { alert('Select at least one fighter you want to receive.'); return; }

  var message = document.getElementById('tradeMessage').value.trim() || null;

  var btn = document.getElementById('proposeBtn');
  btn.disabled = true;
  btn.textContent = 'Sending...';

  var givingArr    = Array.from(giving);
  var receivingArr = Array.from(receiving);

  var insertRes = await supabaseClient.from('trades').insert({
    league_id:    leagueId,
    proposer_id:  myMemberId,
    recipient_id: partnerId,
    trade_details: {
      proposer_gives:  givingArr,
      recipient_gives: receivingArr
    },
    status:      'proposed',
    message:     message,
    proposed_at: new Date().toISOString()
  }).select('id').single();

  btn.disabled = false;
  btn.textContent = 'Send Trade Offer';

  if (insertRes.error) { alert('Error sending trade: ' + insertRes.error.message); return; }

  // Activity feed: trade_proposed. Denormalize fighter names + recipient
  // team name so the feed entry stays readable without joins.
  if (typeof LeagueActivity !== 'undefined') {
    var recipientMember = (members || []).find(function(m) { return m.id === partnerId; });
    LeagueActivity.logEvent(leagueId, LeagueActivity.KINDS.TRADE_PROPOSED, {
      trade_id:                  insertRes.data ? insertRes.data.id : null,
      recipient_member_id:       partnerId,
      recipient_team_name:       recipientMember ? recipientMember.team_name : null,
      offered_fighter_ids:       givingArr,
      offered_fighter_names:     givingArr.map(function(id) { return allFighters[id] ? allFighters[id].name : null; }).filter(Boolean),
      requested_fighter_ids:     receivingArr,
      requested_fighter_names:   receivingArr.map(function(id) { return allFighters[id] ? allFighters[id].name : null; }).filter(Boolean)
    }, myMemberId);
  }

  // Reset form
  giving.clear();
  receiving.clear();
  prefillFighterId = null;
  document.getElementById('partnerSelect').value = '';
  document.getElementById('rosterPicker').style.display = 'none';
  document.getElementById('tradeMessage').value = '';
  document.getElementById('youGiveCount').textContent    = '(0 selected)';
  document.getElementById('youReceiveCount').textContent = '(0 selected)';

  await refreshTrades();
  alert('Trade offer sent.');
}

// ========================================================================
// RENDER INCOMING
// ========================================================================
function renderIncoming() {
  var el = document.getElementById('incomingContent');
  var incoming = myTrades.filter(function(t) {
    return t.recipient_id === myMemberId && t.status === 'proposed';
  });

  if (incoming.length === 0) {
    el.innerHTML = EmptyState.html({
      kind:  'trades',
      title: 'No incoming offers',
      body:  'When another manager sends you a trade, it\'ll appear here for you to accept, reject, or counter.'
    });
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
  el.querySelectorAll('.btn-execute-trade').forEach(function(btn) {
    btn.addEventListener('click', function() { executeTradeNow(btn.getAttribute('data-trade-id')); });
  });
}

// ========================================================================
// RENDER PENDING
// Accepted trades that are still in the 24h review window. Shown to both
// proposer and recipient so either party can watch the timer (and the
// commissioner can push the trade through from any tab).
// ========================================================================
function renderPending() {
  var el = document.getElementById('pendingContent');

  var pending = myTrades.filter(function(t) {
    return t.status === 'accepted' && !t.executed_at &&
           (t.proposer_id === myMemberId || t.recipient_id === myMemberId);
  });

  if (pending.length === 0) {
    el.innerHTML = EmptyState.html({
      kind:  'trades',
      title: 'No trades in review',
      body:  'Accepted trades sit here for 24 hours before they auto-execute. The commissioner can push them through sooner.'
    });
    return;
  }

  // Soonest auto-execution first
  pending.sort(function(a, b) {
    return new Date(a.responded_at).getTime() - new Date(b.responded_at).getTime();
  });

  var memberMap = {};
  members.forEach(function(m) { memberMap[m.id] = m; });

  var html = '';
  pending.forEach(function(trade) {
    // 'pending' view reuses the trade-card template; the renderer already
    // surfaces the timer strip and the commissioner Push Through button
    // for any in-review trade regardless of view.
    html += renderTradeCard(trade, memberMap, 'pending');
  });
  el.innerHTML = html;

  el.querySelectorAll('.btn-execute-trade').forEach(function(btn) {
    btn.addEventListener('click', function() { executeTradeNow(btn.getAttribute('data-trade-id')); });
  });
}

// ========================================================================
// RENDER SENT
// ========================================================================
function renderSent() {
  var el = document.getElementById('sentContent');
  var sent = myTrades.filter(function(t) { return t.proposer_id === myMemberId; });

  if (sent.length === 0) {
    el.innerHTML = EmptyState.html({
      kind:  'trades',
      title: 'No trade offers sent',
      body:  'Propose a swap with another manager and it\'ll show up here while they decide.'
    });
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
  el.querySelectorAll('.btn-execute-trade').forEach(function(btn) {
    btn.addEventListener('click', function() { executeTradeNow(btn.getAttribute('data-trade-id')); });
  });
}

// ========================================================================
// RENDER TRADE CARD
// Mirrors the visual of .waiver-pending-card but with two fighter columns
// and an arrow between them (like the standings/activity feed).
// ========================================================================
function renderTradeCard(trade, memberMap, view) {
  var proposer  = memberMap[trade.proposer_id];
  var recipient = memberMap[trade.recipient_id];
  var details   = trade.trade_details || {};
  var propGives = details.proposer_gives  || [];
  var recGives  = details.recipient_gives || [];

  // Derived UI state
  var isProposed       = trade.status === 'proposed';
  var isInReviewWindow = trade.status === 'accepted' && !trade.executed_at;
  var isExecuted       = trade.status === 'accepted' && !!trade.executed_at;
  var isResolved       = !isProposed && !isInReviewWindow; // executed / rejected / cancelled

  // Pick a badge label + class. We override the raw status for the in-review
  // and executed cases so users see what's actually happening.
  var badgeLabel, badgeClass;
  if (isProposed)            { badgeLabel = 'Proposed';        badgeClass = 'badge-pending';   }
  else if (isInReviewWindow) { badgeLabel = 'Pending review';  badgeClass = 'badge-pending';   }
  else if (isExecuted)       { badgeLabel = 'Completed';       badgeClass = 'badge-approved';  }
  else if (trade.status === 'rejected')  { badgeLabel = 'Rejected';  badgeClass = 'badge-rejected'; }
  else if (trade.status === 'cancelled') { badgeLabel = 'Cancelled'; badgeClass = 'badge-cancelled'; }
  else                       { badgeLabel = trade.status;      badgeClass = ''; }

  var date = trade.proposed_at
    ? new Date(trade.proposed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '';

  // Inline SVG "swap" arrow — matches the nav-tab trade icon for a
  // consistent visual language across the app.
  var swapSvg =
    '<svg class="trade-card__arrow-svg" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.75" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M4 9h13" /><path d="m14 6 3 3-3 3" />' +
      '<path d="M20 15H7" /><path d="m10 18-3-3 3-3" />' +
    '</svg>';

  // Value indicator — sum FV on each side, show "+X.X FV" on whichever
  // side gets the bigger haul. Hidden when FV isn't loaded or the trade
  // is even-FV (within 0.5 — too noisy to call out).
  var propFv      = tradeSideFvTotal(propGives);
  var recFv       = tradeSideFvTotal(recGives);
  // From each side's perspective: you "get" what the OTHER side gives.
  var proposerGets = recFv;
  var recipientGets = propFv;
  var fvDelta = Math.abs(proposerGets - recipientGets);
  var fvIndicator = '';
  if ((propFv > 0 || recFv > 0) && fvDelta >= 0.5) {
    var favoredSide = proposerGets > recipientGets ? 'proposer' : 'recipient';
    fvIndicator =
      '<span class="trade-card__value-indicator trade-card__value-indicator--' + favoredSide + '" ' +
            'title="Side getting more Fantasy Value">' +
        '+' + fvDelta.toFixed(1) + ' FV' +
      '</span>';
  }

  var html =
    '<div class="trade-card' + (isResolved ? ' trade-card--resolved' : '') + '">' +
      '<div class="trade-card__header">' +
        '<span class="trade-card__teams">' +
          escapeHtml(proposer ? proposer.team_name : '?') +
          ' <span class="trade-card__arrow">' + swapSvg + '</span> ' +
          escapeHtml(recipient ? recipient.team_name : '?') +
        '</span>' +
        '<span class="trade-card__meta">' +
          '<span class="waiver-status-badge ' + badgeClass + '">' + escapeHtml(badgeLabel) + '</span>' +
          (date ? '<span class="trade-card__date">' + escapeHtml(date) + '</span>' : '') +
        '</span>' +
      '</div>' +

      '<div class="trade-card__sides">' +
        renderTradeSide(proposer, propGives) +
        '<span class="trade-card__divider" aria-hidden="true">' +
          swapSvg +
          fvIndicator +
        '</span>' +
        renderTradeSide(recipient, recGives) +
      '</div>';

  // Review-window timer strip — visible to both sides while pending review
  if (isInReviewWindow) {
    var executesAt = tradeAutoExecuteAt(trade);
    var now        = new Date();
    var timerText  = executesAt
      ? 'Auto-executes ' + formatEtDateTime(executesAt) +
        ' (' + formatRelativeShort(executesAt, now) + ')'
      : 'Auto-executes when 24h review elapses';
    html +=
      '<p class="trade-card__timer">' +
        '<strong>Pending review.</strong> ' + escapeHtml(timerText) + '.' +
        (isCommissioner
          ? ' As commissioner, you can push it through sooner using the button below.'
          : ' The commissioner can push it through sooner.') +
      '</p>';
  }

  // Executed footer — show when the swap actually happened
  if (isExecuted && trade.executed_at) {
    var execDate = new Date(trade.executed_at)
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    html += '<p class="trade-card__timer trade-card__timer--done">' +
              'Rosters swapped ' + escapeHtml(execDate) + '.' +
            '</p>';
  }

  if (trade.message) {
    html += '<p class="trade-card__message">"' + escapeHtml(trade.message) + '"</p>';
  }

  // Action buttons — depend on view, status, and commissioner role
  var actions = '';

  if (view === 'incoming' && isProposed) {
    actions +=
      '<button class="btn-ghost btn-reject"   data-trade-id="' + trade.id + '">Reject</button>' +
      '<button class="btn-primary btn-accept" data-trade-id="' + trade.id + '">Accept</button>';
  } else if (view === 'sent' && isProposed) {
    actions +=
      '<button class="btn-ghost btn-cancel-trade" data-trade-id="' + trade.id + '">Cancel Offer</button>';
  }

  // Commissioner can force-push a trade in the review window from either tab
  if (isInReviewWindow && isCommissioner) {
    actions +=
      '<button class="btn-primary btn-execute-trade" data-trade-id="' + trade.id + '">' +
        'Push Through Now' +
      '</button>';
  }

  if (actions) {
    html += '<div class="trade-card__actions">' + actions + '</div>';
  }

  html += '</div>';
  return html;
}

// Sum the Fantasy Value of every fighter in a list. Returns 0 if FV isn't
// loaded yet or any fighter is unknown — the divider just hides itself.
function tradeSideFvTotal(fighterIds) {
  if (typeof FantasyValue === 'undefined' || !FantasyValue.scoreFor) return 0;
  var total = 0;
  for (var i = 0; i < fighterIds.length; i++) {
    var v = FantasyValue.scoreFor(fighterIds[i]);
    if (typeof v === 'number') total += v;
  }
  return total;
}

function renderTradeFighterTile(f) {
  if (!f) {
    return '<div class="trade-fighter-tile trade-fighter-tile--missing">' +
             '<span>Unknown fighter</span>' +
           '</div>';
  }

  var divLabel = TRADE_DIVISION_LABELS[f.primary_division] || f.primary_division;
  var rankLabel = f.is_champion ? 'C' : (f.current_rank ? '#' + f.current_rank : 'NR');
  var rankClass = f.is_champion ? 'trade-fighter-tile__rank--champ'
                : (f.current_rank ? 'trade-fighter-tile__rank--ranked'
                                  : 'trade-fighter-tile__rank--unranked');

  var photoHtml = f.photo_url
    ? '<img class="trade-fighter-tile__photo" src="' + escapeHtml(f.photo_url) +
      '" alt="' + escapeHtml(f.name) + '" onerror="this.style.display=\'none\'">'
    : '';

  // Fantasy Value chip — only renders if FV is loaded for this fighter.
  var fvHtml = '';
  if (typeof FantasyValue !== 'undefined' && FantasyValue.scoreFor) {
    var fv = FantasyValue.scoreFor(f.id);
    if (typeof fv === 'number') {
      fvHtml = '<span class="trade-fighter-tile__fv">FV ' + fv.toFixed(1) + '</span>';
    }
  }

  return (
    '<div class="trade-fighter-tile">' +
      '<div class="trade-fighter-tile__photo-wrap">' +
        photoHtml +
      '</div>' +
      '<div class="trade-fighter-tile__info">' +
        '<span class="trade-fighter-tile__name">' + escapeHtml(f.name) + '</span>' +
        '<span class="trade-fighter-tile__meta">' +
          '<span class="trade-fighter-tile__rank ' + rankClass + '">' + rankLabel + '</span>' +
          '<span class="trade-fighter-tile__div">' + escapeHtml(divLabel) + '</span>' +
        '</span>' +
        (fvHtml ? '<span class="trade-fighter-tile__chips">' + fvHtml + '</span>' : '') +
      '</div>' +
    '</div>'
  );
}

function renderTradeSide(member, fighterIds) {
  var html = '<div class="trade-card__side">' +
               '<span class="trade-card__side-label">' +
                 escapeHtml(member ? member.team_name : '?') + ' gives' +
               '</span>' +
               '<div class="trade-card__tiles">';
  if (fighterIds.length === 0) {
    html += '<div class="trade-fighter-tile trade-fighter-tile--empty"><span>—</span></div>';
  } else {
    fighterIds.forEach(function(id) {
      html += renderTradeFighterTile(allFighters[id]);
    });
  }
  html += '</div></div>';
  return html;
}

// ========================================================================
// ACCEPT TRADE
// Sets the trade to status='accepted' and stamps responded_at — but does
// NOT swap rosters. The 24-hour review window starts now. Rosters move
// when either:
//   * the lazy processor finds responded_at + 24h <= now, or
//   * the commissioner force-executes it from the trade card.
// ========================================================================
async function acceptTrade(tradeId) {
  var trade = myTrades.find(function(t) { return t.id === tradeId; });
  if (!trade) return;

  if (!confirm(
    'Accept this trade?\n\n' +
    'It will enter a 24-hour review window. Rosters update automatically when ' +
    'the timer expires, or the commissioner can push it through sooner.'
  )) return;

  var upd = await supabaseClient.from('trades')
    .update({ status: 'accepted', responded_at: new Date().toISOString() })
    .eq('id', tradeId);

  if (upd.error) { alert('Error accepting trade: ' + upd.error.message); return; }

  // Activity feed: trade_accepted. Capture both sides of the swap so the
  // feed line reads "X for Y" without a JOIN at render time.
  if (typeof LeagueActivity !== 'undefined') {
    var details   = trade.trade_details || {};
    var propGives = details.proposer_gives  || [];
    var recGives  = details.recipient_gives || [];
    var proposer  = (members || []).find(function(m) { return m.id === trade.proposer_id;  });
    LeagueActivity.logEvent(leagueId, LeagueActivity.KINDS.TRADE_ACCEPTED, {
      trade_id:                trade.id,
      proposer_member_id:      trade.proposer_id,
      proposer_team_name:      proposer ? proposer.team_name : null,
      // Names — from the perspective of the proposer, "offered" goes out,
      // "requested" comes back. Mirroring the proposeTrade naming for
      // consistency in the feed renderer.
      offered_fighter_names:   propGives.map(function(id) { return allFighters[id] ? allFighters[id].name : null; }).filter(Boolean),
      requested_fighter_names: recGives.map(function(id)  { return allFighters[id] ? allFighters[id].name : null; }).filter(Boolean)
    }, myMemberId);
  }

  await refreshTrades();
}

// ========================================================================
// EXECUTE TRADE
// Performs the actual roster swap and stamps executed_at. Called by the
// lazy processor and by the commissioner's "Push Through Now" button.
// Idempotent: skipped if executed_at is already set.
// ========================================================================
async function executeTradeNow(tradeId) {
  var trade = myTrades.find(function(t) { return t.id === tradeId; });
  if (!trade)                          return;
  if (trade.status !== 'accepted')     return;
  if (trade.executed_at)               return;

  if (!isCommissioner) {
    alert('Only the commissioner can push a trade through before its 24-hour review expires.');
    return;
  }
  if (!confirm('Push this trade through immediately? Rosters update right now.')) return;

  await executeTrade(trade);
  await refreshTrades();
}

// Internal helper — does the swap and stamps executed_at. No confirmation,
// no permission check (callers handle that).
async function executeTrade(trade) {
  var details     = trade.trade_details || {};
  var propGives   = details.proposer_gives  || [];   // proposer → recipient
  var recGives    = details.recipient_gives || [];   // recipient → proposer
  var proposerId  = trade.proposer_id;
  var recipientId = trade.recipient_id;

  // Move proposer's fighters to recipient
  for (var i = 0; i < propGives.length; i++) {
    var del = await supabaseClient.from('rosters')
      .delete()
      .eq('league_id', leagueId)
      .eq('league_member_id', proposerId)
      .eq('fighter_id', propGives[i]);
    if (del.error) { alert('Error removing fighter from proposer roster: ' + del.error.message); return false; }

    var ins = await supabaseClient.from('rosters').insert({
      league_id: leagueId,
      league_member_id: recipientId,
      fighter_id: propGives[i],
      acquired_method: 'trade'
    });
    if (ins.error) { alert('Error adding fighter to recipient roster: ' + ins.error.message); return false; }
  }

  // Move recipient's fighters to proposer
  for (var j = 0; j < recGives.length; j++) {
    var del2 = await supabaseClient.from('rosters')
      .delete()
      .eq('league_id', leagueId)
      .eq('league_member_id', recipientId)
      .eq('fighter_id', recGives[j]);
    if (del2.error) { alert('Error removing fighter from recipient roster: ' + del2.error.message); return false; }

    var ins2 = await supabaseClient.from('rosters').insert({
      league_id: leagueId,
      league_member_id: proposerId,
      fighter_id: recGives[j],
      acquired_method: 'trade'
    });
    if (ins2.error) { alert('Error adding fighter to proposer roster: ' + ins2.error.message); return false; }
  }

  // Stamp executed_at — keeps status='accepted', signals the swap is done
  var upd = await supabaseClient.from('trades')
    .update({ executed_at: new Date().toISOString() })
    .eq('id', trade.id);

  if (upd.error) { alert('Roster swap completed but executed_at update failed: ' + upd.error.message); return false; }

  // Mirror locally so subsequent renders see the new state
  trade.executed_at = new Date().toISOString();
  return true;
}

// ========================================================================
// LAZY PROCESSOR — runs at every page load. Finds any of MY trades whose
// 24-hour review window has expired and executes them.
//
// NOTE: only the proposer or recipient sees their own trades (RLS), so the
// processor only runs against trades the current user can see. This is fine
// for both sides — whichever party visits first triggers execution. It's
// the same lazy-processing trade-off documented in PRD §4.6 Phase 2.
// ========================================================================
async function runLazyTradeProcessor() {
  var now = Date.now();
  var due = myTrades.filter(function(t) {
    if (t.status !== 'accepted')        return false;
    if (t.executed_at)                  return false;
    if (!t.responded_at)                return false;
    return new Date(t.responded_at).getTime() + TRADE_REVIEW_WINDOW_MS <= now;
  });
  if (due.length === 0) return;

  for (var i = 0; i < due.length; i++) {
    await executeTrade(due[i]);
  }

  // Rosters changed — re-pull so the picker reflects post-trade state
  var rostersRes = await supabaseClient
    .from('rosters')
    .select('fighter_id, league_member_id')
    .eq('league_id', leagueId);
  if (!rostersRes.error) allRosters = rostersRes.data || [];
}

// When does this trade auto-execute? Returns a Date or null.
function tradeAutoExecuteAt(trade) {
  if (!trade.responded_at) return null;
  return new Date(new Date(trade.responded_at).getTime() + TRADE_REVIEW_WINDOW_MS);
}

// ========================================================================
// REJECT / CANCEL TRADE
// ========================================================================
async function respondToTrade(tradeId, newStatus) {
  var label = newStatus === 'cancelled' ? 'Cancel this trade offer?' : 'Reject this trade offer?';
  if (!confirm(label)) return;

  var trade = myTrades.find(function(t) { return t.id === tradeId; });

  var { error } = await supabaseClient.from('trades')
    .update({ status: newStatus, responded_at: new Date().toISOString() })
    .eq('id', tradeId);

  if (error) { alert('Error updating trade: ' + error.message); return; }

  // Activity feed: log only rejections. Cancellations are the proposer
  // pulling their own offer back; not interesting to the wider league.
  if (newStatus === 'rejected' && trade && typeof LeagueActivity !== 'undefined') {
    var proposer = (members || []).find(function(m) { return m.id === trade.proposer_id; });
    LeagueActivity.logEvent(leagueId, LeagueActivity.KINDS.TRADE_REJECTED, {
      trade_id:           trade.id,
      proposer_member_id: trade.proposer_id,
      proposer_team_name: proposer ? proposer.team_name : null
    }, myMemberId);
  }

  await refreshTrades();
}

// ========================================================================
// REFRESH
// ========================================================================
async function refreshTrades() {
  const [rostersRes, tradesRes] = await Promise.all([
    supabaseClient.from('rosters').select('fighter_id, league_member_id').eq('league_id', leagueId),
    supabaseClient.from('trades').select('*').eq('league_id', leagueId).order('proposed_at', { ascending: false })
  ]);

  allRosters = rostersRes.data || [];
  myTrades   = (tradesRes.data || []).filter(function(t) {
    return t.proposer_id === myMemberId || t.recipient_id === myMemberId;
  });

  renderIncoming();
  renderPending();
  renderSent();
  updateTabBadges();

  // Re-render picker if a partner is currently selected
  var partnerId = document.getElementById('partnerSelect').value;
  if (partnerId) {
    giving.clear();
    receiving.clear();
    document.getElementById('youGiveCount').textContent    = '(0 selected)';
    document.getElementById('youReceiveCount').textContent = '(0 selected)';
    renderRosterPicker(partnerId);
  }
}

// Updates the count badges on the Incoming and Pending tabs.
function updateTabBadges() {
  var incomingCount = myTrades.filter(function(t) {
    return t.recipient_id === myMemberId && t.status === 'proposed';
  }).length;
  var pendingCount = myTrades.filter(function(t) {
    return t.status === 'accepted' && !t.executed_at &&
           (t.proposer_id === myMemberId || t.recipient_id === myMemberId);
  }).length;

  setBadge('incomingBadge', incomingCount);
  setBadge('pendingBadge',  pendingCount);
}

function setBadge(id, count) {
  var badge = document.getElementById(id);
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = '';
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
