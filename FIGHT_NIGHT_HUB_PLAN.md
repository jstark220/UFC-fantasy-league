# Fight Night Hub — Build Plan

**Created:** June 9, 2026
**Owner:** Jacob Stark
**Status:** Plan approved-pending-review, not yet built
**Companion docs:** `PRD.md` (rules), `DESIGN_SYSTEM.md` (tokens/voice), `PRIORITIES.md` (open bugs)

One live, second-screen page per event, per league. The thing a manager keeps
open on their phone while watching the card: live fight results, live fantasy
scores, the league race re-ranking in real time, their own starters front and
center, and chat docked. It is also the pitch-demo centerpiece named in the
brand-swap playbook ("the live Fight Night Hub moment").

Design north star: **the page should feel like the arena scoreboard, not a
sportsbook.** Mostly neutral, crimson reserved for LIVE and knockdown moments,
gold reserved for wins (per DESIGN_SYSTEM 2.1).

---

## 1. What already exists (reuse, don't rebuild)

| Need | Existing source |
|---|---|
| Live results + stats in DB every 2 min during events | `api/cron-ingest.js` (event-gated Vercel cron) → `fight_results` |
| Live fantasy points for started fighters | same cron → `scoreEvents.js` → `scores` upsert keyed `(league_member_id, event_id, fighter_id)` |
| Event phase math (lock time, "current until Mon 4am ET", PPV vs Fight Night starter counts) | `public/js/waiver-phase.js` (`eventCurrentUntil`, `getStarterCountForEvent`, `isNumberedEvent`) |
| Per-league event overrides (name/date/venue/lock) | `public/js/event-overrides.js` |
| Card rendering with odds/projection/score chips, YOURS/STARTER highlights | `public/js/fight-card-modal.js` (extract its row renderer, see §6) |
| Client-side scoring engine matching the server | `public/js/scoring.js` (`computeFighterScore` + league `scoring_config`) |
| Score explainability | `public/js/score-breakdown.js` |
| Odds + projections | `public/js/fight-odds.js`, `public/js/projections.js` |
| Floating chat on every league page | `public/js/chat-widget.js` + `chat.js` (zero work: include the scripts) |
| Realtime-publication SQL pattern | `sql/2026-04-26_draft_picks_realtime.sql` |
| Nav tabs | `public/js/league-nav.js` |

The only genuinely new infrastructure is: the page itself, realtime
subscriptions on `scores` / `fight_results`, and the fight-final "moment"
detection.

---

## 2. Page model

**New files:** `public/fight-night.html` + `public/js/fight-night.js`
**URL:** `fight-night.html?id=LEAGUE_UUID` (optional `&event=EVENT_UUID` to view
a past event's hub as a recap; default is the current/next event via the same
`pickDefaultEvent` logic lineup.js uses).

### The three page states

Derived from `lineup_lock_time` (effective lock = first prelim) and
`eventCurrentUntil(event_date)` (Mon 4am ET after a Saturday card). Same
helpers lineup.js already trusts; do not invent a new clock.

| State | When | Page behavior |
|---|---|---|
| **PREVIEW** | now < lock | Countdown hero, full card with odds + projections, lineup-status strip ("2/3 set" per manager, links to lineup page), pick'em open (Phase 3) |
| **LIVE** | lock ≤ now < currentUntil AND event not fully decided | Crimson LIVE dot, live ticker, race re-ranks on every score change, moments fire |
| **FINAL** | event decided or currentUntil passed | Gold "FINAL" treatment, event winner banner (top event-points team), full results, recap feed (Phase 4) |

State is recomputed on a 30s timer plus on every realtime payload, so the page
flips PREVIEW→LIVE→FINAL without a refresh.

### Data loaded on init (one parallel batch, like lineup.js)

