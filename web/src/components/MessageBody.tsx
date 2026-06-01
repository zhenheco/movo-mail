/**
 * Renders an email body. HTML is sanitized with browser DOMPurify before it is
 * injected via dangerouslySetInnerHTML. If there is no HTML, the plain-text
 * body is shown in a wrapping <pre> instead.
 */

import { useMemo } from "react";
import DOMPurify from "dompurify";
import type { Config } from "dompurify";

/**
 * Hardened DOMPurify config: no scripts, no inline handlers, safe links.
 * `RETURN_DOM*: false` selects the string-returning behavior.
 */
const SANITIZE_CONFIG: Config = {
  FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input"],
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "style"],
  ALLOW_DATA_ATTR: false,
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
};

/**
 * Pure sanitizer, exported for unit testing. Returns a safe HTML string with
 * all script/event-handler vectors removed. Empty input → "".
 *
 * `sanitize` is typed to return `TrustedHTML | string` depending on config; with
 * RETURN_DOM disabled it is always a string. We coerce to `string` explicitly so
 * the value is safe to assign to `dangerouslySetInnerHTML`.
 */
export function sanitizeEmailHtml(html: string | null | undefined): string {
  if (!html || html.trim() === "") {
    return "";
  }
  return String(DOMPurify.sanitize(html, SANITIZE_CONFIG));
}

export interface MessageBodyProps {
  html: string | null;
  text: string | null;
}

export function MessageBody({ html, text }: MessageBodyProps) {
  const safeHtml = useMemo(() => sanitizeEmailHtml(html), [html]);

  if (safeHtml.length > 0) {
    return (
      <div
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: safeHtml }}
        className="email-html max-w-none break-words text-sm leading-relaxed"
      />
    );
  }

  const fallback = text?.trim() ?? "";
  if (fallback.length === 0) {
    return (
      <p className="text-sm italic text-muted-foreground">
        (This message has no displayable content.)
      </p>
    );
  }

  return (
    <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
      {fallback}
    </pre>
  );
}
