-- =============================================================================
-- Workspace commercial plans (Starter / Growth / Scale / custom).
-- plan drives default monthly_sending_limit + monthly_ai_limit; prices are
-- catalog-only (billing happens outside the app for now).
-- =============================================================================

alter table public.workspaces
  add column if not exists plan text not null default 'custom'
    check (plan in ('starter', 'growth', 'scale', 'custom'));

comment on column public.workspaces.plan is
  'Commercial package: starter ($49), growth ($149), scale ($399), or custom limits.';

-- Best-effort backfill from existing send limits.
update public.workspaces set plan = 'starter' where monthly_sending_limit = 3000 and plan = 'custom';
update public.workspaces set plan = 'growth'  where monthly_sending_limit = 15000 and plan = 'custom';
update public.workspaces set plan = 'scale'   where monthly_sending_limit = 50000 and plan = 'custom';
