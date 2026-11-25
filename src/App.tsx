import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, count, type CanvasData, type Note, type Pointer, type Screen, type Session, type Show } from "./api";
import { Canvas } from "./Canvas";
import { Arrival, Progress } from "./Loading";
import { Stage } from "./Stage";
import { Reader } from "./Reader";
import { layout, type Area } from "./scene";
import { readPlace } from "./place";
import { NO_VIEW, START_HOURS, ViewControls, wider, type Filter, type View } from "./Controls";

const SETUP = "npx github:openscout-app/studio setup";

function readView(): View {
  try { return { ...NO_VIEW, ...JSON.parse(localStorage.getItem("scout-studio:view") || localStorage.getItem("scout-canvas:view") || "{}") }; } catch { return NO_VIEW; }
}
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
  // how far back: every visit starts short. Picking a window holds it for the visit; until then the canvas
  // widens on its own when the window holds no screens.
  // ?hours=24 in the address opens on that window, as if it had been picked
  const startAt = Number(new URLSearchParams(location.search).get("hours"));
  const given = [4, 24, 72].includes(startAt) ? startAt : 0;
  const [hours, setHours] = useState(given || START_HOURS);
  const [picked, setPicked] = useState(!!given);
  const pick = (h: number) => { setPicked(true); setHours(h); };
  const [data, setData] = useState<CanvasData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [query, setQuery] = useState("");
  const [reading, setReading] = useState<Show | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  // which projects and agents show, kept between visits
  const [view, setView] = useState<View>(readView);
  useEffect(() => { try { localStorage.setItem("scout-studio:view", JSON.stringify(view)); } catch {} }, [view]);
  const viewing = view.hiddenProjects.length > 0 || view.hiddenSessions.length > 0 || view.agents !== "all";
  // "/" goes to the search, as on Scout
  const find = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !/^(INPUT|TEXTAREA)$/.test(t.tagName) && !t.isContentEditable) { e.preventDefault(); find.current?.focus(); }
      if (e.key === "Escape" && t === find.current) { setQuery(""); find.current?.blur(); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
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
    }, () => setMissing("That link points at something Scout Studio doesn't have. It may come from another Mac."));
  }, []);

  const loadNotes = useCallback(() => api.notes().then(setNotes, () => {}), []);
  // ask often while sessions are still being read, then settle to every 15 seconds
  useEffect(() => {
    // pushed: the server sends the whole canvas when it opens and again each time it changes. If the
    // stream drops, poll until it is back (EventSource reconnects on its own).
    let stop = false, timer = 0, live = false;
    setData((d) => (d && d.hours === hours ? d : null));
    const poll = () => api.canvas(hours).then(
      (d) => { if (stop || live) return; setData(d); setError(null); timer = window.setTimeout(poll, d.loading.done ? 15e3 : 450); },
      (e) => { if (stop || live) return; setError(String(e.message || e)); timer = window.setTimeout(poll, 5e3); },
    );
    let es: EventSource | null = null;
    if (typeof EventSource === "function") {
      es = new EventSource(`/api/events?hours=${hours}`);
      es.addEventListener("canvas", (e) => {
        if (stop) return;
        live = true; clearTimeout(timer); timer = 0;
        setData(JSON.parse((e as MessageEvent).data)); setError(null);
      });
      es.onerror = () => { if (stop) return; live = false; if (!timer) timer = window.setTimeout(poll, 2e3); };
    } else poll();
    return () => { stop = true; clearTimeout(timer); es?.close(); };
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
    // and the projects and agents picked to show; a session a link opened always shows
    const hp = new Set(view.hiddenProjects), hs = new Set(view.hiddenSessions);
    const agent = (s: Session) => s.id === linked || (!hs.has(s.id) && (view.agents === "all" || (view.agents === "open" ? s.open : s.working)));
    const shaped = {
      ...data,
      projects: data.projects.filter((p) => !hp.has(p.root) || p.sessions.some((s) => s.id === linked)).map((p) => ({
        ...p,
        sessions: p.sessions.filter(agent).map((s) => ({
          ...s, screens: s.screens.filter((sc) => keep(sc, `${p.name} ${s.title} ${s.prompt}`)),
          // a shown file has no notes or before/after yet, so only the plain view and search keep it
          shows: (s.shows || []).filter((sh) => filter === "all" && (!query.trim() || `${p.name} ${s.title} ${s.prompt} ${sh.name} ${sh.path} ${sh.caption}`.toLowerCase().includes(query.trim().toLowerCase()))),
        })),
      })),
    };
    return layout(shaped, opened);
  }, [data, opened, keep, view, linked, filter, query]);
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
    if (linked && data?.loading.done && data.hours === hours && !found && hours < 168) setHours(wider(hours));
  }, [linked, found, data?.loading.done, hours]);
  // nothing in the last few hours: look further back, a step at a time, unless a window was picked
  const empty = !!data?.loading.done && data.hours === hours && !data.projects.some((p) => p.sessions.some((s) => s.screens.length || s.shows?.length));
  useEffect(() => {
    if (!picked && !linked && empty && hours < 72) setHours(wider(hours));
  }, [picked, linked, empty, hours]);

  const onOpen = useCallback((a: Area, s: Screen, at?: { x: number; y: number }) => show({ session: a.session.id, hash: s.hash, at }), []);

  return (
    <div className="app">
      <header className="bar">
        <div className="bar-side">
          <a className="brand" href="/" aria-label="Scout Studio">
            <span className="mark" aria-hidden="true" />Scout Studio
          </a>
        </div>
        <label className="find">
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.8" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="m10.6 10.6 3.4 3.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          <input ref={find} className="search" placeholder="Search screens, sessions, repos" aria-label="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
          <kbd aria-hidden="true">/</kbd>
        </label>
        <div className="bar-side end">
          {data && (
            <span className="chip counts">
              {counts.working > 0 && <><span className="dot accent" />{counts.working} working · </>}
              {count(counts.sessions, "session")}
            </span>
          )}
          {data && <span className="sep" />}
          <span className="chip runtime-status" title={data?.scout.up ? "Scout's runtime answers on this Mac; notes go to sessions through it" : `Scout's runtime isn't answering; notes wait until it is. To start it: ${SETUP}`}>
            <span className={`dot ${data ? (data.scout.up ? "ok" : "bad") : "accent"}`} />
            {data ? (data.scout.up ? "Scout is up" : "Scout isn't running") : "Looking for Scout…"}
          </span>
        </div>
      </header>
      <main className="field">
        {data && !data.scout.up && (
          <aside className="setup-colophon" aria-label="Scout setup">
            <p>Notes wait until Scout is running. Start it with <code>{SETUP}</code>.</p>
          </aside>
        )}
        <Arrival data={data} error={error} hours={hours} filtered={!!query || filter !== "all" || viewing} ready={ready}
          returning={linked ? "link" : place ? "back" : undefined} landedOn={landedOn}
          controls={data && <ViewControls data={data} hours={hours} setHours={pick} filter={filter} setFilter={setFilter} view={view} setView={setView} />}>
          {scene && ready && (
            <Canvas key={`${hours}:${landKey.startsWith("link:") ? landKey : ""}`} frames={scene.frames} bounds={scene.bounds} notes={notes} focus={focus} onOpen={onOpen} opened={opened} onShow={setReading}
              onMore={(id) => setOpened((o) => { const n = new Set(o); n.has(id) ? n.delete(id) : n.add(id); return n; })} />
          )}
          {data && <Progress loading={data.loading} counts={counts} />}
        </Arrival>
      </main>
      {missing && <div className="toast" role="alert" onClick={() => { setMissing(null); history.replaceState(null, "", "/"); }}>{missing}</div>}
      {reading && <Reader show={reading} onClose={() => setReading(null)} />}
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
