-- ============================================================================
-- Fighter age column
-- The Octagon API exposes an `age` string field (e.g. "32"). We don't have
-- date_of_birth for most fighters (DOB isn't on the API), so we store age
-- directly. It gets refreshed weekly by the data-pipeline workflow.
--
-- Existing rows stay NULL until the next fetchFighters.js run populates them
-- (the weekly Tuesday pipeline does this automatically).
-- ============================================================================

alter table public.fighters
  add column if not exists age integer;
