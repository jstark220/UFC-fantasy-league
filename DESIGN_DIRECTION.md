# KNOCKDOWN FANTASY: DESIGN DIRECTION V2
## From "competent default" to "designed with conviction"

*Companion to DESIGN_AUDIT.md. That document is about consistency and trust (fixing
seams). This one is about vision: the structural moves that change what the site
IS, not how tidy it is. Goal, in Jacob's words: make it look less like an AI built
it and more like a designer with 20 years of experience did.*

**See the direction, don't just read it:** open
[design-explorations/direction-ab.html](design-explorations/direction-ab.html)
(or the rendered `direction-ab.png`). Panel A is a faithful recreation of the
current language. Panel B is the same data in the proposed language. Same palette,
same content, completely different conviction.

---

## 1. THE DIAGNOSIS: WHY IT READS "AI-MADE"

AI-built sites aren't ugly. They're *unopinionated*. Every choice is the safest
default, and safety in every individual choice adds up to anonymity in the whole.
The current site has seven specific tells:

1. **Everything is a rounded card.** Same radius, same 1px `border-subtle`, same
   padding, stacked in a centered column. Card-in-card-in-card. No surface ever
   bleeds, overlaps, cuts, or touches an edge.
2. **Every section is Eyebrow / Title / Subtitle.** The crimson overline +
   heading + gray sub pattern repeats on literally every section of every page.
   It's a good pattern. Used 40 times, it's a template.
3. **The type never gets loud.** Bebas at 36px for page titles is whispering in a
   sport that screams. And Bebas Neue itself is the single most default "sports
   site" font on the internet; it signals template, not brand.
4. **Color is an accent, never an atmosphere.** Flat #0E0E10 everywhere with tiny
   crimson chips. Real broadcast packages light the room: gradients, glows, tinted
   zones. The site has one radial glow (homepage hero) and nothing else.
5. **There is almost no photography.** UFC is the most visually dramatic sport on
   earth and the product shows it as circular 36px headshots. No art direction, no
   image treatment, no drama.
6. **Symmetry everywhere.** Two equal columns, centered heroes, evenly distributed
   stat strips. Nothing is ever off-balance on purpose, so nothing has tension.
7. **Geometry is generic web.** Rounded rectangles and circles. The sport's own
   iconic shape (the octagon) and the language of fight broadcast graphics
   (angled lower-thirds, diagonal cuts) appear nowhere.

None of these are bugs. All of them are missed decisions.

---

## 2. THE THESIS: BROADCAST GRADE

One sentence to test every future design decision against:

> **Knockdown Fantasy should feel like a UFC PPV broadcast package turned into
> software, not like a SaaS dashboard wearing a dark theme.**

What that means concretely: condensed italic display type at poster scale, angular
geometry borrowed from lower-third graphics, duotone fighter photography as
atmosphere, scoreboard numerals, arena-light gradients, and dense data zones that
contrast against dramatic hero zones. Sleeper feels like a social app. ESPN feels
like a network. Knockdown should feel like the broadcast truck.

---

## 3. TYPE SYSTEM V2

**The move: retire Bebas Neue from the UI. Keep it only in the wordmark.**

The logo, favicon, and app icon stay Bebas (that's the brandmark, it's built, it
works). But UI display type switches to a family with weight range, true italics,
and broadcast credibility:

- **Display: Barlow Condensed** (Google Fonts, free). Weights 600/700/800 plus
  real italics. The 800-italic uppercase setting is the signature voice: it's the
  type language of fight posters and sports broadcast graphics. Bebas has one
  weight and no italic, which is exactly why it can't build hierarchy.
- **Body: Space Grotesk stays.** It's distinctive, reads well, and contrasts
  cleanly against a condensed display face. No change.
- **Numbers: Barlow Condensed 800 for scoreboard moments** (big points, ranks,
  countdowns) with `tabular-nums`; Space Grotesk for inline data.

