-- =============================================================================
-- Stripe billing: workspace Stripe customer/subscription + payment ledger.
-- Payments are written ONLY from the Stripe webhook (service role) so every
-- successful charge is captured automatically and idempotently.
-- =============================================================================

alter table public.workspaces
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists billing_email text;

create unique index if not exists workspaces_stripe_customer_uidx
  on public.workspaces (stripe_customer_id)
  where stripe_customer_id is not null;

create unique index if not exists workspaces_stripe_subscription_uidx
  on public.workspaces (stripe_subscription_id)
  where stripe_subscription_id is not null;

create table if not exists public.payments (
  id                         uuid primary key default gen_random_uuid(),
  workspace_id               uuid not null references public.workspaces (id) on delete cascade,
  stripe_event_id            text not null,
  stripe_checkout_session_id text,
  stripe_payment_intent_id   text,
  stripe_invoice_id          text,
  stripe_customer_id         text,
  amount_cents               integer not null check (amount_cents >= 0),
  currency                   text not null default 'usd',
  status                     text not null default 'succeeded'
                               check (status in ('succeeded', 'pending', 'failed', 'refunded')),
  plan                       text check (plan is null or plan in ('starter', 'growth', 'scale', 'custom')),
  description                text,
  receipt_url                text,
  paid_at                    timestamptz not null default now(),
  created_at                 timestamptz not null default now(),
  constraint payments_stripe_event_key unique (stripe_event_id)
);

create unique index if not exists payments_stripe_invoice_uidx
  on public.payments (stripe_invoice_id)
  where stripe_invoice_id is not null;

create index payments_workspace_paid_idx on public.payments (workspace_id, paid_at desc);

alter table public.payments enable row level security;
revoke all on public.payments from anon, authenticated;
grant select on public.payments to authenticated;
grant all on public.payments to service_role;

-- Workspace members (admin+) can read their own payment history; writes are
-- service-role only via the Stripe webhook.
create policy payments_select on public.payments for select to authenticated
  using (private.is_workspace_admin(workspace_id));
