-- =============================================================================
-- Promote an email to platform superuser (platform_admins)
-- Paste into Supabase → SQL Editor → Run
--
-- Edit the email below, then run the whole script.
-- The Auth user must already exist (they must have signed up / signed in once).
-- Platform admin unlocks /admin only — it does NOT grant mailbox access.
-- =============================================================================

do $$
declare
  v_email   text := lower(trim('partsonmanyika@gmail.com')); -- <-- change me
  v_user_id uuid;
begin
  select id into v_user_id
  from auth.users
  where lower(email) = v_email
  limit 1;

  if v_user_id is null then
    raise exception 'No auth.users row for %. Have them sign up / sign in once first.', v_email;
  end if;

  insert into public.profiles (id, email, full_name)
  values (
    v_user_id,
    v_email,
    coalesce(
      (select raw_user_meta_data->>'full_name' from auth.users where id = v_user_id),
      split_part(v_email, '@', 1)
    )
  )
  on conflict (id) do update
    set email = excluded.email,
        updated_at = now();

  insert into public.platform_admins (user_id)
  values (v_user_id)
  on conflict (user_id) do nothing;

  raise notice 'OK: % (%) is a platform admin', v_email, v_user_id;
end $$;

-- Verify
select
  u.email,
  pa.user_id,
  pa.created_at as platform_admin_since
from public.platform_admins pa
join auth.users u on u.id = pa.user_id
where lower(u.email) = lower(trim('partsonmanyika@gmail.com')); -- <-- same email
