/**
 * Sanitiser for previewing archived email HTML. Defence in depth — the preview is also
 * served with a CSP that forbids scripts and inside an <iframe sandbox> without
 * allow-scripts, so archived JavaScript can never execute even if this misses something.
 * The ORIGINAL content is stored untouched; only the preview is sanitised.
 */
export function sanitizeArchivedHtml(html: string, opts: { allowRemoteImages: boolean; archivedImages?: Map<string, string> }): { html: string; removed: Record<string, number> } {
  const removed: Record<string, number> = {};
  const count = (k: string, n = 1) => (removed[k] = (removed[k] ?? 0) + n);
  let s = html;
  const strip = (re: RegExp, key: string, replacement = "") => {
    s = s.replace(re, () => {
      count(key);
      return replacement;
    });
  };
  strip(/<script\b[\s\S]*?<\/script\s*>/gi, "script");
  strip(/<script\b[^>]*\/?>/gi, "script");
  strip(/<(iframe|frame|frameset|object|embed|applet|portal)\b[\s\S]*?(<\/\1\s*>|\/?>)/gi, "embedded_frame");
  strip(/<(base|link)\b[^>]*>/gi, "base_or_link");
  strip(/<meta\b[^>]*http-equiv[^>]*>/gi, "meta_refresh");
  strip(/<form\b[^>]*>/gi, "form");
  strip(/<\/form\s*>/gi, "form_end");
  strip(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "event_handler");
  strip(/(href|src|action|formaction|xlink:href)\s*=\s*(["']?)\s*(javascript|vbscript|data:text\/html)[^"'\s>]*\2/gi, "script_url", 'data-removed-url=""');
  strip(/expression\s*\(/gi, "css_expression", "removed(");
  if (opts.archivedImages?.size) {
    // Swap remote image URLs for the copies held in the archive (inlined as data: URIs).
    const archived = opts.archivedImages;
    s = s.replace(/(<img\b[^>]*?\ssrc\s*=\s*)(["'])(https?:[^"']*)\2/gi, (m, pre: string, q: string, url: string) => {
      const hit = archived.get(url.replace(/^http:/i, "https:").replace(/&amp;/g, "&"));
      if (!hit) return m;
      count("archived_image_used");
      return `${pre}${q}${hit}${q} data-archived-src=${q}${url.replace(/"/g, "&quot;")}${q}`;
    });
  }
  if (!opts.allowRemoteImages) {
    s = s.replace(/(<img\b[^>]*?\ssrc\s*=\s*)(["'])(https?:[^"']*)\2/gi, (_m, pre: string, q: string, url: string) => {
      count("remote_image_blocked");
      return `${pre}${q}data:image/gif;base64,R0lGODlhAQABAAAAACw=${q} data-archived-src=${q}${url.replace(/"/g, "&quot;")}${q}`;
    });
    s = s.replace(/url\(\s*(['"]?)(https?:[^)'"]+)\1\s*\)/gi, () => {
      count("remote_css_url_blocked");
      return "none";
    });
  }
  return { html: s, removed };
}

export function previewCsp(allowRemoteImages: boolean) {
  return ["default-src 'none'", "style-src 'unsafe-inline'", `img-src data:${allowRemoteImages ? " https:" : ""}`, "font-src data:", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'", "sandbox"].join("; ");
}
