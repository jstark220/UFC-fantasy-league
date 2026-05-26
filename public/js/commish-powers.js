// ========================================================================
// COMMISH POWERS
// Standalone admin page giving commissioners direct control over rosters,
// scoring, and trades. Three tabs:
//
//   Rosters — pick a team, add/remove fighters. Roster row inserts are
//             stamped acquired_method='commish' so the activity log /
//             waiver flow can tell them apart from waiver/trade adds.
//
//   Scores  — links to the existing score-event.html surface where
//             commish fight stats are entered. Re-using the canonical
//             editor instead of duplicating it.
//
//   Trades  — lists executed trades with a "Reverse" button. Reversal
//             swaps fighters back to their original team and stamps
//             trade_details.reversed_at so the row stays for audit but
//             is treated as undone by downstream surfaces.
//
// RLS is the real gate — every write below assumes the row passes the
// commissioner check at the database level. The UI also hides the page's
// entry button for non-commish so casual users never see destructive
// affordances.
// ========================================================================

var leagueId, user, myMember, isCommish;
var league;
var members      = [];
var allFighters  = [];
var fighterMap   = {};
var memberMap    = {};
var rosters      = [];          // { id, league_member_id, fighter_id, acquired_method, ... }
var events       = [];          // ufc_events rows
var trades       = [];          // trades rows

document.addEventListener('DOMContentLoaded', initCommishPowers);

async function initCommishPowers() {
  user = await requireAuth();
  if (!user) return;

  leagueId = new URLSearchParams(window.location.search).get('id');
  if (!leagueId) { window.location.href = 'dashboard.html'; return; }

  document.getElementById('backToLeague').href = 'league.html?id=' + leagueId;

  // Load league + members + fighters in parallel.
  var res = await Promise.all([
    supabaseClient.from('leagues').select('id, name, commissioner_id, draft_started, draft_completed, scoring_config, roster_size').eq('id', leagueId).single(),
    supabaseClient.from('league_members').select('id, user_id, team_name, is_commissioner').eq('league_id', leagueId),
    supabaseClient.from('fighters').select('id, name, primary_division, current_rank, is_champion, is_sub_champion, sub_title_type, photo_url, record_wins, record_losses, record_draws')
  ]);

  var leagueRes  = res[0];
  var membersRes = res[1];
  var fightersRes = res[2];

  if (leagueRes.error || !leagueRes.data) {
    window.location.href = 'dashboard.html';
    return;
  }
  league  = leagueRes.data;
  members = membersRes.data || [];
  allFighters = fightersRes.data || [];

  members.forEach(function(m) { memberMap[m.id] = m; });
  allFighters.forEach(function(f) { fighterMap[f.id] = f; });

  myMember = members.find(function(m) { return m.user_id === user.id; });
  if (!myMember) { window.location.href = 'dashboard.html'; return; }

  // Local commish gate. Server-side RLS is still authoritative on writes,
  // but failing fast here keeps a non-commish member from seeing the
  // half-loaded page state if they navigate here by typing the URL.
  isCommish = (typeof Commissioner !== 'undefined')
    ? Commissioner.isCommissioner(league, members, user.id)
    : (league.commissioner_id === user.id);
  if (!isCommish) {
    alert('Commissioner access only.');
    window.location.href = 'league.html?id=' + leagueId;
    return;
  }

  document.title = 'Commish Powers - ' + league.name;
  document.getElementById('leagueName').textContent = league.name;

  // Shared "? How it works" primer.
  if (typeof LeaguePrimer !== 'undefined') {
    LeaguePrimer.install(league);
  }

  setupTabs();
  document.getElementById('pageContent').style.display = 'block';

  // Each tab loads its own data lazily on first activation. Rosters is the
  // default-visible tab so we kick its data off immediately.
  loadRostersTab();
}

// ========================================================================
// TAB SWITCHING
// ========================================================================
function setupTabs() {
  var buttons = document.querySelectorAll('[data-commish-tab]');
  buttons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      var key = btn.getAttribute('data-commish-tab');
      buttons.forEach(function(b) { b.classList.toggle('waiver-tab--active', b === btn); });
      document.getElementById('commishRostersSection').hidden = key !== 'rosters';
      document.getElementById('commishScoresSection').hidden  = key !== 'scores';
      document.getElementById('commishTradesSection').hidden  = key !== 'trades';
      // Lazy-load the destination tab's data the first time it's viewed.
      if (key === 'scores' && !events.length)  loadScoresTab();
      if (key === 'trades' && !trades.length)  loadTradesTab();
    });
  });
}

