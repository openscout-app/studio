import test from "node:test";
import assert from "node:assert/strict";
import { answer, TOOLS } from "./mcp.mjs";
import { VIEW_HTML, VIEW_MIME, VIEW_URI } from "./mcp-view.mjs";

const ask = (method, params, tools) => answer({ jsonrpc: "2.0", id: 1, method, params }, tools);

test("initialize offers tools and resources", async () => {
  const { result } = await ask("initialize", { protocolVersion: "2025-06-18" });
  assert.deepEqual(result.capabilities, { tools: {}, resources: {} });
  assert.equal(result.serverInfo.name, "scout-studio");
});

test("a notification gets no answer", async () => {
  assert.equal(await answer({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
});

test("screens and point carry the view; screen_image is for the view only", async () => {
  const { result } = await ask("tools/list");
  const by = Object.fromEntries(result.tools.map((t) => [t.name, t]));
  assert.equal(by.screens._meta.ui.resourceUri, VIEW_URI);
  assert.equal(by.point._meta.ui.resourceUri, VIEW_URI);
  assert.equal(by.pointers._meta, undefined);
  assert.deepEqual(by.screen_image._meta.ui.visibility, ["app"]);
  assert.ok(VIEW_URI.startsWith("ui://"));
  assert.equal(TOOLS.length, 4);
});

test("the view is listed and read as an MCP App page", async () => {
  const list = await ask("resources/list");
  assert.deepEqual(list.result.resources.map((r) => [r.uri, r.mimeType]), [[VIEW_URI, VIEW_MIME]]);
  assert.equal(VIEW_MIME, "text/html;profile=mcp-app");
  const read = await ask("resources/read", { uri: VIEW_URI });
  const [c] = read.result.contents;
  assert.equal(c.uri, VIEW_URI);
  assert.equal(c.mimeType, VIEW_MIME);
  assert.match(c.text, /^<!doctype html>/);
  const missing = await ask("resources/read", { uri: "ui://scout-studio/nope.html" });
  assert.equal(missing.error.code, -32002);
});

test("the view's script compiles and sets text, not HTML", () => {
  const script = VIEW_HTML.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script));
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(script, /"ui\/initialize"/);
  assert.match(script, /"ui\/notifications\/initialized"/);
});

test("tools/call passes the tool's result through, and a failure as isError", async () => {
  const ok = await ask("tools/call", { name: "screens", arguments: {} }, async (name) => ({ content: [{ type: "text", text: name }], structuredContent: { kind: "screens" } }));
  assert.deepEqual(ok.result, { content: [{ type: "text", text: "screens" }], structuredContent: { kind: "screens" } });
  const bad = await ask("tools/call", { name: "point", arguments: {} }, async () => { throw new Error("no screens yet"); });
  assert.equal(bad.result.isError, true);
  assert.equal(bad.result.content[0].text, "no screens yet");
});

test("screen_image refuses anything but a screen id and type", async () => {
  const r = await ask("tools/call", { name: "screen_image", arguments: { id: "../../etc/passwd", ext: "png" } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /screen id/);
});
