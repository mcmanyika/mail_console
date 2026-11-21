"use client";

import { ImageIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

function buildDoc(html: string, allowImages: boolean) {
  const imgSrc = allowImages ? "'self' data: https: http:" : "'self' data:";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src 'none'">
<base target="_blank">
<style>
  html,body{margin:0;padding:0}
  body{font:14px/1.6 "IBM Plex Sans",system-ui,sans-serif;color:#1E293B;overflow-wrap:anywhere}
  img{max-width:100%;height:auto}
  a{color:#4F46E5}
  p{margin:0 0 .85em}
  blockquote{margin:.5em 0 .5em .25em;padding-left:1em;border-left:3px solid #E2E8F0;color:#64748B}
  table{max-width:100%}
  pre{white-space:pre-wrap}
</style></head><body>${html}</body></html>`;
}

/**
 * Renders already-sanitised email HTML inside a sandboxed iframe (no scripts,
 * CSP blocks everything but inline styles + images). Remote images are blocked
 * until the reader opts in. `allow-same-origin` is only used to measure height;
 * with scripts disabled nothing inside can touch the parent.
 */
export function EmailBody({
  safeHtml,
  safeHtmlWithImages,
  hasBlockedImages,
}: {
  safeHtml: string;
  safeHtmlWithImages: string;
  hasBlockedImages: boolean;
}) {
  const [showImages, setShowImages] = useState(false);
  const [height, setHeight] = useState(120);
  const ref = useRef<HTMLIFrameElement>(null);

  const measure = useCallback(() => {
    const doc = ref.current?.contentDocument;
    if (doc?.documentElement) setHeight(Math.max(60, doc.documentElement.scrollHeight + 4));
  }, []);

  return (
    <div>
      {hasBlockedImages && !showImages ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface-muted px-3 py-2 text-[13px] text-muted">
          <span className="inline-flex items-center gap-2">
            <ImageIcon className="size-4" aria-hidden /> Remote images are hidden to protect your privacy.
          </span>
          <button type="button" onClick={() => setShowImages(true)} className="font-medium text-accent hover:underline">
            Load images
          </button>
        </div>
      ) : null}
      <iframe
        ref={ref}
        title="Message content"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={buildDoc(showImages ? safeHtmlWithImages : safeHtml, showImages)}
        onLoad={measure}
        style={{ height }}
        className="block w-full border-0"
      />
    </div>
  );
}
