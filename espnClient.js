// ============================================================================
// espnClient.js
// Shared ESPN MMA data client for the ingest scripts. ufcstats.com now serves
// a JS bot-challenge to non-browser clients, so events + fight results come
// from ESPN instead. ESPN answers plain HTTP fine and exposes the same fight
// stats (verified to match ufcstats exactly).
//
// Two ESPN surfaces are used:
//   * scoreboard (site.api)  -> event listing + upcoming card matchups.
//     Inline competitor names + flags, but NO detailed stats.
//   * core API (sports.core) -> per-bout statistics (sig strikes, takedowns,
//     knockdowns, control time), method, round, finish time, title flags.
//
// Exposes plain CommonJS functions; the scrapers require() this.
// ============================================================================

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard';
const CORE_EVENT = 'https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events';

// Polite delay between core-API calls; ESPN is generous but we don't hammer.
const REQUEST_DELAY_MS = 120;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res.json();
      if (res.status === 404) return null;
    } catch (err) { /* retry */ }
    await sleep(250 * (i + 1));
  }
  return null;
}

// Pull the trailing numeric id out of a core-API $ref, e.g.
// ".../athletes/3088862?lang=en&region=us" -> "3088862".
function idFromRef(ref) {
  if (!ref) return null;
  const m = String(ref).match(/\/(\d+)(?:\?|$)/);
  return m ? m[1] : null;
}

// ----------------------------------------------------------------------------
// VALUE MAPPERS
// ----------------------------------------------------------------------------

// "3:08" -> 188 seconds; "5:00" -> 300; null/garbage -> null.
function parseClockToSeconds(str) {
  if (!str) return null;
  const parts = String(str).trim().split(':');
  if (parts.length !== 2) return null;
  const m = parseInt(parts[0], 10);
  const s = parseInt(parts[1], 10);
  if (isNaN(m) || isNaN(s)) return null;
  return m * 60 + s;
}

