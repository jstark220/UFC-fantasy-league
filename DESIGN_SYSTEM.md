# DESIGN_SYSTEM.md

## Knockdown Fantasy — Product Design System v1.0

**Last updated:** April 2026
**Owner:** Jacob Stark
**Purpose:** This document is the single source of truth for visual design, voice, and interaction patterns across Knockdown Fantasy. Anyone (human or AI) writing UI code for this product should consult this document first. Deviations require explicit approval.

---

## 1. Brand Foundation

### 1.1 Product Name

**Knockdown Fantasy** (working name; open to change later)

The name references the single most explosive moment in MMA: the knockdown. This shapes the product's personality. Knockdowns are sudden, decisive, and emotionally charged. The design should feel **exciting but grounded**, not chaotic. Think "edge of your seat on fight night," not "screaming commentator."

### 1.2 Personality

- **Between Sleeper and ESPN.** Sleeper is the playful young cousin. ESPN is the buttoned-up uncle. Knockdown Fantasy sits at the dinner table between them.
- **Confident, not cocky.** We're a specialty product for UFC fans. We know our sport. We don't try to be everything.
- **Approachable, not juvenile.** Emoji used sparingly and intentionally. No exclamation-point-spam.
- **Collectible, not transactional.** Fighters feel like assets with history, not database rows.

### 1.3 Voice & Tone

**UI copy (buttons, labels, form fields):** Professional and direct. Matches what users would expect from any serious fantasy product.
- ✅ "Create League"
- ✅ "Submit Lineup"
- ✅ "View Standings"
- ❌ "Let's goooo 🔥"
- ❌ "Smash that draft button"

**Marketing & empty states:** Personality allowed. Reference the sport. Make the product feel alive.
- ✅ "No fights this week. Rest up."
- ✅ "Your draft board is empty. Time to build a dynasty."
- ✅ "Champions hold all 10 belts. Go get yours."

**Error messages:** Helpful, never cute. Assume the user is frustrated.
- ✅ "Incorrect password. Try again or reset it below."
- ✅ "This league is full. Ask your commissioner to remove a member or find another league."
- ❌ "Oops! Something went wrong 😬"

**Emoji usage:** Allowed for flavor but used sparingly. Prefer SVG icons over emoji in the UI. Reserve emoji for empty states, notifications, and marketing moments. NEVER use 🔥, 💯, 🚀, or other generic hype emoji.

### 1.4 Things We Actively Avoid

- **Gambling aesthetics.** No neon green on black. No "LIVE ODDS" banners. No dice, chips, or coin imagery. No "sportsbook" framing of any interaction.
- **Crypto/NFT aesthetics.** No holographic effects beyond the trading card context. No "mint your fighter" language. No Web3 terminology.
- **Emoji overload.** Emoji is seasoning, not a main course.
- **Corporate sterility.** No stock photos. No generic Inter-everywhere. No "Welcome to our platform" greetings.
- **Commentator shouting.** No "AND STILLLL" or "WHAT A KNOCKOUT" in UI copy.
- **Fake urgency.** No "Only 3 spots left!" unless it's literally true.

---

## 2. Color System

### 2.1 Primary Palette

Knockdown Fantasy uses a restrained, intentional palette. Most of the interface is neutral (grays, near-black, off-white). Color is used strategically for emphasis.

#### Neutrals (form the majority of the UI)

| Token | Dark Mode | Light Mode | Usage |
|-------|-----------|------------|-------|
| `--bg-primary` | `#0E0E10` (near-black, warm) | `#FAFAF7` (warm off-white) | Main page background |
| `--bg-secondary` | `#17171A` | `#F2F2EE` | Card backgrounds, sidebar |
| `--bg-tertiary` | `#1F1F23` | `#E8E8E3` | Hover states, nested surfaces |
| `--border-subtle` | `#2A2A2F` | `#DADAD3` | Dividers, card borders |
| `--border-strong` | `#3A3A40` | `#B8B8B0` | Input borders, active states |
| `--text-primary` | `#F5F5F0` | `#1A1A1C` | Headings, primary text |
| `--text-secondary` | `#A8A8A3` | `#5A5A55` | Subheadings, meta info |
| `--text-tertiary` | `#6A6A65` | `#8A8A82` | Timestamps, hints |

**Important:** The dark mode background is `#0E0E10`, not pure black. The light mode background is `#FAFAF7`, not pure white. Both are warm-shifted. This makes the product feel less clinical.

#### Accents (used strategically, never overwhelming)

