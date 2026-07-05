# UFC Fantasy League — Product Requirements Document

**Version:** 1.2
**Last Updated:** June 1, 2026
**Owner:** Jacob Stark
**Status:** MVP live; first Season 1 draft completed (May 31, 2026)

**Companion doc:** `PRIORITIES.md` tracks the post-draft bug-fix and cleanup
list coming out of the first live draft. This PRD remains the source of truth
for scope and rules; PRIORITIES.md is the running task queue.

---

## 1. Product Overview

### 1.1 Vision

UFC Fantasy League is a web-based fantasy sports platform purpose-built for the Ultimate Fighting Championship. Unlike generic sports fantasy platforms that shoehorn MMA into season-based frameworks, this product reflects the unique structure of UFC competition: discrete events, weight-class divisions, title fights, and performance bonuses. The platform enables 8 managers per league to draft real UFC fighters, select starters for each event, and compete on accumulated points across the season.

### 1.2 Problem Statement

Existing fantasy sports products serve UFC poorly. ESPN's offering is simplistic. Tapology's pick'em games lack the depth of full roster management. DraftKings MMA pools are single-event only with no season-long progression. UFC fans who want the strategic depth of fantasy football applied to their sport have no dedicated platform.

### 1.3 Target Audience

- **Primary:** UFC fans aged 18-35 who also play fantasy football or similar season-long fantasy sports with friends
- **Secondary:** Hardcore UFC fans who already engage with ESPN Pick'em, Tapology predictions, or MMA betting markets
- **Initial beta:** Jacob's friends (8 managers) as proof of concept

### 1.4 Success Metrics

**MVP launch (Season 1 with friends):**
- 8 managers complete a full draft without technical issues
- Scoring runs weekly without manual intervention beyond commissioner input
- Zero data loss across the season
- All 8 managers finish the season (no dropouts)

**Post-MVP (Season 2+):**
- Expand to 2-3 leagues (16-24 total managers)
- 90% weekly engagement rate (managers set lineups before card lock)
- Net Promoter Score among users >7/10

---

## 2. Core Product Principles

1. **UFC-native, not sport-agnostic.** Every feature should reflect UFC-specific concepts: weight classes, title fights, performance bonuses, card positions.

2. **Simplicity over feature richness.** The MVP does fewer things well. Trade features come later; scoring system and draft come first.

3. **Commissioner-friendly.** Leagues are run by one manager. All admin features should empower that commissioner with minimal friction.

4. **Mobile-adequate, desktop-first.** MVP optimizes for desktop browsers. Mobile responsiveness is required but mobile-specific features come post-MVP.

5. **Privacy and data integrity.** User data stays within the platform. No data sold. No third-party analytics trackers in MVP.

---

## 3. Technical Architecture

### 3.1 Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Database | Supabase (Postgres) | Integrated auth, RLS policies, generous free tier |
| Authentication | Supabase Auth | Email/password MVP, OAuth post-MVP |
| Frontend | Plain HTML/CSS/JavaScript | No build step, easy for beginner, deploys anywhere |
| Hosting | Vercel | Auto-deploy from GitHub, free tier, custom domains |
| Version Control | Git + GitHub | Industry standard, required for Vercel |
| IDE | VS Code + Claude Code | Familiar editor, AI-assisted coding |

### 3.2 Explicit Non-Choices

- **No React/Next.js for MVP.** Complexity cost outweighs benefits for a beginner. Revisit only if plain HTML becomes unmaintainable.
- **No npm build pipeline for frontend.** Dependencies loaded via CDN.
- **No external analytics (PostHog, Mixpanel, etc.) in MVP.**
- **No paid APIs for fighter data.** Octagon API (free, unofficial) covered ranked roster. Unranked prospects added manually or via SQL seeds.

### 3.3 Database Schema (Current State)

The database is fully provisioned with 11 tables in Supabase:

- **profiles** — User profile data, linked to `auth.users` via trigger
- **leagues** — League metadata (name, format, scoring config, commissioner)
- **league_members** — Junction table linking users to leagues with roles
- **fighters** — 233 UFC fighters with rankings, records, champion flags
- **ufc_events** — UFC event calendar
- **fight_results** — Per-fight outcomes used for scoring
- **rosters** — Per-league-per-member fighter ownership
- **starter_selections** — Per-event starter picks (3 per card per manager)
- **scores** — Computed fantasy points by manager/event/fighter
- **waiver_claims** — Waiver system for free-agent pickups
- **trades** — Trade proposals and execution records

