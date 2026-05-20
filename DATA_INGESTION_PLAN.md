# Data Ingestion Plan — Knockdown Fantasy

## Goals

1. **All fighters** (ranked + unranked, records kept current after each event)
2. **All historical events + fight results** seeded into the DB so fighters show past fantasy scores on their card
3. **Upcoming events** visible in the app (schedule, lineup lock times)

---

## What Already Works (don't break it)

| What | How | File |
|------|-----|------|
| Fighter seed (233 fighters) | Octagon API `/fighters` | `fetchFighters.js` |
| Rankings + champion flags | Hardcoded, run manually | `applyRankings.js` |
| Manual fight entry + scoring | Commissioner UI | `score-event.js` |

Everything new is additive — the commissioner manual-entry flow stays as an override/correction tool.

---

## Data Source: ufcstats.com

**Why ufcstats.com:**
- Free, no API key required
- Complete UFC history going back to UFC 1
- Has every stat the scoring formula needs: sig strikes, takedowns, knockdowns, control time (by round), win method, round, time
- The site has been stable HTML for years; many community scrapers use it
- Our `fight_results` table schema was built to match its data shape exactly

**Key URLs:**
```
Events list (all completed):  http://ufcstats.com/statistics/events/completed?page=all
Upcoming events:              http://ufcstats.com/statistics/events/upcoming
Event detail page:            http://ufcstats.com/event-details/{hex-id}
Fight detail page:            http://ufcstats.com/fight-details/{hex-id}
```

Event and fight IDs are hex strings like `1fada8a5f77f5555` embedded in the page's anchor hrefs.

**Node packages needed (add to package.json):**
```
npm install cheerio node-fetch
```
(`cheerio` parses HTML like jQuery; `node-fetch` for HTTP requests from Node)

---

## Existing Database Schema (confirmed from code)

### `ufc_events`
```
id               uuid PK
name             text        -- short: "UFC 300"
full_name        text        -- long: "UFC 300: Pereira vs Hill"
event_date       date
venue            text
lineup_lock_time timestamptz -- used by lineup page for lock countdown
```
**Needs one new column:** `ufcstats_id text unique` — the hex ID from the URL, used to avoid duplicate inserts on re-runs.

### `fight_results`
```
id                      uuid PK
event_id                uuid → ufc_events
fighter_a_id            uuid → fighters
fighter_b_id            uuid → fighters
weight_class            text
card_position           text   -- "main_event" | "co_main" | "main_card" | "prelim" | "early_prelim"
title_type              text   -- "none" | "title" | "interim" | "bmf"
is_title_defense        bool
fight_of_the_night      bool
outcome                 text   -- "KO/TKO" | "Submission" | "Decision - Unanimous" | etc.
winner_id               uuid → fighters (null = draw/NC)
end_round               int
end_time_seconds        int
fighter_a_sig_strikes   int
fighter_a_takedowns     int
fighter_a_knockdowns    int
fighter_a_control_seconds int
fighter_a_opponent_rank int    -- null if unranked
fighter_a_potn          bool
fighter_b_sig_strikes   int
fighter_b_takedowns     int
fighter_b_knockdowns    int
fighter_b_control_seconds int
fighter_b_opponent_rank int
fighter_b_potn          bool
```
**No schema changes needed** — this already perfectly mirrors what ufcstats.com exposes.

### `fighters`
**Needs one new column:** `ufcstats_name text` — the exact display name as ufcstats.com spells it (with accents). Used to match scraped fight results back to fighter rows. Populated once during the initial historical ingest.

---

## Scripts to Build (all Node.js in project root)

### Script 1: `refreshFighters.js` (update of existing `fetchFighters.js`)
Already works. Minor changes:
- Re-run after each event to update records (wins/losses)
- The `upsert` on `ufc_id` already handles this correctly
- No new code needed; just document that this should be run weekly

### Script 2: `ingestEvents.js`
**What it does:** Scrapes the ufcstats.com completed + upcoming events lists and upserts all events into `ufc_events`.

**Steps:**
1. Fetch `http://ufcstats.com/statistics/events/completed?page=all`
2. Parse each `<tr>` row: extract event name, date, location, and ufcstats href (the hex ID)
3. Fetch `http://ufcstats.com/statistics/events/upcoming` and repeat
4. Upsert into `ufc_events` with `onConflict: 'ufcstats_id'`

**Output fields:**
- `name`: shortened from "UFC Fight Night: Holloway vs Allen" → "UFC Fight Night"
- `full_name`: full as-scraped
- `event_date`: parsed from "May. 03, 2025" format
- `ufcstats_id`: hex string from the href

**`lineup_lock_time`** is left null by this script — commish sets it manually via the existing event editor (it's event-time-zone-specific and ufcstats doesn't publish it).

---

### Script 3: `ingestFightResults.js`
**What it does:** Given one event's ufcstats hex ID, scrapes all fight results and stats, matches fighters to the DB, and upserts into `fight_results`.

**Usage:**
```
node ingestFightResults.js 1fada8a5f77f5555
```
Or ingest all events at once (slow, use for initial historical seed):
```
node ingestFightResults.js --all
```

**Steps per event:**
1. Fetch `http://ufcstats.com/event-details/{id}`, parse fight rows
2. For each fight row: get fighter names, weight class, outcome, winner, round, time, and the fight's own detail URL
3. Fetch each fight detail URL: parse per-fighter totals for sig strikes, takedowns, knockdowns, control time
4. Match each fighter name → `fighters.id` using normalized name lookup (see Name Matching below)
5. Upsert into `fight_results` with `onConflict: 'event_id, fighter_a_id, fighter_b_id'`