| Token | Hex | Usage |
|-------|-----|-------|
| `--accent-crimson` | `#C13B2E` | Primary CTA, knockdown moments, live indicators |
| `--accent-crimson-hover` | `#A82E23` | Hover state for crimson buttons |
| `--accent-crimson-subtle` | `#C13B2E15` | 8% opacity version for backgrounds |
| `--accent-gold` | `#D4A84B` | Champion badges, victory states, achievements |
| `--accent-gold-subtle` | `#D4A84B15` | 8% opacity version for backgrounds |
| `--accent-success` | `#4A9D6F` | Wins, completed actions, "live now" positive states |
| `--accent-warning` | `#D4A84B` | Warnings, lineup lock imminent, cap exceeded |
| `--accent-error` | `#C13B2E` | Errors (same as crimson, used in different contexts) |

**Critical usage rules:**
- **Crimson is rare.** Use it for maximum 1-2 elements per screen. The primary CTA button. The "LIVE" indicator on a fight card. Your KO notification. Never decorative.
- **Gold is for earned moments.** Championship badges, your team winning, achievements unlocked. Never decorative.
- **Neutrals do most of the work.** A well-designed Knockdown Fantasy page is mostly gray/near-black with one or two strategic pops of crimson or gold.

### 2.2 Tier System Colors (for Fighter Trading Cards)

Ranked fighters get visual tier treatment on their trading cards. This reinforces the collectible feel and lets users see value at a glance.

| Tier | Border Color | Accent Color | Glow Effect |
|------|--------------|--------------|-------------|
| Champion | `#D4A84B` (gold) | `#D4A84B` | Subtle gold glow, slightly animated |
| Top 5 (rank 1-5) | `#C8C8C8` (silver) | `#C8C8C8` | Subtle silver glow |
| Top 15 (rank 6-15) | `#B87333` (bronze) | `#B87333` | No glow |
| Unranked | `--border-subtle` | None | No special treatment |
| BMF / Interim champion | Gold + crimson accent stripe | Both | Crimson "BMF" or "INTERIM" badge overlay |

Glow effects are subtle CSS box-shadows, not aggressive. Example:
```css
.card-champion {
  border: 2px solid var(--accent-gold);
  box-shadow: 0 0 24px -8px var(--accent-gold);
}
```

### 2.3 Dark Mode / Light Mode Implementation

- **Dark mode is the default.** Ship it first.
- **Light mode is a toggle** in the user settings menu.
- Use CSS custom properties with `[data-theme="dark"]` and `[data-theme="light"]` attributes on the `<html>` tag.
- Respect `prefers-color-scheme` on first visit, then persist user preference in `localStorage`.

---

## 3. Typography

### 3.1 Font Families

**Headers & display text:** `"Archivo Black"`, fallback to `system-ui, sans-serif`

- Use for page titles (H1), section headers (H2), and fighter name displays
- Has fight-poster energy without being cheesy
- Alternative if Archivo Black isn't accessible: `"Anton"` or `"Oswald"` (similar feel)

**Body & UI text:** `"Inter"`, fallback to `"SF Pro Text", system-ui, sans-serif`

- Clean, modern, professional
- Use for all body copy, buttons, form labels, table cells
- Inter has excellent numeric characters (tabular figures) which matters for stats

**Tabular/numeric data:** Inter with `font-feature-settings: "tnum"`

- Critical for stats tables, leaderboards, records
- Ensures numbers align vertically in columns

