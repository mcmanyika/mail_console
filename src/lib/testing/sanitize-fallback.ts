/**
 * Test double for `@/lib/email/sanitize`, used ONLY when the real module cannot
 * be loaded: sanitize-html@2 (CJS) needs `require(esm)` (Node >= 20.19 / 22.12),
 * which older Node versions lack. Under Node 22 the real sanitizer runs.
 *
 * Deliberately simple/regex-based; real sanitisation behaviour is covered by
 * sanitize.test.ts on supported Node versions.
 */
const PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

export const sanitizeEmailHtml = (html: string, opts: { allowRemoteImages?: boolean } = {}): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<(iframe|style|object|embed)[\s\S]*?<\/\1>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/href="javascript:[^"]*"/gi, "")
    .replace(/<img([^>]*?)src="(https?:\/\/[^"]+)"([^>]*)>/gi, (m, a, src, b) =>
      opts.allowRemoteImages ? m : `<img${a}src="${PLACEHOLDER}" data-blocked-src="${src}"${b}>`,
    );

export const htmlToText = (html: string): string =>
  html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export const makeSnippet = (s: { text?: string | null; html?: string | null }, max = 160): string => {
  const t = (s.text?.trim() ? s.text : s.html ? htmlToText(s.html) : "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export const textToHtml = (text: string): string =>
  `<div style="white-space:pre-wrap">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`;
