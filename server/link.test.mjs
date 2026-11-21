// Which screen an agent means, and where on it.
import test from "node:test";
import assert from "node:assert/strict";
import { pickScreen } from "./link.mjs";
import { boxOf } from "./pointers.mjs";

const screens = [
  { hash: "aaaa111122223333", w: 1600, h: 1000, at: 3, url: "http://localhost:3000/board?x=1", file: null },
  { hash: "bbbb111122223333", w: 800, h: 600, at: 2, url: null, file: "/tmp/shots/after.png" },
  { hash: "cccc111122223333", w: 800, h: 600, at: 1, url: "http://localhost:3000/settings", file: null },
];

test("a screen is picked by latest, id, page or file", () => {
  assert.equal(pickScreen(screens).hash, "aaaa111122223333");
  assert.equal(pickScreen(screens, "cccc111122223333").hash, "cccc111122223333");
  assert.equal(pickScreen(screens, "cccc").hash, "cccc111122223333");
  assert.equal(pickScreen(screens, "localhost:3000/settings").hash, "cccc111122223333");
  assert.equal(pickScreen(screens, "/tmp/shots/after.png").hash, "bbbb111122223333");
  assert.equal(pickScreen(screens, "nothing.png"), null);
  assert.equal(pickScreen([], "latest"), null);
});

test("a spot is pixels of the screen unless it says fractions", () => {
  const s = screens[0];
  assert.deepEqual(boxOf({ x: 800, y: 250 }, s), { x: 0.5, y: 0.25, w: 0, h: 0 });
  assert.deepEqual(boxOf({ x: 1, y: 1 }, s), { x: 0.0006, y: 0.001, w: 0, h: 0 }, "1,1 is a pixel, not the corner");
  assert.deepEqual(boxOf({ x: 0.5, y: 0.25, w: 0.1, h: 0.2, unit: "fraction" }, s), { x: 0.5, y: 0.25, w: 0.1, h: 0.2 });
  assert.deepEqual(boxOf({ x: 400, y: 100, w: 800, h: 500 }, s), { x: 0.25, y: 0.1, w: 0.5, h: 0.5 });
  assert.throws(() => boxOf({ x: 2000, y: 10 }, s), /outside the screen, which is 1600×1000/);
  assert.throws(() => boxOf({ x: 1500, y: 10, w: 300, h: 10 }, s), /outside/);
  assert.throws(() => boxOf({ x: "left", y: 1 }, s), /numbers/);
  assert.throws(() => boxOf({ x: 1, y: 1, unit: "em" }, s), /unit/);
});
