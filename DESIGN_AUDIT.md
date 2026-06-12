# KNOCKDOWN FANTASY — FULL-SITE DESIGN AUDIT

*Conducted June 2026. Lens: turning the current product into what a Fortune-500 fantasy
sports company would ship — judged against Apple (craft), ESPN (sports authority),
Sleeper (fantasy product benchmark), Adobe/Spotify (design systems), Clay Global /
&Walsh (brand distinctiveness).*

---

## EXECUTIVE SUMMARY

**The verdict:** The foundation is genuinely strong — stronger than most funded
fantasy startups at this stage. The token system is disciplined, the dark theme has a
real point of view, the Fight Night Hub and draft room are flagship-grade, and the
microcopy has personality ("Finishing is always the right call" is a brand line most
agencies would charge for). This is not a redesign situation.

**The gap:** What separates this from Sleeper/ESPN today is not any single screen —
it's **consistency, trust signals, and the seams between screens**. The app reads as
"one excellent designer who built 24 pages over months" rather than "one system that
generated 24 pages." Fortune-500 polish is mostly about killing the 200 small
inconsistencies, shipping the trust layer (meta, favicon, footer, legal), and making
the in-app data *always* real (two hardcoded demo blocks are live in production).

**Scorecard (1–10, Fortune-500 = 9+):**

| Area | Score | One-line diagnosis |
|---|---|---|
| Design tokens / color system | 8.5 | Genuinely excellent; light mode is a second-class citizen |
| Typography | 7 | Strong pairing; missing mid-scale + tabular numerals everywhere |
| Flagship surfaces (Hub, Draft) | 9 | Already at benchmark quality |
| Core app pages (league, lineup, waivers) | 7 | Good bones, inconsistent seams |
| Marketing site (index, auth) | 6 | Solid visually; zero SEO/social layer, carousel dilutes message |
| Navigation / app shell | 5 | No identity layer, logout-as-nav, inconsistent back links |
| Component consistency | 5 | **Four** competing input systems, two page-header systems |
| Trust & credibility layer | 3 | No favicon, no OG cards, no footer links, hardcoded demo data live |
| Accessibility | 6 | Reduced-motion handled; focus states and contrast unaudited |
| Engineering-design hygiene | 4 | 14 different CSS cache versions across pages = stale-style bugs |

---

## THE BIG FIVE (if you only do five things)

1. **Kill the credibility killers (P0, ~1 day).** league.html ships a *hardcoded*
   "UFC 329 · May 3" This Week card whose countdown is already at zero, plus a fake
   Top Performers panel ("Stark 1/2/3"). One stale date destroys more trust than ten
   polished pages can buy back. Wire both to live data or remove until wired.

2. **One stylesheet version, one deploy (P0, ~1 hour).** `components.css` is loaded
   at 14 different `?v=` values (unversioned on dashboard/trades/league-settings/
   account/chat/etc., `?v=41` on fight-night). Any returning user gets a random mix
   of fresh and stale CSS per page — this *is* the source of "it looked broken
   yesterday" bugs. Single version constant, bumped on every deploy, on every page.

3. **Ship the trust layer (P0, ~1 day).** Favicon (none exists — the browser tab is
   a blank globe), meta description, OG/Twitter cards (league invite links should
   unfurl with the league name like Sleeper's do), a real footer (About, Contact,
   Privacy, Terms, "not affiliated with UFC®" disclaimer — you need that line for
   the pitch anyway), and an Android `manifest.webmanifest` (install prompt currently
   iOS-only).

4. **Unify the app shell (P1, ~3 days).** One nav with a user identity chip (initials
   avatar → menu: Account, theme, log out), one back-link convention, one page-header
   component, one input component, one SVG icon set replacing the emoji (☾ 🔊 ⛶).
   This single workstream removes ~60% of the "built by hand" feel.

5. **Make numbers behave like a sports product (P1, ~1 day).** Every score, rank,
   countdown and record should use `font-variant-numeric: tabular-nums`, consistent
   decimal precision (847.4 vs 41.40 vs 186 currently coexist), and shared
   delta/trend chips (▲ green / ▼ red with the same geometry everywhere). ESPN's
   entire feel is "numbers never jiggle."

---

## GLOBAL SYSTEMS AUDIT

### 1. Brand & identity
- **No logomark.** The brand is a text string ("Knockdown Fantasy" with a red first
  word). The iOS icon (KN/FANTASY tile) exists but nothing else uses that mark. Cut a
  proper "KN" monogram as SVG: favicon, nav logo at small sizes, loading screen,
  empty states, OG card template. &Walsh would say: you have a wordmark, not a brand.
