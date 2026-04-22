# UFC Fantasy League — Product Requirements Document

**Version:** 1.0
**Last Updated:** April 22, 2026
**Owner:** Jacob Stark
**Status:** MVP in Development

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
- Draft board shows all teams' picks in real-time
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
- As a manager, I want to select 3 starters from my roster for each card
- As a manager, I want to see which of my fighters are scheduled on this card

**Requirements:**
- Lineup lock at first prelim fight start time
- 3 starters per card, must be from manager's roster
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

**Requirements:**
- Thursday: roster expands to +2 over normal cap (allowing claims to land)
- Thursday: any undrafted fighter (free agent) moves to waivers
- Friday: waiver claims process in reverse standings order (worst record first)
- Tuesday: manager must drop down to normal cap (20 fighters)
- Wednesday: auto-drop 2 most recently acquired if still over cap
- UI: "Roster" page shows current roster; "Waivers" page shows claimable fighters

**Out of scope for MVP:**
- FAAB (free agent auction budget)
- Waiver trades
- IR slots for injured fighters

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
| Reversal | +1.0 |
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
| Performance of the Night | +6 |
| Fight of the Night | +4 (both fighters) |
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
- 3 starters per card

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

- **Thursday:** Roster cap expands to +2, free agents move to waivers
- **Friday:** Waiver claims process in reverse standings order
- **Saturday (fight night):** Starters locked at first prelim fight
- **Tuesday:** Deadline to drop down to normal cap
- **Wednesday:** Auto-drop 2 most recently acquired fighters if still over cap

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

---

## 10. Glossary

- **BMF:** Baddest Motherf*** (UFC's secondary lightweight title awarded by Dana White to create marquee fights)
- **Interim title:** Temporary championship awarded when a champion is inactive
- **PotN:** Performance of the Night ($50k bonus for a standout performance)
- **FotN:** Fight of the Night ($50k bonus to both fighters in the most exciting fight)
- **Co-main event:** Second-most-important fight on a card, just before the main event
- **RLS:** Row Level Security (Postgres feature for database-level access control)
- **MVP:** Minimum Viable Product

---

*End of PRD*