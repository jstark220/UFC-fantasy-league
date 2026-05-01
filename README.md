# UFC Fantasy League

## Description

A fantasy league web app where UFC fans draft real fighters, set weekly starters, and earn points based on actual fight performance. Built for casual and hardcore MMA fans who want a season-long competition with friends, similar to fantasy football but for the UFC.

## Live Demo

https://knockdown-nine.vercel.app

## Features

- Account creation and league setup: Users sign up with email, create or join a league.
- Drafting and roster management: Each manager builds a 20-fighter roster across required divisions, with weekly add/drop and trade functionality.
- Weekly starter selection: Managers pick 3 starters per UFC card before the lineup lock at the first prelim.
- Live scoring and standings: Points are calculated automatically from fight stats (strikes, takedowns, finishes, bonuses) and standings update after each event.
- League chat: A built-in group chat for each league so managers can talk trash and negotiate trades.

## Technologies Used

- Frontend: Plain HTML, CSS, and JavaScript.
- Backend: Supabase for Postgres database, authentication, row-level security, and realtime subscriptions.
- Hosting: Vercel for static hosting, with a custom domain pointed at the deployment.

## AI Tools Used

- Claude Code: Used as a pair programmer inside VS Code.
- Claude: Used to help ideate aspects of the website and draft PRD.md.


## Challenges Faced

- Row-level security debugging: PostgREST returns "violates row-level security policy" errors that often point at the wrong policy, so I learned to test inserts without `.select()` to isolate whether the problem was the INSERT or the SELECT policy.
- Scoring complexity: Translating real UFC stats into a balanced points system took several iterations, and I solved it by versioning the scoring rules (v1.0, v1.1, v1.2) and testing against historical fight data.

## Future Improvements

- Mobile-first redesign: The current layout works on desktop but needs a proper mobile experience since most fans will check scores on their phones during fights.
- Live in-fight scoring: Right now scores update after the event, but pulling stats round-by-round during the broadcast would make watch parties way more fun.
- Direct messages and trade proposals in-app: League chat exists, but private DMs and a structured trade-offer UI would replace the current "negotiate over text" workflow.
