// ========================================================================
// LEAGUE PRIMER
// Shared "How Knockdown Fantasy works" modal trigger + content. Used by
// every league-context page (league, lineup, waivers, trades, standings,
// activity, chat, lineups, league-settings, draft, score-event).
//
// How it works:
//   - On any page that includes this script AND has a #leagueName element
//     in the DOM AND a ?id= in the URL, this auto-fetches the league row
//     (scoring_config + roster_size) and registers the modal content with
//     PageHelp, then injects the "? How it works" trigger button right
//     after the league name.
//
//   - Pages that already loaded the league row (e.g. league.js) can call
//     LeaguePrimer.install(leagueRow) directly to skip the extra fetch.
//     A guard prevents double-install.
//
// Dependencies (must load first):
//   js/supabase-config.js  — for supabaseClient
//   js/page-help-modal.js  — for PageHelp.register / attachTrigger
//   js/scoring.js          — for Scoring.SCORING_DEFAULTS_V1_2 (optional fallback)
// ========================================================================

(function (root) {
  var _installed = false;
  var _injected  = false;

  // -----------------------------------------------------------------------
  // Trigger injection — adds the "?" pill right after #leagueName.
  // -----------------------------------------------------------------------
  function injectTrigger() {
    if (_injected) return;
    var nameEl = document.getElementById('leagueName');
    if (!nameEl) return;

    // Some pages might have already hard-coded the button (legacy). Don't
    // duplicate — just mark injected and bail.
    if (document.getElementById('pageHelpTrigger')) {
      _injected = true;
      return;
    }

    var btn = document.createElement('button');
    btn.id        = 'pageHelpTrigger';
    btn.type      = 'button';
    btn.className = 'page-help-trigger';
    btn.setAttribute('aria-label', 'How Knockdown Fantasy works');
    btn.innerHTML =
      '<span class="page-help-trigger__icon" aria-hidden="true">?</span>' +
      '<span class="page-help-trigger__label">How it works</span>';

    // Sits as a sibling immediately after the h1. With .page-help-trigger
    // styled `margin-right: auto`, it stays glued to the name while the
    // page's right-side actions push to the far edge of the header.
    nameEl.insertAdjacentElement('afterend', btn);
    _injected = true;
  }

  // -----------------------------------------------------------------------
  // Number formatting helpers for the scoring section.
  // -----------------------------------------------------------------------
  function fmt(n) {
    var num = Number(n);
    var s   = Number.isInteger(num) ? num.toString() : num.toString();
    return (num >= 0 ? '+' : '') + s;
  }
  function fmtMult(n) {
    return Number(n).toFixed(2).replace(/0$/, '');
  }

  // -----------------------------------------------------------------------
  // Build the modal content from a league row. All numbers are pulled from
  // league.scoring_config / league.roster_size, falling back to v1.2
  // defaults via the Scoring module.
  // -----------------------------------------------------------------------
  function buildPrimerContent(league) {
    var DEFAULTS = (typeof Scoring !== 'undefined' && Scoring.SCORING_DEFAULTS_V1_2)
      ? Scoring.SCORING_DEFAULTS_V1_2
      : {
          sig_strike: 0.1, takedown: 1, knockdown: 2, control_per_sec: 0.01,
          finish_r1: 18, finish_r2: 14, finish_r3: 9, finish_r4_r5: 8,
          decision: 6, quick_win_bonus: 5,
          divisional_title_win: 12, divisional_title_defense: 12,
          bmf_interim_win: 8, bmf_interim_defense: 8,
          top5_win: 8, top10_win: 5, top15_win: 3,
          fotn: 4, main_event_mult: 1.2, co_main_mult: 1.1
        };
    var scoringCfg = (league && league.scoring_config) || {};

    function cfg(key) {
      return scoringCfg[key] != null ? Number(scoringCfg[key]) : DEFAULTS[key];
    }

    var rosterSize  = (league && league.roster_size) ? Number(league.roster_size) : 15;
    var mensSlots   = 8;
    var womensFlex  = 1;
    var anyFlex     = Math.max(0, rosterSize - mensSlots - womensFlex);

    var startersNumbered   = scoringCfg.starters_numbered    != null ? Number(scoringCfg.starters_numbered)    : 3;
    var startersFightNight = scoringCfg.starters_fight_night != null ? Number(scoringCfg.starters_fight_night) : 2;

    return {
      eyebrow: 'Welcome to Knockdown',
      title:   'How Knockdown Fantasy works',
      sections: [
        {
          heading: 'The big idea',
          body:
            '<p>Knockdown Fantasy is a season-long fantasy league built around UFC events. ' +
            'You manage a roster of fighters, pick a few starters before each card, and earn ' +
            'points based on how those starters actually perform inside the octagon — strikes ' +
            'landed, takedowns, finishes, title wins, the works.</p>' +
            '<p>Highest cumulative points at the end of the season wins.</p>'
        },
        {
          heading: 'Your roster',
          body:
            '<p>You own <strong>' + rosterSize + ' fighters</strong> at a time, in three slot categories:</p>' +
            '<ul>' +
              '<li><strong>' + mensSlots + ' men\'s divisions</strong> — one fighter per weight class (flyweight up through heavyweight).</li>' +
              '<li><strong>' + womensFlex + ' Women\'s Flex</strong> — any fighter from the three women\'s divisions.</li>' +
              '<li><strong>' + anyFlex + ' Any-Division Flex</strong> — any fighter, any weight class.</li>' +
            '</ul>' +
            '<p>During event-week the cap temporarily expands: <strong>+' + startersNumbered + ' for numbered PPVs</strong> ' +
            '(UFC 329, UFC 330, …) and <strong>+' + startersFightNight + ' for Fight Nights</strong>. Those extra spots ' +
            '("Temporary Flex") auto-drop the most recently added fighters on Wednesday at 3am ET ' +
            'if you don\'t drop down voluntarily first.</p>'
        },
        {
          heading: 'Setting your lineup',
          body:
            '<p>Before each UFC event, pick your starters from your roster. <strong>Only starters ' +
            'score points.</strong></p>' +
            '<ul>' +
              '<li><strong>' + startersNumbered + ' starters</strong> for numbered PPV events.</li>' +
              '<li><strong>' + startersFightNight + ' starters</strong> for Fight Nights and other non-numbered cards.</li>' +
            '</ul>' +
            '<p>Your lineup locks at the start of the first prelim on event night. After that ' +
            'point you can\'t add, drop, or swap starters until the event finishes.</p>' +
            '<p class="page-help__subheading"><strong>Temporary Flex (TERF) spots</strong></p>' +
            '<p>Between the Thursday waiver window and the post-event auto-drop, your roster cap ' +
            'temporarily grows so you can stash extra options for the upcoming card. The number of ' +
            'extra spots matches the starter count for that event:</p>' +
            '<ul>' +
              '<li><strong>Numbered PPVs:</strong> +' + startersNumbered + ' TERF spots (roster cap ' +
                  rosterSize + ' → <strong>' + (rosterSize + startersNumbered) + '</strong>)</li>' +
              '<li><strong>Fight Nights:</strong> +' + startersFightNight + ' TERF spots (roster cap ' +
                  rosterSize + ' → <strong>' + (rosterSize + startersFightNight) + '</strong>)</li>' +
            '</ul>' +
            '<p>TERF fighters count as full roster members during event week — you can start them, ' +
            'they earn points just like anyone else, and they fill normal slot rules. The catch:</p>' +
            '<ul>' +
              '<li><strong>Drop deadline:</strong> Tuesday at 3am ET. By then your roster has to be ' +
                  'back down to ' + rosterSize + '.</li>' +
              '<li><strong>Auto-drop:</strong> if you\'re still over the cap at Wednesday 3am ET, ' +
                  'your most recently added fighters are dropped automatically until you\'re at ' + rosterSize + '.</li>' +
              '<li><strong>Strategy:</strong> use TERF to scoop a hot one-off matchup, then drop them ' +
                  'before deadline. If you want to keep them, drop someone else first.</li>' +
            '</ul>'
        },
        {
          heading: 'Scoring',
          body:
            '<p>Every starter earns points based on what they actually do in their fight. These ' +
            'numbers come straight from <strong>this league\'s scoring settings</strong> — if your ' +
            'commissioner tweaks them, this page updates automatically:</p>' +
            '<p class="page-help__subheading"><strong>Base scoring (per fight)</strong></p>' +
            '<ul>' +
              '<li>Significant strike landed: <strong>' + fmt(cfg('sig_strike')) + '</strong></li>' +
              '<li>Takedown: <strong>' + fmt(cfg('takedown')) + '</strong></li>' +
              '<li>Knockdown: <strong>' + fmt(cfg('knockdown')) + '</strong></li>' +
              '<li>Control time: <strong>' + fmt(cfg('control_per_sec')) + '/second</strong></li>' +
            '</ul>' +
            '<p class="page-help__subheading"><strong>Win bonuses</strong></p>' +
            '<ul>' +
              '<li>R1 finish: <strong>' + fmt(cfg('finish_r1')) + '</strong> &middot; ' +
                  'R2: <strong>' + fmt(cfg('finish_r2')) + '</strong> &middot; ' +
                  'R3: <strong>' + fmt(cfg('finish_r3')) + '</strong> &middot; ' +
                  'R4/R5: <strong>' + fmt(cfg('finish_r4_r5')) + '</strong></li>' +
              '<li>Decision: <strong>' + fmt(cfg('decision')) + '</strong></li>' +
              '<li>Quick win bonus (R1 finish under 60s): <strong>' + fmt(cfg('quick_win_bonus')) + '</strong></li>' +
            '</ul>' +
            '<p class="page-help__subheading"><strong>Matchup bonuses (winner only)</strong></p>' +
            '<ul>' +
              // Win and defense scores are unified by default (same number).
              // If this league's commissioner has overridden them to differ,
              // show both values; otherwise collapse to a single "win or defense" line.
              (cfg('divisional_title_win') === cfg('divisional_title_defense')
                ? '<li>Divisional title win or defense: <strong>' + fmt(cfg('divisional_title_win')) + '</strong></li>'
                : '<li>Divisional title win: <strong>' + fmt(cfg('divisional_title_win')) + '</strong> &middot; ' +
                      'defense: <strong>' + fmt(cfg('divisional_title_defense')) + '</strong></li>') +
              (cfg('bmf_interim_win') === cfg('bmf_interim_defense')
                ? '<li>Interim or BMF title win or defense: <strong>' + fmt(cfg('bmf_interim_win')) + '</strong></li>'
                : '<li>Interim or BMF title win: <strong>' + fmt(cfg('bmf_interim_win')) + '</strong> &middot; ' +
                      'defense: <strong>' + fmt(cfg('bmf_interim_defense')) + '</strong></li>') +
              '<li>Beating a top-5 opponent: <strong>' + fmt(cfg('top5_win')) + '</strong></li>' +
              '<li>Beating a top-10 opponent: <strong>' + fmt(cfg('top10_win')) + '</strong></li>' +
              '<li>Beating a top-15 opponent: <strong>' + fmt(cfg('top15_win')) + '</strong></li>' +
            '</ul>' +
            '<p><em>Title and ranked-opponent bonuses don\'t stack — only the larger of the two counts. ' +
            'Title-holders count as top-5 talent for the ranked-opponent bonus.</em></p>' +
            '<p class="page-help__subheading"><strong>Performance bonuses</strong></p>' +
            '<ul>' +
              '<li>Fight of the Night: <strong>' + fmt(cfg('fotn')) + '</strong></li>' +
            '</ul>' +
            '<p class="page-help__subheading"><strong>Card-position multiplier</strong></p>' +
            '<p>Main event fights score at <strong>×' + fmtMult(cfg('main_event_mult')) + '</strong>, ' +
            'co-mains at <strong>×' + fmtMult(cfg('co_main_mult')) + '</strong>. ' +
            'Everything else is ×1.0.</p>' +
            '<p>The Standings page shows totals; click any total to see the per-fighter breakdown.</p>' +

            '<p class="page-help__subheading"><strong>Projected points (the "Proj" pill)</strong></p>' +
            '<p>For every upcoming fight with live Polymarket odds, we publish a projected fantasy-point ' +
            'total so you can compare options when picking starters or adding free agents. The number ' +
            'rolls up three pieces:</p>' +
            '<ul>' +
              '<li><strong>Base activity</strong> — the fighter\'s career averages for sig strikes, takedowns, ' +
                  'knockdowns and control time, run through the scoring rules above. Fighters with few past ' +
                  'fights get blended with their division\'s average (Bayesian shrinkage), so a 1-fight ' +
                  'sample doesn\'t produce a wild projection.</li>' +
              '<li><strong>Win bonus</strong> — the full finish/decision bonus, weighted by the fighter\'s ' +
                  'Polymarket win probability. A 65% favorite gets 65% of the typical win bonus.</li>' +
              '<li><strong>Matchup bonus</strong> — title and ranked-opponent bonuses, also weighted by P(win).</li>' +
              '<li><strong>Card multiplier</strong> — main-event and co-main fights are boosted just like real scoring.</li>' +
            '</ul>' +
            '<p>Projections refresh hourly as odds move. Fights without Polymarket markets show no ' +
            'projection. <em>Click any Proj pill to see the breakdown for that specific fighter.</em></p>' +

            '<p class="page-help__subheading"><strong>Fantasy Value score (the "FV" rank)</strong></p>' +
            '<p>Projections answer "how will this fighter do on Saturday?" Fantasy Value answers ' +
            '"how good is this fighter overall?" — a single 0-100ish number, plus a league-wide rank, ' +
            'that lets you compare every fighter in the database when drafting, claiming waivers, or ' +
            'evaluating trades.</p>' +
            '<p>It blends:</p>' +
            '<ul>' +
              '<li><strong>Base score</strong> — career fantasy-point average (Bayesian-blended with the ' +
                  'league mean for low-sample fighters), weighted toward their last 3 fights.</li>' +
              '<li><strong>Activity multiplier</strong> — fighters who have actually competed in the last ' +
                  '12 months get full weight; inactive fighters are discounted.</li>' +
              '<li><strong>Rank bonus</strong> — champion +10, top-5 +6, top-10 +3, top-15 +1.</li>' +
              '<li><strong>Consistency bonus</strong> — credit for fights that scored above the league mean.</li>' +
              '<li><strong>Streak bonus</strong> — current win streak adds, loss streak subtracts.</li>' +
              '<li><strong>Strength of schedule</strong> — bonus for fighters who\'ve faced top-15 ' +
                  'opposition recently.</li>' +
            '</ul>' +
            '<p>FV uses <strong>this league\'s scoring rules</strong> when computing past fight scores, so ' +
            'two leagues with different settings will see different FV rankings. <em>Click any FV score ' +
            'in the fighter modal to see the breakdown.</em></p>'
        },
        {
          heading: 'The fight week',
          body:
            '<p>Every UFC week follows the same rhythm. All cutoffs are <strong>3am Eastern</strong>:</p>' +
            '<table class="page-help__table">' +
              '<tr><td><strong>Thursday</strong></td><td>Pre-event waivers open. Roster cap expands ' +
                  '(+' + startersFightNight + ' or +' + startersNumbered + ') for Temporary Flex pickups.</td></tr>' +
              '<tr><td><strong>Friday</strong></td><td>Pre-event waiver claims process — worst standings get first pick.</td></tr>' +
              '<tr><td><strong>Saturday</strong></td><td>Event day. Lineup locks at the first prelim.</td></tr>' +
              '<tr><td><strong>Sunday</strong></td><td>Post-event waivers open. Cap reverts to ' + rosterSize + '.</td></tr>' +
              '<tr><td><strong>Tuesday</strong></td><td>Post-event waiver claims process.</td></tr>' +
              '<tr><td><strong>Wednesday</strong></td><td>Auto-drop — anyone still over ' + rosterSize + ' has their newest fighters dropped automatically.</td></tr>' +
            '</table>'
        },
        {
          heading: 'Free agency & waivers',
          body:
            '<p>Adds happen in two modes depending on what day it is:</p>' +
            '<ul>' +
              '<li><strong>"Add" (instant):</strong> outside waiver windows, free agents are first-come ' +
                  'first-served. Click Add and the fighter is on your roster.</li>' +
              '<li><strong>"Claim" (queued):</strong> during waiver windows (Thu→Fri and Sun→Tue), ' +
                  'every add becomes a claim. All claims process at the cutoff with worst-standings ' +
                  'priority. Multiple managers can claim the same fighter; only one wins.</li>' +
            '</ul>' +
            '<p>Any fighter you drop is on a <strong>48-hour rolling waiver</strong> before they\'re ' +
            'available as a free agent again, so you can\'t drop someone and snipe them back instantly.</p>'
        },
        {
          heading: 'Trades',
          body:
            '<p>Trades are open all season. The flow:</p>' +
            '<ol>' +
              '<li><strong>Propose</strong> — pick a manager, choose what you give and what you receive.</li>' +
              '<li><strong>Other side reviews</strong> — they accept, reject, or counter.</li>' +
              '<li><strong>24-hour review window</strong> — once accepted, the trade sits in a ' +
                  'review window during which the commissioner can veto. After that it executes.</li>' +
            '</ol>' +
            '<p>Trades can\'t leave either side with an invalid roster — slot construction rules ' +
            'are enforced before the trade can even be proposed.</p>'
        },
        {
          heading: 'The draft',
          body:
            '<p>The season starts with a snake draft: pick order reverses each round so the manager ' +
            'who picks last in round 1 picks first in round 2, and so on. You\'ll draft until your ' +
            'roster is full (' + rosterSize + ' fighters).</p>' +
            '<ul>' +
              '<li><strong>Pick clock:</strong> 90 seconds default. If your clock runs out, the highest-ranked ' +
                  'fighter in your queue is auto-drafted (or top-ranked overall if your queue is empty).</li>' +
              '<li><strong>Queue:</strong> drag fighters in priority order before your turn so a slow ' +
                  'reaction doesn\'t cost you.</li>' +
              '<li><strong>Commissioner controls:</strong> pause the clock, undo a pick, or clear the board.</li>' +
            '</ul>'
        },
        {
          heading: 'Where to go next',
          body:
            '<p>The "?" button on every page opens this same primer. The main areas:</p>' +
            '<ul>' +
              '<li><strong>Roster:</strong> manage your fighters and set your starters for the upcoming event.</li>' +
              '<li><strong>Free Agency:</strong> add or claim fighters between events.</li>' +
              '<li><strong>Trades:</strong> propose, review, and counter trades with other managers.</li>' +
              '<li><strong>Standings:</strong> see where you sit and which fighters earned what.</li>' +
            '</ul>'
        }
      ]
    };
  }

  // -----------------------------------------------------------------------
  // Public install — registers the modal content with PageHelp, injects
  // the trigger button next to #leagueName, and wires the click handler.
  // Auto-opens on first visit only when we're actually on league.html (the
  // primer is comprehensive; don't pop it unprompted on focused pages).
  // -----------------------------------------------------------------------
  function install(league) {
    if (_installed) return;
    if (typeof PageHelp === 'undefined') {
      console.warn('LeaguePrimer.install: PageHelp not loaded — primer disabled');
      return;
    }
    PageHelp.register('league', buildPrimerContent(league || {}));
    injectTrigger();
    PageHelp.attachTrigger('pageHelpTrigger', 'league');

    // Only auto-open on the main league hub. Other pages get the trigger
    // but don't pop the comprehensive modal unprompted.
    if (window.location.pathname.indexOf('league.html') !== -1) {
      PageHelp.autoOpenIfFirstVisit('league');
    }
    _installed = true;
  }

  // -----------------------------------------------------------------------
  // Auto-init — fires on DOMContentLoaded for any page that has both a
  // #leagueName element and a ?id= URL param. Pages that already have the
  // league row in hand can preempt by calling install() themselves.
  // -----------------------------------------------------------------------
  async function autoInit() {
    if (_installed) return;
    if (!document.getElementById('leagueName')) return;
    if (typeof supabaseClient === 'undefined') return;

    var leagueId = new URLSearchParams(window.location.search).get('id');
    if (!leagueId) return;

    var res = await supabaseClient
      .from('leagues')
      .select('id, name, roster_size, scoring_config')
      .eq('id', leagueId)
      .maybeSingle();
    if (res.error || !res.data) return;  // not a member, or league missing
    install(res.data);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }

  root.LeaguePrimer = { install: install };
})(typeof window !== 'undefined' ? window : this);