Custom PostgreSQL enums define: weight_class, league_format, draft_format, fight_outcome, card_position, title_type, waiver_status, trade_status.

RLS policies protect user data; reference data (fighters, events, results) is publicly readable.

---

## 4. Feature Specifications

### 4.1 Authentication (MVP Scope)

**User stories:**
- As a new user, I want to sign up with email and password so I can participate in a league
- As a returning user, I want to log in so I can manage my team
- As a logged-in user, I want to log out so I can secure my account on shared devices

**Requirements:**
- Signup form: email, password (minimum 8 chars), confirm password
- Login form: email, password, "forgot password" link
- Password reset via email (post-MVP polish, can use Supabase default flow for now)
- Email confirmation disabled in dev, enabled for production
- Session persistence across browser close
- Logout clears session and redirects to login

**Out of scope for MVP:**
- Social login (Google, Facebook, Apple)
- Two-factor authentication
- Username display (use email for now)
- Profile pictures

### 4.2 League Management (MVP Scope)

**User stories:**
- As a commissioner, I want to create a new league so my friends can join
- As a commissioner, I want to generate an invite code so I can share it
- As a user with an invite code, I want to join the league
- As a commissioner, I want to set scoring rules before the draft
- As a league member, I want to view the member list and standings

**Requirements:**
- League creation form: name, format (season-long or dynasty), draft format (snake or auction), start date
- Scoring rules: defaults locked to v1.2 scoring system (see Section 5)
- Invite code: 6-character alphanumeric, copy-to-clipboard button
- Join flow: paste code, click join, become a league member
- Maximum 8 managers per league (enforced at database level)
- Commissioner can remove members before draft locks

**Out of scope for MVP:**
- Custom scoring rules per league (locked to v1.2 defaults)
- Multiple commissioners
- League visibility controls (private only)
- League-to-league transfers

### 4.3 Draft Interface (MVP Scope — most complex feature)

**User stories:**
- As a manager, I want to see all available fighters organized by division
- As a manager, I want to filter by ranking, division, record
- As a manager drafting, I want a real-time turn indicator
- As a manager, I want an auto-draft queue in case I miss my pick
- As a commissioner, I want to start the draft when all members are ready

**Requirements:**
- Snake draft default: 8 managers × 20 rounds = 160 total picks
- Turn timer: 90 seconds per pick
- Auto-draft: if timer expires, pick top-ranked available player from manager's queue (or highest overall rank if queue is empty)
  - **Known gap (post-draft, June 2026):** the current implementation only fires the expiry auto-pick from the on-clock manager's own awake browser tab, so an inactive manager (sleeping phone, closed tab) stalls the whole draft until the commissioner assigns a pick manually. This must become device-independent (any connected client, or a server-side trigger) before the next live draft. See PRIORITIES.md P0.1.
- Draft board shows all teams' picks in real-time
  - **Known gap (post-draft, June 2026):** picks/turn changes sometimes do not propagate to other managers without a full page refresh. See PRIORITIES.md P0.2.
- Roster construction constraints:
  - 20 fighters total per manager
  - 2 per men's weight class (including flyweight)
  - 2 women's flex (any women's division)
  - 2 any-division flex
- Fighter pool updates as picks are made (drafted fighters grayed out)

**Out of scope for MVP:**
- Auction draft (defer to post-MVP)
- Mock drafts
- Draft grades / analysis
- Video chat during draft

### 4.4 Starter Selection (MVP Scope)

**User stories:**
- As a manager, I want to see all fights on the upcoming UFC card
- As a manager, I want to select my starters from my roster for each card
- As a manager, I want to see which of my fighters are scheduled on this card

**Requirements:**
- Lineup lock at first prelim fight start time
- Starters per card: 2 across all card types (numbered PPVs and Fight Nights). Starters must be from the manager's roster. Historical note: numbered PPVs were 3 through UFC 328; changed to 2 across the board starting with UFC 329.
- Starter must be competing on this card (enforced)
- Visual indicator of which fighters on roster are scheduled
- Last lineup persists if no change made before lock
- After lock, lineup is read-only

**Out of scope for MVP:**
- Multiple starter tiers (superstar/bench)
- Captain multipliers
- Last-minute fighter injury replacements

