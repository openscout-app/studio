// The canvas's own controls, floating over its top right: how far back, which screens, and which
// projects and agents to show. Also the Scout glyph, drawn in the current text color.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CanvasData } from "./api";
import { HarnessCoin } from "./Harness";

export function Glyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="5 -4 214 244" aria-hidden="true">
      <path d="M103.01 13.21 Q112 8 120.99 13.21 L198.01 57.79 Q207 63 207 73.39 L207 162.61 Q207 173 198.01 178.21 L120.99 222.79 Q112 228 103.01 222.79 L25.99 178.21 Q17 173 17 162.61 L17 73.39 Q17 63 25.99 57.79 Z" fill="none" stroke="currentColor" strokeWidth="24" strokeLinejoin="round" />
      <path d="M112 70 154 94v48l-42 24-42-24V94Z" fill="currentColor" />
    </svg>
  );
}

/** How far back: a short look by default; the canvas widens on its own when there's nothing in it */
export const WINDOWS = [
  { h: 4, label: "4 hours" },
  { h: 24, label: "24 hours" },
  { h: 72, label: "3 days" },
  { h: 336, label: "14 days" },
];
export const START_HOURS = 4;
/** The next window out, for an empty canvas or a link to an older session */
export const wider = (h: number) => (h < 24 ? 24 : h < 72 ? 72 : 336);
export type Filter = "all" | "notes" | "changed";
export type AgentMode = "all" | "open" | "working";
export type View = { hiddenProjects: string[]; hiddenSessions: string[]; agents: AgentMode };
export const NO_VIEW: View = { hiddenProjects: [], hiddenSessions: [], agents: "all" };

/** A button that opens a small panel below it; a click anywhere else closes it. */
function Pop({ label, badge, children }: { label: string; badge?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("pointerdown", away); window.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="pop" ref={box}>
      <button className={`s-ds-btn${badge ? "" : " s-ds-btn--secondary"}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}{badge && <span className="badge">{badge}</span>}<svg className="caret" viewBox="0 0 10 6" aria-hidden="true"><path d="m1 1 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && <div className="pop-panel" role="dialog" aria-label={label}>{children}</div>}
    </div>
  );
}

export function ViewControls({ data, hours, setHours, filter, setFilter, view, setView }: {
  data: CanvasData | null; hours: number; setHours: (h: number) => void;
  filter: Filter; setFilter: (f: Filter) => void; view: View; setView: (v: View) => void;
}) {
  const projects = data?.projects || [];
  const sessions = projects.flatMap((p) => p.sessions.map((s) => ({ s, project: p.name })))
    .sort((a, b) => b.s.lastAt - a.s.lastAt);
  const hp = new Set(view.hiddenProjects), hs = new Set(view.hiddenSessions);
  const flip = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const shownProjects = projects.filter((p) => !hp.has(p.root)).length;
  const shownAgents = sessions.filter(({ s }) => !hs.has(s.id) && (view.agents === "all" || (view.agents === "open" ? s.open : s.working))).length;

  return (
    <div className="float" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div className="seg" role="group" aria-label="How far back">
        {WINDOWS.map((w) => <button key={w.h} aria-pressed={hours === w.h} onClick={() => setHours(w.h)}>{w.label}</button>)}
      </div>
      <Pop label="Projects" badge={hp.size ? `${shownProjects}/${projects.length}` : undefined}>
        <div className="pop-head">
          <span>Projects</span>
          <span className="grow" />
          <button className="s-ds-btn s-ds-btn--tertiary" onClick={() => setView({ ...view, hiddenProjects: [] })}>All</button>
          <button className="s-ds-btn s-ds-btn--tertiary" onClick={() => setView({ ...view, hiddenProjects: projects.map((p) => p.root) })}>None</button>
        </div>
        <ul className="pick">
          {projects.map((p) => (
            <li key={p.root}>
              <label>
                <input type="checkbox" checked={!hp.has(p.root)} onChange={() => setView({ ...view, hiddenProjects: flip(view.hiddenProjects, p.root) })} />
                <span className="name">{p.name}</span>
                <span className="meta">{p.sessions.length}</span>
              </label>
            </li>
          ))}
        </ul>
      </Pop>
      <Pop label="Agents" badge={hs.size || view.agents !== "all" ? `${shownAgents}/${sessions.length}` : undefined}>
        <div className="pop-head">
          <div className="seg small" role="group" aria-label="Which agents">
            {(["all", "open", "working"] as const).map((m) => (
              <button key={m} aria-pressed={view.agents === m} onClick={() => setView({ ...view, agents: m })}>
                {m === "all" ? "All" : m === "open" ? "Open" : "Working"}
              </button>
            ))}
          </div>
          <span className="grow" />
          <button className="s-ds-btn s-ds-btn--tertiary" onClick={() => setView({ ...view, hiddenSessions: [] })}>All</button>
          <button className="s-ds-btn s-ds-btn--tertiary" onClick={() => setView({ ...view, hiddenSessions: sessions.map(({ s }) => s.id) })}>None</button>
        </div>
        <ul className="pick">
          {sessions.map(({ s, project }) => {
            const out = view.agents === "open" ? !s.open : view.agents === "working" ? !s.working : false;
            return (
              <li key={s.id} className={out ? "out" : ""}>
                <label>
                  <input type="checkbox" checked={!hs.has(s.id)} onChange={() => setView({ ...view, hiddenSessions: flip(view.hiddenSessions, s.id) })} />
                  <HarnessCoin harness={s.harness} size={16} />
                  <span className={`dot${s.working ? " accent" : s.open ? " ok" : ""}`} />
                  <span className="name">{s.title}</span>
                  <span className="meta">{project}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </Pop>
    </div>
  );
}
