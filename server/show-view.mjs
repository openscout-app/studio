// A shown file, made into something the reader can frame. Everything here is an agent's file, so
// every page is served sandboxed: it gets an origin of its own, so it can't call Studio's API or
// send notes. Markdown and text are drawn here with scripts off; an HTML page keeps its scripts
// but nothing else.
import { marked } from "marked";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** The frontmatter a plan carries (title, status, blurb), and the text after it. */
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv && kv[2]) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body: text.slice(m[0].length) };
}

const READER = `
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --line: #e4e4e7; --code: #f4f4f5; --accent: #b4690e; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8e8ea; --muted: #9a9aa0; --line: #2e2e33; --code: #1c1c20; --accent: #e0a458; } }
html { background: transparent; }
body { margin: 0; padding: 40px 32px 80px; color: var(--fg); font: 16px/1.62 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; }
main { max-width: 1040px; margin: 0 auto; }
.meta { color: var(--muted); font-size: 13px; margin: 0 0 28px; }
.meta span + span::before { content: " · "; }
h1 { font-size: 30px; line-height: 1.2; font-weight: 600; margin: 0 0 8px; }
h2 { font-size: 21px; font-weight: 600; margin: 36px 0 10px; }
h3 { font-size: 17px; font-weight: 600; margin: 28px 0 8px; }
p, ul, ol, table, pre, blockquote { margin: 0 0 16px; }
a { color: var(--accent); }
code { font: 13.5px/1.5 ui-monospace, "SF Mono", Menlo, monospace; background: var(--code); padding: 1px 4px; border-radius: 4px; }
pre { background: var(--code); padding: 14px 16px; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; font-size: 14.5px; }
th, td { border-bottom: 1px solid var(--line); padding: 7px 10px; text-align: left; vertical-align: top; }
th { font-weight: 600; }
blockquote { margin-left: 0; padding-left: 14px; border-left: 2px solid var(--line); color: var(--muted); }
hr { border: 0; border-top: 1px solid var(--line); margin: 28px 0; }
img { max-width: 100%; }
pre.text { white-space: pre-wrap; word-break: break-word; }
`;

const page = (title, inner) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${READER}</style></head><body><main>${inner}</main></body></html>`;

/** CSP for a page drawn here: no scripts, nothing fetched but inline styles and data images. */
const DRAWN = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
/** CSP for an agent's own HTML: its scripts run, in an origin of its own. */
const SANDBOXED = "sandbox allow-scripts allow-popups; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'";
const INLINE = /^(?:image\/(?:png|jpeg|gif|webp)|video\/(?:mp4|webm|quicktime))$/;

/** What to send for a show: status, headers and body. */
export function viewResponse(show, bytes) {
  const base = {
    "cache-control": show.local ? "no-store" : "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  };
  const where = show.sourcePath.replace(/^\/Users\/[^/]+/, "~");
  const meta = (extra = []) => `<p class="meta">${[...extra, where, new Date(show.createdAt).toLocaleString()].map((x) => `<span>${esc(x)}</span>`).join("")}</p>`;
  const view = show.view;
  if ((view === "image" || view === "video") && INLINE.test(show.mediaType)) {
    return { status: 200, headers: { ...base, "content-type": show.mediaType, "content-security-policy": "sandbox; default-src 'none'" }, body: bytes };
  }
  if (view === "markdown") {
    const { meta: fm, body } = frontmatter(bytes.toString("utf8"));
    const hasH1 = /^#\s/m.test(body.slice(0, 400));
    const title = fm.title || (/^#\s+(.+)$/m.exec(body)?.[1]) || show.name;
    let html = marked.parse(body, { gfm: true, async: false });
    const line = meta([fm.status].filter(Boolean));
    // the file's own title stays on top, with where it came from just under it
    if (hasH1 && !fm.title) html = html.replace(/<\/h1>/, `</h1>${line}`);
    else html = `<h1>${esc(title)}</h1>${line}${html}`;
    return { status: 200, headers: { ...base, "content-type": "text/html; charset=utf-8", "content-security-policy": DRAWN }, body: page(title, html) };
  }
  if (view === "html") {
    return { status: 200, headers: { ...base, "content-type": "text/html; charset=utf-8", "content-security-policy": SANDBOXED }, body: bytes };
  }
  if (view === "pdf") {
    return { status: 200, headers: { ...base, "content-type": "application/pdf", "content-disposition": "inline" }, body: bytes };
  }
  if (view === "text") {
    let text = bytes.toString("utf8");
    if (/json/.test(show.mediaType)) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {} }
    return { status: 200, headers: { ...base, "content-type": "text/html; charset=utf-8", "content-security-policy": DRAWN }, body: page(show.name, `<h1>${esc(show.name)}</h1>${meta()}<pre class="text">${esc(text)}</pre>`) };
  }
  return { status: 200, headers: { ...base, "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${show.name.replace(/"/g, "")}"` }, body: bytes };
}
