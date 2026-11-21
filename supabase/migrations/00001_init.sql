-- =============================================================================
-- Mail Console — initial schema
--
-- Design rules
--   * Every tenant table carries workspace_id. Child rows use COMPOSITE foreign
--     keys (id, workspace_id) so a row can never point at a parent in another
--     workspace.
--   * RLS is enabled on every table. Authorization helpers live in the
--     `private` schema (not exposed through PostgREST) and are SECURITY DEFINER
--     so policies do not recurse into each other.
--   * Platform admins can manage workspaces/memberships and see operational
--     metadata, but have NO policy on threads / messages / recipients /
--     attachments / templates — they cannot read message content through RLS.
--   * Drafts (messages.direction = 'draft') are only visible to their author.
--   * Rows that carry provider/security state (domains, outbox, webhooks,
--     usage, audit, API keys) are written by the service role only.
--   * The service role (server-side only!) bypasses RLS.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Generic helpers
-- -----------------------------------------------------------------------------
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- profiles / platform_admins
-- -----------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint profiles_email_lowercase check (email = lower(email))
);
create unique index profiles_email_key on public.profiles (email);
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();

create table public.platform_admins (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- Create a profile whenever an auth user is created.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    lower(new.email),
    nullif(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Keep profile email in sync with auth.users.
create or replace function private.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = lower(new.email) where id = new.id;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function private.handle_user_email_change();

-- -----------------------------------------------------------------------------
-- workspaces / memberships / invitations
-- -----------------------------------------------------------------------------
create table public.workspaces (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null check (char_length(name) between 1 and 120),
  slug                   text not null,
  status                 text not null default 'pending'
                           check (status in ('active', 'suspended', 'pending')),
  monthly_sending_limit  integer not null default 3000 check (monthly_sending_limit >= 0),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint workspaces_slug_key unique (slug),
  constraint workspaces_slug_format check (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
);
create trigger workspaces_set_updated_at before update on public.workspaces
  for each row execute function private.set_updated_at();

create table public.workspace_memberships (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  role          text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint workspace_memberships_workspace_user_key unique (workspace_id, user_id),
  constraint workspace_memberships_id_workspace_key unique (id, workspace_id)
);
create index workspace_memberships_user_idx on public.workspace_memberships (user_id);
create trigger workspace_memberships_set_updated_at before update on public.workspace_memberships
  for each row execute function private.set_updated_at();

create table public.workspace_invitations (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  email         text not null,
  role          text not null default 'member' check (role in ('owner', 'admin', 'member')),
  token_hash    text not null,
  expires_at    timestamptz not null,
  accepted_at   timestamptz,
  revoked_at    timestamptz,
  invited_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint workspace_invitations_email_lowercase check (email = lower(email)),
  constraint workspace_invitations_token_hash_key unique (token_hash)
);
-- At most one pending (not accepted, not revoked) invitation per workspace+email.
create unique index workspace_invitations_pending_key
  on public.workspace_invitations (workspace_id, email)
  where accepted_at is null and revoked_at is null;
create index workspace_invitations_email_idx on public.workspace_invitations (email);

-- -----------------------------------------------------------------------------
-- domains / mailboxes / mailbox_access
-- -----------------------------------------------------------------------------
create table public.domains (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  hostname          text not null,
  resend_domain_id  text,
  send_status       text not null default 'not_started'
                      check (send_status in ('not_started', 'pending', 'verified', 'partially_verified',
                                             'partially_failed', 'failed', 'temporary_failure')),
  inbound_status    text not null default 'not_started'
                      check (inbound_status in ('not_started', 'pending', 'verified', 'partially_verified',
                                                'partially_failed', 'failed', 'temporary_failure', 'disabled')),
  dns_records       jsonb not null default '[]'::jsonb,
  last_checked_at   timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint domains_hostname_key unique (hostname),
  constraint domains_hostname_normalized check (
    hostname = lower(btrim(hostname))
    and hostname ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
  ),
  constraint domains_id_workspace_key unique (id, workspace_id)
);
create unique index domains_resend_domain_id_key on public.domains (resend_domain_id)
  where resend_domain_id is not null;
create index domains_workspace_idx on public.domains (workspace_id);
create trigger domains_set_updated_at before update on public.domains
  for each row execute function private.set_updated_at();

create table public.mailboxes (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  domain_id     uuid not null,
  address       text not null,
  display_name  text,
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint mailboxes_address_key unique (address),
  constraint mailboxes_address_lowercase check (address = lower(btrim(address))),
  constraint mailboxes_address_format check (address ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+$'),
  constraint mailboxes_id_workspace_key unique (id, workspace_id),
  constraint mailboxes_domain_fk foreign key (domain_id, workspace_id)
    references public.domains (id, workspace_id) on delete cascade
);
create index mailboxes_workspace_idx on public.mailboxes (workspace_id);
create index mailboxes_domain_idx on public.mailboxes (domain_id);
create trigger mailboxes_set_updated_at before update on public.mailboxes
  for each row execute function private.set_updated_at();

-- Mailbox address must be local@<domain hostname>.
create or replace function private.mailbox_address_matches_domain()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_hostname text;
begin
  select hostname into v_hostname from public.domains where id = new.domain_id;
  if v_hostname is null or split_part(new.address, '@', 2) <> v_hostname then
    raise exception 'mailbox address % does not belong to its domain', new.address
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger mailboxes_address_matches_domain
  before insert or update of address, domain_id on public.mailboxes
  for each row execute function private.mailbox_address_matches_domain();

create table public.mailbox_access (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  membership_id  uuid not null,
  mailbox_id     uuid not null,
  permission     text not null default 'read' check (permission in ('read', 'read_send')),
  created_at     timestamptz not null default now(),
  constraint mailbox_access_membership_mailbox_key unique (membership_id, mailbox_id),
  constraint mailbox_access_membership_fk foreign key (membership_id, workspace_id)
    references public.workspace_memberships (id, workspace_id) on delete cascade,
  constraint mailbox_access_mailbox_fk foreign key (mailbox_id, workspace_id)
    references public.mailboxes (id, workspace_id) on delete cascade
);
create index mailbox_access_mailbox_idx on public.mailbox_access (mailbox_id);

-- -----------------------------------------------------------------------------
-- threads / messages
-- -----------------------------------------------------------------------------
create table public.threads (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null,
  mailbox_id          uuid not null,
  subject             text not null default '',
  normalized_subject  text not null default '',
  last_activity_at    timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  constraint threads_id_workspace_mailbox_key unique (id, workspace_id, mailbox_id),
  constraint threads_mailbox_fk foreign key (mailbox_id, workspace_id)
    references public.mailboxes (id, workspace_id) on delete cascade
);
-- Inbox listing.
create index threads_inbox_idx on public.threads (mailbox_id, last_activity_at desc);
create index threads_subject_lookup_idx on public.threads (mailbox_id, normalized_subject, last_activity_at desc);
create index threads_workspace_idx on public.threads (workspace_id);

create table public.thread_user_state (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  thread_id     uuid not null references public.threads (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  is_read       boolean not null default false,
  is_archived   boolean not null default false,
  updated_at    timestamptz not null default now(),
  constraint thread_user_state_thread_user_key unique (thread_id, user_id)
);
create index thread_user_state_user_idx on public.thread_user_state (user_id, is_archived, is_read);
create trigger thread_user_state_set_updated_at before update on public.thread_user_state
  for each row execute function private.set_updated_at();

create table public.messages (
  id                         uuid primary key default gen_random_uuid(),
  workspace_id               uuid not null,
  -- NULL only for brand-new compose drafts that do not belong to a thread yet
  -- (the thread is created atomically when the draft is enqueued).
  thread_id                  uuid,
  mailbox_id                 uuid not null,
  direction                  text not null check (direction in ('inbound', 'outbound', 'draft')),
  lifecycle_state            text not null
                               check (lifecycle_state in ('draft', 'queued', 'submitted', 'failed', 'received')),
  from_address               text not null,
  reply_to                   text,
  subject                    text not null default '',
  snippet                    text,
  text_body                  text,
  html_body                  text,
  resend_email_id            text,
  rfc_message_id             text,
  in_reply_to                text,
  references_header          text,
  author_user_id             uuid references public.profiles (id) on delete set null,
  created_by_integration_id  uuid,
  failure_reason             text,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  sent_at                    timestamptz,
  received_at                timestamptz,
  constraint messages_id_workspace_key unique (id, workspace_id),
  constraint messages_mailbox_fk foreign key (mailbox_id, workspace_id)
    references public.mailboxes (id, workspace_id) on delete cascade,
  constraint messages_thread_fk foreign key (thread_id, workspace_id, mailbox_id)
    references public.threads (id, workspace_id, mailbox_id) on delete cascade,
  constraint messages_direction_state_chk check (
    (direction = 'draft'    and lifecycle_state = 'draft')
    or (direction = 'inbound'  and lifecycle_state = 'received')
    or (direction = 'outbound' and lifecycle_state in ('queued', 'submitted', 'failed'))
  ),
  constraint messages_thread_required_chk check (direction = 'draft' or thread_id is not null),
  constraint messages_draft_owner_chk check (
    direction <> 'draft' or author_user_id is not null or created_by_integration_id is not null
  )
);
create index messages_thread_idx on public.messages (thread_id, created_at);
create index messages_mailbox_idx on public.messages (mailbox_id, created_at desc);
create index messages_workspace_idx on public.messages (workspace_id);
create index messages_author_drafts_idx on public.messages (author_user_id, mailbox_id)
  where direction = 'draft';
-- Provider IDs / threading lookups.
create index messages_resend_email_id_idx on public.messages (resend_email_id)
  where resend_email_id is not null;
create unique index messages_inbound_provider_key on public.messages (mailbox_id, resend_email_id)
  where direction = 'inbound' and resend_email_id is not null;
create unique index messages_outbound_provider_key on public.messages (resend_email_id)
  where direction = 'outbound' and resend_email_id is not null;
create index messages_rfc_message_id_idx on public.messages (mailbox_id, rfc_message_id)
  where rfc_message_id is not null;
create trigger messages_set_updated_at before update on public.messages
  for each row execute function private.set_updated_at();

create table public.message_recipients (
  id              uuid primary key default gen_random_uuid(),
  message_id      uuid not null,
  workspace_id    uuid not null,
  address         text not null,
  type            text not null check (type in ('to', 'cc', 'bcc')),
  delivery_state  text not null default 'pending'
                    check (delivery_state in ('pending', 'sent', 'delivered', 'delayed', 'bounced',
                                              'complained', 'failed', 'suppressed', 'received')),
  updated_at      timestamptz not null default now(),
  constraint message_recipients_address_lowercase check (address = lower(btrim(address))),
  constraint message_recipients_unique_key unique (message_id, address, type),
  constraint message_recipients_message_fk foreign key (message_id, workspace_id)
    references public.messages (id, workspace_id) on delete cascade
);
create index message_recipients_message_idx on public.message_recipients (message_id);
create index message_recipients_address_idx on public.message_recipients (workspace_id, address);
create trigger message_recipients_set_updated_at before update on public.message_recipients
  for each row execute function private.set_updated_at();

create table public.attachments (
  id            uuid primary key default gen_random_uuid(),
  message_id    uuid not null,
  workspace_id  uuid not null,
  storage_path  text not null,
  filename      text not null,
  mime_type     text not null default 'application/octet-stream',
  size_bytes    bigint not null check (size_bytes >= 0),
  content_id    text,
  provider_attachment_id text,
  created_at    timestamptz not null default now(),
  constraint attachments_storage_path_key unique (storage_path),
  constraint attachments_message_fk foreign key (message_id, workspace_id)
    references public.messages (id, workspace_id) on delete cascade,
  -- Storage path convention: <workspace_id>/<message_id>/<uuid>-<filename>
  constraint attachments_path_prefix_chk check (storage_path like workspace_id::text || '/%')
);
create index attachments_message_idx on public.attachments (message_id);

-- -----------------------------------------------------------------------------
-- templates / integrations / idempotency
-- -----------------------------------------------------------------------------
create table public.email_templates (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 120),
  subject       text not null default '',
  body_text     text,
  body_html     text,
  variables     jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint email_templates_workspace_name_key unique (workspace_id, name),
  constraint email_templates_id_workspace_key unique (id, workspace_id)
);
create trigger email_templates_set_updated_at before update on public.email_templates
  for each row execute function private.set_updated_at();

create table public.app_integrations (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces (id) on delete cascade,
  name                text not null check (char_length(name) between 1 and 120),
  -- NULL = may send from any mailbox in the workspace.
  allowed_mailbox_id  uuid,
  key_hash            text not null,
  key_prefix          text not null,
  last_used_at        timestamptz,
  revoked_at          timestamptz,
  created_by          uuid references public.profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  constraint app_integrations_key_hash_key unique (key_hash),
  constraint app_integrations_key_prefix_key unique (key_prefix),
  constraint app_integrations_id_workspace_key unique (id, workspace_id),
  constraint app_integrations_mailbox_fk foreign key (allowed_mailbox_id, workspace_id)
    references public.mailboxes (id, workspace_id) on delete cascade
);
create index app_integrations_workspace_idx on public.app_integrations (workspace_id);

alter table public.messages
  add constraint messages_integration_fk foreign key (created_by_integration_id, workspace_id)
    references public.app_integrations (id, workspace_id) on delete set null (created_by_integration_id);

create table public.api_idempotency_keys (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  integration_id   uuid not null references public.app_integrations (id) on delete cascade,
  idempotency_key  text not null check (char_length(idempotency_key) between 1 and 255),
  request_hash     text not null,
  response_status  integer,
  response_body    jsonb,
  message_id       uuid references public.messages (id) on delete set null,
  locked_at        timestamptz not null default now(),
  completed_at     timestamptz,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default (now() + interval '24 hours'),
  constraint api_idempotency_keys_integration_key unique (integration_id, idempotency_key)
);
create index api_idempotency_keys_expires_idx on public.api_idempotency_keys (expires_at);

-- -----------------------------------------------------------------------------
-- outbox / webhooks / usage / audit
-- -----------------------------------------------------------------------------
create table public.outbox_jobs (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null,
  message_id         uuid not null,
  status             text not null default 'pending'
                       check (status in ('pending', 'processing', 'succeeded', 'failed', 'dead')),
  attempts           integer not null default 0 check (attempts >= 0),
  idempotency_key    text not null,
  next_attempt_at    timestamptz not null default now(),
  last_error         text,
  claimed_at         timestamptz,
  claimed_by         text,
  -- Quota accounting (see reserve/finalize functions below).
  quota_year_month   text,
  quota_units        integer not null default 0 check (quota_units >= 0),
  quota_state        text not null default 'none' check (quota_state in ('none', 'reserved', 'settled', 'released')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint outbox_jobs_message_key unique (message_id),
  constraint outbox_jobs_idempotency_key unique (workspace_id, idempotency_key),
  constraint outbox_jobs_message_fk foreign key (message_id, workspace_id)
    references public.messages (id, workspace_id) on delete cascade
);
create index outbox_jobs_due_idx on public.outbox_jobs (next_attempt_at)
  where status in ('pending', 'processing');
create index outbox_jobs_workspace_status_idx on public.outbox_jobs (workspace_id, status);
create trigger outbox_jobs_set_updated_at before update on public.outbox_jobs
  for each row execute function private.set_updated_at();

create table public.webhook_events (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null default 'resend',
  provider_account  text not null default 'default',
  event_id          text not null,
  event_type        text not null,
  payload           jsonb not null,
  status            text not null default 'received'
                      check (status in ('received', 'processing', 'processed', 'ignored', 'failed')),
  error             text,
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  constraint webhook_events_provider_event_key unique (provider, provider_account, event_id)
);
create index webhook_events_status_idx on public.webhook_events (status, received_at)
  where status in ('received', 'processing', 'failed');

create table public.monthly_usage (
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  year_month      text not null check (year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  reserved_count  integer not null default 0 check (reserved_count >= 0),
  settled_count   integer not null default 0 check (settled_count >= 0),
  updated_at      timestamptz not null default now(),
  primary key (workspace_id, year_month)
);
create trigger monthly_usage_set_updated_at before update on public.monthly_usage
  for each row execute function private.set_updated_at();

create table public.audit_logs (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid references public.workspaces (id) on delete set null,
  actor_user_id  uuid references public.profiles (id) on delete set null,
  action         text not null,
  resource_type  text,
  resource_id    text,
  -- Never put message content in here; ids and field names only.
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index audit_logs_workspace_idx on public.audit_logs (workspace_id, created_at desc);
create index audit_logs_actor_idx on public.audit_logs (actor_user_id, created_at desc);

-- =============================================================================
-- Authorization helpers (SECURITY DEFINER, schema `private`)
-- =============================================================================
create or replace function private.is_platform_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins where user_id = (select auth.uid())
  );
$$;

create or replace function private.workspace_role(p_workspace_id uuid)
returns text
language sql stable security definer
set search_path = ''
as $$
  select role from public.workspace_memberships
  where workspace_id = p_workspace_id and user_id = (select auth.uid());
$$;

create or replace function private.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_memberships
    where workspace_id = p_workspace_id and user_id = (select auth.uid())
  );
$$;

create or replace function private.is_workspace_admin(p_workspace_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_memberships
    where workspace_id = p_workspace_id and user_id = (select auth.uid())
      and role in ('owner', 'admin')
  );
$$;

create or replace function private.is_workspace_owner(p_workspace_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_memberships
    where workspace_id = p_workspace_id and user_id = (select auth.uid())
      and role = 'owner'
  );
$$;

-- Can the current user READ the mailbox? Requires an explicit mailbox_access
-- grant for every role (owners/admins included). Platform admins get nothing.
create or replace function private.can_read_mailbox(p_mailbox_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.mailboxes mb
    join public.workspace_memberships ms
      on ms.workspace_id = mb.workspace_id and ms.user_id = (select auth.uid())
    join public.mailbox_access ma
      on ma.membership_id = ms.id and ma.mailbox_id = mb.id
    where mb.id = p_mailbox_id
  );
$$;

-- Can the current user SEND from the mailbox? Requires an active workspace,
-- an enabled mailbox, and an explicit read_send grant.
create or replace function private.can_send_mailbox(p_mailbox_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.mailboxes mb
    join public.workspaces w on w.id = mb.workspace_id and w.status = 'active'
    join public.workspace_memberships ms
      on ms.workspace_id = mb.workspace_id and ms.user_id = (select auth.uid())
    join public.mailbox_access ma
      on ma.membership_id = ms.id and ma.mailbox_id = mb.id
     and ma.permission = 'read_send'
    where mb.id = p_mailbox_id
      and mb.enabled
  );
$$;

grant execute on all functions in schema private to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Guard triggers
-- -----------------------------------------------------------------------------

-- Non-platform-admins (i.e. workspace owners/admins) cannot change status, slug
-- or the sending limit. service_role calls (auth.uid() is null) are trusted.
create or replace function private.workspaces_guard_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and not private.is_platform_admin() then
    if new.status is distinct from old.status
       or new.slug is distinct from old.slug
       or new.monthly_sending_limit is distinct from old.monthly_sending_limit then
      raise exception 'only platform admins can change workspace status, slug or sending limit'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger workspaces_guard_privileged_columns
  before update on public.workspaces
  for each row execute function private.workspaces_guard_privileged_columns();

-- A workspace must never lose its last owner (unless the workspace itself is
-- being deleted, in which case the parent row is already gone).
create or replace function private.memberships_keep_an_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner')
     and exists (select 1 from public.workspaces where id = old.workspace_id)
     and not exists (
       select 1 from public.workspace_memberships
       where workspace_id = old.workspace_id and role = 'owner' and id <> old.id
     ) then
    raise exception 'a workspace must keep at least one owner' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger memberships_keep_an_owner
  before update of role or delete on public.workspace_memberships
  for each row execute function private.memberships_keep_an_owner();

-- Thread activity bump whenever a non-draft message is stored.
create or replace function private.bump_thread_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.thread_id is not null and new.direction <> 'draft' then
    update public.threads
       set last_activity_at = greatest(last_activity_at, coalesce(new.received_at, new.sent_at, new.created_at))
     where id = new.thread_id;
  end if;
  return new;
end;
$$;
create trigger messages_bump_thread_activity
  after insert on public.messages
  for each row execute function private.bump_thread_activity();

-- =============================================================================
-- Service-role-only RPC: quota, outbox, enqueue
-- (EXECUTE is revoked from anon/authenticated; PostgREST exposes `public` only.)
-- =============================================================================

-- Atomically reserve sending quota. Returns the usage snapshot.
create or replace function public.reserve_send_quota(
  p_workspace_id uuid,
  p_year_month   text,
  p_units        integer
)
returns table (allowed boolean, reserved_count integer, settled_count integer, monthly_limit integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_status text;
  v_usage public.monthly_usage%rowtype;
begin
  if p_units < 1 then
    raise exception 'units must be positive' using errcode = '22023';
  end if;

  select w.monthly_sending_limit, w.status into v_limit, v_status
    from public.workspaces w where w.id = p_workspace_id;
  if v_limit is null then
    raise exception 'workspace not found' using errcode = 'P0002';
  end if;

  insert into public.monthly_usage (workspace_id, year_month)
  values (p_workspace_id, p_year_month)
  on conflict do nothing;

  select * into v_usage from public.monthly_usage mu
   where mu.workspace_id = p_workspace_id and mu.year_month = p_year_month
   for update;

  if v_status <> 'active' or v_usage.reserved_count + v_usage.settled_count + p_units > v_limit then
    return query select false, v_usage.reserved_count, v_usage.settled_count, v_limit;
    return;
  end if;

  update public.monthly_usage mu
     set reserved_count = mu.reserved_count + p_units
   where mu.workspace_id = p_workspace_id and mu.year_month = p_year_month
   returning mu.reserved_count, mu.settled_count into v_usage.reserved_count, v_usage.settled_count;

  return query select true, v_usage.reserved_count, v_usage.settled_count, v_limit;
end;
$$;

-- Finalize the quota reservation held by an outbox job exactly once.
--   p_consumed = true  -> reserved becomes settled (email was submitted)
--   p_consumed = false -> reservation is released (permanent failure)
create or replace function public.finalize_job_quota(p_job_id uuid, p_consumed boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.outbox_jobs%rowtype;
begin
  select * into v_job from public.outbox_jobs where id = p_job_id for update;
  if not found or v_job.quota_state <> 'reserved' then
    return false;
  end if;

  update public.monthly_usage mu
     set reserved_count = greatest(mu.reserved_count - v_job.quota_units, 0),
         settled_count  = mu.settled_count + case when p_consumed then v_job.quota_units else 0 end
   where mu.workspace_id = v_job.workspace_id and mu.year_month = v_job.quota_year_month;

  update public.outbox_jobs
     set quota_state = case when p_consumed then 'settled' else 'released' end
   where id = p_job_id;
  return true;
end;
$$;

-- Atomically convert a draft into a queued outbound message:
--   reserves quota -> creates the thread if needed -> flips message to
--   outbound/queued -> inserts the outbox job. All-or-nothing.
-- Idempotent on (workspace_id, idempotency_key).
create or replace function public.enqueue_outbound_message(
  p_message_id       uuid,
  p_idempotency_key  text,
  p_year_month       text,
  p_units            integer,
  p_rfc_message_id   text default null,
  p_in_reply_to      text default null,
  p_references       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msg    public.messages%rowtype;
  v_job    public.outbox_jobs%rowtype;
  v_quota  record;
  v_thread uuid;
begin
  select * into v_msg from public.messages where id = p_message_id for update;
  if not found then
    raise exception 'message not found' using errcode = 'P0002';
  end if;

  select * into v_job from public.outbox_jobs
   where workspace_id = v_msg.workspace_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('status', 'already_queued', 'job_id', v_job.id,
                              'thread_id', v_msg.thread_id, 'message_id', v_msg.id);
  end if;

  if v_msg.direction <> 'draft' then
    raise exception 'message is not a draft' using errcode = '22023';
  end if;

  if not exists (select 1 from public.workspaces w where w.id = v_msg.workspace_id and w.status = 'active') then
    return jsonb_build_object('status', 'workspace_inactive');
  end if;

  select * into v_quota from public.reserve_send_quota(v_msg.workspace_id, p_year_month, p_units);
  if not v_quota.allowed then
    return jsonb_build_object('status', 'quota_exceeded',
                              'reserved', v_quota.reserved_count,
                              'settled', v_quota.settled_count,
                              'limit', v_quota.monthly_limit);
  end if;

  v_thread := v_msg.thread_id;
  if v_thread is null then
    insert into public.threads (workspace_id, mailbox_id, subject, normalized_subject)
    values (
      v_msg.workspace_id, v_msg.mailbox_id, v_msg.subject,
      btrim(regexp_replace(lower(v_msg.subject), '^((re|fwd?|aw|sv)\s*:\s*)+', '', 'i'))
    )
    returning id into v_thread;
  end if;

  update public.messages
     set direction = 'outbound',
         lifecycle_state = 'queued',
         thread_id = v_thread,
         rfc_message_id = coalesce(p_rfc_message_id, rfc_message_id),
         in_reply_to = coalesce(p_in_reply_to, in_reply_to),
         references_header = coalesce(p_references, references_header)
   where id = p_message_id;

  update public.threads set last_activity_at = now() where id = v_thread;

  insert into public.outbox_jobs (workspace_id, message_id, idempotency_key,
                                  quota_year_month, quota_units, quota_state)
  values (v_msg.workspace_id, p_message_id, p_idempotency_key, p_year_month, p_units, 'reserved')
  returning * into v_job;

  return jsonb_build_object('status', 'queued', 'job_id', v_job.id,
                            'thread_id', v_thread, 'message_id', p_message_id);
end;
$$;

-- Claim due jobs for a worker (SKIP LOCKED). Jobs whose lease expired are
-- reclaimed, so a crashed worker never wedges the queue.
create or replace function public.claim_outbox_jobs(
  p_worker_id      text,
  p_batch_size     integer default 10,
  p_lease_seconds  integer default 120
)
returns setof public.outbox_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select j.id
      from public.outbox_jobs j
     where (
             (j.status = 'pending' and j.next_attempt_at <= now())
          or (j.status = 'processing' and j.claimed_at < now() - make_interval(secs => p_lease_seconds))
           )
     order by j.next_attempt_at
     limit greatest(p_batch_size, 1)
     for update skip locked
  )
  update public.outbox_jobs j
     set status = 'processing',
         attempts = j.attempts + 1,
         claimed_at = now(),
         claimed_by = p_worker_id
    from due
   where j.id = due.id
  returning j.*;
end;
$$;

revoke all on function public.reserve_send_quota(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.finalize_job_quota(uuid, boolean) from public, anon, authenticated;
revoke all on function public.enqueue_outbound_message(uuid, text, text, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.claim_outbox_jobs(text, integer, integer) from public, anon, authenticated;
grant execute on function public.reserve_send_quota(uuid, text, integer) to service_role;
grant execute on function public.finalize_job_quota(uuid, boolean) to service_role;
grant execute on function public.enqueue_outbound_message(uuid, text, text, integer, text, text, text) to service_role;
grant execute on function public.claim_outbox_jobs(text, integer, integer) to service_role;

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table public.profiles               enable row level security;
alter table public.platform_admins        enable row level security;
alter table public.workspaces             enable row level security;
alter table public.workspace_memberships  enable row level security;
alter table public.workspace_invitations  enable row level security;
alter table public.domains                enable row level security;
alter table public.mailboxes              enable row level security;
alter table public.mailbox_access         enable row level security;
alter table public.threads                enable row level security;
alter table public.thread_user_state      enable row level security;
alter table public.messages               enable row level security;
alter table public.message_recipients     enable row level security;
alter table public.attachments            enable row level security;
alter table public.email_templates        enable row level security;
alter table public.app_integrations       enable row level security;
alter table public.api_idempotency_keys   enable row level security;
alter table public.outbox_jobs            enable row level security;
alter table public.webhook_events         enable row level security;
alter table public.monthly_usage          enable row level security;
alter table public.audit_logs             enable row level security;

-- ---- profiles ---------------------------------------------------------------
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or private.is_platform_admin()
    or exists (
      select 1
      from public.workspace_memberships mine
      join public.workspace_memberships theirs on theirs.workspace_id = mine.workspace_id
      where mine.user_id = (select auth.uid()) and theirs.user_id = profiles.id
    )
  );
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- ---- platform_admins (read own row only; managed via service role / SQL) ----
create policy platform_admins_select_self on public.platform_admins for select to authenticated
  using (user_id = (select auth.uid()));

-- ---- workspaces -------------------------------------------------------------
create policy workspaces_select on public.workspaces for select to authenticated
  using (private.is_workspace_member(id) or private.is_platform_admin());
create policy workspaces_insert_platform on public.workspaces for insert to authenticated
  with check (private.is_platform_admin());
create policy workspaces_update on public.workspaces for update to authenticated
  using (private.is_platform_admin() or private.is_workspace_admin(id))
  with check (private.is_platform_admin() or private.is_workspace_admin(id));
create policy workspaces_delete_platform on public.workspaces for delete to authenticated
  using (private.is_platform_admin());

-- ---- workspace_memberships --------------------------------------------------
create policy memberships_select on public.workspace_memberships for select to authenticated
  using (
    user_id = (select auth.uid())
    or private.is_workspace_member(workspace_id)
    or private.is_platform_admin()
  );
create policy memberships_insert on public.workspace_memberships for insert to authenticated
  with check (
    private.is_platform_admin()
    or private.is_workspace_owner(workspace_id)
    or (private.is_workspace_admin(workspace_id) and role <> 'owner')
  );
create policy memberships_update on public.workspace_memberships for update to authenticated
  using (
    private.is_platform_admin()
    or private.is_workspace_owner(workspace_id)
    or (private.is_workspace_admin(workspace_id) and role <> 'owner')
  )
  with check (
    private.is_platform_admin()
    or private.is_workspace_owner(workspace_id)
    or (private.is_workspace_admin(workspace_id) and role <> 'owner')
  );
create policy memberships_delete on public.workspace_memberships for delete to authenticated
  using (
    user_id = (select auth.uid())  -- leave a workspace
    or private.is_platform_admin()
    or private.is_workspace_owner(workspace_id)
    or (private.is_workspace_admin(workspace_id) and role <> 'owner')
  );

-- ---- workspace_invitations (admins read; writes via service role) -----------
create policy invitations_select on public.workspace_invitations for select to authenticated
  using (private.is_workspace_admin(workspace_id));

-- ---- domains (members read; writes via service role after provider calls) ---
create policy domains_select on public.domains for select to authenticated
  using (private.is_workspace_member(workspace_id) or private.is_platform_admin());

-- ---- mailboxes --------------------------------------------------------------
create policy mailboxes_select on public.mailboxes for select to authenticated
  using (private.can_read_mailbox(id) or private.is_platform_admin());
create policy mailboxes_insert on public.mailboxes for insert to authenticated
  with check (private.is_workspace_admin(workspace_id) or private.is_platform_admin());
create policy mailboxes_update on public.mailboxes for update to authenticated
  using (private.is_workspace_admin(workspace_id) or private.is_platform_admin())
  with check (private.is_workspace_admin(workspace_id) or private.is_platform_admin());
create policy mailboxes_delete on public.mailboxes for delete to authenticated
  using (private.is_workspace_admin(workspace_id) or private.is_platform_admin());

-- ---- mailbox_access ---------------------------------------------------------
create policy mailbox_access_select on public.mailbox_access for select to authenticated
  using (
    private.is_workspace_admin(workspace_id)
    or exists (
      select 1 from public.workspace_memberships ms
      where ms.id = mailbox_access.membership_id and ms.user_id = (select auth.uid())
    )
  );
create policy mailbox_access_insert on public.mailbox_access for insert to authenticated
  with check (private.is_workspace_admin(workspace_id));
create policy mailbox_access_update on public.mailbox_access for update to authenticated
  using (private.is_workspace_admin(workspace_id))
  with check (private.is_workspace_admin(workspace_id));
create policy mailbox_access_delete on public.mailbox_access for delete to authenticated
  using (private.is_workspace_admin(workspace_id));

-- ---- threads (NO platform-admin access; writes via service role) ------------
create policy threads_select on public.threads for select to authenticated
  using (private.can_read_mailbox(mailbox_id));

-- ---- thread_user_state (own rows, only for threads you can read) ------------
create policy thread_user_state_select on public.thread_user_state for select to authenticated
  using (user_id = (select auth.uid()));
create policy thread_user_state_insert on public.thread_user_state for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.threads t
                where t.id = thread_user_state.thread_id and t.workspace_id = thread_user_state.workspace_id)
  );
create policy thread_user_state_update on public.thread_user_state for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy thread_user_state_delete on public.thread_user_state for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---- messages (NO platform-admin access; drafts are author-only) ------------
create policy messages_select on public.messages for select to authenticated
  using (
    private.can_read_mailbox(mailbox_id)
    and (direction <> 'draft' or author_user_id = (select auth.uid()))
  );
-- Users may only create/edit/delete THEIR OWN drafts from mailboxes they can
-- send from. Queueing/sending happens server-side via enqueue_outbound_message.
create policy messages_insert_own_draft on public.messages for insert to authenticated
  with check (
    direction = 'draft'
    and lifecycle_state = 'draft'
    and author_user_id = (select auth.uid())
    and created_by_integration_id is null
    and private.can_send_mailbox(mailbox_id)
  );
create policy messages_update_own_draft on public.messages for update to authenticated
  using (direction = 'draft' and author_user_id = (select auth.uid()))
  with check (
    direction = 'draft' and lifecycle_state = 'draft'
    and author_user_id = (select auth.uid())
    and private.can_send_mailbox(mailbox_id)
  );
create policy messages_delete_own_draft on public.messages for delete to authenticated
  using (direction = 'draft' and author_user_id = (select auth.uid()));

-- ---- message_recipients (visibility follows the parent message) -------------
create policy message_recipients_select on public.message_recipients for select to authenticated
  using (exists (select 1 from public.messages m where m.id = message_recipients.message_id));
create policy message_recipients_write_own_draft on public.message_recipients for all to authenticated
  using (exists (select 1 from public.messages m
                 where m.id = message_recipients.message_id
                   and m.direction = 'draft' and m.author_user_id = (select auth.uid())))
  with check (exists (select 1 from public.messages m
                      where m.id = message_recipients.message_id
                        and m.workspace_id = message_recipients.workspace_id
                        and m.direction = 'draft' and m.author_user_id = (select auth.uid())));

-- ---- attachments (visibility follows the parent message; uploads via server) -
create policy attachments_select on public.attachments for select to authenticated
  using (exists (select 1 from public.messages m where m.id = attachments.message_id));

-- ---- email_templates (members read, admins write; no platform-admin) --------
create policy email_templates_select on public.email_templates for select to authenticated
  using (private.is_workspace_member(workspace_id));
create policy email_templates_insert on public.email_templates for insert to authenticated
  with check (private.is_workspace_admin(workspace_id));
create policy email_templates_update on public.email_templates for update to authenticated
  using (private.is_workspace_admin(workspace_id))
  with check (private.is_workspace_admin(workspace_id));
create policy email_templates_delete on public.email_templates for delete to authenticated
  using (private.is_workspace_admin(workspace_id));

-- ---- app_integrations (admins read metadata; keys minted via service role) --
create policy app_integrations_select on public.app_integrations for select to authenticated
  using (private.is_workspace_admin(workspace_id));

-- ---- outbox_jobs (admins can see queue health) ------------------------------
create policy outbox_jobs_select on public.outbox_jobs for select to authenticated
  using (private.is_workspace_admin(workspace_id));

-- ---- monthly_usage ----------------------------------------------------------
create policy monthly_usage_select on public.monthly_usage for select to authenticated
  using (private.is_workspace_member(workspace_id) or private.is_platform_admin());

-- ---- audit_logs -------------------------------------------------------------
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (
    private.is_platform_admin()
    or (workspace_id is not null and private.is_workspace_admin(workspace_id))
  );

-- api_idempotency_keys and webhook_events: RLS on, no policies => service role only.

-- =============================================================================
-- Grants (defense in depth on top of RLS)
-- =============================================================================
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

grant select on public.profiles, public.platform_admins, public.workspaces,
                public.workspace_memberships, public.domains, public.mailboxes,
                public.mailbox_access, public.threads, public.thread_user_state,
                public.messages, public.message_recipients, public.attachments,
                public.email_templates, public.outbox_jobs, public.monthly_usage,
                public.audit_logs
  to authenticated;

-- Secrets-bearing tables expose only non-secret columns to end users.
grant select (id, workspace_id, email, role, expires_at, accepted_at, revoked_at, invited_by, created_at)
  on public.workspace_invitations to authenticated;
grant select (id, workspace_id, name, allowed_mailbox_id, key_prefix, last_used_at, revoked_at, created_by, created_at)
  on public.app_integrations to authenticated;

grant update (full_name) on public.profiles to authenticated;
grant insert, update, delete on public.workspaces to authenticated;           -- RLS: platform admin / guarded trigger
grant insert, update, delete on public.workspace_memberships to authenticated;
grant insert, update, delete on public.mailboxes to authenticated;
grant insert, update, delete on public.mailbox_access to authenticated;
grant insert, update, delete on public.thread_user_state to authenticated;
grant insert, update, delete on public.messages to authenticated;             -- RLS: own drafts only
grant insert, update, delete on public.message_recipients to authenticated;   -- RLS: own drafts only
grant insert, update, delete on public.email_templates to authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