- **Voice is a real asset — codify it.** "Built for fans who actually watch,"
  "Finishing is always the right call," "Last Place Larry." Add a one-page voice
  section to DESIGN_SYSTEM.md (confident, insider, a little cocky, never snarky at
  the user) so every new empty state and toast keeps the accent.
- **"THE FIRST OF ITS KIND" (hero eyebrow)** is a claim, not a story. Replace with
  the category you own: "STAT-BY-STAT UFC FANTASY."

### 2. Typography
- Bebas Neue + Space Grotesk is a strong, ownable pairing. Issues:
  - **No mid-scale step.** Scale jumps 36 → 28 → 20px. Card titles keep getting set
    at h3/20px and look weak next to Bebas headers. Add `--text-h2-sm: 1.5rem`.
  - **Bebas is doing too many jobs.** It's display AND labels AND buttons on some
    surfaces. Rule: Bebas only ≥20px and only for names/headlines/numbers-as-drama;
    everything else Space Grotesk semibold uppercase with letter-spacing.
  - **Tabular numerals are not set anywhere.** Countdowns visibly jiggle as digits
    change width. One rule fixes the whole site:
    `.countdown-unit__value, .standings-table td, [class*="__pts"], [class*="score"] { font-variant-numeric: tabular-nums; }`
  - **Font loading:** Google Fonts with `display=swap` = visible FOUT on every cold
    load, and a third-party request. Self-host the two families (woff2, preload) —
    faster, more private, more "we own our stack."

### 3. Color
- tokens.css is the best file in the codebase. Keep the discipline. Gaps:
  - **Light mode is reactive, not designed.** The hub needed a 5-fix override block
    because component CSS hardcodes dark rgba values. Audit `components.css` for
    every `rgba(0,0,0` / `rgba(255,255,255` literal and replace with tokens:
    `--overlay-1/2`, `--shadow-1/2/3`, `--halo`. Until then, every new feature will
    break light mode the same way the hub did.
  - **Crimson discipline is slipping on dense pages.** Waivers mobile (Add button) +
    LIVE pill + phase banner + claim badge can all be crimson in one viewport. Run a
    per-screen pass with the rule from your own design system: max 1–2 crimson
    elements; demote the rest to text-primary weight or borders.
  - **Add `--accent-crimson-strong` text-on-dark variant** — #C13B2E text on #0E0E10
    is ~4.0:1, borderline for small text (kf-red nav logo, st-delta values).

### 4. Layout & page templates
- **Two header systems:** `dashboard-header` (dashboard/create/join/score-event) vs
  `league-header` (everything else) with different padding, eyebrow handling, and
  type sizes. Collapse to one `page-header` with `--eyebrow`, `--title`, `--actions`
  slots.
- **Inline styles are leaking** (`style="display:block; margin-top: var(--space-4)"`
  on league.html buttons, inline-styled mockup dots on index). Each one is a place
  the design system can't reach. Sweep them into classes.
- **Hardcoded content in HTML** (This Week card, Top Performers, countdown script
  targeting a past date in league.html) — see Big Five #1.

### 5. Components
- **Four input systems coexist:** `.input` (create-league, score-event),
  `.form-input` (league-settings), `.waiver-search`/`.waiver-filter` (waivers,
  trades, commissioner), and bare inputs (account.html). Different heights, borders,
  focus states. One `.field` component, four aliases during migration.
- **Buttons are close but not closed:** `btn-primary/secondary/ghost` is right; add
  the missing variants people are hand-rolling: `btn-danger` (commissioner), `btn-sm`
  (exists in score-event only), icon-button (waiver order, theme, sound). Document
  the matrix: variant × size × state.
- **Tables:** `league-table` and `standings-table` are separately styled. One
  `.data-table` with density modifiers; right-align all numeric columns (standings
  mockup on the homepage currently center/left-aligns points).
- **Empty states (empty-state.js) are a strength** — most products never build this.
  Extend the same API to error states ("couldn't load — retry") which currently fall
  back to bare text like "Loading free agents…" forever on failure.
- **Toasts/messages:** hub has a real toast layer; the rest of the app uses
  page-local `#message` divs with different styling (settings-message, message,
  commishMessage). Promote the hub toast system sitewide.

### 6. Navigation & app shell (biggest structural gap vs Sleeper)
- **No user identity anywhere in the chrome.** No avatar, no display name, no
  account entry point except remembering account.html exists. Add an initials chip
  (top right) → menu: Account, Theme, Log out.
