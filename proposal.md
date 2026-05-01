# Project Proposal: UFC Fantasy League

## What are you building? Who is it for?

A web app that lets UFC fans play a season-long fantasy league with friends, where managers draft real fighters, set weekly starters, and earn points based on how those fighters actually perform in their fights. It's built for casual and hardcore MMA fans who already follow the UFC and want a way to compete with their friends, similar to fantasy football but built specifically around the structure of UFC events.

## Why? What problem does it solve?

There is no good fantasy UFC product. Existing options are either one-off pick'em games tied to a single card or clunky spreadsheet leagues people run manually, so this project fills the gap by giving fans a real season-long platform with rosters, scoring, trades, and standings all in one place.

## MVP vs. Stretch Goals

MVP: Account signup and login, league creation and joining, a 20-fighter draft with roster construction rules, weekly starter selection, automated scoring from fight results, and a standings page. These are the features needed to actually play a season start to finish.

Stretch Goals: League chat for trash talk and trade negotiation, in-app trade proposals with accept/reject flow, a waiver wire with reverse-standings priority, mobile-optimized layout, and live in-fight scoring that updates round by round during broadcasts. These would make the product feel polished and competitive with paid fantasy platforms.

## What technologies do you plan to use?

Frontend: Plain HTML, CSS, and JavaScript.

Backend: Supabase for everything server-side, including Postgres for the database, Supabase Auth for email/password login, row-level security for per-league data access, and realtime subscriptions for the chat feature.

Data and hosting: Fighter data is seeded from the public Octagon API via Node scripts, the site is deployed as a static frontend on Vercel, and scheduled jobs (like waiver processing) run on Supabase using pg_cron.
