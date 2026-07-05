# Post-Draft Priority List (Season 1)

**Created:** June 1, 2026
**Owner:** Jacob Stark
**Source:** Issues observed during the first live Season 1 draft (night of May 31, 2026)
**Companion docs:** `PRD.md` (full spec), `DESIGN_SYSTEM.md` (tokens/components)

This is the running to-do list coming out of the first real draft. Items are
ordered by priority, not by effort. Each item lists what to fix, why it matters,
where in the code it likely lives, and a rough effort tag (Quick / Medium /
Large). "Needs investigation" means the root cause is not yet confirmed.

Stretch goals raised the same night live in `PRD.md` Section 10 (Future Feature
Backlog), with a short index at the bottom of this file.

---

## P0: Draft-breaking (fix before the next live draft)

These either stalled the draft or made it confusing/unusable for at least one
manager. They are the priority.

### P0.1 Auto-draft only fires from the on-clock manager's own device
- **What:** Auto-pick on clock expiry currently runs only when (a) that manager
  turned auto-draft on AND (b) their browser tab is open and awake. A manager on
  a sleeping phone, or one who closed the tab, never gets auto-picked, so the
  whole draft stalls on their clock until the commissioner manually assigns a
  pick.
- **Why it matters:** This is the single biggest draft-killer. One inactive
  person halts everyone. The manual commissioner-assign backstop works but
  defeats the point of a timer.
- **Where:** `public/js/draft.js` (the auto-draft toggle setup around line 156,
  `maybeAutoPickNow` / `autoPick` around line 1747, and the clock-expiry path).
  The fix likely needs a server-side or any-connected-client fallback so a pick
  fires even when the on-clock manager is gone.
- **Options to weigh:**
  1. Default auto-draft to ON for everyone (smallest change, partial fix: still
     needs at least one client awake).
  2. Let any connected client (e.g. the commissioner's, or whoever is in the
     room) run the expiry auto-pick, not just the on-clock manager's.
  3. Move expiry auto-pick server-side (Supabase Edge Function / cron). Most
     robust, most work.
- **Effort:** Medium to Large depending on option chosen.

### P0.2 Draft board does not update without a full page refresh
- **What:** Picks and turn changes sometimes do not appear for other managers
  until they manually refresh the whole page.
- **Why it matters:** Managers could not trust the board, and a missed turn
  change feeds directly into the P0.1 stall problem.
- **Where:** `public/js/draft.js` realtime subscription (Supabase realtime
  channel for picks/turn state). Likely a dropped/!resubscribed channel, a
  missed event type, or render not being triggered on the event.
- **Effort:** Medium. Needs investigation to confirm whether it is a
  subscription drop or a render-trigger gap.

### P0.3 Duplicate fighters in the draft pool  (CLEANUP DONE June 3, 2026; prevention pending)
- **Done (June 3):** `cleanupDuplicateFighters.js` deduped the table — 6,364 → 3,862
  fighters (2,502 phantoms removed, 8 split fighters consolidated incl. Jan
  Błachowicz, Navajo Stirling, Waldo Cortes Acosta). It catches what the old
  `mergeDuplicateFighters.js` missed (diacritics like Błachowicz≠Blachowicz,
  reversed order "Stirling Navajo", hyphen variants) and re-points ALL fighter
  FKs (the old one orphaned scores/draft_picks/draft_queue/projections). No
  roster was touched (every rostered copy was the survivor). Also: the draft
  pool + View-all now hide undraftable phantoms (no photo AND inactive), so
  reversed scraper rows can't flood the draft (`draft.js` renderFighterPool /
  renderViewAllList).
- **Still pending — prevent recurrence:** tighten the name-match in
  `ingestFightResults.js` / `scrapeActiveFromEvents.js` to use a normalized
  (diacritic/word-order/punctuation-insensitive) key so they stop minting
  `ufcstats-` rows. Until then, re-run `node cleanupDuplicateFighters.js
  --dry-run` after each ingest.

<!-- Original write-up below, kept for context. -->
### P0.3 Duplicate fighters in the draft pool
- **What:** Some fighters appeared twice. The bad copy shows "Lastname Firstname"
  ordering, no photo, and no fight history.
- **Why it matters:** Confusing during the draft, and a manager could draft the
  phantom copy, which then has wrong/empty data downstream (division, scoring).
- **Root cause (known):** These are the `ufcstats-` prefixed rows auto-created by
  `ingestFightResults.js` / `scrapeActiveFromEvents.js` when a fighter is looked
  up by name and not matched to the canonical Octagon-API row. See the header of
  `mergeDuplicateFighters.js` for the full explanation.
