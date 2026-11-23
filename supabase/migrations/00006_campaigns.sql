-- =============================================================================
-- Bulk emailing (campaigns):
--   audience_lists / audience_contacts  — workspace-scoped recipient lists
--   campaigns / campaign_recipients     — draft → sending → sent fan-out
-- One contact becomes one outbound message via the existing outbox + quota.
-- =============================================================================

-- ---- audience lists ----------------------------------------------------------
create table public.audience_lists (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 120),
  description   text check (description is null or char_length(description) <= 500),
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint audience_lists_workspace_name_key unique (workspace_id, name),
  constraint audience_lists_id_workspace_key unique (id, workspace_id)
);
create index audience_lists_workspace_idx on public.audience_lists (workspace_id);
create trigger audience_lists_set_updated_at before update on public.audience_lists
  for each row execute function private.set_updated_at();

create table public.audience_contacts (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  list_id       uuid not null,
  email         text not null,
  full_name     text check (full_name is null or char_length(full_name) <= 200),
  fields        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint audience_contacts_email_lowercase check (email = lower(email)),
  constraint audience_contacts_list_email_key unique (list_id, email),
  constraint audience_contacts_list_fk foreign key (list_id, workspace_id)
    references public.audience_lists (id, workspace_id) on delete cascade
);
create index audience_contacts_list_idx on public.audience_contacts (list_id);
create index audience_contacts_workspace_idx on public.audience_contacts (workspace_id);
create trigger audience_contacts_set_updated_at before update on public.audience_contacts
  for each row execute function private.set_updated_at();