**Scale gets a poster register.** Add to tokens.css:

```css
--text-poster:  clamp(64px, 9vw, 128px);  /* hub hero, league name, winner moments */
--text-display: clamp(44px, 6vw, 80px);   /* page heroes (today's 80px stays for home) */
--text-h1:      2.75rem;                   /* 44px, up from 36: page titles */
```

**Usage rules (the part that makes it look designed):**
- Poster type is set tight (`line-height 0.88`, slight negative tracking), breaks
  onto two lines on purpose, and one word gets the crimson. See Panel B's
  "FIGHT / NIGHT." treatment.
- Italic 800 = live/dramatic moments. Upright 700 = structure (section labels,
  card titles). Never mix both in one block.
- Section labels move from 11px gray Space Grotesk to 17px Barlow Condensed 700
  with wide tracking. Bigger label, less visual weight than it sounds, far more
  confident. (Panel B's "MY CORNER · 2 OF 3 FIGHTING".)
- Kill the universal eyebrow. The crimson overline survives only where there's
  genuinely a kicker to say (LIVE · UFC 317). Sections otherwise open with the
  label itself.

Font loading: add Barlow Condensed to the existing Google Fonts request (later
self-host per the audit). Bebas stays loaded only for `.top-nav__logo` and the
auth wordmark until those become SVG.

---

## 4. GEOMETRY SYSTEM: THE OCTAGON IS THE BRAND

The sport hands you a geometric identity no other fantasy product has. Use it.

- **Octagonal avatars everywhere.** One utility class,
  `clip-path: polygon(30% 0, 70% 0, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0 70%, 0 30%)`,
  replaces every circular fighter/manager photo. This single change is the
  highest recognition-per-line-of-CSS move available. (Panel B rows.)
- **Cut corners replace rounded corners on feature cards.** Key surfaces (this-week
  card, hub hero, race panel, starter cards) get one 22px diagonal cut
  (`clip-path: polygon(0 0, calc(100% - 22px) 0, 100% 22px, 100% 100%, 0 100%)`)
  plus a 3px crimson spine on the left edge, and lose their 1px border entirely.
  Elevation comes from background contrast, not borders.
- **Radius scale drops globally:** 12px → 6px default, 8px → 4px on chips. Soft
  pill shapes (border-radius: 999px) are retired except for presence dots. Pills
  read "friendly SaaS"; this product is angular.
- **Lower-third chips.** Status tags (LIVE, NEXT, PROJ, W/L, CHAMP) become skewed
  parallelograms (`transform: skewX(-10deg)`, content counter-skewed), set in
  Barlow Condensed 700. This is the most broadcast-coded element in the whole
  system. (Panel B's LIVE R2 chip.)
- **Diagonal section seams** on the marketing page: alternating sections meet at a
  2-3deg clipped angle instead of a straight border. Two `clip-path` lines, huge
  template-breaking effect.

Rule of restraint: cut corners and skewed chips appear on *featured* and *status*
elements only. Body cards, forms, and settings keep plain 6px-radius rectangles,
or the language becomes noise.

---

## 5. COLOR AND ATMOSPHERE V2

The palette doesn't change (it's good). The *application* changes from flat to lit.

New tokens:

```css
/* Arena atmosphere: hero/moment surfaces are lit, not flat */
--bg-arena: radial-gradient(90% 60% at 85% -10%, rgba(193,59,46,0.20), transparent 60%),
            radial-gradient(70% 45% at -10% 110%, rgba(193,59,46,0.09), transparent 60%),
            #0B0A0B;
/* Data surfaces: one step cooler than drama surfaces */
--bg-data:  #131316;
/* Champion gold is a gradient, never a flat fill */
--gold-strap: linear-gradient(135deg, #E8C56C 0%, #D4A84B 45%, #B8862F 100%);
```

- **Two-zone model.** Every screen divides into *drama zones* (heroes, winner
  banners, live moments: arena gradient, poster type, photography) and *data
  zones* (tables, lists, forms: flat, cool, dense, quiet). The contrast between
  zones is what makes both work. Today every zone is the same temperature.
- **Champion gold upgrades to the gradient** everywhere it's earned (champ tier
  borders, leader row, title chips). Flat #D4A84B stays for small text/icons.
  Gold semantics don't change: earned things only.