**Card position inference:**
ufcstats lists fights in order (top = main event). Assign:
- Index 0 → `main_event`
- Index 1 → `co_main`
- Index 2–4 → `main_card`
- Index 5–8 → `prelim`
- Index 9+ → `early_prelim`

**Title fight detection:**
ufcstats marks title fights with a belt icon in the fight row. Parse for the word "Title" or the belt image; set `title_type` accordingly.

**Performance of the Night (PotN):**
ufcstats does NOT publish bonus winners. These must still be entered manually by the commissioner via the existing score-event UI. The scraper sets `fighter_a_potn` and `fighter_b_potn` to `false`; commish corrects after.

---

### Script 4: `refreshRankings.js` (automate `applyRankings.js`)
For now, rankings stay manually maintained in `applyRankings.js`. This is fine — UFC rankings update once a week on Tuesdays and there's no reliable free API.

**Future option:** Scrape `http://www.ufc.com/rankings` (the UFC website rankings page). The HTML structure has changed before so it's fragile. Low priority — rankings only need updating after events.

---

## Name Matching Strategy

The trickiest part. ufcstats uses full display names with accents (e.g., "Jiří Procházka"). Our fighters table has `ufc_id` slugs from Octagon ("jiri-prochazka") but not ufcstats names.

**Approach:**
1. On first run of `ingestFightResults.js`, build a lookup from fighters table: normalize each `fighters.name` (strip accents, lowercase, remove punctuation) → `fighters.id`
2. Normalize each ufcstats name the same way and look it up
3. For matches: write the exact ufcstats name into `fighters.ufcstats_name` so future runs are exact-match, not normalized
4. For misses: print a list of unmatched names to the console; add manual overrides in a small lookup object in the script (same pattern as `applyRankings.js`)

**Normalization function (JavaScript):**
```js
function normalizeName(name) {
  return name
    .normalize('NFD')               // decompose accented chars
    .replace(/[̀-ͯ]/g, '') // strip accent marks
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')     // remove punctuation
    .replace(/\s+/g, ' ')
    .trim();
}
```

Known edge cases to add as manual overrides:
- "Benoît Saint Denis" → "benoit-saint-denis"
- "Jan Błachowicz" → "jan-blachowicz"
- "O'Malley" names (apostrophes)

---

## Database Migration Required

Run this SQL in Supabase before running the new scripts:

```sql
-- Add ufcstats_id to events table for upsert matching
alter table public.ufc_events
  add column if not exists ufcstats_id text unique;

-- Add ufcstats_name to fighters for reliable name matching  
alter table public.fighters
  add column if not exists ufcstats_name text;
```

Save as `sql/2026-XX-XX_ufcstats_ids.sql`.

---

## Ingestion Order of Operations

### One-time historical seed (do this first)
```bash
node fetchFighters.js          # refresh fighter records
node applyRankings.js          # apply current rankings
node ingestEvents.js           # seed all historical + upcoming events
node ingestFightResults.js --all   # seed all historical fight results (slow, ~30 min)
```

### After each UFC event (weekly cadence)
```bash
node refreshFighters.js        # update win/loss records
node applyRankings.js          # update rankings if they changed
node ingestEvents.js           # pick up any newly announced events
node ingestFightResults.js {hex-id}  # ingest just that event's results
# Then: open score-event.html and manually set PotN/FotN/title bonuses
```

---

## Frontend Changes Needed

### Fighter modal — "Fight History" tab
`fighter-modal.js` already queries `fight_results` for a fighter. Once results are seeded, this tab will show real data automatically. Verify the query joins correctly:
```js
.from('fight_results')
.select('*, event:ufc_events(id, name, event_date)')
.or(`fighter_a_id.eq.${fighterId},fighter_b_id.eq.${fighterId}`)
.order('event_date', { foreignTable: 'event', ascending: false })
```

### Events / Schedule page (new page: `events.html`)
Simple page listing upcoming and past events. Upcoming events show: name, date, venue. Past events link to their fight card. Low complexity, nice to have.

### Upcoming event on lineup page
The lineup page already reads `ufc_events` for the lock time. Once upcoming events are seeded, this will show real upcoming cards automatically.

---

## What the Commissioner Scoring UI Becomes

Currently: commish enters every stat manually (sig strikes, takedowns, etc.).

After ingestion: the scraper pre-populates all the objective stats. The commish UI becomes a **review + bonus tool**:
1. Scraper runs → fight_results populated with all stats
2. Commish opens score-event.html → sees pre-filled fights, verifies/corrects if needed
3. Commish sets PotN, FotN, title defense flags (these require judgment, not in ufcstats)
4. Hits "Push Scores" → fantasy points calculated and distributed

This means commish work per event drops from ~30 minutes of data entry to ~5 minutes of checkbox-clicking.

---

## Open Questions for Next Session

1. **Historical depth** — how far back to seed? UFC 1 (1993) is available but fighters from that era aren't in the Octagon API and wouldn't be in any league rosters. Suggested starting point: seed from 2023 forward (covers recent fighter history visible on cards).
2. **`--all` ingest performance** — ufcstats has ~650 events. Each event page + ~10 fight detail pages = ~7,000 HTTP requests. Need rate limiting (100ms delay between requests) and resume-on-failure support.
3. **RLS on ufc_events** — currently only commissioners can insert events. The Node scripts use the service role key (bypasses RLS), so no policy changes needed for the scripts themselves. But confirm the `ufcstats_id` column doesn't break any existing commissioner insert flows.
4. **Fight result conflicts** — if a commish manually entered a fight before the scraper ran, the upsert will overwrite it. Decide: scraper wins (simpler) or commish wins (add a `manually_reviewed` flag and skip those rows).
