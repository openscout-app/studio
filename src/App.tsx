import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type CanvasData, type Note, type Screen } from "./api";
import { Canvas } from "./Canvas";
import { Stage } from "./Stage";
import { layout, type Area } from "./scene";

const WINDOWS = [{ h: 24, label: "Today" }, { h: 72, label: "3 days" }, { h: 168, label: "Week" }];
type Filter = "all" | "notes" | "changed";
type Open = { session: string; hash: string; at?: { x: number; y: number } };

function readHash(): Open | null {
  const m = location.hash.match(/^#s\/([^/]+)\/([0-9a-f]{16})$/);
  return m ? { session: m[1], hash: m[2] } : null;
}

export function App() {
  const [hours, setHours] = useState(() => Number(localStorage.getItem("scout-canvas:hours")) || 72);
  const [data, setData] = useState<CanvasData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Open | null>(readHash);

  const loadCanvas = useCallback(() => api.canvas(hours).then((d) => { setData(d); setError(null); }, (e) => setError(String(e.message || e))), [hours]);
  const loadNotes = useCallback(() => api.notes().then(setNotes, () => {}), []);
  useEffect(() => {
    try { localStorage.setItem("scout-canvas:hours", String(hours)); } catch {}
    loadCanvas();
    const t = setInterval(loadCanvas, 15e3);
    return () => clearInterval(t);
  }, [loadCanvas]);
  useEffect(() => { loadNotes(); const t = setInterval(loadNotes, 4e3); return () => clearInterval(t); }, [loadNotes]);
  useEffect(() => {
    const on = () => setOpen(readHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const show = (o: Open | null) => {
    setOpen(o);
    history.replaceState(null, "", o ? `#s/${o.session}/${o.hash}` : location.pathname);
  };

  const noted = useMemo(() => new Set(notes.map((n) => `${n.session}:${n.screen.hash}`)), [notes]);
  const keep = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (s: Screen, extra = "") => {
      if (filter === "notes" && !noted.has(s.id)) return false;
      if (filter === "changed" && !s.before) return false;
      return !q || `${extra} ${s.caption} ${s.url || ""} ${s.file || ""}`.toLowerCase().includes(q);
    };
  }, [query, filter, noted]);

  const scene = useMemo(() => {
    if (!data) return null;
    // a search matches a screen by its project, its session's title and prompt, or its own words
    const shaped = {
      ...data,
      projects: data.projects.map((p) => ({
        ...p,
        sessions: p.sessions.map((s) => ({ ...s, screens: s.screens.filter((sc) => keep(sc, `${p.name} ${s.title} ${s.prompt}`)) })),
      })),
    };
    return layout(shaped, opened);
  }, [data, opened, keep]);

  const counts = useMemo(() => {
    const ss = data?.projects.flatMap((p) => p.sessions) || [];
    const sc = ss.flatMap((s) => s.screens);
    return { sessions: ss.length, screens: sc.length, changed: sc.filter((x) => x.before).length, working: ss.filter((s) => s.working).length };
  }, [data]);

  const target = useMemo(() => {
    if (!open || !data) return null;
    for (const p of data.projects) for (const s of p.sessions) {
      if (s.id !== open.session) continue;
      const screens = s.screens.slice().reverse();
      const i = screens.findIndex((x) => x.hash === open.hash);
      if (i >= 0) return { project: p, session: s, screens, index: i };
    }
    return null;
  }, [open, data]);

  const onOpen = useCallback((a: Area, s: Screen, at?: { x: number; y: number }) => show({ session: a.session.id, hash: s.hash, at }), []);

  return (
    <div className="app">
      <header className="bar">
        <a className="brand" href="/" aria-label="Scout Canvas">
          <span className="lockup" role="img" aria-label="Scout" />
          <span className="product">Canvas</span>
        </a>
        <span className="sep" />
        <div className="seg" role="group" aria-label="How far back">
          {WINDOWS.map((w) => <button key={w.h} aria-pressed={hours === w.h} onClick={() => setHours(w.h)}>{w.label}</button>)}
        </div>
        <div className="seg" role="group" aria-label="Which screens">
          <button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All</button>
          <button aria-pressed={filter === "changed"} onClick={() => setFilter("changed")}>Before / after</button>
          <button aria-pressed={filter === "notes"} onClick={() => setFilter("notes")}>With notes</button>
        </div>
        <input className="search" placeholder="Search screens, sessions, repos" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="grow" />
        {data && (
          <span className="chip counts">
            {counts.working > 0 && <><span className="dot accent" />{counts.working} working · </>}
            {counts.sessions} sessions · {counts.screens} screens · {counts.changed} before / after
          </span>
        )}
        <span className="sep" />
        <span className="chip" title={data?.scout.up ? "Scout's runtime answers on this Mac; notes go to sessions through it" : "Scout's runtime isn't answering; notes wait until it is"}>
          <span className={`dot ${data ? (data.scout.up ? "ok" : "bad") : ""}`} />
          {data ? (data.scout.up ? "Scout is up" : "Scout isn't running") : "Looking for Scout…"}
        </span>
      </header>
      {scene && scene.frames.length > 0 ? (
        <Canvas frames={scene.frames} bounds={scene.bounds} notes={notes} onOpen={onOpen} opened={opened}
          onMore={(id) => setOpened((o) => { const n = new Set(o); n.has(id) ? n.delete(id) : n.add(id); return n; })} />
      ) : (
        <div style={{ position: "relative" }}>
          <div className="empty">
            {error ? <div><b>The canvas couldn't load</b>{error}</div>
              : !data ? <div><b>Reading your sessions</b>The first read lifts every screen out of the transcripts, and can take a few seconds.</div>
              : <div><b>No screens here</b>{query || filter !== "all" ? "Nothing matches. Clear the search or the filter." : `No Claude Code session took a screen in the last ${hours} hours.`}</div>}
          </div>
        </div>
      )}
      {target && open && (
        <Stage
          key={target.session.id} session={target.session} project={target.project} screens={target.screens} index={target.index}
          notes={notes} at={open.at} scoutUp={!!data?.scout.up}
          onIndex={(i) => show({ session: target.session.id, hash: target.screens[i].hash })}
          onClose={() => show(null)} onNotes={loadNotes}
        />
      )}
    </div>
  );
}