### 4.5 Scoring Engine (MVP Scope)

Scoring follows the v1.2 rulebook. The MVP implements manual scoring by the commissioner after each event. Automated scoring (via ESPN API or manual fight stat entry) is post-MVP.

**Requirements:**
- Commissioner enters fight results after each event
- System computes fantasy points for each starter using scoring rules
- Leaderboard updates after commissioner submits scores
- Points stored per-manager-per-event for history
- Manager sees breakdown: base stats + bonuses + multipliers

See Section 5 for complete scoring rules.

**Out of scope for MVP:**
- Live scoring during event
- Automated ingestion from UFC/ESPN APIs
- Post-fight stat disputes / corrections (commissioner must manually edit)

### 4.6 Waivers (MVP Scope)

**User stories:**
- As a manager, I want to drop a fighter I no longer want
- As a manager, I want to claim a new UFC signee or undrafted fighter
- As a manager, I want waiver priority to follow reverse standings

**Two waiver mechanisms run simultaneously:**

1. **Event-window waivers** — coordinated league-wide claim periods anchored to each Saturday event:
    - **Thu 3am ET → Fri 3am ET (event week)**: pre-event claim window. All adds queue as claims, processed at Fri 3am ET in reverse-standings priority order.
    - **Sun 3am ET → Tue 3am ET (after event)**: post-event claim window. Same mechanic, processed at Tue 3am ET.
2. **Per-drop rolling waivers** — every dropped fighter sits on waivers in the league for ~48 hours regardless of phase. Claims clear at 3am ET on (drop_date_ET + 2 calendar days). Outside event windows, only newly dropped fighters are claim-only; everyone else is instant free agency.

**Roster cap:**
- Normal cap: 20 fighters.
- Expanded cap: 23 fighters from **Thu 3am ET → Sun 3am ET** during event week (+3 "Temporary Extended Roster Flex" slots that show as a separate section on the lineup page).
- **Wed 3am ET auto-drop**: any manager who has made fewer than 3 manual drops since the cap-expansion start gets their most-recently-acquired fighters dropped until roster size = 20.

**Priority:** approved claimants move to the back of the priority queue (low-priority/last position). Stored on `league_members.waiver_priority`.

**Required tables:**
- `waiver_claims` — pending/approved/rejected/cancelled claims
- `roster_drops` — every drop with source `manual`/`claim`/`auto`. Powers rolling-waiver calculations and the auto-drop bookkeeping.

**UI:**
- **Waivers page**: status banner naming the current phase and the next cutoff time. Available fighters list distinguishes "+ Add" (instant) from "+ Claim" (queued). Each pending claim shows when it will process. League-wide approved-claim activity feed.
- **Lineup page**: "Temporary Extended Roster Flex" section appears only while the +3 expansion is active.

**Processing trigger (v1):** lazy. Every load of the waivers page runs a catch-up pass that processes any cutoffs whose time has passed. Migrate to a Supabase scheduled Edge Function before any meaningful user count (see roadmap §8 Phase 2).

**Out of scope for MVP:**
- FAAB (free agent auction budget)
- Waiver trades
- IR slots for injured fighters
- Configurable cutoff times per league

### 4.7 Leaderboard (MVP Scope)

**User stories:**
- As a manager, I want to see current standings
- As a manager, I want to click into another team to see their roster
- As a manager, I want to see week-by-week scoring history

**Requirements:**
- Main leaderboard: manager name, cumulative points, points per event, last event points
- Click-through to team roster page
- Per-event history table
- No playoffs — highest cumulative points at season end wins

**Out of scope for MVP:**
- Weekly head-to-head scoring (this is a points total format)
- Division / conference splits
- Playoffs or tournaments

### 4.8 Trades (DEFERRED to Phase 2)

Trades are explicitly deferred from MVP. Phase 2 feature. If time allows, a barebones trade system (propose, accept, reject, no counter-proposals) may be built, but it is not a blocker for Season 1 launch.

---

## 5. Scoring System v1.2 (Locked)

### 5.1 Base Scoring (Applied to Every Fight)

| Stat | Points |
|------|--------|
| Significant strike landed | +0.1 |
| Takedown | +1.0 |
| Knockdown | +2.0 |
| Control time (per second) | +0.01 |

### 5.2 Win Bonuses

