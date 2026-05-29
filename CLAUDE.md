# Claude Code Session Briefing

Copy-paste this as your first message when starting a Claude Code session. It gives the AI complete context about the project so it can help effectively.

---

## Project Context

I'm Jacob, building a **UFC Fantasy League** web app. My team in this project is just me (beginner coder, ~1 year HTML/CSS experience, no frameworks).

## Stack

- **Database:** Supabase (Postgres) — project URL `https://zfffboipbdegrzyyzoto.supabase.co`
- **Auth:** Supabase Auth (email/password, email confirmation off in dev)
- **Frontend:** Plain HTML, CSS, JavaScript (NO frameworks, NO build tools, NO React)
- **Hosting:** Will deploy to Vercel eventually (not yet)
- **Supabase client library:** Loaded via CDN (`https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2`)

## Important Coding Conventions I Follow

1. **Plain HTML/JS only.** Do NOT suggest React, Vue, Next.js, or any framework. Do NOT suggest npm packages for the frontend. CDN imports are fine.
2. **Heavy code comments.** I'm learning. Every non-trivial line should have a `//` comment explaining what it does and why.
3. **No em dashes.** Writing style preference (I use "—" never, use parentheses or commas instead).
4. **Variable naming.** When creating a Supabase client, name the variable `supabaseClient` to avoid the naming conflict with `window.supabase` (the CDN library).
5. **Security first.** NEVER put the service role key in any file that loads in a browser. Only the publishable (anon) key goes in frontend code.

## Project Structure

```
~/Projects/ufc-data-tools/
├── .env                     # Contains SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (gitignored)
├── .gitignore
├── applyRankings.js         # Node script, matches fighters by ufc_id slug
├── connections_test.html    # Working Supabase connection demo — FOLLOW THIS PATTERN
├── fetchFighters.js         # Node script, fetches from Octagon API
├── node_modules/            # (gitignored)
├── package-lock.json
└── package.json
```

When I add new frontend pages (signup.html, login.html, dashboard.html, etc.), follow the pattern in `connections_test.html`. That file is the canonical example of how I want HTML/JS structured.

## Database State

- **11 tables:** profiles, leagues, league_members, fighters, ufc_events, fight_results, rosters, starter_selections, scores, waiver_claims, trades
- **233 fighters seeded** (post-UFC 327 accurate, April 2026)
- **RLS policies active:**
  - Public reference data (fighters, events, fight_results) readable by anon + authenticated
  - League-specific data (rosters, trades, etc.) scoped to league membership
  - User profiles auto-created on signup via trigger `handle_new_user()`

## Current Status (End of Day 1)

**Completed:**
- Schema, RLS policies, fighter data all in Supabase
- Working connection test proves end-to-end stack
- Git + GitHub set up (`github.com/jstark220/UFC-fantasy-league`)
- VS Code + Claude Code + Git workflow established

**Today's goal:**
Build the authentication flow (signup, login, logout pages).

## Scoring System v1.2 (reference for future work)

Base scoring: sig strike +0.1, takedown +1, knockdown +2, control +0.01/sec

Win bonuses: R1 finish +18, R2 +14, R3 +9, R4/R5 +8, Decision +6, Quick win (<60s R1) +5 additional

League bonuses: Title win +10, Title defense +5, BMF/interim win +5, BMF/interim defense +3, Top-5 opp win +4, Top-10 +2, Top-15 +1 (Performance/Fight of the Night bonuses were removed)

Multipliers: Main event 1.2x, Co-main 1.1x

## League Rules v1.2 (reference for future work)

8 managers per league. 20 fighters per roster. 3 starters per card. Roster construction: 2 per men's division (including flyweight), 2 women's flex, 2 any-division flex. Season-long or dynasty. Highest cumulative points wins. Weekly schedule: Thursday roster +2 cap / FA→waivers, Friday waivers process (reverse standings), Saturday lineup lock at first prelim, Tuesday drop-down deadline, Wednesday auto-drop.

## How to Help Me Best

1. **Read files before writing.** Before modifying a file, read its current state. Before creating a new file, read related existing files to match my style.
2. **Small, focused changes.** Don't overhaul things. Make the smallest edit that accomplishes the task.
3. **Explain what you're doing.** After making changes, tell me (a) what you changed, (b) why, (c) what I should test.
4. **Surface trade-offs.** If a design decision has pros and cons, flag them so I can choose.
5. **Stop and ask when unsure.** Better to clarify than assume. My plan is locked, not flexible.
6. **Validate against the PRD.** See `PRD.md` in the project for full spec. If a request conflicts with the PRD, flag it.

## Reference Files

Always look at these before starting work:
- `PRD.md` — Full product requirements (features, scope, out-of-scope)
- `connections_test.html` — Canonical HTML/JS pattern to follow
- `.env` — Database credentials (do NOT include contents in generated code)

---

## Reference Files

Always look at these before starting work:
- `PRD.md` — Full product requirements (features, scope, out-of-scope)
- `DESIGN_SYSTEM.md` — Design tokens, components, and voice guidelines (NEW)
- `connections_test.html` — Canonical HTML/JS pattern to follow
- `.env` — Database credentials (do NOT include contents in generated code)