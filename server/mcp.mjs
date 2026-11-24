// Local Studio tools over stdio. The host ID or an explicit share handle identifies the session.
// `screens` and `point` also carry a view (an MCP App, ./mcp-view.mjs). A host that draws MCP Apps
// shows it under the tool call; every other host reads the same text it always did.
//
// Plain JSON-RPC over stdio, one message per line; no dependencies.
import readline from "node:readline";
import { callerSession, shareScreen } from "./shared-screens.mjs";
import { call, ensure } from "./local.mjs";
import { VIEW_HTML, VIEW_MIME, VIEW_URI } from "./mcp-view.mjs";

const VERSION = "0.2.0";
const EXTS = ["png", "jpg", "webp", "gif"];
const view = { ui: { resourceUri: VIEW_URI } };

const sessionInput = { type: "string", description: "This conversation's native ID or the handle returned by share_screen." };
export const TOOLS = [
  {
    name: "share_screen",
    description: "Share a local screenshot. Keep the returned session handle for later shares, pointers and feedback in this conversation.",
    inputSchema: { type: "object", required: ["file"], properties: {
      file: { type: "string", description: "Absolute path to the screenshot." }, caption: { type: "string" },
      harness: { type: "string", description: "Name of your harness if the server was registered manually." }, session: sessionInput } },
  },
  {
    name: "feedback",
    description: "Read this session's pinned notes, or answer one with its note ID and a reply.",
    inputSchema: { type: "object", properties: { session: sessionInput, note: { type: "string" }, reply: { type: "string" } } },
  },
  {
    name: "screens",
    description: "List the screenshots this session has taken, newest first, as Scout Studio shows them to the person. Each has an id to pass to `point`, its size in pixels, the page or file it shows, and what you said around it.",
    inputSchema: { type: "object", properties: { session: sessionInput, limit: { type: "number", description: "How many, newest first. Default 12." } } },
    annotations: { readOnlyHint: true },
    _meta: view,
  },
  {
    name: "point",
    description: "Show the person one spot or area on a screenshot you took, with what you want to say about it. Returns a short link to give them; it opens Scout Studio on that screen with the spot marked and your words beside it, and they can reply there. Use feedback to read their reply. Give x and y in pixels of the screenshot as you saw it (or unit \"fraction\"); add w and h to mark an area instead of a point.",
    inputSchema: {
      type: "object",
      required: ["x", "y", "say"],
      properties: {
        session: sessionInput,
        screen: { type: "string", description: "A screen id from `screens`, or \"latest\" (the default)." },
        x: { type: "number", description: "Left of the spot or area." },
        y: { type: "number", description: "Top of the spot or area." },
        w: { type: "number", description: "Width of the area. Leave out for a point." },
        h: { type: "number", description: "Height of the area. Leave out for a point." },
        unit: { type: "string", enum: ["px", "fraction"], description: "px (default): pixels of the screenshot. fraction: 0 to 1 of its width and height." },
        say: { type: "string", description: "What the person should know about this spot: one or two sentences." },
      },
    },
    _meta: view,
  },
  {
    name: "pointers",
    description: "List what this session has pointed the person at, newest first: the link, whether they opened it, and their replies.",
    inputSchema: { type: "object", properties: { session: sessionInput } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "screen_image",
    description: "One of this session's screens as a JPEG, for Scout Studio's view in the thread. Use `screens` to find screens.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "A screen id from `screens`." },
        ext: { type: "string", enum: ["png", "jpg", "webp", "gif"], description: "The screen's file type, as `screens` gives it, if it does." },
        size: { type: "string", enum: ["t", "m"], description: "t: card-sized (520 px). m: 1600 px, the default." },
      },
    },
    annotations: { readOnlyHint: true },
    _meta: { ui: { visibility: ["app"] } },
  },
];

export const RESOURCES = [
  { uri: VIEW_URI, name: "Scout Studio view", description: "This session's screens, or one screen with a spot marked.", mimeType: VIEW_MIME },
];

const hostArg = process.argv.indexOf("--host");
const configuredHost = hostArg >= 0 ? process.argv[hostArg + 1] : undefined;

const when = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

const text = (t, structuredContent) => ({ content: [{ type: "text", text: t }], ...(structuredContent ? { structuredContent } : {}) });

