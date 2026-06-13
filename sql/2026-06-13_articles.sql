-- ============================================================================
-- ARTICLES — analysis posts, rankings, waiver-wire pieces, event previews.
--
-- An ESPN/Sleeper-style content layer. One row per article. Articles are
-- written in Markdown (body_md) and rendered client-side. Published articles
-- are PUBLIC (readable by anonymous visitors and search engines) so the
-- Analysis section doubles as the product's content-marketing surface.
-- Drafts are private to their author.
--
-- Writing is gated: only profiles flagged is_author = true can create or edit
-- articles, and only their own. This mirrors the "public read, restricted
-- write" model already used by fighter_projections / fight_odds, except the
-- write side is gated on an author flag instead of the service role (so the
-- in-app editor on write.html can use the normal anon key under RLS).
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Author permission flag on profiles.
--    Default false. Flip it true for yourself once, by hand, in the Supabase
--    SQL editor:
--        update public.profiles set is_author = true where id = '<your-user-id>';
--    (Find your id with:  select id, display_name from public.profiles;)
-- ----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists is_author boolean not null default false;

-- ----------------------------------------------------------------------------
-- 2. The articles table.
-- ----------------------------------------------------------------------------
create table if not exists public.articles (
  id              uuid        primary key default gen_random_uuid(),
  -- URL slug, e.g. "ufc-320-waiver-wire-targets". Unique so /article.html?slug=
  -- resolves to exactly one piece. Generated from the title in the editor.
  slug            text        not null unique,
  title           text        not null,
  -- Short summary / standfirst shown under the title and on index cards.
  dek             text,
  -- One of the CATEGORIES defined in js/articles.js (waiver_wire, rankings,
  -- event_preview, recap, strategy). Stored as text, validated app-side.
  category        text        not null default 'strategy',
  -- The article body, authored in Markdown. Rendered client-side with
  -- marked + DOMPurify (never with innerHTML of raw md).
  body_md         text        not null default '',
  -- 'draft' or 'published'. Only published rows are publicly readable.
  status          text        not null default 'draft',
  -- Who wrote it. references profiles so we can gate edits to the author.
  author_id       uuid        not null references public.profiles(id) on delete cascade,
  -- Byline, denormalized (copied from the author's display_name at write time).
  -- Storing it on the row means the public reader never has to read the
  -- profiles table, so we don't have to expose profiles to anonymous visitors.
  author_name     text,
  -- Optional cover art: a fighter whose photo_url becomes the hero image.
  -- Free, on-brand art direction using assets we already have.
  hero_fighter_id uuid        references public.fighters(id) on delete set null,
  published_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists articles_status_published_idx
  on public.articles (status, published_at desc);
create index if not exists articles_category_idx on public.articles (category);
create index if not exists articles_author_idx   on public.articles (author_id);

-- Keep updated_at honest on every write.
create or replace function public.articles_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists articles_touch_updated_at on public.articles;
create trigger articles_touch_updated_at
  before update on public.articles
  for each row execute function public.articles_touch_updated_at();

-- ----------------------------------------------------------------------------
-- 3. Row-level security.
-- ----------------------------------------------------------------------------
alter table public.articles enable row level security;

-- READ: a row is visible if it is published (to everyone, including anon /
-- search engines) OR the caller is its author (so authors see their drafts).
drop policy if exists "Articles readable when published or own draft" on public.articles;
create policy "Articles readable when published or own draft"
  on public.articles
  for select
  using (
    status = 'published'
    or author_id = auth.uid()
  );

-- WRITE (insert): only an author flag holder, and only as themselves.
drop policy if exists "Authors can insert their own articles" on public.articles;
create policy "Authors can insert their own articles"
  on public.articles
  for insert
  to authenticated
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_author = true
    )
  );

-- WRITE (update): authors can edit their own articles.
drop policy if exists "Authors can update their own articles" on public.articles;
create policy "Authors can update their own articles"
  on public.articles
  for update
  to authenticated
  using (
    author_id = auth.uid()
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_author = true
    )
  )
  with check ( author_id = auth.uid() );

-- WRITE (delete): authors can delete their own articles.
drop policy if exists "Authors can delete their own articles" on public.articles;
create policy "Authors can delete their own articles"
  on public.articles
  for delete
  to authenticated
  using (
    author_id = auth.uid()
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_author = true
    )
  );

-- Note: the public byline comes from articles.author_name (denormalized at
-- write time), so we deliberately do NOT expose the profiles table to
-- anonymous readers. The is_author checks above read only the caller's own
-- profile row, which the existing "Users can view own profile" policy allows.