// ========================================================================
// MESSAGE STRIP — top-of-page feedback banner shared by all three tabs.
// ========================================================================
function showMessage(text, kind) {
  var el = document.getElementById('commishMessage');
  if (!el) return;
  el.textContent = text;
  el.className   = 'settings-message settings-message--' + (kind || 'success');
  el.style.display = 'block';
  setTimeout(function() { el.style.display = 'none'; }, 4500);
}

// ========================================================================
// ROSTERS TAB
// Pick a team, see their roster, remove fighters, add fighters. All
// inserts marked acquired_method='commish' so they're distinguishable
// from waiver / draft / trade adds in activity logs.
// ========================================================================
async function loadRostersTab() {
  var rosterRes = await supabaseClient
    .from('rosters')
    .select('id, league_member_id, fighter_id, acquired_method, acquired_at')
    .eq('league_id', leagueId);
  if (rosterRes.error) {
    showMessage('Failed to load rosters: ' + rosterRes.error.message, 'error');
    return;
  }
  rosters = rosterRes.data || [];

  // Populate team picker. Sorts members by team name for predictable order.
  var sel = document.getElementById('commishTeamSelect');
  sel.innerHTML = '<option value="">— Pick a team —</option>' +
    members.slice().sort(function(a, b) {
      return (a.team_name || '').localeCompare(b.team_name || '');
    }).map(function(m) {
      return '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.team_name || '?') + '</option>';
    }).join('');

  sel.addEventListener('change', function() {
    renderRosterPane(sel.value);
  });

  renderRosterPane('');
}

function renderRosterPane(memberId) {
  var pane = document.getElementById('commishRosterPane');
  if (!memberId) {
    pane.innerHTML = '<p class="commish-empty">Pick a team to view their roster.</p>';
    return;
  }
  var member = memberMap[memberId];
  var theirRoster = rosters
    .filter(function(r) { return r.league_member_id === memberId; })
    .map(function(r) {
      var f = fighterMap[r.fighter_id];
      return f ? { roster: r, fighter: f } : null;
    })
    .filter(Boolean)
    .sort(function(a, b) { return (a.fighter.name || '').localeCompare(b.fighter.name || ''); });

  // Build available-fighters search list (excludes anyone already on ANY
  // roster in this league — adding a duplicate would silently fail RLS).
  var allRosteredIds = new Set(rosters.map(function(r) { return r.fighter_id; }));

  var rowsHtml = theirRoster.length === 0
    ? '<p class="commish-empty">No fighters on this roster yet.</p>'
    : '<ul class="commish-roster-list">' + theirRoster.map(function(item) {
        var f         = item.fighter;
        var rankLabel = f.is_champion ? 'C' : (f.current_rank ? '#' + f.current_rank : 'NR');
        var divLabel  = (typeof DIVISION_LABELS !== 'undefined' && DIVISION_LABELS[f.primary_division]) || f.primary_division || '';
        var photo     = f.photo_url
          ? '<img class="commish-roster-list__photo" src="' + escapeHtml(f.photo_url) + '" alt="">'
          : '<div class="commish-roster-list__photo commish-roster-list__photo--placeholder"></div>';
        return '<li class="commish-roster-list__row">' +
          photo +
          '<div class="commish-roster-list__info">' +
            '<span class="commish-roster-list__name">' + escapeHtml(f.name) + '</span>' +
            '<span class="commish-roster-list__meta">' + escapeHtml(rankLabel) + ' · ' + escapeHtml(divLabel) +
              ' · acquired via ' + escapeHtml(item.roster.acquired_method || 'unknown') + '</span>' +
          '</div>' +
          '<button class="btn-ghost commish-roster-list__remove" data-remove-roster-id="' + escapeHtml(item.roster.id) + '" data-fighter-name="' + escapeHtml(f.name) + '">Remove</button>' +
        '</li>';
      }).join('') + '</ul>';

  // Add-fighter search input + result picker. We don't pre-render every
  // unrostered fighter (could be 5000+); render on demand as user types.
  pane.innerHTML =
    '<h3 class="commish-roster-pane__title">' + escapeHtml(member ? member.team_name : '?') +
      '<span class="commish-roster-pane__count">(' + theirRoster.length + ' fighters)</span></h3>' +
    rowsHtml +
    '<div class="commish-roster-add">' +
      '<label class="form-label" for="commishAddSearch">Add a fighter</label>' +
      '<input type="text" id="commishAddSearch" class="waiver-search" placeholder="Search by name…" autocomplete="off">' +
      '<div class="commish-roster-add__results" id="commishAddResults" hidden></div>' +
    '</div>';

  // Wire remove buttons
  pane.querySelectorAll('[data-remove-roster-id]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var rosterId   = btn.getAttribute('data-remove-roster-id');
      var fighterName = btn.getAttribute('data-fighter-name');
      removeFromRoster(rosterId, fighterName, memberId);
    });
  });

  // Wire add-fighter search
  var searchEl  = document.getElementById('commishAddSearch');
  var resultsEl = document.getElementById('commishAddResults');
  searchEl.addEventListener('input', function() {
    var q = searchEl.value.trim().toLowerCase();
    if (q.length < 2) { resultsEl.hidden = true; resultsEl.innerHTML = ''; return; }
    var matches = allFighters.filter(function(f) {
      return !allRosteredIds.has(f.id) &&
             (f.name || '').toLowerCase().indexOf(q) !== -1;
    }).slice(0, 12);
    if (matches.length === 0) {
      resultsEl.hidden = false;
      resultsEl.innerHTML = '<p class="commish-roster-add__none">No unrostered fighters match.</p>';
      return;
    }
    resultsEl.hidden = false;
    resultsEl.innerHTML = matches.map(function(f) {
      var divLabel = (typeof DIVISION_LABELS !== 'undefined' && DIVISION_LABELS[f.primary_division]) || f.primary_division || '';
      var rank     = f.is_champion ? 'C' : (f.current_rank ? '#' + f.current_rank : 'NR');
      return '<button class="commish-roster-add__result" data-add-fighter-id="' + escapeHtml(f.id) + '" data-fighter-name="' + escapeHtml(f.name) + '" type="button">' +
        '<span class="commish-roster-add__result-rank">' + escapeHtml(rank) + '</span>' +
        '<span class="commish-roster-add__result-name">' + escapeHtml(f.name) + '</span>' +
        '<span class="commish-roster-add__result-div">' + escapeHtml(divLabel) + '</span>' +
      '</button>';
    }).join('');
    resultsEl.querySelectorAll('[data-add-fighter-id]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        addToRoster(memberId, btn.getAttribute('data-add-fighter-id'), btn.getAttribute('data-fighter-name'));
      });
    });
  });
}

