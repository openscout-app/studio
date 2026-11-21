import { test } from "node:test";
import assert from "node:assert/strict";
import { sameShape, subjectOf, plain } from "./transcripts.mjs";
import { imageSize } from "./image-size.mjs";

test("a page is its address, without the query", () => {
  assert.equal(subjectOf("mcp__lattices__browser_screenshot", {}, '{"ok":true,"url":"http://127.0.0.1:43122/terminal?x=1"}'), "page:127.0.0.1:43122/terminal");
});

test("a window is its window id", () => {
  assert.equal(subjectOf("mcp__lattices__host_screenshot", { wid: 12652 }), "window:12652");
});

test("files pair by name less a trailing count or before/after", () => {
  const a = subjectOf("Read", { file_path: "/tmp/x/board-1.png" });
  assert.equal(a, subjectOf("Read", { file_path: "/tmp/x/board-2.png" }));
  assert.equal(a, subjectOf("Read", { file_path: "/tmp/x/board-after.png" }));
  assert.notEqual(subjectOf("Read", { file_path: "/tmp/x/board-live.png" }), subjectOf("Read", { file_path: "/tmp/x/sessions-fixed.png" }));
  assert.notEqual(a, subjectOf("Read", { file_path: "/tmp/y/board-1.png" }));
});

test("a screen nothing names follows nothing", () => {
  assert.equal(subjectOf("mcp__lattices__host_screenshot", {}), null);
  assert.equal(subjectOf("Read", { file_path: "/tmp/notes.md" }), null);
});

test("only screens of about the same shape are laid over each other", () => {
  assert.ok(sameShape({ w: 2560, h: 1080 }, { w: 2560, h: 1100 }));
  assert.ok(!sameShape({ w: 2576, h: 1100 }, { w: 1440, h: 900 }));
});

test("image sizes come from the header", () => {
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(1280, 16);
  png.writeUInt32BE(720, 20);
  assert.deepEqual(imageSize(png), { w: 1280, h: 720 });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x02, 0xd0, 0x05, 0x00, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpg), { w: 1280, h: 720 });
  assert.equal(imageSize(Buffer.from("not an image at all, no")), null);
});

test("prompts read without their wrapper tags", () => {
  assert.equal(plain('<pasted_content id="69ca"> New broker ask </pasted_content>'), "New broker ask");
  assert.equal(plain("<system-reminder>hidden</system-reminder>Fix the header"), "Fix the header");
});
