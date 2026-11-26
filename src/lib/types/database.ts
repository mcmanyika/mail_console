/**
 * Hand-written types mirroring supabase/migrations/00001_init.sql.
 * Keep in sync with the schema (or replace with `supabase gen types`).
 *
 * NOTE: these must be `type` aliases (not interfaces) so they satisfy
 * postgrest-js' `Record<string, unknown>` constraints.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

// ---- enums (CHECK constraints in SQL) ----------------------------------------
export type WorkspaceStatus = "active" | "suspended" | "pending";
export type WorkspaceRole = "owner" | "admin" | "member";
export type InvitationRole = "owner" | "admin" | "member";
export type MailboxPermission = "read" | "read_send";
export type DomainStatus =
  | "not_started"
  | "pending"
  | "verified"
  | "partially_verified"
  | "partially_failed"
  | "failed"
  | "temporary_failure";
export type InboundDomainStatus = DomainStatus | "disabled";
export type MessageDirection = "inbound" | "outbound" | "draft";
export type MessageLifecycleState = "draft" | "queued" | "submitted" | "failed" | "received";
export type RecipientType = "to" | "cc" | "bcc";
export type DeliveryState =
  | "pending"
  | "sent"
  | "delivered"
  | "delayed"
  | "bounced"
  | "complained"
  | "failed"
  | "suppressed"
  | "received";
export type OutboxStatus = "pending" | "processing" | "succeeded" | "failed" | "dead";
export type QuotaState = "none" | "reserved" | "settled" | "released";
export type WebhookStatus = "received" | "processing" | "processed" | "ignored" | "failed";
export type CampaignStatus = "draft" | "scheduled" | "sending" | "paused" | "sent" | "cancelled";
export type CampaignRecipientStatus = "pending" | "queued" | "sent" | "failed" | "skipped";

/** One DNS record as stored in domains.dns_records. */
export type DnsRecord = {
  record: string;
  name: string;
  type: string;
  value: string;
  ttl: string;
  status: string;
  priority?: number;
};

// ---- rows --------------------------------------------------------------------
export type ProfileRow = {
  id: string;
  email: string;
  full_name: string | null;
  created_at: string;
  updated_at: string;
};

export type PlatformAdminRow = { user_id: string; created_at: string };

export type WorkspacePlan = "starter" | "growth" | "scale" | "custom";

export type WorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  plan: WorkspacePlan;
  monthly_sending_limit: number;
  ai_enabled: boolean;
  ai_instructions: string | null;
  monthly_ai_limit: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  billing_email: string | null;
  created_at: string;
  updated_at: string;
};

export type PaymentStatus = "succeeded" | "pending" | "failed" | "refunded";

export type PaymentRow = {
  id: string;
  workspace_id: string;
  stripe_event_id: string;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_invoice_id: string | null;
  stripe_customer_id: string | null;
  amount_cents: number;
  currency: string;
  status: PaymentStatus;
  plan: WorkspacePlan | null;
  description: string | null;
  receipt_url: string | null;
  paid_at: string;
  created_at: string;
};

export type WorkspaceMembershipRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
  updated_at: string;
};

export type WorkspaceInvitationRow = {
  id: string;
  workspace_id: string;
  email: string;
  role: InvitationRole;
  token_hash: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  invited_by: string | null;
  created_at: string;
};