async function removeFromRoster(rosterId, fighterName, memberId) {
  if (!confirm('Remove ' + fighterName + ' from this roster?\n\nThe fighter goes back to free agency.')) return;
  var res = await supabaseClient.from('rosters').delete().eq('id', rosterId);
  if (res.error) { showMessage('Remove failed: ' + res.error.message, 'error'); return; }
  // Local mirror
  rosters = rosters.filter(function(r) { return r.id !== rosterId; });
  showMessage(fighterName + ' removed.', 'success');
  renderRosterPane(memberId);
}

async function addToRoster(memberId, fighterId, fighterName) {
  if (!confirm('Add ' + fighterName + ' to this roster?')) return;
  var res = await supabaseClient.from('rosters').insert({
    league_id:        leagueId,
    league_member_id: memberId,
    fighter_id:       fighterId,
    acquired_method:  'commish'
  }).select().single();
  if (res.error) { showMessage('Add failed: ' + res.error.message, 'error'); return; }
  rosters.push(res.data);
  showMessage(fighterName + ' added.', 'success');
  renderRosterPane(memberId);
}

// ========================================================================
// SCORES TAB
// Lists events with a button to launch the existing score-event editor.
// score-event.html is the canonical fight-stat surface — duplicating that
// UI here would risk drift; instead we surface it as a quick launcher.
// ========================================================================
async function loadScoresTab() {
  var pane = document.getElementById('commishScoresPane');
  pane.innerHTML = '<p class="commish-empty">Loading events…</p>';

  var res = await supabaseClient
    .from('ufc_events')
    .select('id, name, event_date, is_completed')
    .order('event_date', { ascending: false });
  if (res.error) {
    pane.innerHTML = '<p class="commish-empty">Failed to load events: ' + escapeHtml(res.error.message) + '</p>';
    return;
  }
  events = res.data || [];

  if (events.length === 0) {
    pane.innerHTML = '<p class="commish-empty">No events in the system yet.</p>';
    return;
  }

  // The dropdown is for the form; the table beneath lists events as
  // quick-launch buttons. score-event.html only takes ?league=X, so the
  // user picks the event there after we route them in.
  var sel = document.getElementById('commishEventSelect');
  sel.innerHTML = '<option value="">— Pick an event —</option>' +
    events.map(function(e) {
      var label = (e.name || 'Unnamed') + ' · ' + (e.event_date || '').slice(0, 10) +
                  (e.is_completed ? ' · completed' : '');
      return '<option value="' + escapeHtml(e.id) + '">' + escapeHtml(label) + '</option>';
    }).join('');

  pane.innerHTML =
    '<p class="commish-empty" style="text-align:left">Open the dedicated fight-scoring editor below. It walks you through every fight on the event\'s card, with per-fighter stats (sig strikes, takedowns, knockdowns, control time) and the league\'s scoring rules applied in real time.</p>' +
    '<a class="btn-primary" href="score-event.html?league=' + escapeHtml(leagueId) + '">Open Fight Scoring →</a>' +
    '<ul class="commish-events-list">' + events.map(function(e) {
      var status = e.is_completed ? 'completed' : 'upcoming';
      return '<li class="commish-events-list__row">' +
        '<div class="commish-events-list__info">' +
          '<span class="commish-events-list__name">' + escapeHtml(e.name || 'Unnamed') + '</span>' +
          '<span class="commish-events-list__meta">' + escapeHtml((e.event_date || '').slice(0, 10)) + ' · ' + status + '</span>' +
        '</div>' +
        '<a class="btn-ghost" href="score-event.html?league=' + escapeHtml(leagueId) + '">Edit fights →</a>' +
      '</li>';
    }).join('') + '</ul>';
}

