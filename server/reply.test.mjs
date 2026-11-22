// What a session reads when the person replies to something it pointed at.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "scout-studio-test-"));
process.env.SCOUT_STUDIO_HOME = home;
const { message } = await import("./notes.mjs");
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const base = { id: "n_abc", screen: { hash: "aaaa111122223333", ext: "png", url: "http://localhost:3000/board", file: null }, x: 0.5, y: 0.25, text: "Yes, that total is wrong" };

test("a reply to a pointer says what it answers", () => {
  const m = message({ ...base, re: "p_123", reSay: "This total still reads 0 after the import" });
  assert.match(m, /A reply from Scout Studio to what you pointed at/);
  assert.match(m, /\[scout-studio:n_abc\]/, "the marker still finds the answer in the transcript");
  assert.match(m, /You said: This total still reads 0 after the import/);
  assert.match(m, /They answered: Yes, that total is wrong/);
});

test("a plain note reads as before", () => {
  const m = message(base);
  assert.match(m, /^A note from Scout Studio on a screen you took of http:\/\/localhost:3000\/board, at 50% across, 25% down \[scout-studio:n_abc\]/);
  assert.doesNotMatch(m, /You said/);
});