export type DomainRow = {
  id: string;
  workspace_id: string;
  hostname: string;
  resend_domain_id: string | null;
  send_status: DomainStatus;
  inbound_status: InboundDomainStatus;
  dns_records: Json;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MailboxRow = {
  id: string;
  workspace_id: string;
  domain_id: string;
  address: string;
  display_name: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type MailboxAccessRow = {
  id: string;
  workspace_id: string;
  membership_id: string;
  mailbox_id: string;
  permission: MailboxPermission;
  created_at: string;
};

export type ThreadRow = {
  id: string;
  workspace_id: string;
  mailbox_id: string;
  subject: string;
  normalized_subject: string;
  last_activity_at: string;
  created_at: string;
};

export type ThreadUserStateRow = {
  id: string;
  workspace_id: string;
  thread_id: string;
  user_id: string;
  is_read: boolean;
  is_archived: boolean;
  updated_at: string;
};

export type MessageRow = {
  id: string;
  workspace_id: string;
  thread_id: string | null;
  mailbox_id: string;
  direction: MessageDirection;
  lifecycle_state: MessageLifecycleState;
  from_address: string;
  reply_to: string | null;
  subject: string;
  snippet: string | null;
  text_body: string | null;
  html_body: string | null;
  resend_email_id: string | null;
  rfc_message_id: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  author_user_id: string | null;
  created_by_integration_id: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  received_at: string | null;
};

export type MessageRecipientRow = {
  id: string;
  message_id: string;
  workspace_id: string;
  address: string;
  type: RecipientType;
  delivery_state: DeliveryState;
  updated_at: string;
};

export type AttachmentRow = {
  id: string;
  message_id: string;
  workspace_id: string;
  storage_path: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  content_id: string | null;
  provider_attachment_id: string | null;
  created_at: string;
};

export type EmailTemplateRow = {
  id: string;
  workspace_id: string;
  name: string;
  subject: string;
  body_text: string | null;
  body_html: string | null;
  variables: Json;
  created_at: string;
  updated_at: string;
};

export type AppIntegrationRow = {
  id: string;
  workspace_id: string;
  name: string;
  allowed_mailbox_id: string | null;
  key_hash: string;
  key_prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_by: string | null;
  created_at: string;
};

export type ApiIdempotencyKeyRow = {
  id: string;
  workspace_id: string;
  integration_id: string;
  idempotency_key: string;
  request_hash: string;
  response_status: number | null;
  response_body: Json | null;
  message_id: string | null;
  locked_at: string;
  completed_at: string | null;
  created_at: string;
  expires_at: string;
};

export type OutboxJobRow = {
  id: string;
  workspace_id: string;
  message_id: string;
  status: OutboxStatus;
  attempts: number;
  idempotency_key: string;
  next_attempt_at: string;
  last_error: string | null;
  claimed_at: string | null;
  claimed_by: string | null;
  quota_year_month: string | null;
  quota_units: number;
  quota_state: QuotaState;
  created_at: string;
  updated_at: string;
};

export type WebhookEventRow = {
  id: string;
  provider: string;
  provider_account: string;
  event_id: string;
  event_type: string;
  payload: Json;
  status: WebhookStatus;
  error: string | null;
  received_at: string;
  processed_at: string | null;
  attempts: number;
  locked_at: string | null;
};

export type MonthlyUsageRow = {
  workspace_id: string;
  year_month: string;
  reserved_count: number;
  settled_count: number;
  updated_at: string;
};

export type MonthlyAiUsageRow = {
  workspace_id: string;
  year_month: string;
  request_count: number;
  updated_at: string;
};

export type AudienceListRow = {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type AudienceContactRow = {
  id: string;
  workspace_id: string;
  list_id: string;
  email: string;
  full_name: string | null;
  fields: Json;
  created_at: string;
  updated_at: string;
};

export type CampaignRow = {
  id: string;
  workspace_id: string;
  list_id: string;
  mailbox_id: string;
  name: string;
  subject: string;
  body_text: string;
  body_html: string | null;
  status: CampaignStatus;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_by: string | null;
  total_count: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  created_at: string;
  updated_at: string;
};

export type CampaignRecipientRow = {
  id: string;
  workspace_id: string;
  campaign_id: string;
  email: string;
  full_name: string | null;
  fields: Json;
  status: CampaignRecipientStatus;
  message_id: string | null;
  error: string | null;
  claimed_at: string | null;
  claimed_by: string | null;
  processed_at: string | null;
  created_at: string;
};

export type AuditLogRow = {
  id: string;
  workspace_id: string | null;
  actor_user_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: Json;
  created_at: string;
};

// ---- table definition helper -------------------------------------------------
/** Insert = Row minus server-defaulted columns (which become optional). */
type TableDef<
  Row extends Record<string, unknown>,
  Optional extends keyof Row,
  Relationships extends Rel[] = [],
> = {
  Row: Row;
  Insert: Omit<Row, Optional> & Partial<Pick<Row, Optional>>;
  Update: Partial<Row>;
  Relationships: Relationships;
};

/** Foreign-key relationship metadata (enables typed embedded selects like `workspace:workspaces(*)`). */
type Rel<Name extends string = string, Col extends string = string, Ref extends string = string, RefCol extends string = string> = {
  foreignKeyName: Name;
  columns: [Col];
  isOneToOne: false;
  referencedRelation: Ref;
  referencedColumns: [RefCol];
};
type ToOne<Col extends string, Ref extends string> = Rel<`${Ref}_fk`, Col, Ref, "id">;

type Ts = "created_at" | "updated_at";

export type Database = {
  public: {
    Tables: {
      profiles: TableDef<ProfileRow, Ts | "full_name">;
      platform_admins: TableDef<PlatformAdminRow, "created_at">;
      workspaces: TableDef<
        WorkspaceRow,
        | "id"
        | "status"
        | "plan"
        | "monthly_sending_limit"
        | "ai_enabled"
        | "ai_instructions"
        | "monthly_ai_limit"
        | "stripe_customer_id"
        | "stripe_subscription_id"
        | "billing_email"
        | Ts
      >;
      payments: TableDef<
        PaymentRow,
        | "id"
        | "stripe_checkout_session_id"
        | "stripe_payment_intent_id"
        | "stripe_invoice_id"
        | "stripe_customer_id"
        | "currency"
        | "status"
        | "plan"
        | "description"
        | "receipt_url"
        | "paid_at"
        | "created_at"
      >;
      workspace_memberships: TableDef<
        WorkspaceMembershipRow,
        "id" | "role" | Ts,
        [ToOne<"workspace_id", "workspaces">, ToOne<"user_id", "profiles">]
      >;
      workspace_invitations: TableDef<
        WorkspaceInvitationRow,
        "id" | "role" | "accepted_at" | "revoked_at" | "invited_by" | "created_at"
      >;
      domains: TableDef<
        DomainRow,
        | "id"
        | "resend_domain_id"
        | "send_status"
        | "inbound_status"
        | "dns_records"
        | "last_checked_at"
        | Ts,
        [ToOne<"workspace_id", "workspaces">]
      >;
      mailboxes: TableDef<
        MailboxRow,
        "id" | "display_name" | "enabled" | Ts,
        [ToOne<"workspace_id", "workspaces">, ToOne<"domain_id", "domains">]
      >;
      mailbox_access: TableDef<
        MailboxAccessRow,
        "id" | "permission" | "created_at",
        [ToOne<"membership_id", "workspace_memberships">, ToOne<"mailbox_id", "mailboxes">]
      >;
      threads: TableDef<
        ThreadRow,
        "id" | "subject" | "normalized_subject" | "last_activity_at" | "created_at",
        [ToOne<"mailbox_id", "mailboxes">]
      >;
      thread_user_state: TableDef<
        ThreadUserStateRow,
        "id" | "is_read" | "is_archived" | "updated_at",
        [ToOne<"thread_id", "threads">]
      >;
      messages: TableDef<
        MessageRow,
        | "id"
        | "thread_id"
        | "subject"
        | "snippet"
        | "reply_to"
        | "text_body"
        | "html_body"
        | "resend_email_id"
        | "rfc_message_id"
        | "in_reply_to"
        | "references_header"
        | "author_user_id"
        | "created_by_integration_id"
        | "failure_reason"
        | "sent_at"
        | "received_at"
        | Ts,
        [ToOne<"thread_id", "threads">, ToOne<"mailbox_id", "mailboxes">, ToOne<"author_user_id", "profiles">]
      >;
      message_recipients: TableDef<
        MessageRecipientRow,
        "id" | "delivery_state" | "updated_at",
        [ToOne<"message_id", "messages">]
      >;
      attachments: TableDef<
        AttachmentRow,
        "id" | "mime_type" | "content_id" | "provider_attachment_id" | "created_at",
        [ToOne<"message_id", "messages">]
      >;
      email_templates: TableDef<
        EmailTemplateRow,
        "id" | "subject" | "body_text" | "body_html" | "variables" | Ts
      >;
      app_integrations: TableDef<
        AppIntegrationRow,
        "id" | "allowed_mailbox_id" | "last_used_at" | "revoked_at" | "created_by" | "created_at"
      >;
      api_idempotency_keys: TableDef<
        ApiIdempotencyKeyRow,
        | "id"
        | "response_status"
        | "response_body"
        | "message_id"
        | "locked_at"
        | "completed_at"
        | "created_at"
        | "expires_at"
      >;
      outbox_jobs: TableDef<
        OutboxJobRow,
        | "id"
        | "status"
        | "attempts"
        | "next_attempt_at"
        | "last_error"
        | "claimed_at"
        | "claimed_by"
        | "quota_year_month"
        | "quota_units"
        | "quota_state"
        | Ts,
        [ToOne<"message_id", "messages">]
      >;
      webhook_events: TableDef<
        WebhookEventRow,
        "id" | "provider" | "provider_account" | "status" | "error" | "received_at" | "processed_at" | "attempts" | "locked_at"
      >;
      monthly_usage: TableDef<MonthlyUsageRow, "reserved_count" | "settled_count" | "updated_at">;
      monthly_ai_usage: TableDef<MonthlyAiUsageRow, "request_count" | "updated_at">;
      audience_lists: TableDef<AudienceListRow, "id" | "description" | "created_by" | Ts>;
      audience_contacts: TableDef<AudienceContactRow, "id" | "full_name" | "fields" | Ts>;
      campaigns: TableDef<
        CampaignRow,
        | "id"
        | "body_html"
        | "status"
        | "scheduled_at"
        | "started_at"
        | "completed_at"
        | "created_by"
        | "total_count"
        | "sent_count"
        | "failed_count"
        | "skipped_count"
        | Ts
      >;
      campaign_recipients: TableDef<
        CampaignRecipientRow,
        | "id"
        | "full_name"
        | "fields"
        | "status"
        | "message_id"
        | "error"
        | "claimed_at"
        | "claimed_by"
        | "processed_at"
        | "created_at"
      >;
      audit_logs: TableDef<
        AuditLogRow,
        "id" | "workspace_id" | "actor_user_id" | "resource_type" | "resource_id" | "metadata" | "created_at"
      >;
    };
    Views: { [_ in never]: never };
    Functions: {
      reserve_send_quota: {
        Args: { p_workspace_id: string; p_year_month: string; p_units: number };
        Returns: {
          allowed: boolean;
          reserved_count: number;
          settled_count: number;
          monthly_limit: number;
        }[];
      };
      finalize_job_quota: {
        Args: { p_job_id: string; p_consumed: boolean };
        Returns: boolean;
      };
      enqueue_outbound_message: {
        Args: {
          p_message_id: string;
          p_idempotency_key: string;
          p_year_month: string;
          p_units: number;
          p_rfc_message_id?: string | null;
          p_in_reply_to?: string | null;
          p_references?: string | null;
        };
        Returns: Json;
      };
      consume_api_rate_limit: {
        Args: { p_integration_id: string; p_limit: number; p_window_seconds?: number };
        Returns: { allowed: boolean; request_count: number; retry_after_seconds: number }[];
      };
      consume_ai_quota: {
        Args: { p_workspace_id: string; p_year_month: string; p_limit: number };
        Returns: { allowed: boolean; request_count: number }[];
      };
      claim_campaign_recipients: {
        Args: { p_campaign_id: string; p_worker_id: string; p_batch_size?: number };
        Returns: CampaignRecipientRow[];
      };
      bump_campaign_recipient_result: {
        Args: { p_recipient_id: string; p_status: string; p_message_id?: string | null; p_error?: string | null };
        Returns: undefined;
      };
      claim_outbox_jobs: {
        Args: { p_worker_id: string; p_batch_size?: number; p_lease_seconds?: number };
        Returns: OutboxJobRow[];
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

export type Tables = Database["public"]["Tables"];
export type TableName = keyof Tables;
export type TableRow<T extends TableName> = Tables[T]["Row"];
export type TableInsert<T extends TableName> = Tables[T]["Insert"];
export type TableUpdate<T extends TableName> = Tables[T]["Update"];
