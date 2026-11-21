// Where you were on the canvas: a session, where it sat on the screen, and the zoom. Kept by
// session rather than by coordinates, because sessions move as new ones arrive above them.
import type { Area } from "./scene";
import type { Cam } from "./Canvas";

export type Place = { session: string; sx: number; sy: number; k: number; at: number };
const KEY = "scout-canvas:place";

export function readPlace(): Place | null {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || "null");
    return p && typeof p.session === "string" && Number.isFinite(p.sx) && Number.isFinite(p.sy) && p.k > 0 ? p : null;
  } catch { return null; }
}

/** Remember the session nearest the upper middle of the view, and where it sits on screen. */
export function savePlace(cam: Cam, view: { w: number; h: number }, areas: Area[]) {
  const wx = (view.w / 2 - cam.x) / cam.k, wy = (view.h / 3 - cam.y) / cam.k;
  let best: Area | null = null, bestD = Infinity;
  for (const a of areas) {
    const dx = Math.max(a.box.x - wx, 0, wx - (a.box.x + a.box.w));
    const dy = Math.max(a.box.y - wy, 0, wy - (a.box.y + a.box.h));
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = a; }
  }
  if (!best) return;
  const p: Place = { session: best.session.id, sx: cam.x + best.box.x * cam.k, sy: cam.y + best.box.y * cam.k, k: cam.k, at: Date.now() };
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch {}
}