**Load fonts via Google Fonts CDN:**
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
```

### 3.2 Type Scale

| Token | Size | Line Height | Weight | Usage |
|-------|------|-------------|--------|-------|
| `--text-display` | 48px / 3rem | 1.1 | Archivo Black 900 | Hero headlines (homepage) |
| `--text-h1` | 36px / 2.25rem | 1.2 | Archivo Black 900 | Page titles |
| `--text-h2` | 28px / 1.75rem | 1.2 | Archivo Black 900 | Section headers |
| `--text-h3` | 20px / 1.25rem | 1.3 | Inter 700 | Card titles, subsections |
| `--text-h4` | 16px / 1rem | 1.4 | Inter 600 | Small section labels |
| `--text-body` | 16px / 1rem | 1.5 | Inter 400 | Default paragraph text |
| `--text-body-sm` | 14px / 0.875rem | 1.5 | Inter 400 | Secondary text, meta info |
| `--text-caption` | 12px / 0.75rem | 1.4 | Inter 500 | Timestamps, badges, small labels |
| `--text-overline` | 11px / 0.6875rem | 1.3 | Inter 700 uppercase, tracking 0.1em | Section labels, table headers |

### 3.3 Special Typography Treatments

**Fighter names on trading cards:** Archivo Black, uppercase, slight letter-spacing

```css
.fighter-name-card {
  font-family: "Archivo Black", sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  font-size: 1.5rem;
  line-height: 1;
}
```

**Fighter records (e.g., "27-5-0"):** Inter tabular figures

```css
.fighter-record {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
```

**Numerical scores / OVR ratings:** Archivo Black, prominent

```css
.ovr-rating {
  font-family: "Archivo Black", sans-serif;
  font-size: 3rem;
  line-height: 1;
}
```

---

## 4. Spacing & Layout

### 4.1 Spacing Scale

Use a consistent 4px base grid.

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | 4px | Micro-spacing (icon + text) |
| `--space-2` | 8px | Tight spacing (form label + input) |
| `--space-3` | 12px | Default spacing between related items |
| `--space-4` | 16px | Standard gap (between cards in a list) |
| `--space-6` | 24px | Section spacing within a card |
| `--space-8` | 32px | Spacing between major sections |
| `--space-12` | 48px | Page section breaks |
| `--space-16` | 64px | Major layout gaps (hero sections) |
| `--space-24` | 96px | Rarely used, top-level page padding |

### 4.2 Container Widths

| Breakpoint | Min Width | Max Content Width |
|------------|-----------|-------------------|
| Mobile | 0px | 100% (with 16px padding) |
| Tablet | 768px | 720px |
| Desktop | 1024px | 1200px (standard pages) |
| Wide desktop | 1440px | 1440px (for dense tables) |

**Page padding rules:**
- Mobile: 16px left/right
- Tablet: 24px left/right
- Desktop: 32px left/right

### 4.3 Density Modes

Pages are either **spacious** or **dense** depending on purpose:

**Spacious (discovery/marketing):**
- Homepage
- Fighter profile / trading card pages
- League creation flow
- Sign-up / login

Uses `--space-8` and above between sections. Generous padding inside cards. Large typography.

**Dense (operational/data):**
- Leaderboards
- Rosters
- Draft board
- Fighter browse lists
- Upcoming event cards

Uses `--space-3` and `--space-4` between items. Tighter padding. Smaller typography. Tables with clear row separation.

---

## 5. Component Library

### 5.1 Buttons

#### Primary Button
```css
.btn-primary {
  background: var(--accent-crimson);
  color: #FFF;
  font-family: "Inter", sans-serif;
  font-weight: 600;
  font-size: 15px;
  padding: 12px 24px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.btn-primary:hover { background: var(--accent-crimson-hover); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
```

**Usage:** One primary button per screen. This is the main action (e.g., "Draft Fighter", "Create League", "Submit Lineup").

#### Secondary Button
```css
.btn-secondary {
  background: transparent;
  color: var(--text-primary);
  border: 1px solid var(--border-strong);
  font-weight: 500;
  padding: 12px 24px;
  border-radius: 6px;
}
.btn-secondary:hover {
  background: var(--bg-tertiary);
  border-color: var(--text-primary);
}
```

**Usage:** Alternative actions (e.g., "Cancel", "View Details", "Back").

#### Ghost Button
```css
.btn-ghost {
  background: transparent;
  color: var(--text-secondary);
  border: none;
  padding: 8px 12px;
}
.btn-ghost:hover { color: var(--text-primary); }
```

**Usage:** Tertiary actions, nav links.

### 5.2 Cards

**Standard card:**
```css
.card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: var(--space-6);
}
```

**Interactive card (hover effect):**
```css
.card-interactive {
  cursor: pointer;
  transition: transform 0.15s ease, border-color 0.15s ease;
}
.card-interactive:hover {
  transform: translateY(-2px);
  border-color: var(--border-strong);
}
```

### 5.3 Fighter Trading Cards (Signature Component)

This is the hero component of Knockdown Fantasy. Spend design effort here.

**Layout:**
- Portrait orientation, aspect ratio 2:3 (e.g., 240px × 360px)
- Full-bleed fighter photo from UFC CDN occupying top 60%
- Bottom 40% contains structured info on a solid background
- Tier border (2px) based on ranking (see Section 2.2)

**Structure (top to bottom):**
1. Tier border + optional glow (champion, top 5, top 15, standard)
2. OVR rating badge (top-left corner, 40px circle, Archivo Black number)
3. Champion/BMF/Interim badge (top-right corner, only if applicable)
4. Fighter photo (full width, top 60%)
5. Division label (small uppercase overline)
6. Fighter name (Archivo Black, uppercase, 2 lines max)
7. Record (tabular numerals)
8. "OWNED" badge (only if logged-in user owns this fighter in any league)

**Example structure:**
```html
<article class="fighter-card fighter-card--champion">
  <div class="fighter-card__rating">94</div>
  <div class="fighter-card__badge-champ">CHAMP</div>
  <img src="https://dmxg5wxfqgb4u.cloudfront.net/..." class="fighter-card__photo" alt="Ilia Topuria">
  <div class="fighter-card__info">
    <span class="fighter-card__division">Lightweight</span>
    <h3 class="fighter-card__name">Ilia Topuria</h3>
    <span class="fighter-card__record">17-0-0</span>
    <span class="fighter-card__owned">Owned in Stark's League</span>
  </div>
</article>
```

**Tier variants:**
- `.fighter-card--champion` → gold border + subtle gold glow animation
- `.fighter-card--top5` → silver border + subtle silver glow
- `.fighter-card--top15` → bronze border
- `.fighter-card--standard` → subtle neutral border (no glow)

### 5.4 Tables

For operational data (leaderboards, rosters, draft board):

**Base table styles:**
```css
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.table th {
  text-align: left;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-subtle);
  font-weight: 700;
  text-transform: uppercase;
  font-size: 11px;
  letter-spacing: 0.1em;
  color: var(--text-secondary);
}
.table td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-subtle);
}
.table tr:hover td { background: var(--bg-tertiary); }
.table tr:last-child td { border-bottom: none; }
```

### 5.5 Form Inputs

```css
.input {
  width: 100%;
  background: var(--bg-primary);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  padding: 12px 16px;
  font-family: "Inter", sans-serif;
  font-size: 15px;
  color: var(--text-primary);
  transition: border-color 0.15s ease;
}
.input:focus {
  outline: none;
  border-color: var(--accent-crimson);
}
.input::placeholder { color: var(--text-tertiary); }
```

### 5.6 Navigation

**Top Nav (global):**
- 64px height
- `--bg-secondary` background
- Logo/wordmark on far left
- Primary nav links: "Fighters", "Events", "Rankings", "My Leagues" (logged in only)
- User menu / theme toggle on far right
- Sticky at top on scroll

**Sidebar (within a league context):**
- 240px wide
- `--bg-secondary` background
- Links: "My Team", "Standings", "Draft Room", "Transactions", "Scoring", "Members"
- Active link has crimson left border (3px)

---

## 6. Signature Design Moments

These are the details that make Knockdown Fantasy feel unique. Invest effort here.

### 6.1 Champion Badges

Any fighter who is a champion gets a subtle gold glow in perpetuity across the product. In lists, on cards, everywhere.

```css
@keyframes gold-pulse {
  0%, 100% { box-shadow: 0 0 16px -4px var(--accent-gold); }
  50% { box-shadow: 0 0 24px -4px var(--accent-gold); }
}
.badge-champion {
  animation: gold-pulse 3s ease-in-out infinite;
}
```

### 6.2 "About to Fight" Banner

When a logged-in user has a fighter competing on the upcoming/live card, show a dismissible banner at the top of their dashboard:

```
🥊 YOUR FIGHTER IS UP TONIGHT
Ilia Topuria (LW Champion) defends his title in the main event of UFC 328.
Your lineup locks in 2h 14m.
[Set Lineup →]
```

On live nights, this banner updates in real-time with fight status. Use `--accent-crimson` for the live indicator.

### 6.3 Animated Loading States

Loading is an opportunity to reinforce the brand.

**Default loading:** A small animated silhouette of a fighter shadowboxing.
**Data table loading:** Skeleton rows with subtle shimmer effect.
**Draft page loading:** A fight glove pulsing at the center of the screen.

Use lightweight SVG animations rather than loading GIFs.

### 6.4 Win / Loss Notifications

When a user's fighter wins, show a non-intrusive toast notification with gold accent:

```
✓ WIN: Ilia Topuria defeated Arman Tsarukyan by KO in Round 2
+24 fantasy points
```

For a knockdown specifically, use crimson accent and the word "KNOCKDOWN".

### 6.5 Empty States

Every empty state should have personality without being cloying.

- No leagues: "No leagues yet. Start one and invite your friends."
- No fighters drafted: "Your roster is empty. Championships aren't built in a day."
- No upcoming fights: "The cage is quiet. Next card drops [date]."

---

## 7. Information Architecture

### 7.1 Top-Level Navigation Structure

**Public (signed out) users see:**
- Homepage (discovery of fighters, events, rankings)
- Fighters (browsable list with filters)
- Events (upcoming + past UFC cards)
- Rankings (division-by-division rankings + P4P)
- Login / Sign Up (top-right)

**Logged-in users additionally see:**
- My Leagues (top-right dropdown or dedicated page)
- Within a league: My Team, Standings, Draft, Transactions, etc.
- Fantasy context layered on existing pages (e.g., "Owned" badges, "Draft" buttons)

### 7.2 Homepage

The homepage is a public-facing discovery experience. Users should want to stay and explore even if they haven't signed up.

**Proposed sections (from top to bottom):**
1. Hero: "Knockdown Fantasy" logo/wordmark + tagline + "Sign Up" CTA + "Browse Fighters" secondary CTA
2. Live / Upcoming Event banner (if applicable): large card showcasing the next UFC card with countdown timer
3. Champion gallery: 12 gold-bordered trading cards showing current champions across divisions
4. Division spotlight: featured division of the week with ranked fighters as trading cards
5. Upcoming fights preview: 3-5 notable upcoming matchups
6. Footer

### 7.3 Fighter Profile Page

The fighter profile is built around the trading card as the centerpiece.

**Layout:**
- Large trading card rendering on the left (desktop) or top (mobile)
- Stats / fight history / news on the right / below
- "Fantasy Context" panel if logged in: which leagues own this fighter, their recent fantasy performance, etc.

---

## 8. Accessibility

### 8.1 Color Contrast

All text must meet WCAG AA standards:
- Body text: minimum 4.5:1 contrast ratio against background
- Large text (18pt+): minimum 3:1 contrast ratio
- UI components & graphics: minimum 3:1

Verify all token combinations meet this. The specified neutrals do, but any custom combinations should be checked.

### 8.2 Keyboard Navigation

- All interactive elements focusable via Tab
- Focus states clearly visible (2px outline in `--accent-crimson`)
- Skip-to-main-content link available

### 8.3 Reduced Motion

Respect `prefers-reduced-motion`. Disable the gold-pulse animation, shimmer effects, and other decorative motion when set.

```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 9. Implementation Guidelines for Claude Code