| Outcome | Points |
|---------|--------|
| Round 1 finish | +18 |
| Round 2 finish | +14 |
| Round 3 finish | +9 |
| Round 4 or 5 finish | +8 |
| Decision win | +6 |
| Quick win bonus (<60s in R1) | Additional +5 |

### 5.3 League Bonuses

| Event | Points |
|-------|--------|
| Divisional title win | +10 |
| Successful divisional title defense | +5 |
| BMF or interim title win | +5 |
| Successful BMF or interim title defense | +3 |
| Top-5 ranked opponent win | +4 |
| Top-10 ranked opponent win | +2 |
| Top-15 ranked opponent win | +1 |

### 5.4 Card Position Multipliers

| Position | Multiplier |
|----------|------------|
| Main event | 1.2x |
| Co-main event | 1.1x |
| All other fights | 1.0x |

Multiplier applies to total points scored in that fight (base + bonuses).

### 5.5 Edge Cases

| Scenario | Scoring |
|----------|---------|
| Cancelled fight | 0 points, no penalty to manager |
| No contest | Base stats only, no bonuses |
| Draw | Base stats + 3 points (both fighters) |
| DQ win | Decision points awarded (+6) |
| DQ loss | Base stats only |

---

## 6. League Rules v1.2 (Locked)

### 6.1 League Configuration

- 8 managers per league (default)
- 20 fighters per roster
- Starters per card: 2 for all card types (both numbered PPVs and Fight Nights)

### 6.2 Roster Construction Requirements

- 2 men's flyweight
- 2 men's bantamweight
- 2 men's featherweight
- 2 men's lightweight
- 2 men's welterweight
- 2 men's middleweight
- 2 men's light heavyweight
- 2 men's heavyweight
- 2 women's flex (any women's division: strawweight, flyweight, or bantamweight)
- 2 any-division flex

### 6.3 Format