1. `leagues` row (`scoring_config`), `league_members` (all, for the race)
2. `ufc_events` row + `EventOverrides` merge
3. `fight_results` for the event (full stat columns, same select as fight-card-modal)
4. `fighters` for everyone on the card
5. `starter_selections` for this event for **all** members (the race needs everyone's starters; lineups.js proves this is RLS-readable)
6. `scores` for this league + event
7. `rosters` for the viewer (drives YOURS highlights)
8. `FightOdds.loadFightOdds`, `Projections.load` for card fighters

### Realtime (the thing that makes it a hub and not a page)

```
supabaseClient.channel('hub_' + leagueId + '_' + eventId)
  .on('postgres_changes', { table: 'fight_results', filter: 'event_id=eq.' + eventId }, onFightChange)
  .on('postgres_changes', { table: 'scores', filter: 'league_id=eq.' + leagueId }, onScoreChange)
```

- **Two separate channels**, per the hard-won note in chat.js (~line 256) that
  Supabase drops subscriptions when two tables share one channel. Follow that.
- **New SQL migration** `sql/2026-06-XX_hub_realtime.sql`: add `fight_results`
  and `scores` to the `supabase_realtime` publication, idempotent-guarded,
  copying `2026-04-26_draft_picks_realtime.sql`. `fight_results` is public-read
  so payloads flow to everyone; `scores` realtime respects its RLS (league
  members only), which is exactly what we want.
- **Keep a 60s polling fallback** (lineup.js's `LIVE_REFRESH_MS` pattern) so a
  dropped channel degrades to "slightly stale" instead of "frozen." This is the
  P0.2 lesson applied in advance: never trust the channel alone.
- On every payload: update the in-memory maps, recompute affected DOM regions
  only (no full-page re-render: chat focus and scroll position must survive).

### Fight-final "moment" detection

Keep the previous `fight_results` rows in memory. When an UPDATE arrives where
`outcome` was null and is now set:

1. Re-render that fight row (score chips replace projection chips, winner check).
2. Fire a toast per DESIGN_SYSTEM 6.4: gold "WIN" toast if a viewer starter won
   (with `+pts`), neutral result toast otherwise. Knockdown delta on a viewer
   starter gets the crimson "KNOCKDOWN" toast.
3. Prepend an entry to the Round-by-Round feed (§4, block D).
4. Re-rank the race with a FLIP-style row animation (CSS transform, respects
   `prefers-reduced-motion`).

### Cache-first rendering & fight-night resilience

Fight-night conditions are hostile (bar/arena wifi, phone locked and reopened
dozens of times, iOS killing the websocket on every wake). The hub renders
from a local snapshot first and treats the network as hydration, not as a
prerequisite. Architecture decisions, fixed in Phase 1 because they're
expensive to retrofit:

- **Single store, three feeds, and it's a real module.** All data paths
  (initial fetch, realtime payloads, 60s polling, cached snapshot) feed ONE
  in-memory store through the same `apply()` reducer; every DOM region
  renders only from the store. Never render directly from a payload. (This
  is the P0.2 lesson: multiple ad-hoc data paths reconciling in the DOM is
  how boards stop updating.) The store lives in its own dependency-free file,
  `public/js/fight-night-store.js` — pure functions over plain objects, zero
  DOM / zero Supabase references — so it runs in Node. A framework-less test
  file (`tests/fight-night-store.test.js`, run with plain `node`) asserts the
  ugly cases before any fight night does: out-of-order poll vs realtime,
  snapshot older than fetch, score deletions, the moment-tolerance window,
  schema-version mismatch discard. This is the one part of the hub that must
  have tests before it ships.
- **Server version token ends merge guesswork.** `scoreEvents.js` stamps a
  `last_scored_at` timestamp on the `ufc_events` row at the end of every
  scoring run (it is the only writer of scores). Every refetch and snapshot
  carries the token it was built from, and the reducer's ordering rule is
  one line: higher token wins, wholesale — no per-row "can points go down"
  heuristics. The 60s poll gets cheap too: poll the one event row and only
  refetch the heavy data when the token moved. The staleness stamp becomes
  server truth ("scores as of the 9:42 ingest"), not a client-side guess.
- **Corrected clock.** Lock detection, the PREVIEW/LIVE/FINAL machine, the
  countdown, and IT'S TIME never read `new Date()` directly. On init the hub
  computes a server-time offset (the `Date` header on any Supabase response
  suffices) and every time comparison goes through one `hubNow()` helper —
  a phone running 3 minutes fast must not fire IT'S TIME before the prelims
  start.
- **Snapshot on write, render on open.** The store serializes to
  localStorage, debounced (~2s) so a burst of score rows doesn't thrash
  JSON.stringify on the main thread mid-main-event. Snapshot is keyed
  `hub-<leagueId>-<eventId>` with a schema-version field and `updatedAt`;
  on load, discard on version/event mismatch, never overwrite a newer
  snapshot with an older one (multi-tab guard). All localStorage access in
  try/catch (private mode / quota), matching chat-widget.js.
- **Instant first paint.** On open: render the snapshot immediately with the
  "updated Xs ago" stamp and a quiet "syncing" pill, then hydrate from the
  network and diff into the store. No blank loading screen if any snapshot
  exists.
- **Moments fire only on live-observed transitions.** The snapshot persists a
  `seenFinalFightIds` set. Fights discovered as final via hydration/refetch
  (finished while the page was closed) update the UI silently — no toast
  spam, no replayed IT'S TIME on reopen. Toasts/animations fire only when a
  transition is observed over a live channel or poll while the page is
  visible.
- **Wake handling.** `visibilitychange`/`pageshow` (bfcache) handler: on wake,
  recompute the PREVIEW/LIVE/FINAL state machine immediately (interval timers
  are throttled in background tabs and will be stale), force a refetch, and
  resubscribe the channels (iOS will have killed them).
- **Visible degraded states.** Channel dropped → "reconnecting · last updated
  9:41 PM" pill; offline → offline banner. Never a frozen page implying
  liveness.

---

## 3. Functionality by block

### A. Event hero
- Event name (override-merged), date, venue, PPV/FIGHT NIGHT tag
  (`isNumberedEvent`), status chip: countdown (PREVIEW) / crimson LIVE dot
  (LIVE) / gold FINAL.
- PREVIEW: d/h/m/s countdown to first prelim (reuse lineup.js countdown logic).
- At the lock instant: the **"IT'S TIME"** takeover, a one-shot ~2s full-hero
  animation (Archivo Black, crimson flash), then settles into LIVE. One-shot
  per visit, guarded by a sessionStorage flag, skipped under reduced motion.

### B. The card (main column)

Run order note: fights run in **descending `fight_order`** (prelims = large
numbers first, main event = 1 last). "Current" = the undecided bout with the
highest `fight_order`; "up next" = the one after it.

- **B1. IN THE OCTAGON (featured current-fight block, LIVE only).** Pinned at
  the top of the card column: the inferred current bout, large two-sided
  layout with a **live stat comparison** between the fighters: sig strikes,
  takedowns, knockdowns, control time as opposing bars, refreshed by the
  2-min cron (ingest writes stat columns before `outcome` is set, so
  in-progress stats flow; verify on the next live card — risk §9.6). Plus
  odds chips and each fighter's would-be fantasy points if it ended now
  (`Scoring.computeFighterScore` runs fine on a partial stat line with no
  win bonus). "Updated Xs ago" stamp keeps it honest.
- **B2. UP NEXT (compact, LIVE only).** The following bout in run order:
  photos, records, rank, odds, projections, one line.
- **B3. The full card.** Main card / prelims sections, displayed in the usual
  listing order (`fight_order` ascending, ≤5 = main card, matching
  fight-card-modal). Each bout row: photos, name (full desktop /
  "F. Lastname" mobile), inline rank, country flag, then per state:
  - PREVIEW → odds chip + projection pill
  - LIVE/FINAL → decided bouts show earned PTS chip + winner ✓ + method/round/
    time line ("KO · R2 4:32"); undecided bouts keep odds/projection
- **Decided bouts expand on tap** to a full statistics panel: per-fighter sig
  strikes, takedowns, knockdowns, control time (the columns already fetched),
  plus the fantasy-points breakdown via score-breakdown.js for fighters who
  were started in this league.
- Viewer's rostered fighters get the existing `--yours` ring; starters get
  `--starter` (already-built CSS). Current bout carries the pulsing NOW
  treatment in the list too (B1 is a focus view, not the only indicator).
- Tapping a fighter opens the existing fighter modal.

### C. The league race (right rail desktop / tab mobile)
- **Event / Season toggle** in the race header (two-button segmented control,
  same pattern as standings.js's "Scores from" scope). Event mode (default
  during LIVE) ranks by this card's points with season total as the muted
  second column; Season mode ranks by cumulative season points **including**
  this event's live points, with tonight's points as the second column. Both
  re-rank live; the math is standings.js's `buildEventTable` /
  `computeStandings`, fed live.
- Each row expands (tap/click) to show that manager's starters for this event
  with per-fighter status: upcoming (projection), live-pending, final (pts).
  Data: `starter_selections` × `fight_results` × `Scoring`.
- Movement animation on re-rank; viewer's row gets the `--me` treatment.
- PREVIEW variant: ranked by projected event total (sum of starter
  projections), labeled clearly "Projected" so nobody confuses it with real
  points, plus "lineup set 2/3" per manager using `getStarterCountForEvent`
  (this also retires the P1.1 hardcode pattern: the hub never hardcodes 3).

### D. My Corner + Round-by-Round (below card on desktop, tab on mobile)
- **My Corner:** the viewer's starters as compact cards: photo, opponent,
  status (projection → live → final pts), running event total. The emotional
  anchor of the page.
- **Round-by-Round feed:** reverse-chronological event log built client-side:
  "9:42 PM: Topuria def. Tsarukyan, KO R2. 41.2 pts to Team Stark." Entries
  from fight-final detections plus phase changes ("Prelims started. Lineups
  locked."). Phase 4 upgrades these entries with AI color (see §8).

### E. Chat
- The existing floating ChatWidget, included as-is. On mobile-LIVE it's the
  one always-visible launcher bar (its built-in behavior). No new chat code.

### F. Nav integration
- New `league-nav.js` tab: **"Fight Night"**, between Lineup and Standings.
  During the LIVE window the tab shows a crimson dot badge (nav badge slot
  already exists). Outside event windows it reads "Event" and lands on
  PREVIEW/FINAL of the current/most-recent card.
- The league hub's `this-week-card` gets a "Open Fight Night Hub" CTA, crimson
  during LIVE (this is the screen's one crimson element, per the design rule).

---

## 4. Layout, desktop (≥1024px)

12-col grid, 1200px max. Dense mode (DESIGN_SYSTEM 4.3).

```
┌──────────────────────────────────────────────────────────────────────┐
│ top-nav (existing)                                                   │
├──────────────────────────────────────────────────────────────────────┤
│ league-nav tabs (existing)                  [Fight Night •LIVE]      │
├──────────────────────────────────────────────────────────────────────┤
│ HERO  UFC 330: TOPURIA VS TSARUKYAN          ● LIVE  Main card       │
│       T-Mobile Arena · Las Vegas · PPV          underway             │
├───────────────────────────────────────────────┬──────────────────────┤
│ THE CARD (8 cols, scrolls)                    │ LEAGUE RACE (4 cols, │
│ ┌───────────────────────────────────────────┐ │ sticky)              │
│ │ MAIN CARD                                 │ │ ┌──────────────────┐ │
│ │ [Main Event · Lightweight]                │ │ │ 1 Team Dana 88.4 │ │
│ │  Topuria ✓ PTS 41.2   vs   Tsarukyan 6.1  │ │ │ 2 Stark ▲2  71.0 │ │← me
│ │ [Co-Main · Flyweight]            ◄ NOW    │ │ │ 3 KO Kings 64.2  │ │
│ │  Pantoja PROJ 22.1    vs   Royval 18.4    │ │ │ … (8 rows,       │ │
│ │  …                                        │ │ │  expandable)     │ │
│ │ PRELIMS                                   │ │ └──────────────────┘ │
│ │  …                                        │ │ MY CORNER            │
│ └───────────────────────────────────────────┘ │  [starter cards ×3]  │
│ ROUND-BY-ROUND                                │  Event total: 71.0   │
│  9:42 Topuria KO2 · +41.2 Team Stark          │                      │
│  9:18 Prelims final · …                       │                      │
├───────────────────────────────────────────────┴──────────────────────┤
│                                              [chat popup, bottom-right]
└──────────────────────────────────────────────────────────────────────┘
```

- Race rail is `position: sticky` so it stays visible while scrolling the card.
- PREVIEW swaps the hero status for the big countdown and the race for the
  projected race + lineup-status strip. FINAL swaps hero to gold and pins the
  event-winner banner above the race.

## 5. Layout, mobile (<768px)

Mobile is the primary surface (people watch fights with phone in hand). Single
column + a sticky segmented control. No horizontal scrolling, no overlap, per
the mobile-parity rule.

```
┌─────────────────────────────┐
│ top-nav (existing, compact) │
├─────────────────────────────┤
│ HERO (compact, 2 lines)     │
│ UFC 330 ● LIVE              │
│ Topuria vs Tsarukyan        │
├─────────────────────────────┤
│ MY BAR (sticky under hero)  │
│ You: 71.0 pts · 2nd ▲2      │ ← always visible, the one-glance answer
├─────────────────────────────┤
│ [ Card ] [ Race ] [ Feed ]  │ ← segmented control, sticky
├─────────────────────────────┤
│ (active tab content)        │
│                             │
│ Card: bout rows, abbrev     │
│   names, chips stacked      │
│ Race: full-width rows,      │
│   tap to expand starters    │
│ Feed: My Corner cards on    │
│   top, then round-by-round  │
│                             │
├─────────────────────────────┤
│ [chat bar, existing widget] │
└─────────────────────────────┘
```

- **MY BAR** is the mobile signature: viewer's live event total + rank +
  movement, sticky, updates on every score payload. One line, tabular figures.
- Default tab: Card (LIVE), Card (PREVIEW), Race (FINAL).
- Toasts appear above the chat bar, auto-dismiss 5s, never stack more than 2.
- Bout rows reuse the fight-card-modal mobile treatment (abbrev names, chips
  under the name) rather than inventing a new row.

---

## 6. Refactor required (small, do it first)

`fight-card-modal.js` owns the bout-row renderer the hub needs, but it's
locked inside the modal IIFE. Extract into a shared `public/js/fight-rows.js`:

- `FightRows.shape(rawFights, fighterMap)` (today's `shapeFights`)
- `FightRows.rowHtml(fight, eventName, opts)` (today's `fightRowHtml` + helpers)
- fight-card-modal.js and fight-night.js both consume it. No behavior change
  to the modal; its CSS classes (`.fight-row*`) are already in components.css
  and shared by design.

This is the only pre-existing file with a structural change. Everything else
is additive (nav tab, league-page CTA, CSS additions).

---

## 7. Database / infra changes

| Change | File | Notes |
|---|---|---|
| Add `fight_results`, `scores` to `supabase_realtime` publication | `sql/2026-06-XX_hub_realtime.sql` | Idempotent, copy the draft_picks pattern. No replica-identity change needed (we diff old state client-side). |
| `last_scored_at timestamptz` column on `ufc_events` (the version token) | same migration | Stamped by `scoreEvents.js` at the end of every run; one-line change there. Drives the store's wholesale merge rule + cheap poll. |
| Pick'em table (Phase 3) | `sql/2026-06-XX_hub_pickem.sql` | `event_picks(id, league_id, league_member_id, fight_id, picked_fighter_id, created_at, unique(league_member_id, fight_id))`. RLS: members read all picks in their league **only after lock** (enforce via `lineup_lock_time` check in the policy), write own before lock. Blind until lock, public after, no P1.5-style UI-only blindness repeat. |
| AI recap route (Phase 4) | `api/recap.js` + hook in `api/cron-ingest.js` | See §8. |

No Vercel plan changes: the hub consumes the existing 2-min cron.

---

## 8. Phasing

**Phase 1 — The Hub (core, ship first):**
fight-rows.js extraction · fight-night-store.js + node tests ·
`last_scored_at` token (SQL + scoreEvents.js stamp) · `hubNow()` clock offset ·
fight-night.html/js with PREVIEW/LIVE/FINAL ·
cache-first snapshot + wake/degraded handling (§2) ·
realtime + polling fallback · hero/card/race/My Corner/feed ·
nav tab + league-page CTA · realtime SQL · mobile layout per §5.
*Effort: the big one. Everything below is small by comparison.*

**Phase 2 — Moments:** IT'S TIME lock takeover · win/loss/knockdown toasts ·
FLIP race re-rank animation · FINAL event-winner banner (gold, 6.1-style) ·
reduced-motion audit. *Quick/Medium.*

**Phase 3 — Pick'em:** pick UI on PREVIEW card rows (tap a side) · locked at
lineup lock · correct-pick tally column in the race · season pick'em record on
standings later if it's fun. *Medium. Needs the SQL above.*

**Phase 4 — AI color (first Claude API feature):** when cron-ingest detects a
newly-final fight, `api/recap.js` generates a 2-sentence recap with fantasy
context (league names + points included in the prompt) and inserts into a new
`event_feed` table (league-scoped, realtime-published); the hub feed renders
these above the plain client-side entries. Costs ~cents per card (see
conversation notes 2026-06-09). *Medium. Fully server-side, key never in browser.*

---

## 9. Risks / open questions

1. **Realtime on `scores` under RLS:** believed to work (league-member SELECT
   policy), but verify with two browsers before building the race on it. The
   polling fallback covers us if realtime-with-RLS misbehaves.
2. **Granularity honesty:** we get decided-fight updates every ~2 min, not
   true round-by-round. The NOW marker + "updated Xs ago" stamp keep the page
   honest. Don't fake liveness.
3. **`scores` DELETEs** (stale-row cleanup in scoreEvents.js) arrive as
   realtime DELETE events without full old rows; simplest correct handling is
   to refetch the league's event scores on any DELETE payload.
4. **Multi-league users:** hub is league-scoped by URL, same as every other
   league page. No cross-league hub in v1.
5. **Testing without a live event:** add a dev-only `?simulate=live` flag that
   treats a past event as undecided-then-decided on a timer (client-side only),
   so the LIVE state and moments can be exercised any day of the week. Next
   real card validates end-to-end.
6. **In-progress stats from ESPN:** `ingestFightResults.js` writes the stat
   columns on every run regardless of `outcome`, so mid-fight stats should
   flow at cron cadence — but whether ESPN actually populates competitor
   stats before a bout completes must be confirmed on the next live card.
   If it doesn't, B1 degrades gracefully: odds + "live" status only, stats
   appear when the bout ends.

---

*End of plan. Build order within Phase 1: fight-rows extraction →
fight-night-store.js + node tests (merge rules proven before any UI) →
`last_scored_at` migration + scoreEvents stamp → static page with real data
(all three states, no realtime, rendering from the store) → realtime +
fallback + snapshot/wake handling → race interactions → mobile pass →
nav/CTA wiring.*
