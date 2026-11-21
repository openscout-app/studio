import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type CanvasData, type Note, type Pointer, type Screen } from "./api";
import { Canvas } from "./Canvas";
import { Arrival, Progress } from "./Loading";
import { Stage } from "./Stage";
import { layout, type Area } from "./scene";
import { readPlace } from "./place";

const WINDOWS = [{ h: 24, label: "Today" }, { h: 72, label: "3 days" }, { h: 168, label: "Week" }];
type Filter = "all" | "notes" | "changed";
/** What's open: a session, maybe one of its screens, and a point a right-click or a pointer gave. */
type Open = { session: string; hash?: string; at?: { x: number; y: number }; pointer?: Pointer };

/** #s/<session> lands on a session; #s/<session>/<hash|latest> opens one of its screens. */
function readHash(): Open | null {
  const m = location.hash.match(/^#s\/([\w-]+)(?:\/([0-9a-f]{16}|latest))?\/?$/);
  return m ? { session: m[1], hash: m[2] } : null;
}
/** /p/<id>: a pointer an agent made, to be fetched */
const pointerId = () => location.pathname.match(/^\/p\/(p_[a-z0-9]+)\/?$/)?.[1];

export function App() {
  const [hours, setHours] = useState(() => Number(localStorage.getItem("scout-canvas:hours")) || 72);
  const [data, setData] = useState<CanvasData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Open | null>(readHash);
  // the session a link was opened for; it stays after its screen is closed, so the canvas stays put
  const [linked, setLinked] = useState<string | undefined>(() => readHash()?.session);
  const [missing, setMissing] = useState<string | null>(null);
  // a pointer link: fetch it, mark it seen, and open its screen at its spot
  useEffect(() => {
    const id = pointerId();
    if (!id) return;
    api.pointer(id).then(({ pointer: p }) => {
      setOpen({ session: p.session, hash: p.screen.hash, pointer: p });
      setLinked(p.session);
      api.seen(id).catch(() => {});
    }, () => setMissing("That link points at something Scout Canvas doesn't have. It may come from another Mac."));
  }, []);

  const loadNotes = useCallback(() => api.notes().then(setNotes, () => {}), []);
  // ask often while sessions are still being read, then settle to every 15 seconds
  useEffect(() => {
    try { localStorage.setItem("scout-canvas:hours", String(hours)); } catch {}
    let stop = false, timer = 0;
    setData((d) => (d && d.hours === hours ? d : null));
    const tick = () => api.canvas(hours).then(
      (d) => { if (stop) return; setData(d); setError(null); timer = window.setTimeout(tick, d.loading.done ? 15e3 : 450); },
      (e) => { if (stop) return; setError(String(e.message || e)); timer = window.setTimeout(tick, 5e3); },
    );
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [hours]);
  useEffect(() => { loadNotes(); const t = setInterval(loadNotes, 4e3); return () => clearInterval(t); }, [loadNotes]);
  useEffect(() => {
    const on = () => { const o = readHash(); setOpen(o); if (o) setLinked(o.session); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const show = (o: Open | null) => {
    setOpen(o);
    // a pointer keeps its own address while its screen is open; anything else is a plain screen link
    history.replaceState(null, "", o?.pointer ? `/p/${o.pointer.id}` : o?.hash ? `/#s/${o.session}/${o.hash}` : "/");
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
  // land back where you were if that session is in this window, else on the latest session. Sessions
  // are read newest first, so yours usually shows within a moment; past a short wait, take the latest.
  const place = useMemo(readPlace, [hours]);
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => { setGaveUp(false); const t = setTimeout(() => setGaveUp(true), 2500); return () => clearTimeout(t); }, [hours]);
  const areas = scene?.frames.flatMap((f) => f.areas) || [];
  const back = place ? areas.find((a) => a.session.id === place.session) : undefined;
  const asked = linked ? areas.find((a) => a.session.id === linked) : undefined;
  const settled = linked ? !!asked || !!data?.loading.done && hours >= 168 || gaveUp : !!back || !place || gaveUp || !!data?.loading.done;
  const ready = !!scene && scene.frames.length > 0 && settled;
  const landKey = asked ? `link:${asked.session.id}` : back ? `back:${back.session.id}` : `latest:${scene?.frames[0]?.areas[0]?.session.id}`;
  const focus = useMemo(() => {
    if (asked) return { box: asked.box };
    if (back && place) return { box: back.box, at: place };
    const f = scene?.frames[0], a = f?.areas[0];
    // (from the top of its repository's frame, so the repository's name shows above it)
    return f && a ? { box: { x: a.box.x, y: f.box.y, w: a.box.w, h: a.box.y + a.box.h - f.box.y } } : null;
  }, [landKey, ready]);
  const landedOn = (asked || back)?.session.title || scene?.frames[0]?.areas[0]?.session.title;

  const counts = useMemo(() => {
    const ss = data?.projects.flatMap((p) => p.sessions) || [];
    const sc = ss.flatMap((s) => s.screens);
    return { sessions: ss.length, screens: sc.length, changed: sc.filter((x) => x.before).length, working: ss.filter((s) => s.working).length };
  }, [data]);

  const target = useMemo(() => {
    if (!open?.hash || !data) return null;
    for (const p of data.projects) for (const s of p.sessions) {
      if (s.id !== open.session) continue;
      const screens = s.screens.slice().reverse();
      let i = open.hash === "latest" ? 0 : screens.findIndex((x) => x.hash === open.hash);
      // a pointer's screen is kept as it was, even if the session's screens have moved on since
      const ps = open.pointer?.screen;
      if (i < 0 && ps) {
        const sc: Screen = { id: `${s.id}:${ps.hash}`, ...ps, before: null, open: false };
        const j = screens.findIndex((x) => x.at < sc.at);
        i = j < 0 ? screens.length : j;
        screens.splice(i, 0, sc);
      }
      if (i >= 0 && screens[i]) return { project: p, session: s, screens, index: i };
    }
    return null;
  }, [open, data]);
  // a link to a session older than this window: widen the window once everything here is read
  const found = !!linked && !!data?.projects.some((p) => p.sessions.some((s) => s.id === linked));
  useEffect(() => {
    if (linked && data?.loading.done && data.hours === hours && !found && hours < 168) setHours(168);
  }, [linked, found, data?.loading.done, hours]);

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
      <Arrival data={data} error={error} hours={hours} filtered={!!query || filter !== "all"} ready={ready}
        returning={linked ? "link" : place ? "back" : undefined} landedOn={landedOn}>
        {scene && ready && (
          <Canvas key={`${hours}:${landKey.startsWith("link:") ? landKey : ""}`} frames={scene.frames} bounds={scene.bounds} notes={notes} focus={focus} onOpen={onOpen} opened={opened}
            onMore={(id) => setOpened((o) => { const n = new Set(o); n.has(id) ? n.delete(id) : n.add(id); return n; })} />
        )}
        {data && <Progress loading={data.loading} counts={counts} />}
      </Arrival>
      {missing && <div className="toast" role="alert" onClick={() => { setMissing(null); history.replaceState(null, "", "/"); }}>{missing}</div>}
      {target && open && (
        <Stage
          key={target.session.id} session={target.session} project={target.project} screens={target.screens} index={target.index}
          notes={notes} at={open.at} pointer={open.pointer} scoutUp={!!data?.scout.up}
          onIndex={(i) => show({ session: target.session.id, hash: target.screens[i].hash })}
          onClose={() => show(null)} onNotes={loadNotes}
        />
      )}
    </div>
  );
}