- Season-long or dynasty (commissioner's choice at league creation)
- Any start date (no hard season boundaries)
- No playoffs — highest cumulative points at season end wins
- Dynasty rules: keep all 20 fighters across seasons, no rookie draft, waivers for new UFC signees

### 6.4 Weekly Schedule

All cutoffs are at **3:00 AM America/New_York** (handles DST automatically).

- **Thu 3am ET (event week):** Roster cap expands from 20 to 23 (+3 Temporary Extended Roster Flex slots). Pre-event waiver window opens — all adds queue as claims.
- **Fri 3am ET:** Pre-event waiver claims process in reverse-standings priority order. Outside the post-event window the league returns to free agency, except for any fighter dropped in the last 48h (rolling waiver).
- **Saturday (fight night):** Starters locked at first prelim fight (event-anchored).
- **Sun 3am ET:** Roster cap reverts to 20. Post-event waiver window opens.
- **Tue 3am ET:** Post-event waiver claims process. Free agency resumes.
- **Wed 3am ET:** Auto-drop sweep — any manager who has made fewer than 3 manual drops since Thu cap expansion gets their most-recently-acquired fighters dropped until roster size = 20.

**Outside event windows**, free agency is instant for fighters who have been on FA for ≥48 hours. Any fighter dropped at any time runs on rolling waivers until 3am ET on (drop_date_ET + 2 calendar days), regardless of phase.

### 6.5 Trades

- Execute immediately on acceptance (no veto)
- Deadline: 1 month before season end
- MVP: deferred; Phase 2 implementation

---

## 7. Non-Functional Requirements

### 7.1 Performance

- Page load <3 seconds on average broadband
- Database queries <500ms for common operations
- Support concurrent use by 8 managers in one league without degradation

### 7.2 Security

- All passwords hashed via Supabase Auth (bcrypt)
- RLS policies enforce data access at the database level
- Service role key never exposed to frontend
- No sensitive data in URL parameters
- HTTPS enforced in production (via Vercel)

### 7.3 Accessibility

- Keyboard navigation support
- Color contrast meets WCAG AA standards
- Alt text on all informational images
- Form labels correctly associated with inputs

### 7.4 Browser Support

- Chrome 100+, Safari 15+, Firefox 100+ (desktop)
- Chrome mobile, Safari iOS (mobile)
- No IE support

---

## 8. Roadmap

### Phase 1: Core MVP (Weeks 1-6)
1. Authentication flow (signup, login, logout) — **Week 1**
2. League creation and joining — **Week 2**
3. Draft interface — **Weeks 3-4**
4. Starter selection — **Week 5**
5. Manual scoring + leaderboard — **Week 6**
6. Waivers — **Week 7**
7. Launch Season 1 with friends — **End of Week 7**

### Phase 2: Polish & Automation (Weeks 8-12)
- Trade system
- Automated data ingestion (ESPN or UFC API)
- Email notifications (lineup reminders, trade offers, waiver results)
- Mobile responsive polish
- Draft clock visual improvements
- **Migrate waiver processing from lazy/page-load to a scheduled Supabase Edge Function.** v1 ships with a "catch-up" pass that runs whenever someone visits the waivers page. This works for friends-and-family scale but breaks down once you have inactive leagues — claims won't process until someone visits. Replace with a scheduled job that fires at each 3am ET cutoff and on a 5-minute cadence for rolling-waiver clears.

### Phase 3: Scale & Monetization (Month 4+)
- Multi-league support per user
- Custom scoring rules per league
- Paid tier (custom branding, more than 8 managers, FAAB)
- Season 2 dynasty rollover
- Advanced stats and fighter projections

---

## 9. Open Questions & Decisions Needed

These are flagged for future discussion and tracked here:

- **Dynasty succession handling:** How do rosters handle retirements, cuts, and long-term injuries?
- **League creation flow specifics:** Invite code vs email invites (current leaning: invite code)
- **Scoring timing:** Post-event only for v1 is recommended
- **Notifications strategy:** Email + in-app for v1 recommended
- **Trade UI:** Counter-proposals supported or not?
- **Waiver model rethink (raised after Season 1 draft, June 2026):** Should the +3 temporary roster slots be available all the time instead of only during the Thu-to-Sun event window, and should waivers process after fights rather than on the current Thu/Fri/Sun/Tue cutoffs? This is a v1.3 rules proposal, not yet decided. It rewrites the locked event-window waiver model (Sections 4.6 and 6.4), so the full rule (caps, cutoffs, priority reset) needs to be written out before any code changes. Tracked in PRIORITIES.md R.1.

---

## 10. Future Feature Backlog

These are ideas captured for future consideration. They are NOT scoped, prioritized, or committed to a phase yet. The roadmap in Section 8 remains authoritative for what is actually being built. Some items overlap with existing "out of scope" notes in Section 4 and are restated here so the full wishlist lives in one place.

### 10.1 Auth & Account

**Shipped (May 2026):**
- ✅ **Sign in with Google.** OAuth login alongside email/password. Live on login.html and signup.html.
- ✅ **Account settings page** at `account.html`. Linked from the top nav next to "Log out" on every authenticated page. Covers: display name (writes to `profiles.display_name`), email change (double-confirmation flow), password change (only for users with an email/password identity), and a read-only list of linked sign-in methods.
- ✅ **Display name** is read by the dashboard welcome header, with the email-local part as a fallback when unset. Stored in `public.profiles.display_name` per migration `2026-05-10_profiles_display_name.sql`.

**Still open:**
- **Phone number + 2FA.** Capture phone at signup, enable SMS or TOTP second factor. Most useful once leagues might involve money/prizes — for a friends-only league it's polish, not protection.
- **Self-serve account deletion.** The Delete Account section on `account.html` currently opens a mailto link. Real self-deletion needs server-side privileges (Supabase JS client can't call `auth.admin.deleteUser`). Two paths: (a) a Supabase Edge Function with the service role that validates the caller is the user being deleted, or (b) a SQL function with elevated permissions. (a) is cleaner.
- **Forgot password flow.** The "Forgot password?" link on `login.html` is currently `href="#"`. Wire up `supabaseClient.auth.resetPasswordForEmail()` + a `reset-password.html` page that uses `auth.updateUser({ password })` after the email link lands.
- **Display name everywhere.** Currently only the dashboard welcome header reads `display_name`. Other surfaces that show "you" still rely on email or per-league `team_name`. Audit and decide which surfaces should use display_name; chat/standings/etc. legitimately use `team_name` (per-league identity) and shouldn't change.
- **Link/unlink OAuth providers.** Users who signed up with email can't currently add Google to their account, and vice versa. Supabase supports identity linking (`auth.linkIdentity`); needs UI on `account.html`.
- **Display name validation & uniqueness.** Currently accepts any string up to 40 chars. No profanity filter, no uniqueness check. Probably fine for a friends league but worth flagging.
- **Profile picture / avatar.** Currently only initials are shown anywhere there's an avatar slot (chat messages, etc.). Adding an uploaded avatar would require Supabase Storage setup.

### 10.2 Social & Discovery

- **Invite link (not just code).** Sharable URL that auto-joins the league on signup or click. Currently only a 6-char code (4.2).
- **Friend system.** Add friends across the platform, see what leagues they are in, invite them with one click.
- **Public league interface.** Browse and join open leagues run by strangers, not just friend leagues.
- **Site-wide leaderboard.** Cross-league rankings (best managers across the whole platform).

### 10.3 Draft Experience

- **Draft chat.** Real-time chat inside the draft room.
- **Draft sound effects.** Pick clock ticks, on-the-clock alert, pick-confirmed sound, etc.
- **Better desktop and mobile draft room.** Reference target: ESPN fantasy football draft room. Both layouts need rework, mobile especially.

### 10.4 Lineup & Roster

- **Whole-team single-screen view.** See all 20 roster fighters at once without scrolling between sections.
- **Distinct locked-lineup visual state.** Lineup page should look meaningfully different (read-only treatment, not just a disabled button) once starters are locked.
- **Highlight your fighters on the fight card.** When viewing the upcoming card from the lineup page, mark which fighters belong to your roster.
- **Commissioner roster edit power.** Commish can manually adjust any manager's roster (corrections, dropped-fighter recovery, dispute resolution).
- **Country flags on fighter cards.** Small flag icon next to fighter name / photo.

### 10.5 Communication

- **Chat as a pop-up.** Floating / always-accessible chat overlay rather than a dedicated page, so trash talk happens without navigating away.
- **Fighter AI bot.** Chat-based assistant that answers questions about fighters (recent form, matchup history, projection rationale).

### 10.6 Data & Integrations

- **Event API.** Auto-ingest the UFC schedule (events, fight cards, weigh-ins) instead of commissioner manual entry.
- **Scoring API.** Auto-ingest fight stats and results (replace manual commissioner scoring noted in 4.5).
- **Fighter API.** Auto-update fighter records, weight class, status (active / cut / retired / injured).
- **Polymarket API.** Pull live fight odds for display on the lineup and fight card pages.
- **Rankings sync.** Keep the official UFC rankings current automatically and surface them on fighter cards.
- **Improved / manual rankings.** (Raised after Season 1 draft, June 2026.) Beyond the synced official rankings, allow a curated or manually overridden ranking (commissioner or per-manager) to drive draft-pool order and the fantasy-value list, since the official rankings miss prospects and lag reality.
- **Projections.** Per-fighter projected fantasy points per upcoming fight, shown during lineup-setting.

### 10.7 Format & Engagement

- **Playoffs format option.** Optional bracket-style playoffs (or head-to-head matchups) instead of, or after, the cumulative-points season. Currently 6.3 explicitly says no playoffs. (Re-raised after Season 1 draft, June 2026.)
- **Trade block.** (Raised after Season 1 draft, June 2026.) A public "available for trade" shelf where managers can list fighters they will move, visible league-wide. Sits alongside the deferred trade system (4.8), not a replacement for it.
- **Notifications: text, email, and in-app/push.** (Re-raised after Season 1 draft, June 2026.) Phase 2 (Section 8) already plans email notifications; expand the plan to also cover SMS/text and in-app or push notifications for lineup reminders, your turn in the draft, and waiver results.
- **Winner / loser animations.** Celebratory animation for matchup or weekly winner, commiseration animation for the worst score.
- **Mobile integration.** Deeper mobile UX work beyond responsive polish (possible PWA install or native iPhone app, push notifications, lineup-setting from phone optimized for fight night). (Native iPhone app re-raised after Season 1 draft, June 2026.)

---

## 11. Glossary

- **BMF:** Baddest Motherf*** (UFC's secondary lightweight title awarded by Dana White to create marquee fights)
- **Interim title:** Temporary championship awarded when a champion is inactive
- **PotN:** Performance of the Night ($50k bonus for a standout performance)
- **FotN:** Fight of the Night ($50k bonus to both fighters in the most exciting fight)
- **Co-main event:** Second-most-important fight on a card, just before the main event
- **RLS:** Row Level Security (Postgres feature for database-level access control)
- **MVP:** Minimum Viable Product

---

*End of PRD*