import { describe, expect, it } from "vitest";

// sanitize-html@2.18 (CJS) require()s htmlparser2@12 (ESM-only). That only works on
// Node >= 20.19 / 22.12 (require(esm)); inside Next's bundler it always works.
// On older Node the suite is skipped rather than failing for an environmental reason.
const mod = await import("./sanitize").catch(() => null);
const { htmlToText, makeSnippet, sanitizeEmailHtml, textToHtml } = mod ?? ({} as NonNullable<typeof mod>);
const d = describe.skipIf(!mod);

d("sanitizeEmailHtml", () => {
  it("strips scripts, handlers, iframes, forms and javascript: links", () => {
    const out = sanitizeEmailHtml(
      `<p onclick="x()">Hi</p><script>alert(1)</script><iframe src="https://evil.example"></iframe>` +
        `<form action="/x"><input name="a"></form><a href="javascript:alert(1)">bad</a><style>*{display:none}</style>`,
    );
    expect(out).not.toMatch(/script|onclick|iframe|<form|<input|javascript:|<style|alert/i);
    expect(out).toContain("<p>Hi</p>");
  });

  it("hardens links", () => {
    const out = sanitizeEmailHtml('<a href="https://ok.example">ok</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain("noopener");
    expect(out).toContain("noreferrer");
  });

  it("blocks remote images by default and keeps them when allowed", () => {
    const html = '<img src="https://track.example/p.gif" alt="x">';
    const blocked = sanitizeEmailHtml(html);
    expect(blocked).not.toMatch(/\ssrc="https?:/);
    expect(blocked).toContain("data-blocked-src");
    expect(sanitizeEmailHtml(html, { allowRemoteImages: true })).toContain('src="https://track.example/p.gif"');
  });

  it("maps cid images and drops unknown ones", () => {
    const html = '<img src="cid:logo123"><img src="cid:other">';
    const out = sanitizeEmailHtml(html, { cidMap: { logo123: "/api/att/1" } });
    expect(out).toContain('src="/api/att/1"');
    expect(out).not.toContain("cid:");
  });

  it("filters unsafe inline styles", () => {
    const out = sanitizeEmailHtml('<p style="color:#ff0000; position:fixed; background:url(javascript:x)">x</p>');
    expect(out).toContain("color:#ff0000");
    expect(out).not.toMatch(/position|url\(/);
  });
});

d("text helpers", () => {
  it("converts html to text", () => {
    expect(htmlToText("<p>Hello&nbsp;<b>there</b></p><p>Bye</p><script>x()</script>")).toBe("Hello there\nBye");
  });
  it("makes one-line snippets", () => {
    expect(makeSnippet({ text: "a\n\n b   c" })).toBe("a b c");
    expect(makeSnippet({ html: "<p>" + "x".repeat(300) + "</p>" }, 20)).toHaveLength(20);
  });
  it("escapes text into html", () => {
    expect(textToHtml('<b>"&')).toContain("&lt;b&gt;&quot;&amp;");
  });
});