- **Grain.** A barely-there 1px scanline/grain overlay on drama zones
  (`repeating-linear-gradient`, opacity ~0.04) kills the "flat hex fill" AI look
  at zero asset cost. Already proven in the exploration.
- **Light mode gets a concept instead of an inversion:** "the morning-after sports
  page." Warm paper (#FAF7F2 direction), near-black ink, crimson as ink-stamp
  accent, photography stays duotone. Same tokens, different soul. (Build this
  after dark-mode v2 ships; dark is the brand default.)

---

## 6. PHOTOGRAPHY: ONE RECIPE, EVERYWHERE

The site already has every UFC fighter's ESPN cutout. What's missing is treatment.

**The recipe (pure CSS, no asset work):**

```css
.photo-duotone img { filter: grayscale(1) contrast(1.18) brightness(1.02); }
.photo-duotone::after { /* crimson-to-transparent multiply wash */
  background: linear-gradient(160deg, rgba(193,59,46,0.28), transparent 55%);
  mix-blend-mode: multiply;
}
```

Every photo on a drama surface goes through it: hub hero cutouts, league header
backdrop, homepage, fighter page hero, winner banners. Untreated color photos
remain only in data rows (recognition beats art direction when scanning a list).
One treatment, applied with total consistency, is what reads as art direction.

New photographic surfaces this unlocks:
- **League header backdrop:** the next event's main-event fighters, duotone,
  cropped huge behind the league name (the hub hero pattern, promoted upward).
- **Section breaks on the homepage:** full-bleed duotone action strip between
  scoring and format sections.
- **Empty states:** faded duotone cutout behind the empty-state copy.

---

## 7. LAYOUT RE-ARCHITECTURE (PER SURFACE)

- **Homepage: editorial, not centered.** Kill the symmetric two-column hero. New
  composition: poster type at `--text-poster` anchored low-left and allowed to
  bleed toward the edge, full-height duotone Topuria cutout overlapping the
  headline's right side (cutout partially *behind* the type: two z-layers, cheap,
  spectacular), CTAs bottom-left, stats as a single thin ticker row pinned to the
  hero's bottom edge. Sections below alternate left/right alignment with diagonal
  seams. The carousel dies; slides 2 and 3 become scroll sections.
- **League home: bento, not stack.** CSS grid, 12 columns: this-week card spans
  8 wide and 2 rows (with photographic backdrop), standings preview 4 wide,
  top performers 4, free agents 4, activity 4 but double height, league info
  collapses to a footer row. Varying cell sizes create the hierarchy the page
  currently fakes with order alone.
- **App shell: left icon rail on desktop** (64px, octagon-cropped team avatar at
  top, icons for Home / Fight Night / Roster / Free Agency / Trades / Standings /
  Chat, league switcher at bottom). The top bar thins to context + identity chip.
  Mobile keeps bottom-sheet/tab patterns. This is the single biggest "real
  product, not website" move; ship it last, it touches everything.
- **Standings: broadcast scoreboard.** Dense 44px rows, rank in Barlow 800,
  octagon avatars, gold-strap leader row, race bars in the ink treatment from the
  hub, your row pinned/highlighted. Drop the generic table look entirely.
- **Hub:** already 80% of the way to Broadcast Grade. Retrofit: poster-scale
  fight names in the hero, lower-third chips, octagon avatars in race rows.

---

## 8. SIGNATURE COMPONENTS (NEW DESIGN FUNCTIONS)

Things that exist nowhere else; each one is brand equity:

