// The canvas: repositories as frames, sessions as areas, screens as cards. Drag or scroll to move,
// pinch or hold ⌘ and scroll to zoom. Only the cards in view are drawn.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ago, thumb, type Note, type Screen } from "./api";
import { CARD_W, MEDIA_H, type Area, type Box, type Frame } from "./scene";
import { savePlace } from "./place";
import { HarnessCoin } from "./Harness";

export type Cam = { x: number; y: number; k: number };
const K_MIN = 0.1, K_MAX = 2;
const clampK = (k: number) => Math.min(K_MAX, Math.max(K_MIN, k));
/** where a landing puts the top of what it lands on: below the controls floating over the canvas */
const TOP = 60;

/** Where a point on a card's cropped picture falls on the whole screen, as fractions. */
export function cardPoint(s: Screen, px: number, py: number) {
  const k = Math.max(CARD_W / s.w, MEDIA_H / s.h);
  const left = (CARD_W - s.w * k) / 2;
  return { x: Math.min(1, Math.max(0, (px - left) / (s.w * k))), y: Math.min(1, Math.max(0, py / (s.h * k))) };
}
function cardPinStyle(s: Screen, n: Note) {
  const k = Math.max(CARD_W / s.w, MEDIA_H / s.h);
  const left = (CARD_W - s.w * k) / 2 + n.x * s.w * k, top = n.y * s.h * k;
  if (left < 0 || left > CARD_W || top > MEDIA_H) return null;
  return { left, top };
}

export function Working() {
  return <span className="working" aria-label="working"><i /><i /><i /></span>;
}

type Props = {
  frames: Frame[]; bounds: Box; notes: Note[];
  /**
   * Where to land when the canvas first shows: the latest session to glide in on, or, with `at`,
   * the session you were on, put back exactly where it sat on screen.
   */
  focus: { box: Box; at?: { sx: number; sy: number; k: number } } | null;
  onOpen: (area: Area, s: Screen, at?: { x: number; y: number }) => void;
  onMore: (sessionId: string) => void; opened: Set<string>;
};

const still = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** When each thing was first drawn, so only new arrivals fade in, not cards scrolled back into view. */
const seen = new Map<string, number>();

