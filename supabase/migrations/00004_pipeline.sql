-- =============================================================================
-- Email pipeline support:
--   * webhook_events: attempt counter + processing lease (durable intake, then
--     claim -> process -> mark; failed events are retried by Resend and by cron)
--   * api_rate_limits + consume_api_rate_limit(): atomic fixed-window limiter
--     per API integration (shared across serverless instances)
--   * workspace_invitations may invite an 'owner' (platform admins onboarding a
--     new workspace)
-- All objects are service-role only (RLS enabled, no policies / EXECUTE revoked).
-- =============================================================================

-- ---- webhook_events ----------------------------------------------------------
alter table public.webhook_events
  add column if not exists attempts  integer not null default 0 check (attempts >= 0),
  add column if not exists locked_at timestamptz;

-- ---- invitations: allow owner ---------------------------------------------------
alter table public.workspace_invitations
  drop constraint if exists workspace_invitations_role_check;
alter table public.workspace_invitations
  add constraint workspace_invitations_role_check check (role in ('owner', 'admin', 'member'));

-- ---- API rate limiting -----------------------------------------------------------
create table if not exists public.api_rate_limits (
  integration_id  uuid not null references public.app_integrations (id) on delete cascade,
  window_start    timestamptz not null,
  request_count   integer not null default 0 check (request_count >= 0),
  primary key (integration_id, window_start)
);
alter table public.api_rate_limits enable row level security;
revoke all on public.api_rate_limits from anon, authenticated;
grant all on public.api_rate_limits to service_role;

-- Counts one request in the current fixed window and reports whether it is
-- within `p_limit`. A single INSERT .. ON CONFLICT DO UPDATE is atomic, so
-- concurrent serverless invocations can never both squeeze past the limit.
create or replace function public.consume_api_rate_limit(
  p_integration_id uuid,
  p_limit          integer,
  p_window_seconds integer default 60
)
returns table (allowed boolean, request_count integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_count  integer;
begin
  if p_limit < 1 or p_window_seconds < 1 then
    raise exception 'invalid rate limit parameters' using errcode = '22023';
  end if;

  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.api_rate_limits as r (integration_id, window_start, request_count)
  values (p_integration_id, v_window, 1)
  on conflict (integration_id, window_start)
  do update set request_count = r.request_count + 1
  returning r.request_count into v_count;

  -- Opportunistic cleanup of this integration's old windows.
  if random() < 0.02 then
    delete from public.api_rate_limits
     where integration_id = p_integration_id and window_start < now() - interval '1 hour';
  end if;

  return query select
    v_count <= p_limit,
    v_count,
    greatest(ceil(extract(epoch from (v_window + make_interval(secs => p_window_seconds) - now())))::integer, 1);
end;
$$;

revoke all on function public.consume_api_rate_limit(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(uuid, integer, integer) to service_role;
