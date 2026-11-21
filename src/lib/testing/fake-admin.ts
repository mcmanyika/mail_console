/**
 * In-memory stand-in for the Supabase service-role client, used ONLY by unit
 * tests (never imported by app code). It implements the small slice of
 * postgrest-js / storage / rpc the pipeline uses:
 *
 *   - from(t).select/insert/update/upsert/delete with eq/neq/in/is/not/lt/lte/gt/gte/order/limit/single/maybeSingle
 *   - unique constraints (error.code === "23505", like Postgres) incl. partial ones
 *   - storage.from(bucket).upload/download/copy/createSignedUrl
 *   - rpc(): TypeScript ports of the SQL functions in supabase/migrations
 *     (enqueue_outbound_message, claim_outbox_jobs, finalize_job_quota,
 *      reserve_send_quota, consume_api_rate_limit).
 *
 * Fidelity note: RPC handlers run synchronously once invoked, which models the
 * row-level locking of the SQL versions (`for update`) — two concurrent calls
 * can interleave only BETWEEN rpc calls, never inside one. Real SQL atomicity
 * is provided by Postgres; see docs in the migration for the locking strategy.
 */
import { randomUUID } from "node:crypto";
import type { AdminClient } from "@/lib/supabase/admin";

type Row = Record<string, unknown>;
type PgError = { code: string; message: string } | null;
type Result = { data: unknown; error: PgError };

const now = () => new Date().toISOString();

const UNIQUES: Record<string, { cols: string[]; where?: (r: Row) => boolean }[]> = {
  webhook_events: [{ cols: ["provider", "provider_account", "event_id"] }],
  messages: [
    { cols: ["mailbox_id", "resend_email_id"], where: (r) => r.direction === "inbound" && r.resend_email_id != null },
    { cols: ["resend_email_id"], where: (r) => r.direction === "outbound" && r.resend_email_id != null },
  ],
  message_recipients: [{ cols: ["message_id", "address", "type"] }],
  api_idempotency_keys: [{ cols: ["integration_id", "idempotency_key"] }],
  outbox_jobs: [{ cols: ["message_id"] }, { cols: ["workspace_id", "idempotency_key"] }],
  domains: [{ cols: ["hostname"] }],
  mailboxes: [{ cols: ["address"] }],
  workspaces: [{ cols: ["slug"] }],
  attachments: [{ cols: ["storage_path"] }],
  thread_user_state: [{ cols: ["thread_id", "user_id"] }],
  workspace_memberships: [{ cols: ["workspace_id", "user_id"] }],
};

const NULLS = (...cols: string[]) => Object.fromEntries(cols.map((c) => [c, null]));

const DEFAULTS: Record<string, () => Row> = {
  webhook_events: () => ({ provider: "resend", provider_account: "default", status: "received", attempts: 0, received_at: now(), ...NULLS("locked_at", "processed_at", "error") }),
  messages: () => ({ created_at: now(), updated_at: now(), ...NULLS("thread_id", "snippet", "reply_to", "text_body", "html_body", "resend_email_id", "rfc_message_id", "in_reply_to", "references_header", "author_user_id", "created_by_integration_id", "failure_reason", "sent_at", "received_at"), subject: "" }),
  message_recipients: () => ({ delivery_state: "pending", updated_at: now() }),
  api_idempotency_keys: () => ({ locked_at: now(), created_at: now(), expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(), ...NULLS("response_status", "response_body", "message_id", "completed_at") }),
  threads: () => ({ subject: "", normalized_subject: "", last_activity_at: now(), created_at: now() }),
  attachments: () => ({ mime_type: "application/octet-stream", created_at: now(), ...NULLS("content_id", "provider_attachment_id") }),
  thread_user_state: () => ({ is_read: false, is_archived: false, updated_at: now() }),
  workspaces: () => ({ status: "pending", monthly_sending_limit: 3000, created_at: now(), updated_at: now() }),
  workspace_invitations: () => ({ role: "member", created_at: now(), ...NULLS("accepted_at", "revoked_at", "invited_by") }),
  workspace_memberships: () => ({ role: "member", created_at: now(), updated_at: now() }),
  domains: () => ({ send_status: "not_started", inbound_status: "not_started", dns_records: [], created_at: now(), updated_at: now(), ...NULLS("resend_domain_id", "last_checked_at") }),
  audit_logs: () => ({ created_at: now(), metadata: {}, ...NULLS("workspace_id", "actor_user_id", "resource_type", "resource_id") }),
  outbox_jobs: () => ({ status: "pending", attempts: 0, next_attempt_at: now(), quota_units: 0, quota_state: "none", created_at: now(), updated_at: now(), ...NULLS("last_error", "claimed_at", "claimed_by", "quota_year_month") }),
};
const HAS_ID = new Set([
  "webhook_events", "messages", "message_recipients", "api_idempotency_keys", "threads", "attachments", "thread_user_state",
  "workspaces", "workspace_invitations", "workspace_memberships", "domains", "audit_logs", "outbox_jobs", "mailboxes",
  "mailbox_access", "email_templates", "app_integrations",
]);

