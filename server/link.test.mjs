// Links an agent hands a person: which screen, which point, and what it says.
import test from "node:test";
import assert from "node:assert/strict";
import { pickScreen, pointOf, linkTo } from "./link.mjs";

const screens = [
  { hash: "aaaa111122223333", w: 1600, h: 1000, at: 3, url: "http://localhost:3000/board?x=1", file: null },
  { hash: "bbbb111122223333", w: 800, h: 600, at: 2, url: null, file: "/tmp/shots/after.png" },
  { hash: "cccc111122223333", w: 800, h: 600, at: 1, url: "http://localhost:3000/settings", file: null },
];

test("a screen is picked by latest, hash, page or file", () => {
  assert.equal(pickScreen(screens).hash, "aaaa111122223333");
  assert.equal(pickScreen(screens, "cccc").hash, "cccc111122223333");
  assert.equal(pickScreen(screens, "localhost:3000/settings").hash, "cccc111122223333");
  assert.equal(pickScreen(screens, "http://localhost:3000/board").hash, "aaaa111122223333");
  assert.equal(pickScreen(screens, "/tmp/shots/after.png").hash, "bbbb111122223333");
  assert.equal(pickScreen(screens, "nothing.png"), null);
  assert.equal(pickScreen([], "latest"), null);
});

test("a point is fractions as given, or pixels of the screen", () => {
  assert.deepEqual(pointOf("0.5,0.25", screens[0]), { x: 0.5, y: 0.25 });
  assert.deepEqual(pointOf("800, 250", screens[0]), { x: 0.5, y: 0.25 });
  assert.throws(() => pointOf("2000,10", screens[0]), /outside/);
  assert.throws(() => pointOf("left", screens[0]), /x,y/);
  assert.equal(pointOf(undefined, screens[0]), null);
});

test("the link carries the session, the screen, the point and the remark", () => {
  const url = linkTo("http://localhost:4801", { session: "s-1", screen: screens[0], point: { x: 0.5, y: 0.25 }, say: "This total is off & so is 50%" });
  assert.equal(url, "http://localhost:4801/#s/s-1/aaaa111122223333?at=0.5,0.25&say=This+total+is+off+%26+so+is+50%25");
  const q = new URLSearchParams(url.split("?")[1]);
  assert.equal(q.get("say"), "This total is off & so is 50%");
  assert.equal(linkTo("http://localhost:4801", { session: "s-1" }), "http://localhost:4801/#s/s-1");
});
