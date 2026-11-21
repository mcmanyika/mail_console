"use client";

import { useEffect } from "react";
import { markThreadReadAction } from "@/lib/actions/inbox";

/** Marks the open conversation read once it is on screen (rendering itself never mutates). */
export function MarkReadOnView({ slug, threadId, isRead }: { slug: string; threadId: string; isRead: boolean }) {
  useEffect(() => {
    if (isRead) return;
    const t = setTimeout(() => {
      void markThreadReadAction(slug, threadId).catch(() => undefined);
    }, 600);
    return () => clearTimeout(t);
  }, [slug, threadId, isRead]);
  return null;
}