function compare(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export class FakeDb {
  tables = new Map<string, Row[]>();
  objects = new Map<string, { data: Uint8Array; contentType?: string }>();
  rpcCalls: { name: string; args: Record<string, unknown> }[] = [];

  rows(table: string): Row[] {
    let t = this.tables.get(table);
    if (!t) this.tables.set(table, (t = []));
    return t;
  }

  /** Seed helper: inserts a row applying defaults, throws on unique violation. */
  seed(table: string, row: Row): Row {
    const err = this.tryInsert(table, row);
    if ("error" in err) throw new Error(`seed ${table}: ${err.error.message}`);
    return err.row;
  }

  tryInsert(table: string, input: Row): { row: Row } | { error: { code: string; message: string } } {
    const row: Row = { ...(HAS_ID.has(table) ? { id: randomUUID() } : {}), ...(DEFAULTS[table]?.() ?? {}), ...input };
    for (const u of UNIQUES[table] ?? []) {
      if (u.where && !u.where(row)) continue;
      if (u.cols.some((c) => row[c] == null)) continue;
      const clash = this.rows(table).find((r) => (!u.where || u.where(r)) && u.cols.every((c) => r[c] === row[c]));
      if (clash) return { error: { code: "23505", message: `duplicate key value violates unique constraint on ${table}(${u.cols.join(",")})` } };
    }
    this.rows(table).push(row);
    return { row };
  }

  client(): AdminClient {
    return new FakeClient(this) as unknown as AdminClient;
  }
}

class Query implements PromiseLike<Result> {
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private filters: ((r: Row) => boolean)[] = [];
  private payload: Row | Row[] | null = null;
  private opts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private returning = false;
  private cols: string | null = null;
  private orders: { col: string; asc: boolean }[] = [];
  private max: number | null = null;
  private mode: "many" | "single" | "maybe" = "many";

  constructor(private db: FakeDb, private table: string) {}

  select(cols?: string) {
    this.returning = true;
    this.cols = cols ?? null;
    return this;
  }
  insert(p: Row | Row[]) { this.op = "insert"; this.payload = p; return this; }
  update(p: Row) { this.op = "update"; this.payload = p; return this; }
  upsert(p: Row | Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}) { this.op = "upsert"; this.payload = p; this.opts = opts; return this; }
  delete() { this.op = "delete"; return this; }

  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  not(c: string, op: string, v: unknown) {
    if (op !== "is") throw new Error(`fake: not(${op}) unsupported`);
    this.filters.push((r) => !(v === null ? r[c] == null : r[c] === v));
    return this;
  }
  lt(c: string, v: unknown) { this.filters.push((r) => r[c] != null && compare(r[c], v) < 0); return this; }
  lte(c: string, v: unknown) { this.filters.push((r) => r[c] != null && compare(r[c], v) <= 0); return this; }
  gt(c: string, v: unknown) { this.filters.push((r) => r[c] != null && compare(r[c], v) > 0); return this; }
  gte(c: string, v: unknown) { this.filters.push((r) => r[c] != null && compare(r[c], v) >= 0); return this; }
  order(col: string, o: { ascending?: boolean } = {}) { this.orders.push({ col, asc: o.ascending !== false }); return this; }
  limit(n: number) { this.max = n; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }

  then<A = Result, B = never>(f?: ((v: Result) => A | PromiseLike<A>) | null, r?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    return Promise.resolve().then(() => this.execute()).then(f, r);
  }

  private project(rows: Row[]): Row[] {
    const cols = this.cols && !/[*()]/.test(this.cols) ? this.cols.split(",").map((c) => c.trim()) : null;
    return rows.map((r) => (cols ? Object.fromEntries(cols.map((c) => [c, r[c]])) : { ...r }));
  }

  private finish(rows: Row[]): Result {
    let out = rows;
    for (const o of [...this.orders].reverse()) out = [...out].sort((a, b) => (o.asc ? 1 : -1) * compare(a[o.col], b[o.col]));
    if (this.max != null) out = out.slice(0, this.max);
    const data = this.project(out);
    if (this.mode === "single") {
      return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { code: "PGRST116", message: `expected 1 row, got ${data.length}` } };
    }
    if (this.mode === "maybe") {
      if (data.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
      return { data: data[0] ?? null, error: null };
    }
    return { data, error: null };
  }

  private execute(): Result {
    const match = () => this.db.rows(this.table).filter((r) => this.filters.every((f) => f(r)));
    switch (this.op) {
      case "select":
        return this.finish(match());
      case "insert": {
        const inserted: Row[] = [];
        for (const p of Array.isArray(this.payload) ? this.payload : [this.payload as Row]) {
          const res = this.db.tryInsert(this.table, p);
          if ("error" in res) return { data: null, error: res.error };
          inserted.push(res.row);
        }
        return this.returning ? this.finish(inserted) : { data: null, error: null };
      }
      case "upsert": {
        const out: Row[] = [];
        const conflict = (this.opts.onConflict ?? "id").split(",").map((c) => c.trim());
        for (const p of Array.isArray(this.payload) ? this.payload : [this.payload as Row]) {
          const existing = this.db.rows(this.table).find((r) => conflict.every((c) => r[c] === p[c]));
          if (existing) {
            if (!this.opts.ignoreDuplicates) Object.assign(existing, p);
            out.push(existing);
          } else {
            const res = this.db.tryInsert(this.table, p);
            if ("error" in res) return { data: null, error: res.error };
            out.push(res.row);
          }
        }
        return this.returning ? this.finish(out) : { data: null, error: null };
      }
      case "update": {
        const rows = match();
        for (const r of rows) Object.assign(r, this.payload, "updated_at" in r ? { updated_at: now() } : {});
        return this.returning ? this.finish(rows) : { data: null, error: null };
      }
      case "delete": {
        const rows = match();
        const keep = this.db.rows(this.table).filter((r) => !rows.includes(r));
        this.db.tables.set(this.table, keep);
        return this.returning ? this.finish(rows) : { data: null, error: null };
      }
    }
  }
}