- **Fix (two parts):**
  1. **Clean up now:** run `node mergeDuplicateFighters.js --dry-run` then
     `node mergeDuplicateFighters.js` to merge existing duplicates.
  2. **Prevent recurrence:** exclude phantom/undraftable rows from the draft pool
     query (e.g. require a photo or a known division), and/or tighten the
     name-match in the ingest scripts so they stop minting `ufcstats-` rows.
- **Where:** `mergeDuplicateFighters.js`, `ingestFightResults.js`,
  `scrapeActiveFromEvents.js`, and the pool query in `public/js/draft.js`.
- **Effort:** Quick to run the merge; Medium to prevent recurrence.

### P0.4 Cannot scroll the draft pool on desktop (had to zoom out)
- **What:** At least one manager could not scroll the fighter list on desktop
  and had to zoom the browser out to see fighters.
- **Why it matters:** A manager who cannot see the pool cannot draft. Usability
  blocker during the live event.
- **Where:** `public/draft.html` + draft CSS (likely a fixed-height/overflow or
  viewport-height container that traps scroll at certain window sizes or zoom
  levels). Needs investigation, ideally reproduced at the reporter's resolution.
- **Effort:** Quick to Medium once reproduced.

---

## P1: Correctness and high-value UX

### P1.1 "View all lineups" shows "/ 3 set" even on Fight Nights
- **What:** The all-lineups summary hardcodes "/ 3 set". Fight Nights use 2
  starters, so it should read "/ 2 set" on those cards.
- **Why it matters:** Tells managers they are missing a starter they cannot set,
  and contradicts the real lineup page.
- **Where:** `public/js/lineups.js` used to hardcode `' / 3 set'`; the fix is to
  use the same `currentStarterCount()` logic that `public/js/lineup.js` already
  uses (2 across all card types — starters default is 2 everywhere now).
- **Effort:** Quick.

### P1.2 Unranked (NR) fighters share the grey dot used for "slot not filled"
- **What:** Grey is currently used both for unranked fighters and for empty
  roster slots. Grey should mean only "slot not filled"; NR-but-rostered
  fighters need their own color.
- **Why it matters:** Managers misread roster-construction progress during the
  draft.
- **Where:** `public/js/draft.js` dot rendering (around lines 767 and 952) and
  the rank classes (`rank-unranked` around lines 3175 / 3522). Pick a distinct
  color for NR and reserve grey for unfilled slots. Coordinate with
  `DESIGN_SYSTEM.md` so the new color is a real token.
- **Effort:** Quick to Medium.

### P1.3 Default the desktop "view team" to the manager's own team
- **What:** On desktop, the team-view panel should default to showing the
  current manager's team rather than another team or none.
- **Why it matters:** Most-used view; saves a click on every visit and matches
  expectation.
- **Where:** `public/js/draft.js` team-view render (exact variable name not yet
  located; needs a quick look at the team-panel render path).
- **Effort:** Quick.

### P1.4 Show each fighter's next fight on the roster, like the draft does
- **What:** The draft pool now shows next-fight info. The roster view should do
  the same.
- **Why it matters:** Consistency, and managers want next-fight context when
  managing their roster, not only while drafting.
- **Where:** Reuse `public/js/next-fight.js` (already powers the draft) on the
  roster/team views (`public/js/league.js` and/or `public/js/lineup.js`).
- **Effort:** Quick to Medium (mostly wiring an existing module into another
  view).

### P1.5 Enforce blind waivers at the database level (RLS + server-side processing)
- **What:** Pending waiver claims should be invisible to other managers (and
  ideally the commissioner) until they process. Right now only the *UI* hides
  them: the commissioner's Waiver Queue no longer lists claim contents (commit
  46f8992, "Claims are blind" panel), but the rows are still fetched
  client-side, and RLS still lets any league member read every claim in the
  league.
- **Why it matters:** The commissioner is also a manager; seeing who's claiming
  whom is a competitive edge. Blind waivers need to be enforced, not just
  hidden in the UI. (Deferred by Jacob on 2026-06-04 — no risk to current
  claims wanted right now.)