// ========================================================================
// TRADES TAB
// Lists executed trades (status='accepted' AND executed_at IS NOT NULL,
// AND not yet reversed). Each row gets a Reverse button. Reversal swaps
// the fighters back to their original team and stamps trade_details
// with a reversed_at timestamp so the row remains for audit but is
// flagged as undone.
// ========================================================================
async function loadTradesTab() {
  var pane = document.getElementById('commishTradesPane');
  pane.innerHTML = '<p class="commish-empty">Loading trades…</p>';

  var res = await supabaseClient
    .from('trades')
    .select('*')
    .eq('league_id', leagueId)
    .not('executed_at', 'is', null)
    .order('executed_at', { ascending: false });
  if (res.error) {
    pane.innerHTML = '<p class="commish-empty">Failed to load trades: ' + escapeHtml(res.error.message) + '</p>';
    return;
  }
  trades = res.data || [];

  renderTradesPane();
}

function renderTradesPane() {
  var pane = document.getElementById('commishTradesPane');
  if (trades.length === 0) {
    pane.innerHTML = '<p class="commish-empty">No executed trades to reverse.</p>';
    return;
  }
  pane.innerHTML = '<ul class="commish-trades-list">' + trades.map(function(t) {
    var details = t.trade_details || {};
    var prop    = memberMap[t.proposer_id];
    var rec     = memberMap[t.recipient_id];
    var propGives = (details.proposer_gives  || []).map(function(id) { return fighterMap[id]; }).filter(Boolean);
    var recGives  = (details.recipient_gives || []).map(function(id) { return fighterMap[id]; }).filter(Boolean);
    var reversed = !!details.reversed_at;
    var executedStr = t.executed_at ? new Date(t.executed_at).toLocaleString() : '';
    return '<li class="commish-trades-list__row' + (reversed ? ' commish-trades-list__row--reversed' : '') + '">' +
      '<div class="commish-trades-list__teams">' +
        '<div class="commish-trades-list__side">' +
          '<p class="commish-trades-list__team">' + escapeHtml(prop ? prop.team_name : '?') + '</p>' +
          '<p class="commish-trades-list__sent">Sent: ' + (propGives.map(function(f) { return escapeHtml(f.name); }).join(', ') || '—') + '</p>' +
        '</div>' +
        '<span class="commish-trades-list__arrow" aria-hidden="true">⇄</span>' +
        '<div class="commish-trades-list__side">' +
          '<p class="commish-trades-list__team">' + escapeHtml(rec ? rec.team_name : '?') + '</p>' +
          '<p class="commish-trades-list__sent">Sent: ' + (recGives.map(function(f) { return escapeHtml(f.name); }).join(', ') || '—') + '</p>' +
        '</div>' +
      '</div>' +
      '<div class="commish-trades-list__meta">Executed ' + escapeHtml(executedStr) + (reversed ? ' · already reversed' : '') + '</div>' +
      (reversed
        ? ''
        : '<button class="btn-ghost commish-trades-list__reverse" data-trade-id="' + escapeHtml(t.id) + '">Reverse this trade</button>') +
    '</li>';
  }).join('') + '</ul>';

  pane.querySelectorAll('[data-trade-id]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      reverseTrade(btn.getAttribute('data-trade-id'));
    });
  });
}