class FakeClient {
  constructor(private db: FakeDb) {}

  from(table: string) {
    return new Query(this.db, table);
  }

  get storage() {
    const db = this.db;
    return {
      from(bucket: string) {
        const key = (p: string) => `${bucket}/${p}`;
        return {
          async upload(path: string, data: Uint8Array | ArrayBuffer | Blob, opts: { contentType?: string; upsert?: boolean } = {}) {
            if (db.objects.has(key(path)) && !opts.upsert) return { data: null, error: { message: "The resource already exists" } };
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
            db.objects.set(key(path), { data: bytes, contentType: opts.contentType });
            return { data: { path }, error: null };
          },
          async download(path: string) {
            const o = db.objects.get(key(path));
            return o ? { data: new Blob([o.data as BlobPart]), error: null } : { data: null, error: { message: "Object not found" } };
          },
          async copy(from: string, to: string) {
            const o = db.objects.get(key(from));
            if (!o) return { data: null, error: { message: "Object not found" } };
            db.objects.set(key(to), { ...o });
            return { data: { path: to }, error: null };
          },
          async createSignedUrl(path: string, expiresIn: number, opts: { download?: string | boolean } = {}) {
            if (!db.objects.has(key(path))) return { data: null, error: { message: "Object not found" } };
            const dl = opts.download ? `&download=${encodeURIComponent(String(opts.download))}` : "";
            return { data: { signedUrl: `https://storage.test/sign/${bucket}/${path}?token=t&expires=${expiresIn}${dl}` }, error: null };
          },
        };
      },
    };
  }

  async rpc(name: string, args: Record<string, unknown>): Promise<Result> {
    await Promise.resolve(); // yield: lets concurrent callers interleave BETWEEN rpc calls
    this.db.rpcCalls.push({ name, args });
    const h = RPC[name];
    if (!h) return { data: null, error: { code: "42883", message: `fake rpc ${name} not implemented` } };
    try {
      return { data: h(this.db, args), error: null };
    } catch (err) {
      return { data: null, error: { code: "P0001", message: err instanceof Error ? err.message : String(err) } };
    }
  }
}

// ---- ports of the SQL functions (supabase/migrations/00001_init.sql, 00004_pipeline.sql) ----
function reserve(db: FakeDb, workspaceId: string, ym: string, units: number) {
  const ws = db.rows("workspaces").find((w) => w.id === workspaceId);
  if (!ws) throw new Error("workspace not found");
  let usage = db.rows("monthly_usage").find((u) => u.workspace_id === workspaceId && u.year_month === ym);
  if (!usage) {
    usage = { workspace_id: workspaceId, year_month: ym, reserved_count: 0, settled_count: 0 };
    db.rows("monthly_usage").push(usage);
  }
  const limit = ws.monthly_sending_limit as number;
  if (ws.status !== "active" || (usage.reserved_count as number) + (usage.settled_count as number) + units > limit) {
    return { allowed: false, usage, limit };
  }
  usage.reserved_count = (usage.reserved_count as number) + units;
  return { allowed: true, usage, limit };
}