- **Fix (two parts, both deferred):**
  1. **Tighten RLS (Medium).** Replace the `waiver_claims` SELECT policy so a
     member can read a row only if it's their own, OR `status = 'approved'`
     (the Roster Activity feed needs these — verified it only reads approved),
     OR they're a commissioner of that league (so client-side processing keeps
     working). FIRST introspect the live policies
     (`select policyname, cmd, qual, with_check from pg_policies where
     tablename = 'waiver_claims'`) so the migration swaps ONLY the read rule and
     leaves the submit/cancel/process (INSERT/UPDATE) policies untouched. Pair
     with a one-line guard so the auto-processor (`runLazyProcessor`,
     `public/js/waivers.js` ~line 212) runs only for the commissioner — a
     regular manager loading at the cutoff with a narrowed view shouldn't be
     able to self-process a contested claim (a risk that technically exists
     today too).
  2. **Move processing server-side (Large) for FULL blindness.** While
     processing runs in the commissioner's browser, their client must read the
     pending queue, so a determined commish could read the network tab. A
     scheduled job (GitHub Actions cron or a Supabase Edge Function) using the
     service role would process claims at each cutoff via the shared
     `runRoundRobin` logic; then RLS can drop the commissioner read-all clause
     entirely and pending claims become truly owner-only.
- **Where:** Supabase RLS on `waiver_claims`; `public/js/waivers.js`
  (`runLazyProcessor` guard, `runRoundRobin`); `.github/workflows/update-data.yml`
  if processing moves to the cron.
- **Effort:** Medium (RLS + guard) / Large (server-side processing). RLS is
  read-visibility only, so it can't damage existing claim rows.

---

## P2: Polish

### P2.1 Clean up the mobile "whole team" view  (DONE, June 1, 2026)
- **What:** The roster page's "Whole Team" modal needed a cleanup pass.
- **Done:** Rebuilt it to use the draft's dense slot grid (`.draft-roster-grid`)
  instead of the old per-division sections. One cell per construction slot
  (8 men's + women's flex + any-flex), slot-type badge in the top-right corner,
  responsive 8/6/4/3 columns (so mobile is handled by the same grid). This also
  fixed a phantom-empty-slot bug (the old layout hardcoded 2 slots per men's
  division when the rule is 1) and a latent bug where women's-flex fighters were
  silently dropped from the modal. Lineup-only extras (starter star, event
  points, INT/BMF badge, country flag) were preserved. Changes in
  `public/js/lineup.js` (showWholeTeamModal / renderWholeTeamCell) and one CSS
  reposition of the starter star in `public/styles/components.css`.
- **Related (still open):** the consolidated mobile draft-pool cell layout (FV
  overall rank + next-fight date, 3-line layout) and the PRD's "whole-team
  single-screen view" (Section 10.4) are separate items.

---

## Rules decision (needs Jacob's call before any build)

### R.1 Always-on temporary roster slots + run waivers after fights
- **Idea raised:** Make the +3 temporary roster slots available all the time
  (not just Thu 3am to Sun 3am during event week), and run waiver processing
  after fights instead of on the current Thu/Fri/Sun/Tue windows.
- **Why this is a decision, not a task:** It rewrites the event-window waiver
  model that is the most complex locked system in the product (PRD Sections 4.6
  and 6.4). It touches roster caps, the auto-drop sweep, claim windows, and
  reverse-standings priority.
- **Trade-offs to think through:**
  - Always-on temp slots are simpler to explain and friendlier, but weaken the
    "set your real 20" discipline and complicate the cap/auto-drop math.
  - "Waivers after fights" is intuitive (claim the guy who just looked good) but
    needs a clear, single cutoff and changes when priority resets.
- **Recommendation:** Treat as a v1.3 rules proposal. Write the new rule out in
  full (caps, cutoffs, priority) before touching code, then update PRD 4.6/6.4.
- **Effort:** Large (rules + waiver engine).

---

## Stretch goals (tracked in PRD Section 10)

Raised the same night, parked as product direction rather than immediate work.
Full descriptions live in `PRD.md` Section 10. Quick index:

- **Playoffs / head-to-head option** (PRD 10.7). Already captured.
- **Trade Block** (NEW). A public "available for trade" shelf, separate from the
  deferred trade system (PRD 4.8).
- **Notifications: text, email, and in-app/push** (PRD 8 Phase 2 + 10.7).
  Expand the existing email plan to cover SMS and push.
- **Phone sign-in** (PRD 10.1, phone number + 2FA). Already captured.
- **Improve look, feel, and animations everywhere** (PRD 10.7). Already
  captured.
- **Improved rankings, including manual ranking** (NEW). Let the commissioner or
  manager override/curate rankings, beyond the synced official rankings.
- **Native iPhone app** (PRD 10.7 mobile integration / possible PWA). Already
  captured.
- **Fighter AI bot** (PRD 10.5). Already captured.

---

*End of priority list. Re-prioritize after each event or draft.*