// Swap the fighters back to their original team. Mirrors executeTrade in
// trades.js but in reverse, and stamps trade_details.reversed_at.
async function reverseTrade(tradeId) {
  var trade = trades.find(function(t) { return t.id === tradeId; });
  if (!trade) return;
  var details = trade.trade_details || {};
  if (details.reversed_at) { showMessage('Trade already reversed.', 'error'); return; }

  var propGives = details.proposer_gives  || [];
  var recGives  = details.recipient_gives || [];

  if (!confirm('Reverse this trade?\n\n' +
               propGives.length + ' fighter(s) go back to ' + (memberMap[trade.proposer_id] && memberMap[trade.proposer_id].team_name) + '\n' +
               recGives.length  + ' fighter(s) go back to ' + (memberMap[trade.recipient_id] && memberMap[trade.recipient_id].team_name) +
               '\n\nThis cannot be undone (though you could re-create the trade manually).')) {
    return;
  }

  // propGives are currently with recipient → send back to proposer.
  // (Mirrors executeTrade's loop but with the destination flipped.)
  for (var i = 0; i < propGives.length; i++) {
    var del = await supabaseClient.from('rosters')
      .delete()
      .eq('league_id', leagueId)
      .eq('league_member_id', trade.recipient_id)
      .eq('fighter_id', propGives[i]);
    if (del.error) { showMessage('Reverse failed (proposer-give delete): ' + del.error.message, 'error'); return; }
    var ins = await supabaseClient.from('rosters').insert({
      league_id:        leagueId,
      league_member_id: trade.proposer_id,
      fighter_id:       propGives[i],
      acquired_method:  'trade_reversal'
    });
    if (ins.error) { showMessage('Reverse failed (proposer-give insert): ' + ins.error.message, 'error'); return; }
  }

  // recGives are currently with proposer → send back to recipient.
  for (var j = 0; j < recGives.length; j++) {
    var del2 = await supabaseClient.from('rosters')
      .delete()
      .eq('league_id', leagueId)
      .eq('league_member_id', trade.proposer_id)
      .eq('fighter_id', recGives[j]);
    if (del2.error) { showMessage('Reverse failed (recipient-give delete): ' + del2.error.message, 'error'); return; }
    var ins2 = await supabaseClient.from('rosters').insert({
      league_id:        leagueId,
      league_member_id: trade.recipient_id,
      fighter_id:       recGives[j],
      acquired_method:  'trade_reversal'
    });
    if (ins2.error) { showMessage('Reverse failed (recipient-give insert): ' + ins2.error.message, 'error'); return; }
  }

  // Stamp trade_details.reversed_at so the row remains for audit. We
  // keep status='accepted' and executed_at intact — the trade DID happen,
  // we just undid the roster effect.
  var newDetails = Object.assign({}, details, { reversed_at: new Date().toISOString(), reversed_by: user.id });
  var upd = await supabaseClient.from('trades')
    .update({ trade_details: newDetails })
    .eq('id', tradeId);
  if (upd.error) {
    showMessage('Rosters swapped but trade record update failed: ' + upd.error.message, 'error');
    return;
  }

  // Local mirror so renderTradesPane reflects the reversed state without a refetch.
  trade.trade_details = newDetails;
  showMessage('Trade reversed.', 'success');
  renderTradesPane();
}

// ========================================================================
// HELPERS
// ========================================================================
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  var d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}

// Minimal local division-label map. Keeps this page self-contained instead
// of pulling in the larger lineup/draft modules just for one lookup.
var DIVISION_LABELS = {
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
