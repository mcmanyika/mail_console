import sanitizeHtml from "sanitize-html";

/**
 * Inbound HTML is hostile. We sanitise ON READ/STORE and still render inside a
 * sandboxed container; never `dangerouslySetInnerHTML` unsanitised provider HTML.
 */

export type SanitizeOptions = {
  /**
   * Remote images are blocked by default (tracking pixels / IP leaks). When
   * false, `<img src="https://…">` is replaced by an inert placeholder that
   * keeps the URL in `data-blocked-src` so the UI can offer "load images".
   */
  allowRemoteImages?: boolean;
  /**
   * Map of Content-ID (without `cid:` and angle brackets) -> URL to serve it
   * from (e.g. a signed attachment URL). Unmapped cid images are dropped.
   */
  cidMap?: Record<string, string>;
};

const ALLOWED_TAGS = [
  "a", "abbr", "address", "b", "blockquote", "br", "caption", "cite", "code", "col", "colgroup",
  "dd", "del", "div", "dl", "dt", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img",
  "ins", "li", "mark", "ol", "p", "pre", "q", "s", "small", "span", "strike", "strong", "sub",
  "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul", "font", "center",
];

const SAFE_STYLES = {
  "*": {
    color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s,.%]+\)$/i, /^[a-z]+$/i],
    "background-color": [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s,.%]+\)$/i, /^[a-z]+$/i],
    "text-align": [/^(left|right|center|justify)$/],
    "font-weight": [/^(normal|bold|[1-9]00)$/],
    "font-style": [/^(normal|italic)$/],
    "text-decoration": [/^(none|underline|line-through)$/],
    "font-size": [/^\d+(\.\d+)?(px|pt|em|rem|%)$/],
    "font-family": [/^[\w\s,"'-]+$/],
    "line-height": [/^\d+(\.\d+)?(px|pt|em|rem|%)?$/],
    "margin": [/^[\d\s.a-z%-]+$/],
    "padding": [/^[\d\s.a-z%-]+$/],
    "width": [/^\d+(\.\d+)?(px|%)$/],
    "max-width": [/^\d+(\.\d+)?(px|%)$/],
    "height": [/^\d+(\.\d+)?(px|%)$/],
  },
};

const REMOTE_PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

function normalizeCid(src: string): string {
  return src.replace(/^cid:/i, "").replace(/^<|>$/g, "").trim();
}

export function sanitizeEmailHtml(html: string, options: SanitizeOptions = {}): string {
  const { allowRemoteImages = false, cidMap = {} } = options;

  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href", "title", "name", "target", "rel"],
      img: ["src", "alt", "title", "width", "height", "data-blocked-src"],
      td: ["colspan", "rowspan", "align", "valign", "width"],
      th: ["colspan", "rowspan", "align", "valign", "width", "scope"],
      table: ["width", "align", "border", "cellpadding", "cellspacing"],
      font: ["color", "size", "face"],
      "*": ["style", "dir", "lang"],
    },
    allowedStyles: SAFE_STYLES,
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https", "data", "cid"] },
    allowProtocolRelative: false,
    // Drop the *content* of dangerous elements too, not just the tags.
    disallowedTagsMode: "discard",
    nonTextTags: ["script", "style", "textarea", "option", "noscript", "iframe", "object", "embed", "svg", "math", "template"],
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer nofollow ugc" },
      }),
      img: (tagName, attribs) => {
        const src = attribs.src ?? "";
        if (/^cid:/i.test(src)) {
          const mapped = cidMap[normalizeCid(src)];
          if (!mapped) return { tagName: "span", attribs: {}, text: attribs.alt ? `[${attribs.alt}]` : "" };
          return { tagName, attribs: { ...attribs, src: mapped } };
        }
        if (/^data:image\/(png|gif|jpe?g|webp);base64,/i.test(src)) return { tagName, attribs };
        if (/^https?:\/\//i.test(src)) {
          if (allowRemoteImages) return { tagName, attribs };
          const { src: blocked, ...rest } = attribs;
          return { tagName, attribs: { ...rest, src: REMOTE_PLACEHOLDER, "data-blocked-src": blocked } };
        }
        return { tagName: "span", attribs: {}, text: "" };
      },
    },
    exclusiveFilter: (frame) => {
      // Remove empty anchors that only existed to carry tracking hrefs.
      return frame.tag === "a" && !frame.text.trim() && !frame.mediaChildren.length;
    },
  });
}

/** Plain text rendering of (already-safe or untrusted) HTML; used for snippets and text fallbacks. */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "• ");
  const stripped = sanitizeHtml(withBreaks, {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: ["script", "style", "textarea", "option", "noscript", "head", "title"],
  });
  return decodeBasicEntities(stripped)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** One-line preview for inbox lists (stored in messages.snippet). */
export function makeSnippet(source: { text?: string | null; html?: string | null }, maxLength = 160): string {
  const text = source.text?.trim() ? source.text : source.html ? htmlToText(source.html) : "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 1).trimEnd()}…` : oneLine;
}

/** Minimal HTML body for outbound mail composed as plain text (escapes everything). */
export function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<div style="white-space:pre-wrap">${escaped}</div>`;
}
