// Scout Studio as an MCP server, for the Claude Code session it runs under. Claude Code starts it
// with the session's id in CLAUDE_CODE_SESSION_ID, so every tool speaks for exactly that session.
//
// Tools:
//   screens   this session's recent screens, newest first, with the id to point at
//   point     show the person one spot or area on a screen, with what to say; returns a link
//   pointers  this session's pointers: whether the person opened each, and what they replied
//
// Plain JSON-RPC over stdio, one message per line; no dependencies.
import readline from "node:readline";
import { findSession } from "./link.mjs";
import { call, ensure } from "./local.mjs";

const VERSION = "0.1.0";

const TOOLS = [
  {
    name: "screens",
    description: "List the screenshots this session has taken, newest first, as Scout Studio shows them to the person. Each has an id to pass to `point`, its size in pixels, the page or file it shows, and what you said around it.",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "How many, newest first. Default 12." } } },
  },
  {
    name: "point",
    description: "Show the person one spot or area on a screenshot you took, with what you want to say about it. Returns a short link to give them; it opens Scout Studio on that screen with the spot marked and your words beside it, and they can reply there. Their reply comes back to this session as a message. Give x and y in pixels of the screenshot as you saw it (or unit \"fraction\"); add w and h to mark an area instead of a point.",
    inputSchema: {
      type: "object",
      required: ["x", "y", "say"],
      properties: {
        screen: { type: "string", description: "A screen id from `screens`, or \"latest\" (the default)." },
        x: { type: "number", description: "Left of the spot or area." },
        y: { type: "number", description: "Top of the spot or area." },
        w: { type: "number", description: "Width of the area. Leave out for a point." },
        h: { type: "number", description: "Height of the area. Leave out for a point." },
        unit: { type: "string", enum: ["px", "fraction"], description: "px (default): pixels of the screenshot. fraction: 0 to 1 of its width and height." },
        say: { type: "string", description: "What the person should know about this spot: one or two sentences." },
      },
    },
  },
  {
    name: "pointers",
    description: "List what this session has pointed the person at, newest first: the link, whether they opened it, and their replies.",
    inputSchema: { type: "object", properties: {} },
  },
];

const session = () => process.env.CLAUDE_CODE_SESSION_ID || findSession()?.id || null;

const when = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

async function run(name, args = {}) {
  const sid = session();
  if (!sid) throw new Error("no Claude Code session: CLAUDE_CODE_SESSION_ID isn't set and none was found in this folder");
  const base = await ensure();
  if (name === "screens") {
    const { screens } = await call(base, "GET", `/api/screens?session=${encodeURIComponent(sid)}&limit=${Number(args.limit) || 12}`);
    if (!screens.length) return "This session has no screenshots yet.";
    return screens.map((s, i) => [
      `${i + 1}. ${s.id}  ${s.w}×${s.h}  ${when(Date.parse(s.at))}${s.settled ? "" : " (this turn)"}`,
      `   ${s.page || s.file || s.tool}`,
      s.said ? `   you said: ${s.said.replace(/\s+/g, " ").slice(0, 120)}` : null,
    ].filter(Boolean).join("\n")).join("\n");
  }
  if (name === "point") {
    const { pointer: p, url } = await call(base, "POST", "/api/pointers", {
      session: sid, screen: args.screen || "latest", say: args.say,
      at: { x: args.x, y: args.y, w: args.w || 0, h: args.h || 0, unit: args.unit || "px" },
    });
    const what = p.box.w || p.box.h ? "an area" : "a point";
    return [
      url,
      "",
      `Give the person this link. It opens screen ${p.screen.hash} (${p.screen.w}×${p.screen.h}, ${p.screen.url || p.screen.file || p.screen.tool}) with ${what} marked at ${Math.round(p.box.x * 100)}% across, ${Math.round(p.box.y * 100)}% down, and your words beside it.`,
      "Their reply comes back to this session as a message; `pointers` shows whether they've opened it.",
    ].join("\n");
  }
  if (name === "pointers") {
    const { pointers } = await call(base, "GET", `/api/pointers?session=${encodeURIComponent(sid)}`);
    if (!pointers.length) return "Nothing pointed at yet.";
    return pointers.map((p) => [
      `${base}/p/${p.id}  ${when(p.at)}  ${p.seenAt ? `opened ${when(p.seenAt)}` : "not opened yet"}`,
      `   you said: ${p.say}`,
      ...p.replies.map((r) => `   they replied ${when(r.at)}: ${r.text}`),
    ].join("\n")).join("\n");
  }
  throw new Error(`no tool ${name}`);
}

const out = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

export function serveMcp() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id === undefined) return; // a notification
    try {
      if (m.method === "initialize") {
        return out({ id: m.id, result: {
          protocolVersion: m.params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "scout-studio", version: VERSION },
          instructions: "Scout Studio shows the person the screenshots this session took. To show them something precise, call `point` with the spot and what to say, and give them the link it returns, instead of describing where to look.",
        } });
      }
      if (m.method === "ping") return out({ id: m.id, result: {} });
      if (m.method === "tools/list") return out({ id: m.id, result: { tools: TOOLS } });
      if (m.method === "tools/call") {
        try {
          const text = await run(m.params?.name, m.params?.arguments);
          return out({ id: m.id, result: { content: [{ type: "text", text }] } });
        } catch (e) {
          return out({ id: m.id, result: { content: [{ type: "text", text: String(e.message || e) }], isError: true } });
        }
      }
      out({ id: m.id, error: { code: -32601, message: `no method ${m.method}` } });
    } catch (e) {
      out({ id: m.id, error: { code: -32603, message: String(e.message || e) } });
    }
  });
}
