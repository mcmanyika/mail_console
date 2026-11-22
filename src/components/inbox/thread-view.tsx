import { AlertCircle, Archive, ArrowLeft, Download, File, Forward, MailOpen, Paperclip, Reply, ReplyAll, Trash2, Undo2 } from "lucide-react";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Badge, type Tone } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-dialog";
import { SubmitButton } from "@/components/ui/submit-button";
import { archiveThreadAction, deleteThreadAction, markUnreadAction } from "@/lib/actions/inbox";
import type { ThreadDetail, ThreadMessage } from "@/lib/data/inbox";
import { sanitizeEmailHtml } from "@/lib/email/sanitize";
import { displayName, formatBytes, formatFullDate, initials } from "@/lib/format";
import { composeHref } from "@/lib/inbox-links";
import type { DeliveryState } from "@/lib/types/database";
import { cn } from "@/lib/utils";
import { EmailBody } from "./email-body";
import { MarkReadOnView } from "./mark-read";

const deliveryUi: Partial<Record<DeliveryState, { label: string; tone: Tone }>> = {
  pending: { label: "Pending", tone: "neutral" },
  sent: { label: "Sent", tone: "neutral" },
  delivered: { label: "Delivered", tone: "success" },
  delayed: { label: "Delayed", tone: "warn" },
  bounced: { label: "Bounced", tone: "danger" },
  complained: { label: "Spam complaint", tone: "danger" },
  failed: { label: "Failed", tone: "danger" },
  suppressed: { label: "Suppressed", tone: "danger" },
};

export function ThreadView({
  slug,
  detail,
  backHref,
  returnTo,
  mailboxId,
}: {
  slug: string;
  detail: ThreadDetail;
  backHref: string;
  returnTo: string;
  mailboxId: string | null;
}) {
  const { messages, canSend } = detail;
  const last = messages[messages.length - 1];
  const target = [...messages].reverse().find((m) => m.direction === "inbound") ?? last;
  const mb = mailboxId ?? detail.thread.mailbox_id;

  return (
    <article className="flex min-h-0 flex-1 flex-col bg-surface" aria-label={detail.thread.subject || "Conversation"}>
      <MarkReadOnView slug={slug} threadId={detail.thread.id} isRead={detail.isRead} />
      <header className="shrink-0 border-b border-line px-4 py-3 md:px-6">
        <Link href={backHref} className="mb-2 inline-flex items-center gap-1.5 text-[13px] font-medium text-accent lg:hidden">
          <ArrowLeft className="size-4" aria-hidden /> Back
        </Link>
        <h2 className="font-serif text-[22px] font-semibold leading-snug text-ink">{detail.thread.subject || "(no subject)"}</h2>
        <p className="mt-0.5 text-xs text-muted">
          {messages.length} {messages.length === 1 ? "message" : "messages"} · via {detail.mailboxAddress}
          {detail.permission === "read" ? " · read-only access" : ""}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {target ? (
            canSend ? (
              <>
                <Link href={composeHref(slug, { mode: "reply", message: target.id, mailbox: mb })} className={buttonClasses("primary", "sm")}>
                  <Reply className="size-4" aria-hidden /> Reply
                </Link>
                <Link href={composeHref(slug, { mode: "forward", message: target.id, mailbox: mb })} className={buttonClasses("secondary", "sm")}>
                  <Forward className="size-4" aria-hidden /> Forward
                </Link>
              </>
            ) : (
              <span
                className="inline-flex h-8 items-center gap-2 rounded-md border border-dashed border-line-strong px-3 text-[13px] text-muted"
                title="You have read-only access to this mailbox"
              >
                <Reply className="size-4" aria-hidden /> Reply unavailable — read-only access
              </span>
            )
          ) : null}
          <form action={archiveThreadAction.bind(null, slug, detail.thread.id, !detail.isArchived, returnTo)}>
            <SubmitButton variant="secondary" size="sm">
              {detail.isArchived ? <Undo2 className="size-4" aria-hidden /> : <Archive className="size-4" aria-hidden />}
              {detail.isArchived ? "Move to inbox" : "Archive"}
            </SubmitButton>
          </form>
          <form action={markUnreadAction.bind(null, slug, detail.thread.id, returnTo)}>
            <SubmitButton variant="secondary" size="sm">
              <MailOpen className="size-4" aria-hidden /> Mark unread
            </SubmitButton>
          </form>
          <ConfirmButton
            action={deleteThreadAction}
            hiddenFields={{ slug, threadId: detail.thread.id, returnTo }}
            triggerLabel={
              <>
                <Trash2 className="size-4" aria-hidden /> Delete
              </>
            }
            triggerVariant="danger-ghost"
            triggerSize="sm"
            title="Delete this conversation?"
            confirmLabel="Delete permanently"
            description={
              <>
                <p>
                  This permanently removes all {messages.length}{" "}
                  {messages.length === 1 ? "message" : "messages"} in this conversation, including attachments, for
                  everyone with access to this mailbox.
                </p>
                <p className="mt-2">This cannot be undone.</p>
              </>
            }
          />
        </div>
      </header>

      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 px-4 py-5 md:px-6">
          {messages.map((m, i) => (
            <MessageCard
              key={m.id}
              slug={slug}
              message={m}
              defaultOpen={i === messages.length - 1 || m.direction === "inbound" && !detail.isRead}
              canSend={canSend}
              mailboxId={mb}
            />
          ))}
        </div>
      </div>
    </article>
  );
}