When redesigning existing pages or building new ones, Claude Code should:

1. **Read this file first** at the start of every design-related task.
2. **Use CSS custom properties** from Section 2 and Section 4. Never hard-code hex values. Never hard-code pixel spacing.
3. **Match the typography scale** in Section 3.2. Never introduce new font sizes arbitrarily.
4. **Keep the accent colors rare.** Crimson and gold are reserved for specific meanings.
5. **Implement dark mode first.** Light mode should be tested but dark mode is the default launch experience.
6. **Follow the component patterns** in Section 5. If creating a new component, match the visual language.
7. **Always comment the CSS** to explain why a design choice was made, especially for non-obvious spacing or color decisions.
8. **When in doubt, err on the side of less.** Remove rather than add. Reduce rather than decorate.
9. **Use real fighter photos** from the UFC CDN where available. Never stock imagery.
10. **Respect the voice guidelines** in Section 1.3. Professional UI copy, personality in marketing/empty states.

## 10. Pages to Redesign

The following existing pages from Phase 1 should be reviewed and redesigned against this system:

- [ ] `signup.html` — apply new type, colors, input styles
- [ ] `login.html` — apply new type, colors, input styles
- [ ] `dashboard.html` — full redesign as logged-in home with league list
- [ ] `create-league.html` — match new spacious form layout
- [ ] `join-league.html` — match new spacious form layout
- [ ] `my-leagues.html` — apply card grid layout
- [ ] `league.html` — full redesign with sidebar structure

Additionally, **new pages needed** to support the design system:

- [ ] `index.html` (public homepage) — NEW, replaces current default landing
- [ ] `fighters.html` (fighter browse list) — NEW
- [ ] `fighter.html?id=X` (individual fighter trading card page) — NEW
- [ ] `events.html` (upcoming UFC events) — NEW (can be basic for now)

---

## 11. Phased Implementation Priority

**Immediate (before Phase 2 feature work begins):**
1. Set up design tokens in a global CSS file (`public/styles/tokens.css`)
2. Build the component library CSS (`public/styles/components.css`)
3. Rebuild `signup.html`, `login.html`, and `dashboard.html`
4. Build the homepage (`index.html`)
5. Build the fighter trading card component and fighter browse page

**During Phase 2:**
Every new page built should use these tokens and patterns. No exceptions without design discussion.

**Later (Phase 3):**
6. Rating engine for OVR numbers
7. Polished animations (gold pulse, knockdown notifications, etc.)
8. Light mode refinement and toggle

---

*End of Design System v1.0*
