// An image stays in its transcript until it's first shown, and comes out exactly as it went in.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "scout-canvas-test-"));
process.env.SCOUT_CANVAS_HOME = home;
const { readTranscript, screensOf, materialize } = await import("./transcripts.mjs");
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

/** A real PNG of w×h, so the size is read from its header. */
function png(w, h) {
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const rows = Buffer.alloc((w + 1) * h);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

test("an image is written out only when asked for, byte for byte", async () => {
  const img = png(800, 500);
  const file = path.join(home, "t.jsonl");
  const at = new Date().toISOString();
  const lines = [
    { type: "user", timestamp: at, cwd: "/tmp/x", message: { content: "look at the page" } },
    { type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id: "u1", name: "browser_screenshot", input: {} }] } },
    { type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "u1", content: [
      { type: "text", text: '{"url":"http://localhost:3000/a"}' },
      { type: "image", source: { type: "base64", media_type: "image/png", data: img.toString("base64") } },
    ] }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const s = await readTranscript(file, "s1");
  const [sc] = screensOf(s);
  assert.equal(sc.w, 800);
  assert.equal(sc.h, 500);
  const out = path.join(home, "img", `${sc.hash}.png`);
  assert.equal(fs.existsSync(out), false, "nothing is copied while reading");
  assert.equal(materialize(sc.hash, "png"), out);
  assert.deepEqual(fs.readFileSync(out), img);
});
