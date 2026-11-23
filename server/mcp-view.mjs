// The view Scout Studio's tools show in an agent's thread, as an MCP App (the MCP Apps standard,
// github.com/modelcontextprotocol/ext-apps). A host that supports it (T3 Code, Claude, ChatGPT,
// VS Code) draws this page under the tool call; any other host shows the tool's text as before.
//
// One page serves both tools. It reads the tool result's structuredContent:
//   { kind: "screens", base, session, screens: [...] }   a grid of the session's screens
//   { kind: "pointer", base, session, url, pointer }      one screen with the spot marked
// Images come through the server's `screen_image` tool, not from localhost, so the page works in
// hosts that frame it on another origin. Everything the page says is set as text, never as HTML.

export const VIEW_URI = "ui://scout-studio/view.html";
export const VIEW_MIME = "text/html;profile=mcp-app";

export const VIEW_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scout Studio</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: var(--color-background-primary, Canvas);
    --bg2: var(--color-background-secondary, color-mix(in srgb, CanvasText 4%, Canvas));
    --fg: var(--color-text-primary, CanvasText);
    --fg2: var(--color-text-secondary, color-mix(in srgb, CanvasText 60%, Canvas));
    --line: var(--color-border-primary, color-mix(in srgb, CanvasText 12%, Canvas));
    --accent: var(--color-ring-primary, #3b82f6);
    --radius: var(--border-radius-md, 8px);
    --sans: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    --mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.45 var(--sans); }
  html { overflow: hidden; } /* the host sizes the frame to the page; a scrollbar would only eat width */
  body { padding: 12px; }
  button, textarea { font: inherit; color: inherit; }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
  .title { font-weight: 500; }
  .quiet { color: var(--fg2); }
  .link { background: none; border: 0; padding: 0; color: var(--fg2); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; text-decoration-thickness: 1px; }
  .link:hover { color: var(--fg); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
  .card { display: block; width: 100%; text-align: left; padding: 0; background: var(--bg2); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; cursor: pointer; }
  .card:hover { border-color: color-mix(in srgb, var(--fg) 30%, transparent); }
  .shot { display: block; width: 100%; aspect-ratio: 16 / 10; object-fit: cover; object-position: top; background: var(--bg); border-bottom: 1px solid var(--line); }
  .meta { padding: 6px 8px 8px; }
  .where { font: 11px/1.4 var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .said { font-size: 12px; color: var(--fg2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-top: 2px; }
  .stage { position: relative; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; background: var(--bg2); }
  .stage img { display: block; width: 100%; height: auto; }
  .mark { position: absolute; border: 2px solid var(--accent); border-radius: 4px; box-shadow: 0 0 0 9999px color-mix(in srgb, #000 18%, transparent); pointer-events: none; }
  .mark.dot { width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%; }
  .say { margin: 10px 0 0; font-size: 14px; }
  form { display: flex; gap: 8px; margin-top: 10px; align-items: flex-end; }
  textarea { flex: 1; min-height: 34px; max-height: 120px; resize: vertical; padding: 7px 9px; background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); }
  textarea:focus { outline: none; border-color: var(--accent); }
  .send { padding: 7px 14px; background: var(--fg); color: var(--bg); border: 0; border-radius: var(--radius); cursor: pointer; }
  .send:disabled { opacity: .4; cursor: default; }
  .empty { padding: 20px 4px; color: var(--fg2); }
</style>
</head>
<body>
<div id="root"><div class="empty">Waiting for Scout Studio.</div></div>
<script>
(() => {
  const root = document.getElementById("root");
  let nextId = 1;
  const waiting = new Map();
  const post = (m) => window.parent.postMessage({ jsonrpc: "2.0", ...m }, "*");
  const request = (method, params) => new Promise((ok, no) => {
    const id = nextId++;
    waiting.set(id, { ok, no });
    post({ id, method, params });
  });
  const notify = (method, params) => post({ method, params });

  function applyContext(ctx) {
    if (!ctx) return;
    if (ctx.theme) document.documentElement.style.colorScheme = ctx.theme;
    const vars = ctx.styles && ctx.styles.variables;
    if (vars) for (const [k, v] of Object.entries(vars)) if (k.startsWith("--") && v) document.documentElement.style.setProperty(k, v);
  }

  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const kid of kids) if (kid) n.append(kid);
    return n;
  };
  const open = (url) => request("ui/open-link", { url }).catch(() => {});
  const HOME = new RegExp("^/(?:Users|home)/[^/]+(?=/)"); // a string, not a /literal/: this page lives in a template literal
  const where = (x) => (x.page || x.url || x.file || x.tool || "").replace(HOME, "~");
  const ago = (iso) => {
    const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " d ago";
  };

  async function load(img, id, ext, size) {
    try {
      const r = await request("tools/call", { name: "screen_image", arguments: { id, ext, size } });
      const part = (r.content || []).find((c) => c.type === "image");
      if (!part) throw new Error(((r.content || [])[0] || {}).text || "no image");
      img.src = "data:" + part.mimeType + ";base64," + part.data;
    } catch (e) {
      img.alt = "This screen isn't available: " + (e.message || e);
    }
  }

  function screens(d) {
    const list = d.screens || [];
    root.replaceChildren(
      el("div", { class: "head" },
        el("span", { class: "title", text: list.length === 1 ? "1 screen from this session" : list.length + " screens from this session" }),
        el("button", { class: "link", text: "Open Scout Studio", onclick: () => open(d.base + "/#s/" + d.session) })),
      list.length ? el("div", { class: "grid" }, ...list.map((s) => {
        const img = el("img", { class: "shot", alt: where(s) || "screen" });
        load(img, s.id, s.ext, "t");
        return el("button", { class: "card", title: "Open this screen in Scout Studio", onclick: () => open(d.base + "/#s/" + d.session + "/" + s.id) },
          img,
          el("div", { class: "meta" },
            el("div", { class: "where", text: where(s) }),
            el("div", { class: "quiet", text: ago(s.at) + (s.settled ? "" : ", this turn") }),
            s.said ? el("div", { class: "said", text: s.said }) : null));
      })) : el("div", { class: "empty", text: "This session has no screenshots yet." }));
  }

  function pointer(d) {
    const p = d.pointer, b = p.box, sc = p.screen;
    const img = el("img", { alt: where(sc) || "screen" });
    const mark = el("div", { class: b.w || b.h ? "mark" : "mark dot" });
    mark.style.left = b.x * 100 + "%";
    mark.style.top = b.y * 100 + "%";
    if (b.w || b.h) { mark.style.width = b.w * 100 + "%"; mark.style.height = b.h * 100 + "%"; }
    load(img, sc.hash, sc.ext, "m");
    const box = el("textarea", { placeholder: "Reply about this spot", rows: "1" });
    const send = el("button", { class: "send", type: "submit", text: "Send" });
    const sent = el("div", { class: "quiet" });
    const form = el("form", { onsubmit: async (e) => {
      e.preventDefault();
      const text = box.value.trim();
      if (!text) return;
      send.disabled = true;
      try {
        await request("ui/message", { role: "user", content: [{ type: "text", text: "About the spot you showed me (" + d.url + "): " + text }] });
        box.value = "";
        sent.textContent = "Sent to the thread.";
      } catch (err) {
        sent.textContent = "Not sent: " + (err.message || err);
      } finally { send.disabled = false; }
    } }, box, send);
    root.replaceChildren(
      el("div", { class: "head" },
        el("span", { class: "where quiet", text: where(sc) }),
        el("button", { class: "link", text: "Open in Scout Studio", onclick: () => open(d.url) })),
      el("div", { class: "stage" }, img, mark),
      p.say ? el("p", { class: "say", text: p.say }) : null,
      form, sent);
  }

  function result(r) {
    const d = r && r.structuredContent;
    if (r && r.isError) { root.replaceChildren(el("div", { class: "empty", text: ((r.content || [])[0] || {}).text || "Scout Studio couldn't do that." })); return; }
    if (!d) return;
    if (d.kind === "screens") screens(d);
    else if (d.kind === "pointer") pointer(d);
  }

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && !m.method) {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      m.error ? w.no(new Error(m.error.message)) : w.ok(m.result);
      return;
    }
    if (m.method === "ui/notifications/tool-result") result(m.params);
    else if (m.method === "ui/notifications/host-context-changed") applyContext(m.params);
    else if (m.id !== undefined) post({ id: m.id, result: {} }); // ping and anything else asked of us
  });

  // The body's own height: the document's scrollHeight never drops below the frame the host gave us.
  new ResizeObserver(() => notify("ui/notifications/size-changed", { height: Math.ceil(document.body.getBoundingClientRect().height) })).observe(document.body);

  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "scout-studio", version: "0.1.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
  }).then((r) => { applyContext(r && r.hostContext); notify("ui/notifications/initialized", {}); });
})();
</script>
</body>
</html>`;
