// The canvas: repositories as frames, sessions as areas, screens as cards. Drag or scroll to move,
// pinch or hold ⌘ and scroll to zoom. Only the cards in view are drawn.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ago, thumb, type Note, type Screen } from "./api";
import { CARD_W, MEDIA_H, type Area, type Box, type Frame } from "./scene";

export type Cam = { x: number; y: number; k: number };
const K_MIN = 0.1, K_MAX = 2;
const clampK = (k: number) => Math.min(K_MAX, Math.max(K_MIN, k));

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
  /** where to land when the canvas first shows: the latest session */
  focus: Box | null;
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
    return { x: (size.w - bounds.w * k) / 2, y: 12, k };
  };
  const fit = () => moveTo(fitCam());
  // land on the latest session: readable, its head near the top, gliding in from a little further out
  useEffect(() => {
    if (cam || size.w < 100 || bounds.w <= 0) return;
    if (!focus) return setCam(fitCam());
    const k = clampK(Math.min(1, (size.w - 96) / focus.w));
    const to = { k, x: (size.w - focus.w * k) / 2 - focus.x * k, y: 16 - focus.y * k };
    const from = { k: k * 0.86, x: (size.w - focus.w * k * 0.86) / 2 - focus.x * k * 0.86, y: 40 - focus.y * k * 0.86 };
    setCam(from);
    moveTo(to, from);
  }, [focus, size.w, bounds.w]);
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
      </div>
      <div className="zoom" onPointerDown={(e) => e.stopPropagation()}>
        <span className="mono">{Math.round(cam.k * 100)}%</span>
        <button className="ghost" onClick={() => zoomBy(1 / 1.25)} aria-label="Zoom out">−</button>
        <button className="ghost" onClick={() => zoomBy(1.25)} aria-label="Zoom in">+</button>
        <button className="ghost" onClick={fit}>Fit</button>
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