-- ---- campaigns ---------------------------------------------------------------
create table public.campaigns (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  list_id         uuid not null,
  mailbox_id      uuid not null,
  name            text not null check (char_length(name) between 1 and 120),
  subject         text not null check (char_length(subject) between 1 and 300),
  body_text       text not null check (char_length(body_text) <= 50000),
  body_html       text,
  status          text not null default 'draft'
                    check (status in ('draft', 'scheduled', 'sending', 'paused', 'sent', 'cancelled')),
  scheduled_at    timestamptz,
  started_at      timestamptz,
  completed_at    timestamptz,
  created_by      uuid references public.profiles (id) on delete set null,
  total_count     integer not null default 0 check (total_count >= 0),
  sent_count      integer not null default 0 check (sent_count >= 0),
  failed_count    integer not null default 0 check (failed_count >= 0),
  skipped_count   integer not null default 0 check (skipped_count >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint campaigns_id_workspace_key unique (id, workspace_id),
  constraint campaigns_list_fk foreign key (list_id, workspace_id)
    references public.audience_lists (id, workspace_id) on delete restrict,
  constraint campaigns_mailbox_fk foreign key (mailbox_id)
    references public.mailboxes (id) on delete restrict,
  constraint campaigns_schedule_check check (
    (status <> 'scheduled') or (scheduled_at is not null)
  )
);
create index campaigns_workspace_status_idx on public.campaigns (workspace_id, status);
create index campaigns_due_idx on public.campaigns (scheduled_at)
  where status = 'scheduled';
create trigger campaigns_set_updated_at before update on public.campaigns
  for each row execute function private.set_updated_at();

create table public.campaign_recipients (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  campaign_id   uuid not null,
  email         text not null,
  full_name     text,
  fields        jsonb not null default '{}'::jsonb,
  status        text not null default 'pending'
                  check (status in ('pending', 'queued', 'sent', 'failed', 'skipped')),
  message_id    uuid references public.messages (id) on delete set null,
  error         text,
  claimed_at    timestamptz,
  claimed_by    text,
  processed_at  timestamptz,
  created_at    timestamptz not null default now(),
  constraint campaign_recipients_email_lowercase check (email = lower(email)),
  constraint campaign_recipients_campaign_email_key unique (campaign_id, email),
  constraint campaign_recipients_campaign_fk foreign key (campaign_id, workspace_id)
    references public.campaigns (id, workspace_id) on delete cascade
);
create index campaign_recipients_pending_idx
  on public.campaign_recipients (campaign_id, created_at)
  where status = 'pending';
create index campaign_recipients_workspace_idx on public.campaign_recipients (workspace_id);

-- Claim a batch of pending recipients (SKIP LOCKED) for fan-out workers.
create or replace function public.claim_campaign_recipients(
  p_campaign_id uuid,
  p_worker_id   text,
  p_batch_size  integer default 25
)
returns setof public.campaign_recipients
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_batch_size < 1 or p_batch_size > 100 then
    raise exception 'invalid batch size' using errcode = '22023';
  end if;

  return query
  with picked as (
    select r.id
      from public.campaign_recipients r
     where r.campaign_id = p_campaign_id
       and r.status = 'pending'
     order by r.created_at
     for update skip locked
     limit p_batch_size
  )
  update public.campaign_recipients r
     set status = 'queued',
         claimed_at = now(),
         claimed_by = p_worker_id
    from picked
   where r.id = picked.id
  returning r.*;
end;
$$;

revoke all on function public.claim_campaign_recipients(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.claim_campaign_recipients(uuid, text, integer) to service_role;

-- Bump campaign counters after a recipient settles (service role only).
create or replace function public.bump_campaign_recipient_result(
  p_recipient_id uuid,
  p_status       text,
  p_message_id   uuid default null,
  p_error        text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign_id uuid;
  v_prev        text;
begin
  if p_status not in ('sent', 'failed', 'skipped') then
    raise exception 'invalid status' using errcode = '22023';
  end if;

  select campaign_id, status into v_campaign_id, v_prev
    from public.campaign_recipients
   where id = p_recipient_id
   for update;
  if v_campaign_id is null then
    return;
  end if;
  -- Only transition from queued (claimed) once.
  if v_prev <> 'queued' then
    return;
  end if;

  update public.campaign_recipients
     set status = p_status,
         message_id = coalesce(p_message_id, message_id),
         error = p_error,
         processed_at = now(),
         claimed_at = null,
         claimed_by = null
   where id = p_recipient_id;

  if p_status = 'sent' then
    update public.campaigns set sent_count = sent_count + 1 where id = v_campaign_id;
  elsif p_status = 'failed' then
    update public.campaigns set failed_count = failed_count + 1 where id = v_campaign_id;
  else
    update public.campaigns set skipped_count = skipped_count + 1 where id = v_campaign_id;
  end if;

  -- Mark campaign sent when no pending/queued left.
  update public.campaigns c
     set status = 'sent',
         completed_at = now()
   where c.id = v_campaign_id
     and c.status = 'sending'
     and not exists (
       select 1 from public.campaign_recipients r
        where r.campaign_id = c.id and r.status in ('pending', 'queued')
     );
end;
$$;

revoke all on function public.bump_campaign_recipient_result(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.bump_campaign_recipient_result(uuid, text, uuid, text) to service_role;

-- ---- RLS ---------------------------------------------------------------------
alter table public.audience_lists enable row level security;
alter table public.audience_contacts enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_recipients enable row level security;

-- Members can read lists/contacts/campaigns; admins write lists; members with
-- mailbox send access create campaigns (enforced in app for mailbox grant).
create policy audience_lists_select on public.audience_lists for select to authenticated
  using (private.is_workspace_member(workspace_id));
create policy audience_lists_insert on public.audience_lists for insert to authenticated
  with check (private.is_workspace_admin(workspace_id));
create policy audience_lists_update on public.audience_lists for update to authenticated
  using (private.is_workspace_admin(workspace_id))
  with check (private.is_workspace_admin(workspace_id));
create policy audience_lists_delete on public.audience_lists for delete to authenticated
  using (private.is_workspace_admin(workspace_id));

create policy audience_contacts_select on public.audience_contacts for select to authenticated
  using (private.is_workspace_member(workspace_id));
create policy audience_contacts_insert on public.audience_contacts for insert to authenticated
  with check (private.is_workspace_admin(workspace_id));
create policy audience_contacts_update on public.audience_contacts for update to authenticated
  using (private.is_workspace_admin(workspace_id))
  with check (private.is_workspace_admin(workspace_id));
create policy audience_contacts_delete on public.audience_contacts for delete to authenticated
  using (private.is_workspace_admin(workspace_id));

create policy campaigns_select on public.campaigns for select to authenticated
  using (private.is_workspace_member(workspace_id));
create policy campaigns_insert on public.campaigns for insert to authenticated
  with check (private.is_workspace_member(workspace_id));
create policy campaigns_update on public.campaigns for update to authenticated
  using (private.is_workspace_member(workspace_id))
  with check (private.is_workspace_member(workspace_id));
create policy campaigns_delete on public.campaigns for delete to authenticated
  using (private.is_workspace_admin(workspace_id));

create policy campaign_recipients_select on public.campaign_recipients for select to authenticated
  using (private.is_workspace_member(workspace_id));
-- Writes to recipients go through service role during start/fan-out.

grant select on public.audience_lists, public.audience_contacts,
                public.campaigns, public.campaign_recipients to authenticated;
grant insert, update, delete on public.audience_lists to authenticated;
grant insert, update, delete on public.audience_contacts to authenticated;
grant insert, update, delete on public.campaigns to authenticated;

grant all on public.audience_lists, public.audience_contacts,
             public.campaigns, public.campaign_recipients to service_role;