- **"Log out" is a permanent top-level nav action on every page.** No major product
  does this; it reads as developer scaffolding. Move into the avatar menu.
- **Back-link roulette:** "← League", "← Dashboard", "← Back", "← Back to League",
  "← Lobby" — five conventions. Pick one ("← Back" with context label) or replace
  with persistent league tabs (league-nav.js already exists — make it the law on
  every league page, desktop included).
- **Theme toggle placement** floats bottom-center on auth pages (orphaned-looking in
  screenshots) and top-nav elsewhere. One home: the avatar menu + auth page corner.
- **Icons are emoji:** ☾/☀ (theme), 🔊 (draft sound), ⛶ (fullscreen) render
  differently per OS and break the visual register next to your stroke-SVG icons
  (waiver order, install). Single 24px stroke icon set (Lucide-style, inline SVG
  sprite — no framework needed).

### 7. Motion
- The hub's motion layer (FLIP standings, count-up tweens, toasts) is the standard —
  the rest of the app is static, so the hub feels like a different product (in a
  good way, but the gap is felt on the way back). Cheap wins: 150ms ease-out on all
  hover states (some have none), count-up on dashboard stat strip, page-content
  fade-in instead of `display:none → block` pop after auth check.
- `prefers-reduced-motion` blanket override in tokens.css is correct and rare — keep.

### 8. Accessibility (un-audited debt, mostly cheap)
- **No global `:focus-visible` style.** Keyboard users get the browser default ring
  on some elements, nothing on custom dropdowns. One token ring:
  `:focus-visible { outline: 2px solid var(--accent-gold); outline-offset: 2px; }`
