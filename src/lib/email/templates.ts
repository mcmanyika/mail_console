/**
 * Minimal, logic-less templates: `{{variable}}` placeholders only.
 *  - values are HTML-escaped in html bodies; inserted verbatim in subject/text;
 *  - a placeholder with no supplied value is an error (never sent as literal `{{x}}`);
 *  - CR/LF in subject values are rejected (header injection).
 */

export type TemplateVars = Record<string, string | number | boolean>;

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]{0,63})\s*\}\}/g;

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function templateVariableNames(source: string | null | undefined): string[] {
  if (!source) return [];
  return [...new Set([...source.matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

export function renderTemplateString(source: string, vars: TemplateVars, mode: "text" | "html" | "subject"): string {
  return source.replace(PLACEHOLDER, (_m, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      throw new TemplateError(`missing template variable: ${name}`);
    }
    const value = String(vars[name]);
    if (mode === "subject" && /[\r\n]/.test(value)) {
      throw new TemplateError(`variable ${name} may not contain line breaks in a subject`);
    }
    return mode === "html" ? escapeHtml(value) : value;
  });
}

export function renderTemplate(
  template: { subject: string; body_text: string | null; body_html: string | null },
  vars: TemplateVars,
): { subject: string; text: string | null; html: string | null } {
  return {
    subject: renderTemplateString(template.subject, vars, "subject"),
    text: template.body_text == null ? null : renderTemplateString(template.body_text, vars, "text"),
    html: template.body_html == null ? null : renderTemplateString(template.body_html, vars, "html"),
  };
}
