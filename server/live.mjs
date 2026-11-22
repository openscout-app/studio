// The canvas, pushed. A page opens /api/events and gets the whole canvas once, then again each time
// it changes: a transcript grew (macOS file events), the runtime showed a file (its own event
// stream), or the first read moved along. A push goes out only when something the page draws
// changed, and no more than about once a second while agents write.
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_PROJECTS } from "./paths.mjs";
import { canvas, touch } from "./sessions.mjs";
import { onShows } from "./runtime.mjs";

const WRITE_GAP = 800;   // a transcript is written many times a second while a session works
const READ_GAP = 450;    // while the first read is under way
const TICK = 10e3;       // open, closed, titles, attention: what no file event announces

const subs = new Map();  // hours -> Set of responses
const sent = new Map();  // hours -> the last canvas pushed, without its time
const changed = new Set();
let timer = null, busy = false, watcher = null, ticker = null, offShows = null;

const frame = (d) => `event: canvas\ndata: ${JSON.stringify(d)}\n\n`;
const key = ({ at, ...rest }) => JSON.stringify(rest);

/** GET /api/events?hours=N: an event stream of the canvas for that window. */
export async function events(req, res, hours) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
  res.write("retry: 2000\n\n");
  if (!subs.has(hours)) subs.set(hours, new Set());
  subs.get(hours).add(res);
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), 20e3);
  req.on("close", () => {
    clearInterval(keepalive);
    subs.get(hours)?.delete(res);
    if (![...subs.values()].some((s) => s.size)) stop();
  });
  start();
  const d = await canvas(hours);
  res.write(frame(d));
  if (!d.loading.done) soon(READ_GAP);
}

function soon(ms) { if (!timer) timer = setTimeout(flush, ms); }

async function flush() {
  timer = null;
  if (busy) return soon(WRITE_GAP);
  busy = true;
  let reading = false;
  try {
    const files = [...changed];
    changed.clear();
    for (const f of files) await touch(f);
    for (const [hours, set] of subs) {
      if (!set.size) continue;
      const d = await canvas(hours);
      if (!d.loading.done) reading = true;
      const k = key(d);
      if (k === sent.get(hours)) continue;
      sent.set(hours, k);
      const msg = frame(d);
      for (const res of set) res.write(msg);
    }
  } catch {} finally { busy = false; }
  if (reading) soon(READ_GAP);
}

function start() {
  if (ticker) return;
  try {
    watcher = fs.watch(CLAUDE_PROJECTS, { recursive: true }, (_, name) => {
      if (!name || !String(name).endsWith(".jsonl")) return;
      changed.add(path.join(CLAUDE_PROJECTS, String(name)));
      soon(WRITE_GAP);
    });
  } catch {}
  offShows = onShows(() => soon(50));
  ticker = setInterval(() => soon(0), TICK);
}

function stop() {
  watcher?.close(); watcher = null;
  offShows?.(); offShows = null;
  clearInterval(ticker); ticker = null;
  sent.clear();
}
