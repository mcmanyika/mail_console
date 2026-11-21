import type { Folder } from "@/lib/data/inbox";

export function inboxHref(
  slug: string,
  p: { folder?: Folder | string; mailbox?: string | null; thread?: string | null; q?: string | null; extra?: Record<string, string> },
): string {
  const qs = new URLSearchParams();
  if (p.folder && p.folder !== "inbox") qs.set("folder", p.folder);
  else qs.set("folder", "inbox");
  if (p.mailbox) qs.set("mailbox", p.mailbox);
  if (p.q) qs.set("q", p.q);
  if (p.thread) qs.set("thread", p.thread);
  for (const [k, v] of Object.entries(p.extra ?? {})) qs.set(k, v);
  return `/w/${slug}/inbox?${qs.toString()}`;
}

export function composeHref(
  slug: string,
  p: { mode?: string; message?: string; mailbox?: string | null; draft?: string },
): string {
  const qs = new URLSearchParams();
  if (p.mode) qs.set("mode", p.mode);
  if (p.message) qs.set("message", p.message);
  if (p.mailbox) qs.set("mailbox", p.mailbox);
  if (p.draft) qs.set("draft", p.draft);
  const s = qs.toString();
  return `/w/${slug}/compose${s ? `?${s}` : ""}`;
}
