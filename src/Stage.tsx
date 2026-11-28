// One screen, full size. With a before, a wipe lays the two over each other. Click or right-click
// anywhere on the screen to pin a note there; Scout takes it to the session that took the screen,
// and the thread beside it shows how that went and what the session said back.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ago, api, img, type Note, type Pointer, type Screen, type Session, type Project } from "./api";
import { Working, kindOf } from "./Canvas";

type Props = {
  session: Session; project: Project; screens: Screen[]; index: number; notes: Note[];
  at?: { x: number; y: number }; scoutUp: boolean;
  /** a spot or area the session pointed the person at, with what it says about it */
  pointer?: Pointer;
  onIndex: (i: number) => void; onClose: () => void; onNotes: () => void;
};

/** Text fields and notes keep the browser's own menu; everywhere else a right-click places a note. */
const ownMenu = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("textarea, input, [data-note]");

/** Zoom is a multiple of the fitted size: 1 fits the screen in the stage. */
const MAX_ZOOM = 8;
const PAD = 22;
const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(1, k));

export function Stage({ session, project, screens, index, notes, at, pointer, scoutUp, onIndex, onClose, onNotes }: Props) {
  const sc = screens[index];
  const shot = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [draft, setDraft] = useState<{ x: number; y: number } | null>(at ?? null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [wipe, setWipe] = useState(0.5);
  // a linked point is on the screen as it is now, so it opens without the before laid over it
  const [compare, setCompare] = useState(!pointer);
  const [current, setCurrent] = useState<string | null>(null);
  // the pointer belongs to its own screen; stepping to another leaves it behind
  const point = pointer && pointer.screen.hash === sc.hash
    ? { ...pointer.box, cx: pointer.box.x + pointer.box.w / 2, cy: pointer.box.y + pointer.box.h / 2, area: pointer.box.w > 0 && pointer.box.h > 0 }
    : null;
  const [replyTo, setReplyTo] = useState<Pointer | null>(null);
  const [heard, setHeard] = useState(false); // the person put the session's remark away
  const mine = notes.filter((n) => n.session === session.id && n.screen.hash === sc.hash);

  // zoom: the image is drawn larger and the stage scrolls, so pins, notes and the composer keep their size
  const scroller = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [room, setRoom] = useState({ w: 0, h: 0 });
  // the spot to hold still through the next zoom: a fraction of the image and where it sits in the viewport
  const anchor = useRef<{ fx: number; fy: number; vx: number; vy: number } | null>(null);
  const fit = nat && room.w > 0 && room.h > 0 ? Math.min(1, room.w / nat.w, room.h / nat.h) : null;
  const size = nat && fit ? { w: Math.round(nat.w * fit * zoom), h: Math.round(nat.h * fit * zoom) } : null;

  useEffect(() => { setDraft(at ?? null); setText(""); setWipe(0.5); setCurrent(null); setZoom(1); setNat(null); anchor.current = null; }, [sc.id]);

  useLayoutEffect(() => {
    // measured on the stage, not the scroller, so the scrollbars a zoom brings don't move the fit
    const el = scroller.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setRoom({ w: el.clientWidth - PAD * 2, h: el.clientHeight - PAD * 2 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Zoom to `next`, keeping the image point under (vx, vy) of the stage where it is; the middle by default. */
  const zoomTo = (next: number, vx?: number, vy?: number) => {
    const el = scroller.current, s = shot.current;
    const k = clampZoom(next);
    if (!el || !s || k === zoomNow.current) return;
    zoomNow.current = k;
    const x = vx ?? el.clientWidth / 2, y = vy ?? el.clientHeight / 2;
    anchor.current = {
      fx: Math.min(1, Math.max(0, (el.scrollLeft + x - s.offsetLeft) / s.offsetWidth)),
      fy: Math.min(1, Math.max(0, (el.scrollTop + y - s.offsetTop) / s.offsetHeight)),
      vx: x, vy: y,
    };
    setZoom(k);
  };
  const zoomRef = useRef(zoomTo);
  zoomRef.current = zoomTo;

  useLayoutEffect(() => {
    const el = scroller.current, s = shot.current, a = anchor.current;
    if (!el || !s || !a) return;
    anchor.current = null;
    el.scrollLeft = s.offsetLeft + a.fx * s.offsetWidth - a.vx;
    el.scrollTop = s.offsetTop + a.fy * s.offsetHeight - a.vy;
  }, [zoom]);

  // pinch, or ⌘/ctrl and scroll, zooms around the pointer (the canvas's own rate); plain scrolling pans
  const zoomNow = useRef(zoom);
  zoomNow.current = zoom;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomRef.current(zoomNow.current * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /** 100%: the screen's own pixels. Toggles back to fit. */
  const actual = fit ? 1 / fit : 1;
  const pct = fit ? Math.round(fit * zoom * 100) : null;

  useLayoutEffect(() => {
    const el = shot.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [sc.id]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("textarea, input")) return;
      if (e.key === "Escape") { if (draft) setDraft(null); else onClose(); }
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      if (e.key === "ArrowRight" && index < screens.length - 1) onIndex(index + 1);
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomRef.current(zoomNow.current * 1.25); }
      if (e.key === "-") { e.preventDefault(); zoomRef.current(zoomNow.current * 0.8); }
      if (e.key === "0") { e.preventDefault(); zoomRef.current(1); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [draft, index, screens.length]);

  const pointOf = (e: React.MouseEvent) => {
    const r = shot.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const place = (e: React.MouseEvent) => {
    if (ownMenu(e.target) || (e.target as HTMLElement).closest(".wipe, .pin-big")) return;
    e.preventDefault();
    setDraft(pointOf(e));
    setCurrent(null);
  };

  const dragWipe = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const r = shot.current!.getBoundingClientRect();
    const move = (ev: PointerEvent) => setWipe(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const submit = async () => {
    if (!draft || !text.trim()) return;
    setBusy(true);
    try {
      const re = replyTo && replyTo.screen.hash === sc.hash ? { re: replyTo.id, reSay: replyTo.say } : {};
      const { note } = await api.add({ session: session.id, harness: session.harness, project: project.name, cwd: session.cwd, screen: sc, x: draft.x, y: draft.y, text, ...re });
      setDraft(null); setText(""); setCurrent(note.id); setReplyTo(null); onNotes();
    } finally { setBusy(false); }
  };

  const showBefore = !!sc.before && compare;
  const left = draft && draft.x > 0.6;

  return (
    <div className="stage" role="dialog" aria-label="Screen" onContextMenu={(e) => { if (!ownMenu(e.target) && !shot.current?.contains(e.target as Node)) e.preventDefault(); }}>
      <div className="stage-bar">
        <button className="s-ds-btn s-ds-btn--secondary" onClick={onClose}>Close</button>
        <span className="title">{session.title}</span>
        <span className="where">{project.name}{session.branch ? ` · ${session.branch}` : ""} · {sc.url || sc.file || kindOf(sc)}</span>
        <span style={{ flex: 1 }} />
        {sc.before && (
          <button className={`s-ds-btn${compare ? "" : " s-ds-btn--secondary"}`} onClick={() => setCompare((v) => !v)} aria-pressed={compare}>
            {compare ? "Comparing with before" : "Compare with before"}
          </button>
        )}
        <span className="mono" style={{ color: "var(--dim)" }}>{index + 1} of {screens.length}</span>
      </div>
      <div className="stage-main">
        {index > 0 && <button className="s-ds-btn s-ds-btn--secondary nav prev" onClick={() => onIndex(index - 1)} aria-label="Newer screen">←</button>}
        {index < screens.length - 1 && <button className="s-ds-btn s-ds-btn--secondary nav next" onClick={() => onIndex(index + 1)} aria-label="Older screen">→</button>}
        <div className="zoom" role="toolbar" aria-label="Zoom" data-note>
          <button className="s-ds-btn s-ds-btn--secondary" onClick={() => zoomTo(zoom * 0.8)} disabled={zoom <= 1} aria-label="Zoom out" title="Zoom out (−)">−</button>
          <button
            className="s-ds-btn s-ds-btn--secondary pct" onClick={() => zoomTo(zoom > 1 ? 1 : actual)}
            title={zoom > 1 ? "Fit the screen (0)" : "Actual pixels"} aria-label={zoom > 1 ? "Fit the screen" : "Actual pixels"}
          >{pct === null ? "Fit" : `${pct}%`}</button>
          <button className="s-ds-btn s-ds-btn--secondary" onClick={() => zoomTo(zoom * 1.25)} disabled={zoom >= MAX_ZOOM} aria-label="Zoom in" title="Zoom in (+)">+</button>
        </div>
        <div className={`shot-scroll${zoom > 1 ? " zoomed" : ""}`} ref={scroller}>
        <div className="shot" ref={shot} onClick={place} onContextMenu={place}>
          <img
            src={img(sc)} alt="" draggable={false}
            onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            style={size ? { width: size.w, height: size.h, maxWidth: "none", maxHeight: "none" } : undefined}
          />
          {showBefore && (
            <>
              <div className="before" style={{ width: `${wipe * 100}%` }}>
                <img src={img(sc.before!)} alt="" draggable={false} style={{ width: box.w, height: box.h }} />
              </div>
              <div className="wipe" style={{ left: `${wipe * 100}%` }} onPointerDown={dragWipe} onClick={(e) => e.stopPropagation()}>
                <span><b>before · {ago(sc.before!.at)}</b><b>after</b></span>
              </div>
            </>
          )}
          {mine.map((n, i) => (
            <button
              key={n.id} data-note className={`pin-big${n.kept ? " done" : ""}${live(n, session) ? " live" : ""}`}
              style={{ left: `${n.x * 100}%`, top: `${n.y * 100}%` }} aria-current={current === n.id}
              onClick={(e) => { e.stopPropagation(); setCurrent(n.id); setDraft(null); }} title={n.text}
            >{i + 1}</button>
          ))}
          {point && (point.area ? (
            <span className="pointer-area" data-note style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%`, width: `${point.w * 100}%`, height: `${point.h * 100}%` }}
              onClick={(e) => { e.stopPropagation(); setHeard(false); setDraft(null); }} title={pointer!.say} />
          ) : (
            <span className="pointer" data-note style={{ left: `${point.cx * 100}%`, top: `${point.cy * 100}%` }}
              onClick={(e) => { e.stopPropagation(); setHeard(false); setDraft(null); }} title={pointer!.say} />
          ))}
          {point && !heard && !draft && (
            <div
              className="pointer-say" data-note onClick={(e) => e.stopPropagation()}
              style={{
                // beside the spot (or below the area), and above it when it's low, so the spot stays clear
                ...(point.area
                  ? (point.y + point.h > 0.6 ? { bottom: `calc(${(1 - point.y) * 100}% + 12px)` } : { top: `calc(${(point.y + point.h) * 100}% + 12px)` })
                  : (point.cy > 0.6 ? { bottom: `calc(${(1 - point.cy) * 100}% + 22px)` } : { top: `calc(${point.cy * 100}% - 14px)` })),
                ...(point.area
                  ? (point.x > 0.6 ? { right: `calc(${(1 - point.x - point.w) * 100}%)` } : { left: `${point.x * 100}%` })
                  : (point.cx > 0.6 ? { right: `calc(${(1 - point.cx) * 100}% + 22px)` } : { left: `calc(${point.cx * 100}% + 22px)` })),
              }}
            >
              <div className="who">{session.title.slice(0, 60)} <span>· {ago(pointer!.at)}</span></div>
              {pointer!.say && <p>{pointer!.say}</p>}
              {pointer!.replies.length > 0 && <div className="replied">You replied {ago(pointer!.replies.at(-1)!.at)}: {pointer!.replies.at(-1)!.text}</div>}
              <div className="row">
                <button className="s-ds-btn s-ds-btn--secondary" onClick={() => setHeard(true)}>Got it</button>
                <button className="s-ds-btn" onClick={() => { setReplyTo(pointer!); setDraft({ x: point.cx, y: point.cy }); }}>Reply here</button>
              </div>
            </div>
          )}
          {draft && (
            <>
              <span className="pin-big" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, opacity: 0.7 }} />
              <div
                className="composer" data-note onClick={(e) => e.stopPropagation()}
                style={{
                  ...(draft.y > 0.6 ? { bottom: `calc(${(1 - draft.y) * 100}% - 12px)` } : { top: `calc(${draft.y * 100}% - 12px)` }),
                  ...(left ? { right: `calc(${(1 - draft.x) * 100}% + 18px)` } : { left: `calc(${draft.x * 100}% + 18px)` }),
                }}
              >
                <textarea
                  autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={replyTo ? "Your reply" : `A note for ${session.title.slice(0, 40)}`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
                    if (e.key === "Escape") { e.stopPropagation(); setDraft(null); }
                  }}
                />
                <div className="row">
                  <span>{deliveryHint(session, scoutUp)}</span>
                  <button className="s-ds-btn" disabled={!text.trim() || busy} onClick={submit}>Send</button>
                </div>
              </div>
            </>
          )}
        </div>
        </div>
      </div>
      <aside className="side" data-note>
        <div>
          <h3>Session</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            {session.working ? <Working /> : <span className={`dot${session.open ? " ok" : ""}`} />}
            <span>{session.working ? "Working now" : session.open ? "Open" : "Closed"} · last active {ago(session.lastAt)}</span>
          </div>
          <div className="hint mono" style={{ marginTop: 4 }}>{session.cwd.replace(/^\/Users\/[^/]+/, "~")}</div>
        </div>
        {sc.caption && (
          <div>
            <h3>What it said · {ago(sc.at)}</h3>
            <div className="said" style={{ marginTop: 6 }}>{sc.caption}</div>
          </div>
        )}
        <div style={{ display: "grid", gap: 10 }}>
          <h3>Notes on this screen</h3>
          {!mine.length && <div className="hint">Click or right-click anywhere on the screen to pin a note. Scout takes it to this session, and its answer shows here.</div>}
          {mine.map((n, i) => <Thread key={n.id} n={n} i={i + 1} session={session} project={project} current={current === n.id} onFocus={() => setCurrent(n.id)} onNotes={onNotes} />)}
        </div>
      </aside>
    </div>
  );
}

/** A note out with its session while that session works on it. */
function deliveryHint(session: Session, scoutUp: boolean) {
  if (session.id.startsWith("studio-") || (session.harness && !["claude", "codex"].includes(session.harness))) {
    return "Your agent can read this note with feedback";
  }
  if (!scoutUp) return "Scout will try to deliver this note when the runtime starts";
  if (session.harness === "codex") return "Scout will look for this Codex session";
  return session.open ? "Scout takes it to the session now" : "Scout will try again when the session opens";
}

function live(n: Note, s: Session) {
  return !n.kept && !!n.arrivedAt && !n.answers.length && s.working;
}

function status(n: Note, s: Session, project: Project): { text: string; tone: "" | "ok" | "bad" | "accent"; working?: boolean } {
  if (n.kept) return { text: "Done", tone: "" };
  const last = n.trail.at(-1);
  if (!last) return { text: "Scout is taking it to the session…", tone: "accent", working: true };
  if (n.answers.length) return { text: `Answered ${ago(n.answers.at(-1)!.at)}`, tone: "ok" };
  if (last.what === "available" || (n.arrivedAt && last.what !== "sent")) return { text: n.arrivedAt ? "Read by the session" : "Available for the session to read", tone: n.arrivedAt ? "ok" : "" };
  if (last.what === "handed") return { text: `Handed to a new Claude session in ${project.name}${last.task ? ` (${last.task})` : ""}`, tone: "ok" };
  if (last.what === "sent") {
    if (n.arrivedAt) return s.working ? { text: "It arrived; the session is on it", tone: "accent", working: true } : { text: "It arrived; no answer yet", tone: "" };
    return { text: `Sent through Scout ${ago(last.at)}`, tone: "ok" };
  }
  if (last.what === "waiting") return { text: "Waiting: the session isn't open. Scout tries again every 20 seconds.", tone: "" };
  return { text: `Scout couldn't send it: ${last.why}${(n.tries || 0) >= 6 ? ". Stopped trying." : ". Trying again."}`, tone: "bad" };
}

function Thread({ n, i, session, project, current, onFocus, onNotes }: { n: Note; i: number; session: Session; project: Project; current: boolean; onFocus: () => void; onNotes: () => void }) {
  const st = status(n, session, project);
  const last = n.trail.at(-1)?.what;
  const act = (p: Promise<unknown>) => p.finally(onNotes);
  return (
    <div className="thread" aria-current={current} onClick={onFocus}>
      <div className="who"><b>#{i} You</b><span>{ago(n.at)}</span></div>
      <div className="text">{n.text}</div>
      {n.answers.map((a, k) => (
        <div key={k}>
          <div className="who"><b>{session.title.slice(0, 40)}</b><span>{ago(a.at)}</span></div>
          <div className="answer">{a.text}</div>
        </div>
      ))}
      <div className="status">{st.working ? <Working /> : <span className={`dot ${st.tone}`} />}<span>{st.text}</span></div>
      <div className="actions">
        {(last === "waiting" || last === "failed") && (!session.harness || session.harness === "claude") && !n.kept && <button className="s-ds-btn" onClick={() => act(api.handOff(n.id))}>Hand to a new session</button>}
        {last === "failed" && !n.kept && <button className="s-ds-btn s-ds-btn--secondary" onClick={() => act(api.retry(n.id))}>Retry</button>}
        <button className="s-ds-btn s-ds-btn--secondary" onClick={() => act(api.keep(n.id, !n.kept))}>{n.kept ? "Reopen" : "Done"}</button>
        <button className="s-ds-btn s-ds-btn--secondary" onClick={() => act(api.remove(n.id))}>Delete</button>
      </div>
    </div>
  );
}
