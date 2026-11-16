-- 16 Nov 2026: public pages, and a check on post types.
--
-- 1. Public pages. People without an account (and search engines) can read a
--    member's public page and the posts that member published as "Public" (in
--    full) or "Abstract only" (title and abstract). Nothing else: no email
--    address, no private posts, no files, no restricted papers, no comments.
--
--    The tables stay closed to visitors. They get three functions instead,
--    which hand out a fixed list of fields:
--      public_profile(id)   a member's public page
--      public_post(id)      one public post
--      public_sitemap()     the addresses of all public pages, for /sitemap.xml
--
--    A member is shown only when all of this is true:
--      * profiles.public_profile is on (new column, on by default; the switch
--        is on the member's own profile page),
--      * the member accepted the Terms and Privacy Policy of 16 Nov 2026 or
--        later, which explain the public page (so nobody who joined earlier
--        becomes public before reading about it),
--      * the profile has a name, and the account is not banned or deleted.
--
-- 2. The Terms and Privacy Policy get the new date (the same date as
--    TERMS_VERSION in lib/legal.ts), so members are asked to accept them once.
--
-- 3. Post types. The app now offers more kinds of posts (preprint, conference
--    paper, thesis, poster, ...). They are plain text values, so nothing has
--    to change for them; a check is added so that only short lower-case names
--    can be stored for a post's type and category.
--
-- Run it once in Supabase (SQL Editor -> paste -> Run). Running it again
-- changes nothing. It needs the earlier files up to Phase 5.

do $$
begin
  if to_regclass('public.user_consents') is null
     or to_regprocedure('public.accept_terms(text, boolean)') is null then
    raise exception 'Run supabase/migrations/20261017000000_phase5.sql first, then this file.';
  end if;
end $$;

-- ============================================================================
-- 1. Public pages
-- ============================================================================

alter table public.profiles add column if not exists public_profile boolean not null default true;

comment on column public.profiles.public_profile is
  'The member''s public page (profile and public posts readable without an account). The member switches it on their profile page.';

-- Is this member shown to people without an account? Used only by the three
-- functions below.
create or replace function public.profile_is_public(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.profiles p
      join public.user_consents c on c.user_id = p.id
      join auth.users u on u.id = p.id
     where p.id = p_id
       and p.public_profile
       and nullif(btrim(p.full_name), '') is not null
       and c.terms_version >= '2026-11-16'
       and u.deleted_at is null
       and (u.banned_until is null or u.banned_until <= now())
  );
$$;

revoke all on function public.profile_is_public(uuid) from public, anon, authenticated;
grant execute on function public.profile_is_public(uuid) to service_role;