- `--text-tertiary` (#6A6A65 on #0E0E10) is ~3.2:1 — fails AA for the timestamps and
  hints it's used on. Nudge to #7A7A74.
- Tab systems (waiver-tabs, hub tabs) are buttons without `role="tab"`/`aria-selected`;
  screen readers see a row of unrelated buttons.
- Live-updating regions (hub race, countdowns) need `aria-live="polite"` (chat
  already does this — copy the pattern).
- Color-only meaning: trend arrows ↑/↓ have glyphs (good); win/loss state on fight
  rows is check-mark + color (good); keep that discipline.

### 9. Engineering hygiene that IS design
- **CSS versioning chaos (Big Five #2).** Also: `?v=` strings on JS differ per page
  (`waivers.js?v=19`, `league.js?v=4`, `lineup.js?v=7`). Adopt one `BUILD` version
  injected on deploy, or a tiny Node script that rewrites all `?v=` in one pass.
- **components.css is ~17k lines, one file.** Without a build step you can still
  split by domain (`base.css`, `components.css`, `pages.css`, `hub.css`) — HTTP/2
  makes 4 requests free, and you stop scroll-hunting a 17k-line file.
- **Auth-gated pages flash blank** (body hidden until auth resolves, plus a loading
  screen). Replace with skeleton shells (hub already has skeletons — reuse).
- **lineups.html vs lineup.html** both exist (`?v=17` vs `?v=12`) — if one is dead,
  delete it; dead pages rot and get indexed.

---

## PAGE-BY-PAGE FINDINGS

### index.html (marketing home) — the highest-leverage page
*Rendered desktop + 390px mobile.*
1. **No SEO/social layer at all:** no meta description, no OG/Twitter tags, no
   favicon, no canonical. Sharing knockdownfantasy.com anywhere produces a blank
   card. For a product whose growth loop is "invite your league," this is the
   single biggest marketing-design gap.
2. **The hero carousel buries the lede.** Three rotating value props = the visitor
   sees a random one. The strongest story (stat-by-stat scoring + the trading-card
   roster visual, slide 1) should be *the* hero; slides 2–3 become scroll sections.
   Apple doesn't rotate its hero. (Also: 7s auto-rotate with full-layout swap is a
   motion-sickness and CLS risk; arrows only appear on hover = undiscoverable.)
3. **Large dead band above the hero on desktop** (screenshot: headline starts ~35%
   down the viewport). Pull content up; the first paint should show headline + CTA +
   visual with zero scroll.
4. **Mockups are good — make them undeniable.** The browser-chrome frames with real
   component markup are a great trick. Two upgrades: drop a *live* read-only demo
   league link ("See an example league" currently goes to #howto — a dead promise),
   and add a Fight Night Hub screenshot/video — your most impressive surface isn't
   shown to prospects at all.
5. **Scoring section is a spreadsheet.** Four cards × 6 rows of +N values. Keep it,
   but lead with a worked example: "Topuria's UFC 317 night = 41.4 pts" broken into
   chips (you already have this data in the hero card — connect the two).
6. **Numbers drift:** homepage says divisional title +12, BMF +8, top-5 +8;
   CLAUDE.md/scoring.js history says +10/+5/+4. Whatever is true, the homepage table
   should be *generated* from the same config `scoring.js` uses, or it will drift
   again.
7. **Stats strip** ("Every active UFC fighter · Live Polymarket odds · Free to
   play") is good credibility — add the two numbers that actually impress: fighter
   count (~750+) and "scores update every 2 minutes live."
8. **Footer is an empty shell.** Needs: product links, How it works, Contact,
   Privacy/Terms, the UFC trademark disclaimer, and a "Built by a fan" line —
   indie-credibility plays well until the UFC pitch lands.
9. Mobile: hero stacks fine, but the standings mockup table at 390px clips its
   delta column tight to the edge; give the mockup horizontal padding or hide the
   trend column on mobile.

### login.html / signup.html — closest to done
- Centered card + crimson top border + Google SSO + theme support: clean, correct.
- Polish list: password visibility toggle; inline validation states (error styling
  exists only as a generic message div); `autocomplete` attributes
  (`current-password` / `new-password`); the orphaned bottom-center theme button;
  signup card could restate one benefit line under the CTA ("Free. 2 minutes to
  first draft."); legal consent line ("By signing up you agree to…" — needed once
  Terms exist).
- The diamond-pattern background is a nice texture — consider reusing it as the
  brand's "empty space" treatment elsewhere (e.g., auth, modals, empty states).

### dashboard.html — functional, not yet a "home"
- Welcome header + 3-stat strip + league list is the right skeleton. Gaps:
  1. League cards (rendered by dashboard.js) should carry *state*: your rank, last
     event points, next deadline, unread chat dot — right now choosing a league is
     choosing a folder, not continuing a story.
  2. The 3 stats are static facts; "Lineup Locks" should be a living countdown and
     turn gold <24h (warning token exists for exactly this).
  3. Duplicate actions: empty-state has Create/Join AND a permanent Create/Join row
     below the list. Keep one (the row), make the empty state's CTAs primary only
     when the list is empty.
  4. This page is where a "next event" hero belongs (the league page has one —
     cross-league users should see it before picking a league).

### league.html (league home) — highest-priority fixes in the app
1. **Hardcoded This Week card:** "UFC 329 · Saturday, May 3 · Makhachev vs
   Tsarukyan II" with a JS countdown to 2026-05-03 — *a month in the past*. Every
   real user sees a dead countdown today. Wire to `ufc_events` (the code to do this
   exists in index.html's `wireNextEvent()` and lineup.js's event banner — reuse).
2. **Hardcoded Top Performers** (Islam/Pereira/Topuria with owners "Stark 1/2/3").
   Wire to last scored event via `scores`, or hide the panel until wired.
3. With those fixed, this page's architecture is genuinely good (event hero → live
   panels → activity → league info demoted to bottom). The Fight Night Hub button
   placement on the event card is exactly right.
4. Member table: a `league-table` with Team/Role columns reads as admin UI in the
   middle of a fan product — fold managers into the standings preview or restyle as
   avatar rows.

### lineup.html — good bones, one promotion needed
- Starter cards + roster list with sticky mobile starters: solid. The trading-card
  starter treatment is a signature — *promote it*: this is the screenshot that sells
  the product, and it deserves the same poster-cutout art direction the hub hero got.
- Add: total projected points for the lineup (sum chip near "My Starters" — data
  already exists via projections.js), and a lock-state visual (post-lock, cards
  should visibly seal: dimmed border + lock glyph, not just become inert).

### waivers.html — strongest core page post-redesign
- Mobile row redesign (memory: crimson Add, FV + rank, next-fight line) is the
  template the rest of the app should match.
- **Filter overload:** search + 4 selects + a toggle in one row. Collapse to search
  + division + a "Filters" popover for the rest; show active filters as removable
  chips. (Desktop can keep the row; mobile needs the popover.)
- Waiver-order icon button is the right pattern — same treatment should exist for
  sort on mobile.

### standings.html — under-designed relative to its importance
- It's the scoreboard of a season-long game and it's a plain table. The hub's race
  view (bars, deltas, FLIP) proved the right visual language — bring a static
  version here: rank movement vs last event, points-back-of-leader column, your row
  highlighted (homepage mockup already shows `--you` highlighting; production should
  match its own ad), and a simple season sparkline per team (pure SVG, no deps).

### trades.html — functional, low excitement
- Propose flow: two raw lists of names with checkboxes. Add the fighter context that
  every other surface has (FV score, rank chip, next fight) — fight-rows.js patterns
  apply. A "trade balance" meter (sum of FV each side) would be a Sleeper-tier
  feature that your FV system makes nearly free.
- Empty incoming/pending/sent tabs need empty-state.js treatment.

### draft.html — already flagship; protect it
- Lobby, fullscreen mode, sounds, mock flows: this is the second-best surface in the
  product. Only notes: emoji control icons (🔊 ⛶) → SVG, and the approved-but-unbuilt
  mobile cell redesign (FV rank + next-fight date) is still pending from memory.

### fight-night.html (Hub) — benchmark
- Current state is the bar everything else gets judged against. Remaining design
  debt is listed above only as: light-mode literal-rgba sweep originated here —
  finish the token conversion so the override block shrinks.

### account.html / league-settings.html / commissioner.html — utilitarian tier (OK)
- These can stay plain, but they must stop being *differently* plain: three input
  styles, three message-banner styles, two header styles across the three pages.
  After the shell/input unification they're done.
- commissioner.html's warning copy is excellent ("Use sparingly and tell your
  league") — add the visual: crimson-tinted page accent or banner so destructive
  context is felt, not just read.

### activity.html / chat.html / fighter.html
- Activity: feed + filter is fine; add type icons (trade/claim/drop) and day
  grouping headers so it scans like a timeline, not a log file.
- Chat: real page + widget + dock = three chat surfaces sharing one engine — good
  architecture. Unify message styling with the hub dock (it's the most refined).
- Fighter page: hero + history + next fight is the right spine; this page should
  eventually absorb the fighter modal's career/fantasy stats so links are shareable.

### score-event.html — internal tool wearing the public skin
- It's a commissioner/admin scoring console. That's fine — but visually mark it as
  one (settings-style header, no pretense of fan UI) and ensure it's link-gated so
  regular members never wander in.

### how-it-works-print.html — nice asset; add a "Rules" link to it from the footer
  and league primer so it stops being orphaned.

---

## PRIORITIZED ROADMAP

**P0 — Credibility (do before any public push; ~3 days total)**
1. league.html: live This Week card + Top Performers (or hide) — *the* stale-data risk
2. Unified CSS/JS version constant across all 24 pages
3. Favicon set + meta description + OG/Twitter cards (incl. league-invite unfurl)
4. Real footer: About/Contact/Privacy/Terms + UFC® non-affiliation disclaimer
5. Android manifest.webmanifest (closes the install gap noted in memory)
6. Delete or merge lineups.html vs lineup.html

**P1 — System unification (the Fortune-500 feel; ~2 weeks)**
7. App shell: avatar menu (Account/theme/logout), one back-link rule, league tabs everywhere
8. One page-header, one input/field component, one data-table, one toast system
9. SVG icon set replaces all emoji glyphs
10. Tabular numerals + decimal precision + shared delta chips sitewide
11. Light-mode literal-rgba sweep → elevation/overlay tokens
12. `:focus-visible` ring + text-tertiary contrast + tab ARIA roles
13. Self-host fonts, preload, kill FOUT
14. Homepage: de-carousel the hero, live demo league link, hub showcase section,
    scoring table generated from scoring.js config

**P2 — Distinctive moments (the &Walsh layer; ongoing)**
15. KN monogram brand mark → favicon/loading/empty states/OG template
16. Standings page: race bars, movement arrows, points-back, season sparklines
17. Lineup lock "seal" state + lineup projected-total chip
18. Trade balance meter using FV
19. Dashboard league cards with rank/deadline/unread state + living lock countdown
20. Fight-week takeover theming (subtle event-poster tint on league pages during fight week)
21. Activity feed timeline treatment; chat style unification
22. Voice & microcopy page in DESIGN_SYSTEM.md

**P3 — Delight (post-launch)**
23. Season "Wrapped" recap (pairs with planned AI recaps)
24. Auto-generated team crests/avatars from team name
25. Sound design beyond draft (hub moments, opt-in)
26. Champion gold treatment for season winners (profile badge, league banner)

---

*Method note: public pages rendered live (desktop 1600px + mobile 390px) via headless
Chrome; authed pages audited from source (all 24 HTML files, tokens.css, the shared
renderers fight-rows.js / fight-card-modal.js / league-nav, and the components.css
patterns established during the hub build). Authed-page screenshot verification
should accompany each P1 fix per the mobile-parity rule.*