1. **Tale of the Tape.** The split face-off panel (two duotone cutouts converging
   on an angular VS seam, stat bars filling from the center outward). Use it: hub
   hero, fight-card modal header, trade comparison, fighter page vs-next-opponent.
   Build once as a shared module like fight-rows.js.
2. **The Ticker.** A thin live strip (scores, finishes, lock countdown) that runs
   along the top of league surfaces during fight week only. Broadcast chyron
   energy; event-gated so it stays special.
3. **Round pips.** R1-R5 segmented indicator (active round pulses crimson) on
   every live fight representation. Small, repeated, ownable.
4. **The Gold Strap.** A 3px `--gold-strap` gradient edge that marks earned
   status: standings leader, champion cards, winner banners, season champ profile.
   One meaning, everywhere.
5. **Scoreboard counter.** The big Barlow-800 tabular number with count-up tween
   (exists in hub race) promoted to a shared primitive for: lineup projected
   total, dashboard stats, hub points, fighter modal totals.
6. **Octagon avatar** (section 4). Listed here because it's also identity.

---

## 9. MOTION LANGUAGE

One curve, one scale, signature moments. Add to tokens.css:

```css
--ease-broadcast: cubic-bezier(0.16, 1, 0.3, 1);
--t-fast: 120ms;  /* hovers, presses */
--t-base: 240ms;  /* reveals, slides */
--t-slow: 480ms;  /* hero/poster entrances */
```

- Lists cascade in with a 30ms stagger (one helper, reused).
- Numbers never jump: they tween (the hub's tweenNumber becomes shared).
- Lower-third chips enter by sliding along their skew axis (translateX + the
  existing skew), which makes even a status change feel like a broadcast cut.
- Poster headlines enter once per page load: 12px rise + fade at --t-slow. No
  scroll-triggered re-animation, no parallax. Restraint is the tell of seniority.
- `prefers-reduced-motion` blanket stays.

---

## 10. WHAT NOT TO TOUCH

The restraint list, because veterans subtract more than they add:

- The token discipline and the crimson-scarcity rule (1-2 per screen). V2 makes
  crimson *atmospheric* in drama zones but the rule still governs UI elements.
- Gold = earned only. (The exploration uses a gold UP NEXT chip; that's a
  deliberate rule violation to show the chip shape, don't ship gold there.)
- The microcopy voice. It's already better than the visuals.
- The trading-card starter system and tier borders (gold/silver/bronze): keep,
  re-skin with cut corners + duotone.
- The store-first hub architecture, chat dock, mobile-parity workflow.
- Space Grotesk, the dark-first default, and the existing spacing scale.

---

## 11. ROLLOUT PLAN

Sequenced so every phase ships visibly and nothing breaks the one below it.

**Phase 1 (foundation, ~3 days): the system swap.**
Barlow Condensed loaded + display-type classes; radius scale down; octagon avatar
utility; lower-third chip component; arena/data zone tokens; grain; duotone
recipe class. Nothing rearranges yet; the site just sharpens everywhere at once.

**Phase 2 (~1 week): the three showcase surfaces.**
Homepage editorial hero (carousel removed), league home bento + photographic
header, standings scoreboard. These are the screens in the pitch deck.

**Phase 3 (~1 week): signatures.**
Tale of the Tape module (hub hero + trade compare + modal header), gold strap,
scoreboard counter primitive, round pips, fight-week ticker.

**Phase 4 (when ready): the shell.**
Left icon rail + identity chip, then light mode v2 ("sports page" concept).

**First five moves if starting today:** Barlow Condensed in, octagon avatars in,
lower-third chips in, arena gradient on the hub hero + this-week card, section
labels to condensed 17px. Half a day of work, and every screen stops whispering.

---

*Exploration: [design-explorations/direction-ab.html](design-explorations/direction-ab.html)
renders both languages side by side with live data shapes. Open it in a browser,
or view direction-ab.png. Everything in Panel B is plain CSS already proven in
this codebase's constraints (no frameworks, no build step, no paid assets).*
