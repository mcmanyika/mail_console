"use client";

import { File, Paperclip, Save, Send, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useActionState, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form-controls";
import { plainTextToEditorHtml, RichTextEditor } from "@/components/ui/rich-text-editor";
import { SubmitButton } from "@/components/ui/submit-button";
import { composeAction } from "@/lib/actions/compose";
import { discardDraftAction } from "@/lib/actions/inbox";
import { idleState } from "@/lib/actions/state";
import type { ComposeInit } from "@/lib/data/compose";
import { formatBytes } from "@/lib/format";
import { ComposeAiAssist } from "./compose-ai";

type AttachmentMeta = { id: string; filename: string; size: number };

export function ComposeForm({ init, backHref }: { init: ComposeInit; backHref: string }) {
  const [state, formAction] = useActionState(composeAction, idleState);
  const [subject, setSubject] = useState(init.subject);
  const [body, setBody] = useState(init.body);
  const [bodyHtml, setBodyHtml] = useState(init.bodyHtml?.trim() || plainTextToEditorHtml(init.body));
  const [showCc, setShowCc] = useState(!!init.cc);
  const [showBcc, setShowBcc] = useState(!!init.bcc);
  const [files, setFiles] = useState<File[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [fileKey, setFileKey] = useState(0);
  const [syncedSavedAt, setSyncedSavedAt] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const draftId = (typeof state.data?.draftId === "string" ? state.data.draftId : null) ?? init.draftId;
  const savedAtRaw = typeof state.data?.savedAt === "string" ? state.data.savedAt : null;
  const serverAttachments = Array.isArray(state.data?.attachments)
    ? (state.data.attachments as unknown as AttachmentMeta[])
    : null;
  const attachments = (serverAttachments ?? init.attachments).filter((a) => !removed.has(a.id));
  const fe = state.fieldErrors ?? {};

  // After a successful draft save the server returns the canonical attachment list.
  // Adjust local file state during render when the save stamp changes (React-recommended).
  if (state.status === "success" && savedAtRaw && serverAttachments && savedAtRaw !== syncedSavedAt) {
    setSyncedSavedAt(savedAtRaw);
    setFiles([]);
    setRemoved(new Set());
    setFileKey((k) => k + 1);
  }

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const t = init.templates.find((x) => x.id === id);
    if (!t) return;
    setSubject(t.subject);
    setBody((prev) => {
      const next = prev.trim() ? `${t.body}\n\n${prev}` : t.body;
      setBodyHtml(plainTextToEditorHtml(next));
      return next;
    });
  };

  const applyBody = (text: string) => {
    setBody(text);
    setBodyHtml(plainTextToEditorHtml(text));
  };

  const isReply = init.mode === "reply" || init.mode === "replyAll";

  return (
    <form action={formAction} className="flex min-h-0 flex-1 flex-col">
      <input type="hidden" name="slug" value={init.slug} />
      <input type="hidden" name="mode" value={init.mode === "draft" ? "new" : init.mode} />
      {init.parentId ? <input type="hidden" name="parentId" value={init.parentId} /> : null}
      {draftId ? <input type="hidden" name="draftId" value={draftId} /> : null}
      {[...removed].map((id) => (
        <input key={id} type="hidden" name="removeAttachment" value={id} />
      ))}

      <div className="scroll-quiet min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5 md:px-6">
        {state.status === "error" && state.message ? <Alert tone="danger">{state.message}</Alert> : null}
        {!init.workspaceActive ? (
          <Alert tone="warn" title="Sending is paused">
            This workspace is suspended. You can still save drafts.
          </Alert>
        ) : null}

        <Field label="From" htmlFor="mailboxId" error={fe.mailboxId} hint={init.lockMailbox ? "Replies stay in the mailbox that holds the conversation." : undefined}>
          {init.lockMailbox ? <input type="hidden" name="mailboxId" value={init.mailboxId} /> : null}
          <Select id="mailboxId" name={init.lockMailbox ? undefined : "mailboxId"} defaultValue={init.mailboxId} disabled={init.lockMailbox}>
            {init.sendMailboxes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="To" htmlFor="to" error={fe.to} hint="Separate multiple addresses with commas.">
          <div className="flex gap-2">
            <Input id="to" name="to" defaultValue={init.to} placeholder="name@example.com" autoComplete="off" spellCheck={false} />
            {!showCc || !showBcc ? (
              <div className="flex shrink-0 gap-1 text-[13px]">
                {!showCc ? (
                  <button type="button" onClick={() => setShowCc(true)} className="rounded-md px-2 text-accent hover:bg-accent-soft">
                    Cc
                  </button>
                ) : null}
                {!showBcc ? (
                  <button type="button" onClick={() => setShowBcc(true)} className="rounded-md px-2 text-accent hover:bg-accent-soft">
                    Bcc
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </Field>
        {showCc ? (
          <Field label="Cc" htmlFor="cc" error={fe.cc}>
            <Input id="cc" name="cc" defaultValue={init.cc} placeholder="name@example.com" spellCheck={false} />
          </Field>
        ) : null}
        {showBcc ? (
          <Field label="Bcc" htmlFor="bcc" error={fe.bcc} hint="Bcc recipients count toward your monthly limit.">
            <Input id="bcc" name="bcc" defaultValue={init.bcc} placeholder="name@example.com" spellCheck={false} />
          </Field>
        ) : null}

        <Field label="Subject" htmlFor="subject" error={fe.subject}>
          <Input id="subject" name="subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} />
        </Field>

        {init.templates.length ? (
          <div className="flex items-center gap-2 text-[13px]">
            <label htmlFor="template" className="text-muted">
              Insert template
            </label>
            <Select id="template" value={templateId} onChange={(e) => applyTemplate(e.target.value)} className="h-8 w-64 text-[13px]">
              <option value="">Choose…</option>
              {init.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}

        {init.aiEnabled ? (
          <ComposeAiAssist
            slug={init.slug}
            threadId={init.threadId}
            subject={subject}
            body={body}
            onApply={applyBody}
          />
        ) : null}

        <Field label="Message" htmlFor="body" error={fe.body}>
          <RichTextEditor
            id="body"
            name="body"
            htmlName="bodyHtml"
            value={bodyHtml}
            onChange={(plain, html) => {
              setBody(plain);
              setBodyHtml(html);
            }}
            placeholder="Write your message…"
          />
        </Field>

        {/* attachments */}
        <div className="space-y-3 rounded-md border border-line bg-surface-muted/50 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
              <Paperclip className="size-4 text-muted" aria-hidden /> Attachments
            </p>
            <label className={buttonClasses("secondary", "sm", "cursor-pointer")}>
              Add files
              <input
                key={fileKey}
                ref={fileInput}
                type="file"
                name="files"
                multiple
                className="sr-only"
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
            </label>
          </div>

          {init.forwardable.length && !draftId ? (
            <fieldset className="space-y-1.5">
              <legend className="mb-1 text-xs font-medium text-muted">Include from the original message</legend>
              {init.forwardable.map((a) => (
                <label key={a.id} className="flex items-center gap-2.5 rounded-md border border-line bg-surface px-3 py-2 text-[13px]">
                  <input type="checkbox" name="forwardAttachment" value={a.id} defaultChecked className="size-4 accent-[#4F46E5]" />
                  <File className="size-4 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{a.filename}</span>
                  <span className="text-xs text-muted">{formatBytes(a.size)}</span>
                </label>
              ))}
            </fieldset>
          ) : null}

          {attachments.length ? (
            <ul className="space-y-1.5">
              {attachments.map((a) => (
                <li key={a.id} className="flex items-center gap-2.5 rounded-md border border-line bg-surface px-3 py-2 text-[13px]">
                  <File className="size-4 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{a.filename}</span>
                  <span className="text-xs text-muted">{formatBytes(a.size)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${a.filename}`}
                    onClick={() => setRemoved((s) => new Set(s).add(a.id))}
                    className="rounded p-1 text-muted hover:bg-danger-soft hover:text-danger"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {files.length ? (
            <ul className="space-y-1.5">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="flex items-center gap-2.5 rounded-md border border-dashed border-accent/40 bg-accent-soft/40 px-3 py-2 text-[13px]">
                  <File className="size-4 text-accent" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <span className="text-xs text-muted">{formatBytes(f.size)} · uploads on save/send</span>
                </li>
              ))}
            </ul>
          ) : null}
          {!attachments.length && !files.length && !(init.forwardable.length && !draftId) ? (
            <p className="text-xs text-muted">No files attached. Up to 25 MB total.</p>
          ) : null}
        </div>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-surface px-5 py-3 md:px-6">
        <SubmitButton name="intent" value="send" pendingLabel="Sending…" className="min-w-24">
          <Send className="size-4" aria-hidden /> Send
        </SubmitButton>
        <SubmitButton name="intent" value="draft" variant="secondary" pendingLabel="Saving…">
          <Save className="size-4" aria-hidden /> Save draft
        </SubmitButton>
        <Link href={backHref} className={buttonClasses("ghost")}>
          Close
        </Link>
        <span className="ml-auto text-xs text-muted" aria-live="polite">
          {state.status === "success" && savedAtRaw ? `Draft saved at ${new Date(savedAtRaw).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : isReply ? "Threaded as a reply" : ""}
        </span>
        {draftId ? (
          <button
            type="submit"
            formAction={discardDraftAction.bind(null, init.slug, draftId)}
            formNoValidate
            className={buttonClasses("danger-ghost", "md")}
          >
            <Trash2 className="size-4" aria-hidden /> Discard
          </button>
        ) : null}
      </footer>
    </form>
  );
}