const RPC: Record<string, (db: FakeDb, a: Record<string, unknown>) => unknown> = {
  reserve_send_quota(db, a) {
    const r = reserve(db, a.p_workspace_id as string, a.p_year_month as string, a.p_units as number);
    return [{ allowed: r.allowed, reserved_count: r.usage.reserved_count, settled_count: r.usage.settled_count, monthly_limit: r.limit }];
  },

  enqueue_outbound_message(db, a) {
    const msg = db.rows("messages").find((m) => m.id === a.p_message_id);
    if (!msg) throw new Error("message not found");
    const key = a.p_idempotency_key as string;
    const existing = db.rows("outbox_jobs").find((j) => j.workspace_id === msg.workspace_id && j.idempotency_key === key);
    if (existing) return { status: "already_queued", job_id: existing.id, thread_id: msg.thread_id, message_id: msg.id };
    if (msg.direction !== "draft") throw new Error("message is not a draft");
    const ws = db.rows("workspaces").find((w) => w.id === msg.workspace_id);
    if (!ws || ws.status !== "active") return { status: "workspace_inactive" };

    const q = reserve(db, msg.workspace_id as string, a.p_year_month as string, a.p_units as number);
    if (!q.allowed) return { status: "quota_exceeded", reserved: q.usage.reserved_count, settled: q.usage.settled_count, limit: q.limit };

    let threadId = msg.thread_id as string | null;
    if (!threadId) {
      const t = db.seed("threads", {
        workspace_id: msg.workspace_id,
        mailbox_id: msg.mailbox_id,
        subject: msg.subject,
        normalized_subject: String(msg.subject).toLowerCase().replace(/^((re|fwd?|aw|sv)\s*:\s*)+/i, "").trim(),
      });
      threadId = t.id as string;
    }
    Object.assign(msg, {
      direction: "outbound",
      lifecycle_state: "queued",
      thread_id: threadId,
      rfc_message_id: (a.p_rfc_message_id as string | null) ?? msg.rfc_message_id,
      in_reply_to: (a.p_in_reply_to as string | null) ?? msg.in_reply_to,
      references_header: (a.p_references as string | null) ?? msg.references_header,
    });
    const job = db.seed("outbox_jobs", {
      workspace_id: msg.workspace_id,
      message_id: msg.id,
      idempotency_key: key,
      quota_year_month: a.p_year_month,
      quota_units: a.p_units,
      quota_state: "reserved",
    });
    return { status: "queued", job_id: job.id, thread_id: threadId, message_id: msg.id };
  },

  claim_outbox_jobs(db, a) {
    const t = now();
    const lease = new Date(Date.now() - (a.p_lease_seconds as number) * 1000).toISOString();
    const due = db
      .rows("outbox_jobs")
      .filter((j) => (j.status === "pending" && (j.next_attempt_at as string) <= t) || (j.status === "processing" && (j.claimed_at as string) < lease))
      .sort((x, y) => compare(x.next_attempt_at, y.next_attempt_at))
      .slice(0, Math.max(a.p_batch_size as number, 1));
    for (const j of due) Object.assign(j, { status: "processing", attempts: (j.attempts as number) + 1, claimed_at: t, claimed_by: a.p_worker_id });
    return due.map((j) => ({ ...j }));
  },

  finalize_job_quota(db, a) {
    const job = db.rows("outbox_jobs").find((j) => j.id === a.p_job_id);
    if (!job || job.quota_state !== "reserved") return false;
    const usage = db.rows("monthly_usage").find((u) => u.workspace_id === job.workspace_id && u.year_month === job.quota_year_month);
    if (usage) {
      usage.reserved_count = Math.max((usage.reserved_count as number) - (job.quota_units as number), 0);
      if (a.p_consumed) usage.settled_count = (usage.settled_count as number) + (job.quota_units as number);
    }
    job.quota_state = a.p_consumed ? "settled" : "released";
    return true;
  },

  consume_api_rate_limit(db, a) {
    const windowMs = (a.p_window_seconds as number ?? 60) * 1000;
    const start = new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString();
    let row = db.rows("api_rate_limits").find((r) => r.integration_id === a.p_integration_id && r.window_start === start);
    if (!row) {
      row = { integration_id: a.p_integration_id, window_start: start, request_count: 0 };
      db.rows("api_rate_limits").push(row);
    }
    row.request_count = (row.request_count as number) + 1;
    return [{ allowed: (row.request_count as number) <= (a.p_limit as number), request_count: row.request_count, retry_after_seconds: 1 }];
  },
};
