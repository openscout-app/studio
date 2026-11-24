import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-hosts-"));
process.env.SCOUT_STUDIO_HOME = path.join(dir, "studio");
process.env.SCOUT_STUDIO_CLAUDE_PROJECTS = path.join(dir, "claude");
process.env.CODEX_HOME = path.join(dir, "codex");
process.env.SCOUT_RUNTIME_URL = "http://127.0.0.1:1";
const scout = path.join(dir, "scout");
process.env.SCOUT_BIN = scout;
fs.writeFileSync(scout, `#!/bin/sh
printf '%s\\n' "$@" > "$SCOUT_STUDIO_HOME/send-args"
echo '{"ok":true}'
`, { mode: 0o700 });
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.OPENSCOUT_SESSION_ID;
const { serve } = await import("./serve.mjs");
const server = await serve(0);
process.env.SCOUT_STUDIO_PORT = String(server.address().port);
const base = "http://localhost:" + server.address().port;
const { answer } = await import("./mcp.mjs");
const { call } = await import("./local.mjs");
const { callerSession } = await import("./shared-screens.mjs");
const { registerTools, registerFileHosts } = await import("./setup.mjs");
const image = fileURLToPath(new URL("../docs/studio-light.png", import.meta.url));
after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});
async function tool(name, args) {
  const { result } = await answer({ id: 1, method: "tools/call", params: { name, arguments: args } });
  assert.ok(!result.isError, result.content[0]?.text);
  return result.structuredContent;
}

test("Codex tool-result image appears on the canvas and materializes byte for byte", async () => {
  const id = randomUUID();
  const day = path.join(process.env.CODEX_HOME, "sessions/2026/10/01");
  fs.mkdirSync(day, { recursive: true });
  const timestamp = new Date().toISOString();
  const bytes = fs.readFileSync(image);
  const output = [{ type: "input_image", image_url: "data:image/png;base64," + bytes.toString("base64") }];
  const records = [
    ["session_meta", { id, cwd: dir }],
    ["response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Review the canvas" }] }],
    ["response_item", { type: "custom_tool_call", name: "browser_screenshot", call_id: "u" }],
    ["response_item", { type: "custom_tool_call_output", call_id: "u", output }],
    ["event_msg", { type: "task_complete" }],
  ];
  fs.writeFileSync(path.join(day, "rollout-example-" + id + ".jsonl"), records.map(([type, payload]) => JSON.stringify({ type, payload, timestamp })).join("\n") + "\n");
  const { screens } = await tool("screens", { session: id });
  assert.equal(screens.length, 1);
  assert.equal(screens[0].settled, true);
  const data = await call(base, "GET", "/api/canvas");
  assert.equal(data.projects.flatMap(p => p.sessions).find(s => s.id === id)?.harness, "codex");
  const got = await fetch(base + "/img/" + screens[0].id + ".png");
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes);
  const { note } = await call(base, "POST", "/api/notes", { session: id, harness: "codex", screen: { hash: screens[0].id }, text: "Check the header." });
  const sent = path.join(process.env.SCOUT_STUDIO_HOME, "send-args");
  for (let i = 0; !fs.existsSync(sent) && i < 30; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const args = fs.readFileSync(sent, "utf8");
  assert.ok(args.includes(id) && args.includes(note.id) && args.includes("--harness\ncodex"));
  const reply = [
    { role: "user", content: [{ type: "input_text", text: `[scout-studio:${note.id}] Check the header.` }] },
    { role: "assistant", content: [{ type: "output_text", text: "Header checked." }] },
  ].map(message => JSON.stringify({ type: "response_item", payload: { type: "message", ...message }, timestamp }));
  fs.appendFileSync(path.join(day, "rollout-example-" + id + ".jsonl"), reply.join("\n") + "\n");
  const stored = (await call(base, "GET", "/api/notes")).notes.find(n => n.id === note.id);
  assert.equal(stored.answers[0].text, "Header checked.");
});

test("two agents in the same directory get separate screens, pins and replies", async () => {
  const { session, screen } = await tool("share_screen", { file: image, harness: "antigravity" });
  const other = await tool("share_screen", { file: image, harness: "pi" });
  assert.notEqual(session, other.session);
  const pointer = await tool("point", { session, x: 10, y: 10, say: "Check this corner." });
  assert.equal(pointer.session, session);
  const { note } = await call(base, "POST", "/api/notes", { session, harness: "antigravity", screen: { hash: screen }, text: "Move this label.", re: pointer.pointer.id });
  assert.deepEqual((await tool("feedback", { session: other.session })).notes, []);
  await assert.rejects(call(base, "POST", "/api/feedback", { session: other.session, note: note.id, reply: "wrong session" }));
  const mine = await tool("feedback", { session });
  assert.equal(mine.notes[0].pointer, pointer.pointer.id);
  for (let i = 0; i < 2; i++) await tool("feedback", { session, note: note.id, reply: "Moved." });
  const saved = (await call(base, "GET", "/api/notes")).notes.find(n => n.id === note.id);
  assert.equal(saved.trail[0].what, "available");
  assert.ok(saved.arrivedAt);
  assert.deepEqual(saved.answers.map(a => a.text), ["Moved."]);
  assert.throws(() => callerSession(other.session, { CODEX_THREAD_ID: session }, "codex"));
  const projects = await call(base, "GET", "/api/canvas");
  assert.equal(projects.projects.flatMap(p => p.sessions).find(s => s.id === session)?.harness, "antigravity");
});

test("setup is idempotent and preserves existing registrations and plugins", async () => {
  const added = [];
  let agy = false;
  const exec = async (bin, args) => {
    if (bin === "grok" || bin === "hermes") return { missing: true };
    if (args[0] === "plugin") return { ok: true, out: '[{"id":"scout-studio@openscout","enabled":true}]' };
    if (bin === "claude") return { ok: false, error: "No MCP server named scout-studio" };
    if (bin === "codex") return { ok: true, out: '[{"name":"scout-studio","enabled":false}]' };
    if (args[1] === "list") return { ok: true, out: agy ? "scout-studio  stdio  enabled" : "NAME TYPE STATUS" };
    added.push([bin, ...args]); agy = true; return { ok: true };
  };
  for (let i = 0; i < 2; i++) await registerTools(["node", "studio", "mcp"], { exec, log() {} });
  assert.equal(added.length, 1);
  assert.deepEqual(added[0].slice(-2), ["--host", "antigravity"]);
  await registerTools(["node", "studio", "mcp"], { print: true, exec: assert.fail, log() {} });
});

test("Cursor registration preserves other servers and user settings on repeated launch", async () => {
  const home = path.join(dir, "first-run");
  const cfg = path.join(home, ".cursor/mcp.json");
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { existing: { command: "old" } }, other: true }));
  const opts = { home, env: {}, log() {}, exec: async () => ({ missing: true }) };
  const run = ["node", "studio", "mcp"];
  await registerFileHosts(run, opts);
  const written = fs.readFileSync(cfg, "utf8");
  const config = JSON.parse(written);
  assert.deepEqual(config.mcpServers.existing, { command: "old" });
  assert.equal(config.other, true);
  assert.deepEqual(config.mcpServers["scout-studio"].args, ["studio", "mcp", "--host", "cursor"]);
  await registerFileHosts(run, opts);
  assert.equal(fs.readFileSync(cfg, "utf8"), written);
  fs.writeFileSync(cfg, "// user-managed JSONC");
  await registerFileHosts(run, opts);
  assert.equal(fs.readFileSync(cfg, "utf8"), "// user-managed JSONC");
});
