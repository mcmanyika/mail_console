-- =============================================================================
-- Workspace AI assist (summarize / suggest reply):
--   * workspaces.ai_enabled / ai_instructions / monthly_ai_limit
--   * monthly_ai_usage + consume_ai_quota() (service-role atomic counter)
-- Metadata only in audit_logs — never store prompt/completion bodies.
-- =============================================================================

alter table public.workspaces
  add column if not exists ai_enabled boolean not null default false,
  add column if not exists ai_instructions text
    check (ai_instructions is null or char_length(ai_instructions) <= 2000),
  add column if not exists monthly_ai_limit integer not null default 200
    check (monthly_ai_limit >= 0);

comment on column public.workspaces.ai_enabled is
  'When true and OPENAI_API_KEY is set, members with mailbox grants can summarize threads and draft replies.';
comment on column public.workspaces.ai_instructions is
  'Optional workspace tone/context appended to AI system prompts (never sent to other workspaces).';
comment on column public.workspaces.monthly_ai_limit is
  'Max AI assist requests per workspace per UTC calendar month.';

create table if not exists public.monthly_ai_usage (
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  year_month     text not null check (year_month ~ '^[0-9]{4}-[0-9]{2}$'),
  request_count  integer not null default 0 check (request_count >= 0),
  updated_at     timestamptz not null default now(),
  primary key (workspace_id, year_month)
);

create trigger monthly_ai_usage_set_updated_at before update on public.monthly_ai_usage
  for each row execute function private.set_updated_at();

alter table public.monthly_ai_usage enable row level security;
revoke all on public.monthly_ai_usage from anon, authenticated;
grant select on public.monthly_ai_usage to authenticated;
grant all on public.monthly_ai_usage to service_role;

create policy monthly_ai_usage_select on public.monthly_ai_usage for select to authenticated
  using (private.is_workspace_member(workspace_id));

-- Atomic increment; refuses when over the workspace monthly limit.
create or replace function public.consume_ai_quota(
  p_workspace_id uuid,
  p_year_month   text,
  p_limit        integer
)
returns table (allowed boolean, request_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_limit < 0 then
    raise exception 'invalid ai limit' using errcode = '22023';
  end if;
  if p_year_month is null or p_year_month !~ '^[0-9]{4}-[0-9]{2}$' then
    raise exception 'invalid year_month' using errcode = '22023';
  end if;

  if p_limit = 0 then
    return query select false, 0;
    return;
  end if;

  insert into public.monthly_ai_usage as u (workspace_id, year_month, request_count)
  values (p_workspace_id, p_year_month, 1)
  on conflict (workspace_id, year_month)
  do update set request_count = u.request_count + 1, updated_at = now()
  where u.request_count < p_limit
  returning u.request_count into v_count;

  if v_count is null then
    select u.request_count into v_count
      from public.monthly_ai_usage u
     where u.workspace_id = p_workspace_id and u.year_month = p_year_month;
    return query select false, coalesce(v_count, p_limit);
    return;
  end if;

  return query select true, v_count;
end;
$$;

revoke all on function public.consume_ai_quota(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.consume_ai_quota(uuid, text, integer) to service_role;