export function Canvas({ frames, bounds, notes, focus, onOpen, onMore, opened }: Props) {
  const view = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1200, h: 800 });
  const [cam, setCam] = useState<Cam | null>(null);
  const glide = useRef(0);
  const [panning, setPanning] = useState(false);
  const moved = useRef(false);

  useLayoutEffect(() => {
    const el = view.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  /** Ease the camera to a place, unless the viewer prefers no motion. */
  const moveTo = (to: Cam, from?: Cam) => {
    cancelAnimationFrame(glide.current);
    const a = from || cam;
    if (!a || still()) return setCam(to);
    const t0 = performance.now(), ms = 620;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - p, 3);
      setCam({ x: a.x + (to.x - a.x) * e, y: a.y + (to.y - a.y) * e, k: a.k + (to.k - a.k) * e });
      if (p < 1) glide.current = requestAnimationFrame(step);
    };
    glide.current = requestAnimationFrame(step);
  };
  const fitCam = (): Cam => {
    const k = clampK(Math.min((size.w - 40) / bounds.w, 1));
    return { x: (size.w - bounds.w * k) / 2, y: TOP, k };
  };
  const fit = () => moveTo(fitCam());
  // land: back where you were, or on the latest session, readable, gliding in from a little further out
  useEffect(() => {
    if (cam || size.w < 100 || bounds.w <= 0) return;
    if (!focus) return setCam(fitCam());
    const b = focus.box;
    if (focus.at) {
      const k = clampK(focus.at.k);
      return setCam({ k, x: focus.at.sx - b.x * k, y: focus.at.sy - b.y * k });
    }
    const k = clampK(Math.min(1, (size.w - 96) / b.w));
    const to = { k, x: (size.w - b.w * k) / 2 - b.x * k, y: TOP - b.y * k };
    const from = { k: k * 0.86, x: (size.w - b.w * k * 0.86) / 2 - b.x * k * 0.86, y: TOP + 24 - b.y * k * 0.86 };
    setCam(from);
    moveTo(to, from);
  }, [focus, size.w, bounds.w]);
  // remember where you are, a moment after you stop moving
  const areas = useMemo(() => frames.flatMap((f) => f.areas), [frames]);
  useEffect(() => {
    if (!cam) return;
    const t = setTimeout(() => savePlace(cam, size, areas), 400);
    return () => clearTimeout(t);
  }, [cam, size, areas]);
  useEffect(() => () => cancelAnimationFrame(glide.current), []);

  // wheel: scroll pans, pinch (or ⌘/ctrl) zooms around the pointer
  useEffect(() => {
    const el = view.current!;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest(".stage")) return;
      e.preventDefault();
      cancelAnimationFrame(glide.current);
      setCam((c) => {
        if (!c) return c;
        if (e.ctrlKey || e.metaKey) {
          const r = el.getBoundingClientRect();
          const px = e.clientX - r.left, py = e.clientY - r.top;
          const k = clampK(c.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)));
          return { k, x: px - ((px - c.x) / c.k) * k, y: py - ((py - c.y) / c.k) * k };
        }
        return { ...c, x: c.x - e.deltaX, y: c.y - e.deltaY };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    cancelAnimationFrame(glide.current);
    const start = { x: e.clientX, y: e.clientY, cam: cam! };
    moved.current = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!moved.current && Math.hypot(dx, dy) < 4) return;
      moved.current = true;
      setPanning(true);
      setCam({ ...start.cam, x: start.cam.x + dx, y: start.cam.y + dy });
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); setPanning(false); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const zoomBy = (f: number) => {
    if (!cam) return;
    const k = clampK(cam.k * f), px = size.w / 2, py = size.h / 2;
    moveTo({ k, x: px - ((px - cam.x) / cam.k) * k, y: py - ((py - cam.y) / cam.k) * k });
  };

  const byScreen = useMemo(() => {
    const m = new Map<string, Note[]>();
    for (const n of notes) {
      const key = `${n.session}:${n.screen.hash}`;
      m.set(key, [...(m.get(key) || []), n]);
    }
    return m;
  }, [notes]);

  // each session at work shows its cursor on the screen it took last
  const working = useMemo(() => areas.filter((a) => a.session.working && a.cards.length).map((a) => {
    const b = a.cards[0].box;
    return { area: a, at: { x: b.x + b.w - 40, y: b.y + MEDIA_TIP } };
  }), [areas]);

  if (!cam) return <div className="viewport" ref={view} />;
  const margin = 400 / cam.k;
  const vis = { x: -cam.x / cam.k - margin, y: -cam.y / cam.k - margin, w: size.w / cam.k + 2 * margin, h: size.h / cam.k + 2 * margin };
  const inView = (b: Box) => b.x < vis.x + vis.w && b.x + b.w > vis.x && b.y < vis.y + vis.h && b.y + b.h > vis.y;
  const style = { "--k": cam.k, "--gx": `${cam.x}px`, "--gy": `${cam.y}px` } as React.CSSProperties;

  return (
    <div className={`viewport${panning ? " panning" : ""}`} ref={view} onPointerDown={down} style={style}>
      <div className="world" style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})`, width: bounds.w, height: bounds.h }}>
        {frames.filter((f) => inView(f.box)).map((f) => (
          <div key={f.project.root} className={`frame${fresh(`frame:${f.project.root}`) ? " arriving" : ""}`} style={{ left: f.box.x, top: f.box.y, width: f.box.w, height: f.box.h }}>
            <div className="frame-head">
              <h2>{f.project.name}</h2>
              <span className="where">{f.project.root.replace(/^\/Users\/[^/]+/, "~")}</span>
            </div>
          </div>
        ))}
        {frames.flatMap((f) => f.areas).filter((a) => inView(a.box)).map((a) => (
          <AreaView key={a.session.id} area={a} inView={inView} byScreen={byScreen} moved={moved} onOpen={onOpen} onMore={onMore} opened={opened.has(a.session.id)} />
        ))}
        {working.filter((w) => inView(w.area.box)).map((w) => (
          <AgentCursor key={w.area.session.id} at={w.at} k={cam.k} say={w.area.session.now || w.area.session.title} title={w.area.session.title} flip={w.at.x > bounds.w - 380} />
        ))}
      </div>
      <MapDock frames={frames} bounds={bounds} cam={cam} size={size} agents={working.map((w) => w.at)}
        setCam={(c) => { cancelAnimationFrame(glide.current); setCam(c); }} zoomBy={zoomBy} fit={fit} />
    </div>
  );
}

/* ---- an agent's cursor, as on Scout's canvas (scout-apps canvas/marks.tsx, shape J17) */

/** A polygon whose corners ease by a quadratic curve, each inset by its radius or 44% of the shorter edge. */
function roundedPolygon(vs: [number, number, number][]): string {
  const n = vs.length;
  const toward = (a: number[], b: number[], d: number) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return len < 0.001 ? [a[0], a[1]] : [a[0] + ((b[0] - a[0]) / len) * d, a[1] + ((b[1] - a[1]) / len) * d];
  };
  const corners = vs.map((c, i) => {
    const prev = vs[(i - 1 + n) % n], next = vs[(i + 1) % n];
    const inset = Math.min(c[2], Math.hypot(c[0] - prev[0], c[1] - prev[1]) * 0.44, Math.hypot(c[0] - next[0], c[1] - next[1]) * 0.44);
    return { inc: toward(c, prev, inset), out: toward(c, next, inset), ctl: [c[0], c[1]] };
  });
  const f = (pt: number[]) => `${pt[0].toFixed(2)} ${pt[1].toFixed(2)}`;
  let d = `M${f(corners[0].out)}`;
  for (const c of [...corners.slice(1), corners[0]]) d += ` L${f(c.inc)} Q${f(c.ctl)} ${f(c.out)}`;
  return `${d} Z`;
}
/** The tip at 0,0 is the hotspot. */
const CURSOR_D = roundedPolygon([[0, 0, 4.5], [37.5, 28.2, 8], [18.3, 34.4, 5], [2.5, 48.2, 8]]);
/** where a cursor points on a card: in its picture, a little below the top */
const MEDIA_TIP = 64;

/** `k` is the camera's scale: the cursor keeps its size on screen. */
function AgentCursor({ at, k, say, title, flip }: { at: { x: number; y: number }; k: number; say: string; title: string; flip: boolean }) {
  const shape = { d: CURSOR_D, vectorEffect: "non-scaling-stroke" as const };
  return (
    <div className={`agent-cursor${flip ? " flip" : ""}`} style={{ left: at.x, top: at.y, scale: `${1 / k}` }} aria-label={`Claude, working on ${title}: ${say}`} title={`${title}: ${say}`}>
      <div className="drift">
        <svg width="32" height="36" viewBox="-6 -3 32 36" aria-hidden="true">
          <g className="sway" transform="scale(0.6)">
            <path {...shape} className="edge" />
            <path {...shape} className="fill" />
            <path {...shape} className="light" />
          </g>
        </svg>
        <span className="tag"><HarnessCoin size={16} /><span className="who">Claude</span><span className="say">{say}</span><Working /></span>
      </div>
    </div>
  );
}

/*
 * The minimap and zoom, one unit at the bottom left, as on Scout's canvas (scout-apps canvas/Minimap.tsx and
 * minimap-frame.ts): the map, a seam, then the zoom row. Click the map to go there, drag the frame to pan, scroll on
 * it to zoom; with it focused, arrow keys pan and + and − zoom.
 */
const MAP_MAX = 196, MAP_MIN = 56, MAP_PAD = 6;

/** The scene shrunk into a box no larger than MAP_MAX on a side, shaped like the scene. */
function mapFrame(bounds: Box) {
  const bw = Math.max(1, bounds.w), bh = Math.max(1, bounds.h);
  const fit = (MAP_MAX - MAP_PAD * 2) / Math.max(bw, bh);
  const w = Math.max(MAP_MIN, Math.round(bw * fit + MAP_PAD * 2)), h = Math.max(MAP_MIN, Math.round(bh * fit + MAP_PAD * 2));
  const scale = Math.min((w - MAP_PAD * 2) / bw, (h - MAP_PAD * 2) / bh);
  const ox = (w - bw * scale) / 2 - bounds.x * scale, oy = (h - bh * scale) / 2 - bounds.y * scale;
  return {
    w, h,
    toMap: (b: Box): Box => ({ x: b.x * scale + ox, y: b.y * scale + oy, w: b.w * scale, h: b.h * scale }),
    toWorld: (x: number, y: number) => ({ x: (x - ox) / scale, y: (y - oy) / scale }),
  };
}

function Glyph({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function MapDock({ frames, bounds, cam, size, agents, setCam, zoomBy, fit }: {
  frames: Frame[]; bounds: Box; cam: Cam; size: { w: number; h: number }; agents: { x: number; y: number }[];
  setCam: (c: Cam) => void; zoomBy: (f: number) => void; fit: () => void;
}) {
  const map = useMemo(() => mapFrame(bounds), [bounds]);
  const seen = map.toMap({ x: -cam.x / cam.k, y: -cam.y / cam.k, w: size.w / cam.k, h: size.h / cam.k });
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; dx: number; dy: number } | null>(null);
  const latest = useRef({ cam, size, setCam, zoomBy, map });
  latest.current = { cam, size, setCam, zoomBy, map };

  const pointAt = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (map.w / r.width), y: (e.clientY - r.top) * (map.h / r.height) };
  };
  const goTo = (x: number, y: number) => {
    const { cam, size, setCam, map } = latest.current;
    const p = map.toWorld(x, y);
    setCam({ k: cam.k, x: size.w / 2 - p.x * cam.k, y: size.h / 2 - p.y * cam.k });
  };
  // scrolling on the map zooms; it is read here first, so the canvas under it doesn't pan too
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (drag.current) return;
      const unit = e.deltaMode === 1 ? 16 : 1;
      latest.current.zoomBy(Math.exp(-Math.max(-100, Math.min(100, e.deltaY * unit)) * 0.0026));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current) return;
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    const p = pointAt(e);
    const inside = p.x >= seen.x && p.x <= seen.x + seen.w && p.y >= seen.y && p.y <= seen.y + seen.h;
    // grabbing the frame keeps the grip where it was taken; anywhere else, the view jumps there first
    drag.current = { id: e.pointerId, dx: inside ? seen.x + seen.w / 2 - p.x : 0, dy: inside ? seen.y + seen.h / 2 - p.y : 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!inside) goTo(p.x, p.y);
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const p = pointAt(e);
    goTo(p.x + d.dx, p.y + d.dy);
  };
  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const key = (e: React.KeyboardEvent) => {
    const step = ({ ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] } as Record<string, number[]>)[e.key];
    if (step) { e.preventDefault(); setCam({ ...cam, x: cam.x + step[0] * size.w / 4, y: cam.y + step[1] * size.h / 4 }); }
    else if (e.key === "+" || e.key === "=" || e.key === "-") { e.preventDefault(); zoomBy(e.key === "-" ? 0.8 : 1.25); }
  };
  const rect = (b: Box, className: string, key: string) => {
    const r = map.toMap(b);
    return <rect key={key} className={className} x={r.x} y={r.y} width={Math.max(0.5, r.w)} height={Math.max(0.5, r.h)} />;
  };

  return (
    <div className="map-dock" onPointerDown={(e) => e.stopPropagation()}>
      <div ref={ref} className="minimap" style={{ width: map.w, height: map.h }} tabIndex={0} role="group"
        aria-label="Canvas map. Arrow keys pan, plus and minus zoom." title="Click to go there, drag the frame to pan, scroll to zoom"
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        onLostPointerCapture={() => { drag.current = null; }} onKeyDown={key}>
        <svg width={map.w} height={map.h} viewBox={`0 0 ${map.w} ${map.h}`} aria-hidden="true">
          {frames.map((f) => rect(f.box, "map-frame", f.project.root))}
          {frames.flatMap((f) => f.areas.flatMap((a) => a.cards.map((c) => rect(c.box, "map-card", c.screen.id))))}
          {agents.map((p, i) => { const m = map.toMap({ x: p.x, y: p.y, w: 0, h: 0 }); return <circle key={i} className="map-dot" cx={m.x} cy={m.y} r={2} />; })}
          <rect className="map-view" x={seen.x} y={seen.y} width={seen.w} height={seen.h} />
        </svg>
      </div>
      <div className="camera" role="toolbar" aria-label="Zoom">
        <button type="button" className="tool" onClick={() => zoomBy(0.8)} aria-label="Zoom out"><Glyph d="M4 8h8" /></button>
        <span className="pct">{Math.round(cam.k * 100)}%</span>
        <button type="button" className="tool" onClick={() => zoomBy(1.25)} aria-label="Zoom in"><Glyph d="M4 8h8M8 4v8" /></button>
        <span className="grow" />
        <button type="button" className="tool-text" onClick={fit}>Fit</button>
      </div>
    </div>
  );
}

function AreaView({ area, inView, byScreen, moved, onOpen, onMore, opened }: {
  area: Area; inView: (b: Box) => boolean; byScreen: Map<string, Note[]>; moved: React.MutableRefObject<boolean>;
  onOpen: Props["onOpen"]; onMore: (id: string) => void; opened: boolean;
}) {
  const s = area.session;
  return (
    <>
      <div className="area-head" style={{ left: area.box.x, top: area.box.y, width: area.box.w, height: 64 }}>
        <div className="name">
          {s.working ? <Working /> : <span className={`dot${s.open ? " ok" : ""}`} title={s.open ? "open" : "closed"} />}
          <span>{s.title}</span>
        </div>
        <div className="meta">
          <span>{s.working ? "working" : s.open ? "open" : "closed"} · {ago(s.lastAt)}</span>
          {s.branch && <span className="mono">{s.branch}</span>}
          <span>{s.screens.length} screens</span>
          {(area.hidden > 0 || opened) && (
            <button className="more" onPointerDown={(e) => e.stopPropagation()} onClick={() => onMore(s.id)}>
              {opened ? "Show fewer" : `${area.hidden} more`}
            </button>
          )}
        </div>
        <div className="prompt">{s.prompt}</div>
      </div>
      {area.cards.filter((c) => inView(c.box)).map(({ screen: sc, box }) => {
        const pins = byScreen.get(sc.id) || [];
        return (
          <button
            key={sc.id} className={`card${fresh(sc.id) ? " arriving" : ""}`} style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
            onClick={() => { if (!moved.current) onOpen(area, sc); }}
            onContextMenu={(e) => {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect(), k = r.width / CARD_W;
              const px = (e.clientX - r.left) / k, py = (e.clientY - r.top) / k;
              onOpen(area, sc, py <= MEDIA_H ? cardPoint(sc, px, py) : undefined);
            }}
          >
            <div className="media">
              <img src={thumb(sc)} alt="" loading="lazy" draggable={false} />
              {pins.map((n) => { const p = cardPinStyle(sc, n); return p && <span key={n.id} className={`pin${n.kept ? " done" : ""}`} style={p} />; })}
            </div>
            <div className="foot">
              <div className="cap">{sc.caption || sc.url || sc.file || "A screen"}</div>
              <div className="sub">
                <span>{ago(sc.at)}</span>
                <span>{kindOf(sc)}</span>
                {sc.before && <span className="tag accent">before / after</span>}
                {pins.length > 0 && <span className="tag">{pins.length} {pins.length === 1 ? "note" : "notes"}</span>}
              </div>
            </div>
          </button>
        );
      })}
    </>
  );
}

/** True while a thing is new: drawn for the first time less than the fade's length ago. */
function fresh(id: string) {
  const now = performance.now();
  if (!seen.has(id)) seen.set(id, now);
  return now - seen.get(id)! < 420;
}

export function kindOf(sc: Screen) {
  if (sc.url) { try { return new URL(sc.url).host; } catch {} }
  if (/host_screenshot/.test(sc.tool)) return "window";
  if (/browser_screenshot/.test(sc.tool)) return "browser";
  if (sc.tool === "Read") return "image file";
  return sc.tool.replace(/^mcp__\w+__/, "");
}
