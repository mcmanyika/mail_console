-- =============================================================================
-- Require explicit mailbox_access grants for message content for EVERY role,
-- including workspace owners and admins. Owners/admins may still manage grants,
-- domains, mailboxes, and settings without being able to read mail bodies.
-- =============================================================================

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