async function run(name, args = {}) {
  if (name === "screen_image") {
    if (!/^[0-9a-f]{16}$/.test(String(args.id)) || (args.ext !== undefined && !EXTS.includes(args.ext))) throw new Error("screen_image needs a screen id from `screens`");
    const base = await ensure();
    const size = args.size === "t" ? "t" : "m";
    const get = (p, ext) => fetch(`${base}/img/${p}${args.id}.${ext}`, { signal: AbortSignal.timeout(30e3) });
    // A Scout Studio from before this view gives no file type and has no 1600 px size: try each
    // type, and fall back to the whole screen.
    let res;
    for (const ext of args.ext ? [args.ext] : EXTS) {
      res = await get(`${size}/`, ext);
      if (res.status === 404 && size === "m") res = await get("", ext);
      if (res.status !== 404) break;
    }
    if (!res.ok) throw new Error(res.status === 404 ? "Scout Studio has no such screen" : `Scout Studio answered ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer()).toString("base64");
    return { content: [{ type: "image", data, mimeType: res.headers.get("content-type") || "image/jpeg" }] };
  }
  const host = configuredHost || args.harness || (process.env.CODEX_THREAD_ID ? "codex" : process.env.CLAUDE_CODE_SESSION_ID ? "claude" : "");
  const sid = callerSession(args.session, process.env, host);
  if (name === "share_screen") {
    const receipt = shareScreen({ file: args.file, caption: args.caption, session: sid, host: host || "agent" });
    return text(JSON.stringify(receipt), receipt);
  }
  if (!sid) throw Error("Pass this conversation's session ID, or use share_screen first and keep its returned handle.");
  const base = await ensure();
  if (name === "feedback") {
    const data = await call(base, "POST", "/api/feedback", { session: sid, note: args.note, reply: args.reply });
    return text(JSON.stringify(data.notes), data);
  }
  if (name === "screens") {
    const { screens } = await call(base, "GET", `/api/screens?session=${encodeURIComponent(sid)}&limit=${Number(args.limit) || 12}`);
    const typed = screens.map((s) => ({ ...s, ext: s.ext || EXTS.find((e) => s.file?.toLowerCase().endsWith(`.${e}`)) }));
    const data = { kind: "screens", base, session: sid, screens: typed };
    if (!screens.length) return text("This session has no screenshots yet.", data);
    return text(screens.map((s, i) => [
      `${i + 1}. ${s.id}  ${s.w}×${s.h}  ${when(Date.parse(s.at))}${s.settled ? "" : " (this turn)"}`,
      `   ${s.page || s.file || s.tool}`,
      s.said ? `   you said: ${s.said.replace(/\s+/g, " ").slice(0, 120)}` : null,
    ].filter(Boolean).join("\n")).join("\n"), data);
  }
  if (name === "point") {
    const { pointer: p, url } = await call(base, "POST", "/api/pointers", {
      session: sid, screen: args.screen || "latest", say: args.say,
      at: { x: args.x, y: args.y, w: args.w || 0, h: args.h || 0, unit: args.unit || "px" },
    });
    const what = p.box.w || p.box.h ? "an area" : "a point";
    return text([
      url,
      "",
      `Give the person this link. It opens screen ${p.screen.hash} (${p.screen.w}×${p.screen.h}, ${p.screen.url || p.screen.file || p.screen.tool}) with ${what} marked at ${Math.round(p.box.x * 100)}% across, ${Math.round(p.box.y * 100)}% down, and your words beside it.`,
      "Use feedback to read their reply, or pointers to see whether they opened the link.",
    ].join("\n"), {
      kind: "pointer", base, session: sid, url,
      pointer: { id: p.id, box: p.box, say: p.say, screen: { hash: p.screen.hash, ext: p.screen.ext, w: p.screen.w, h: p.screen.h, url: p.screen.url, file: p.screen.file, tool: p.screen.tool } },
    });
  }
  if (name === "pointers") {
    const { pointers } = await call(base, "GET", `/api/pointers?session=${encodeURIComponent(sid)}`);
    if (!pointers.length) return text("Nothing pointed at yet.");
    return text(pointers.map((p) => [
      `${base}/p/${p.id}  ${when(p.at)}  ${p.seenAt ? `opened ${when(p.seenAt)}` : "not opened yet"}`,
      `   you said: ${p.say}`,
      ...p.replies.map((r) => `   they replied ${when(r.at)}: ${r.text}`),
    ].join("\n")).join("\n"));
  }
  throw new Error(`no tool ${name}`);
}

/** The answer to one JSON-RPC request (an object to send), or undefined for a notification. */
export async function answer(m, tools = run) {
  if (!m || m.id === undefined) return undefined;
  try {
    if (m.method === "initialize") {
      return { id: m.id, result: {
        protocolVersion: m.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "scout-studio", version: VERSION },
        instructions: "Scout Studio shows the person the screenshots this session took. To show them something precise, call `point` with the spot and what to say, and give them the link it returns, instead of describing where to look.",
      } };
    }
    if (m.method === "ping") return { id: m.id, result: {} };
    if (m.method === "tools/list") return { id: m.id, result: { tools: TOOLS } };
    if (m.method === "resources/list") return { id: m.id, result: { resources: RESOURCES } };
    if (m.method === "resources/templates/list") return { id: m.id, result: { resourceTemplates: [] } };
    if (m.method === "resources/read") {
      if (m.params?.uri !== VIEW_URI) return { id: m.id, error: { code: -32002, message: `no resource ${m.params?.uri}` } };
      return { id: m.id, result: { contents: [{ uri: VIEW_URI, mimeType: VIEW_MIME, text: VIEW_HTML, _meta: { ui: { prefersBorder: true } } }] } };
    }
    if (m.method === "tools/call") {
      try {
        return { id: m.id, result: await tools(m.params?.name, m.params?.arguments) };
      } catch (e) {
        return { id: m.id, result: { content: [{ type: "text", text: String(e.message || e) }], isError: true } };
      }
    }
    return { id: m.id, error: { code: -32601, message: `no method ${m.method}` } };
  } catch (e) {
    return { id: m.id, error: { code: -32603, message: String(e.message || e) } };
  }
}

const out = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

export function serveMcp() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    const reply = await answer(m);
    if (reply) out(reply);
  });
}