function MessageCard({
  slug,
  message: m,
  defaultOpen,
  canSend,
  mailboxId,
}: {
  slug: string;
  message: ThreadMessage;
  defaultOpen: boolean;
  canSend: boolean;
  mailboxId: string;
}) {
  const outbound = m.direction === "outbound";
  const when = m.received_at ?? m.sent_at ?? m.created_at;
  const to = m.recipients.filter((r) => r.type === "to");
  const cc = m.recipients.filter((r) => r.type === "cc");
  const bcc = m.recipients.filter((r) => r.type === "bcc");

  const cidMap: Record<string, string> = {};
  for (const a of m.attachments) if (a.content_id) cidMap[a.content_id.replace(/^<|>$/g, "")] = `/api/attachments/${a.id}?inline=1`;
  const useHtml = !!m.html_body && !(outbound && m.text_body);
  const safe = useHtml ? sanitizeEmailHtml(m.html_body as string, { cidMap }) : "";
  const safeImages = useHtml ? sanitizeEmailHtml(m.html_body as string, { cidMap, allowRemoteImages: true }) : "";
  const hasBlocked = useHtml && safe.includes("data-blocked-src");
  const downloadable = m.attachments.filter((a) => !a.content_id || !cidMap[a.content_id.replace(/^<|>$/g, "")]);

  return (
    <details open={defaultOpen} className="group overflow-hidden rounded-lg border border-line bg-surface shadow-(--shadow-panel)">
      <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3 hover:bg-surface-muted/60 [&::-webkit-details-marker]:hidden">
        <span
          className={cn(
            "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
            outbound ? "bg-accent-soft text-accent-ink" : "bg-ink text-white",
          )}
          aria-hidden
        >
          {initials(m.from_address)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="truncate text-sm font-semibold text-ink">
              {displayName(m.from_address)}
              {outbound && m.authorName ? <span className="ml-1.5 font-normal text-muted">sent by {m.authorName}</span> : null}
            </span>
            <time className="text-xs text-muted" dateTime={when}>
              {formatFullDate(when)}
            </time>
          </span>
          <span className="block truncate text-[13px] text-muted">
            to {to.map((r) => r.address).join(", ") || "—"}
            {cc.length ? ` · cc ${cc.map((r) => r.address).join(", ")}` : ""}
          </span>
          {outbound && (m.lifecycle_state === "submitted" || m.lifecycle_state === "failed") ? (
            <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {m.lifecycle_state === "submitted" ? <Badge tone="accent">Sent to provider</Badge> : null}
              {m.lifecycle_state === "failed" ? (
                <Badge tone="danger">
                  <AlertCircle className="size-3" aria-hidden /> Failed to send
                </Badge>
              ) : null}
            </span>
          ) : null}
        </span>
      </summary>

      <div className="border-t border-line px-4 py-4 md:px-5">
        {outbound && m.lifecycle_state === "failed" ? (
          <Alert
            tone="danger"
            title="This message couldn't be sent"
            className="mb-4"
            actions={
              canSend ? (
                <Link href={composeHref(slug, { mode: "resend", message: m.id, mailbox: mailboxId })} className={buttonClasses("secondary", "sm")}>
                  Edit &amp; resend
                </Link>
              ) : null
            }
          >
            {m.failure_reason ?? "The provider rejected it."} No quota was used.
          </Alert>
        ) : null}

        {outbound ? (
          <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
            {[...to, ...cc, ...bcc].map((r) => {
              const ui = deliveryUi[r.delivery_state];
              return (
                <span key={`${r.type}-${r.address}`} className="inline-flex items-center gap-1.5 text-ink-2">
                  <span className="text-muted">{r.type === "to" ? "" : `${r.type}: `}</span>
                  {r.address}
                  {ui ? <Badge tone={ui.tone}>{ui.label}</Badge> : null}
                </span>
              );
            })}
          </div>
        ) : null}

        {useHtml ? (
          <EmailBody safeHtml={safe} safeHtmlWithImages={safeImages} hasBlockedImages={hasBlocked} />
        ) : m.text_body ? (
          <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-2">{m.text_body}</div>
        ) : (
          <p className="text-sm italic text-muted">(This message has no content.)</p>
        )}

        {downloadable.length ? (
          <div className="mt-5 border-t border-line pt-4">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
              <Paperclip className="size-3.5" aria-hidden /> {downloadable.length} attachment{downloadable.length === 1 ? "" : "s"}
            </p>
            <ul className="flex flex-wrap gap-2">
              {downloadable.map((a) => (
                <li key={a.id}>
                  <a
                    href={`/api/attachments/${a.id}`}
                    className="flex items-center gap-2.5 rounded-md border border-line-strong bg-surface px-3 py-2 text-[13px] hover:bg-surface-muted"
                  >
                    <File className="size-4 text-muted" aria-hidden />
                    <span className="max-w-48 truncate font-medium text-ink">{a.filename}</span>
                    <span className="text-xs text-muted">{formatBytes(Number(a.size_bytes))}</span>
                    <Download className="size-3.5 text-muted" aria-hidden />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {canSend ? (
          <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
            <Link href={composeHref(slug, { mode: "reply", message: m.id, mailbox: mailboxId })} className={buttonClasses("secondary", "sm")}>
              <Reply className="size-4" aria-hidden /> Reply
            </Link>
            <Link href={composeHref(slug, { mode: "replyAll", message: m.id, mailbox: mailboxId })} className={buttonClasses("secondary", "sm")}>
              <ReplyAll className="size-4" aria-hidden /> Reply all
            </Link>
            <Link href={composeHref(slug, { mode: "forward", message: m.id, mailbox: mailboxId })} className={buttonClasses("secondary", "sm")}>
              <Forward className="size-4" aria-hidden /> Forward
            </Link>
          </div>
        ) : null}
      </div>
    </details>
  );
}