// ESPN result.displayName ("Decision - Unanimous", "Submission", "KO/TKO",
// "TKO - Doctor's Stoppage", "DQ", "No Contest", "Draw") -> our outcome enum.
// Same vocabulary ufcstats used, so the mapping is shared.
const OUTCOME_MAP = {
  'TKO': 'ko_tko', 'KO': 'ko_tko', 'KO/TKO': 'ko_tko',
  "TKO - Doctor's Stoppage": 'ko_tko', 'Could Not Continue': 'ko_tko',
  'Submission': 'submission',
  'Decision - Unanimous': 'decision_u',
  'Decision - Split': 'decision_s',
  'Decision - Majority': 'decision_m',
  'DQ': 'dq', 'Disqualification': 'dq',
  'No Contest': 'no_contest',
  'Draw': 'draw',
};
function mapMethod(displayName) {
  if (!displayName) return null;
  const t = String(displayName).trim();
  if (OUTCOME_MAP[t]) return OUTCOME_MAP[t];
  // Partial match (covers "Decision - Unanimous (29-28...)", "KO/TKO (Punches)").
  for (const [k, v] of Object.entries(OUTCOME_MAP)) {
    if (t.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return null;
}

const WEIGHT_CLASS_MAP = {
  'Heavyweight': 'heavyweight', 'Light Heavyweight': 'light_heavyweight',
  'Middleweight': 'middleweight', 'Welterweight': 'welterweight',
  'Lightweight': 'lightweight', 'Featherweight': 'featherweight',
  'Bantamweight': 'bantamweight', 'Flyweight': 'flyweight',
  "Women's Strawweight": 'strawweight', "Women's Flyweight": 'flyweight_w',
  "Women's Bantamweight": 'bantamweight_w', "Women's Featherweight": 'featherweight',
  'Catch Weight': null, 'Catchweight': null, 'Open Weight': null,
};
function mapWeightClass(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/\s*bout$/i, '').trim();
  if (Object.prototype.hasOwnProperty.call(WEIGHT_CLASS_MAP, cleaned)) return WEIGHT_CLASS_MAP[cleaned];
  for (const [k, v] of Object.entries(WEIGHT_CLASS_MAP)) {
    if (k && cleaned.includes(k)) return v;
  }
  return null;
}

// matchNumber is 1-based with 1 = main event (same convention as our
// fight_order, where main event = 1). card_position enum has only three values.
function cardPositionFromMatchNumber(matchNumber) {
  if (matchNumber === 1) return 'main_event';
  if (matchNumber === 2) return 'co_main';
  return 'main_card';
}

// competition.types[] carries the bout's title status, e.g. "UFC Middleweight
// Title", "UFC Interim ... Title", "BMF Title". Returns our title_type enum.
function titleTypeFromTypes(types) {
  const texts = (types || []).map((t) => (t && t.text ? t.text : '')).join(' ').toLowerCase();
  if (!texts.includes('title')) return 'none';
  if (texts.includes('interim')) return 'interim';
  if (texts.includes('bmf')) return 'bmf';
  return 'divisional';
}

// ----------------------------------------------------------------------------
// CORE API: one event's fights, fully normalized for fight_results upsert.
// Returns { espnEventId, name, date, fights: [ ... ] } or null.
// Each fight:
//   { espnCompetitionId, matchNumber, fightOrder, cardPosition, weightClass,
//     rounds, titleType, completed, method, endRound, endTimeSeconds,
//     isDraw, isNoContest,
//     competitors: [ { espnAthleteId, name, flag, isWinner,
//                      sigStrikes, takedowns, knockdowns, controlSeconds } ] }
// ----------------------------------------------------------------------------
async function fetchEventFights(espnEventId) {
  const ev = await getJson(`${CORE_EVENT}/${espnEventId}`);
  if (!ev || !Array.isArray(ev.competitions)) return null;

  const fights = [];
  for (const compRef of ev.competitions) {
    await sleep(REQUEST_DELAY_MS);
    const c = await getJson(compRef.$ref || compRef);
    if (!c) continue;

    const status = c.status && c.status.$ref ? await getJson(c.status.$ref) : c.status;
    const completed = !!(status && status.type && status.type.completed);
    const method = completed ? mapMethod(status.result && status.result.displayName) : null;
    const isDraw = method === 'draw';
    const isNoContest = method === 'no_contest';

    const competitors = [];
    for (const comp of (c.competitors || [])) {
      const espnAthleteId = idFromRef(comp.athlete && comp.athlete.$ref);
      const ath = comp.athlete && comp.athlete.$ref ? await getJson(comp.athlete.$ref) : comp.athlete;
      const stats = comp.statistics && comp.statistics.$ref ? await getJson(comp.statistics.$ref) : null;
      const cats = stats && stats.splits && stats.splits.categories ? stats.splits.categories : [];
      const general = cats.find((x) => x.name === 'general') || { stats: [] };
      const stat = (name) => {
        const o = general.stats.find((z) => z.name === name);
        return o ? o : null;
      };
      const num = (name) => { const o = stat(name); return o ? o.value : null; };
      const disp = (name) => { const o = stat(name); return o ? o.displayValue : null; };

      competitors.push({
        espnAthleteId,
        name: ath ? (ath.displayName || ath.fullName) : null,
        flag: ath && ath.flag ? (ath.flag.alt || null) : null,
        isWinner: comp.winner === true,
        sigStrikes: num('sigStrikesLanded'),
        takedowns: num('takedownsLanded'),
        knockdowns: num('knockDowns'),
        controlSeconds: parseClockToSeconds(disp('timeInControl')),
      });
    }

    fights.push({
      espnCompetitionId: String(c.id),
      matchNumber: c.matchNumber,
      fightOrder: c.matchNumber,
      cardPosition: cardPositionFromMatchNumber(c.matchNumber),
      weightClass: mapWeightClass(c.type && c.type.text),
      rounds: c.format && c.format.regulation ? c.format.regulation.periods : null,
      titleType: titleTypeFromTypes(c.types),
      completed,
      method,
      endRound: completed && status ? status.period : null,
      endTimeSeconds: completed && status ? parseClockToSeconds(status.displayClock) : null,
      isDraw,
      isNoContest,
      competitors,
    });
  }

  return { espnEventId: String(espnEventId), name: ev.name, date: ev.date, fights };
}

// ----------------------------------------------------------------------------
// SCOREBOARD: events across a date range (chunked <=90 days). Returns light
// event objects for the events table + upcoming-card matchups.
//   { espnEventId, name, shortName, date, venue, city, country,
//     prelimStartUTC, completed, bouts: [ { names:[a,b], flags:[a,b] } ] }
// ----------------------------------------------------------------------------
function yyyymmdd(d) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
async function fetchEventsInRange(start, end) {
  const byId = new Map();
  const CHUNK = 90 * 86400000;
  for (let t = start.getTime(); t <= end.getTime(); t += CHUNK + 86400000) {
    const a = new Date(t);
    const b = new Date(Math.min(t + CHUNK, end.getTime()));
    const json = await getJson(`${SCOREBOARD}?dates=${yyyymmdd(a)}-${yyyymmdd(b)}`);
    (json && json.events ? json.events : []).forEach((e) => {
      const comp = (e.competitions || [])[0] || {};
      const addr = (comp.venue && comp.venue.address) || {};
      const times = (e.competitions || []).map((c) => c.date).filter(Boolean).sort();
      const bouts = (e.competitions || []).map((c) => ({
        names: (c.competitors || []).map((x) => (x.athlete && (x.athlete.displayName || x.athlete.fullName)) || null),
        flags: (c.competitors || []).map((x) => (x.athlete && x.athlete.flag && x.athlete.flag.alt) || null),
      }));
      byId.set(e.id, {
        espnEventId: String(e.id),
        name: e.name,
        shortName: e.shortName,
        date: e.date,
        venue: (comp.venue && comp.venue.fullName) || null,
        city: addr.city || null,
        country: addr.country || null,
        prelimStartUTC: times[0] || e.date,
        completed: !!(e.status && e.status.type && e.status.type.completed),
        bouts,
      });
    });
  }
  return [...byId.values()];
}

module.exports = {
  fetchEventFights,
  fetchEventsInRange,
  // helpers exported for reuse/testing
  parseClockToSeconds,
  mapMethod,
  mapWeightClass,
  cardPositionFromMatchNumber,
  titleTypeFromTypes,
  idFromRef,
};
