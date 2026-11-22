// The way in: a short sequence while Scout Canvas finds Scout and your sessions, then the canvas,
// landing on the latest session while the rest are read behind it.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CanvasData, Loading } from "./api";

const STEP_MS = 280; // the least each step shows, so the sequence reads as one

type Step = { label: string; done: boolean; detail?: string; warn?: boolean };

function steps(data: CanvasData | null, hours: number, ready: boolean, returning?: "back" | "link", landedOn?: string): Step[] {
  const window = hours === 24 ? "today" : hours === 168 ? "this week" : `in the last ${hours / 24} days`;
  return [
    {
      label: "Finding Scout", done: !!data,
      detail: data ? (data.scout.up ? "Scout is up" : "Scout isn't running. Notes wait until it is.") : undefined,
      warn: !!data && !data.scout.up,
    },
    {
      label: "Finding your Claude sessions", done: !!data,
      detail: data ? `${data.loading.sessions} ${data.loading.sessions === 1 ? "session" : "sessions"} ${window}` : undefined,
    },
    {
      label: returning === "link" ? "Opening what you were sent" : returning === "back" ? "Opening where you left off" : "Opening the latest one",
      done: ready, detail: ready ? landedOn : undefined,
    },
  ];
}

export function Arrival({ data, error, hours, filtered, ready, returning, landedOn, controls, children }: {
  data: CanvasData | null; error: string | null; hours: number; filtered: boolean; ready: boolean;
  returning?: "back" | "link"; landedOn?: string;
  /** what floats over the canvas once it shows, and over "nothing matches" so a filter can be undone */
  controls?: ReactNode; children: ReactNode;
}) {
  // how many steps have checked off; each waits for the one before and for its own condition
  const [checked, setChecked] = useState(0);
  const list = steps(data, hours, ready, returning, landedOn);
  const arrived = checked >= list.length;
  // the sequence plays once, on the way in; switching the window later goes straight to the canvas
  const ripe = !arrived && list[checked].done;
  useEffect(() => {
    if (!ripe) return;
    const t = setTimeout(() => setChecked((c) => c + 1), STEP_MS);
    return () => clearTimeout(t);
  }, [ripe, checked]);

  const empty = !!data && data.loading.done && !ready;
  if (error && !data) return <Message title="The canvas couldn't load" text={error} />;
  if (empty && checked >= 2) {
    return <>
      <Message title="No screens here" text={filtered ? "Nothing matches. Clear the search, or show more with the controls at the top right." : `No Claude Code session took a screen ${steps(data, hours, false)[1].detail?.replace(/^\d+ sessions? /, "")}.`} />
      {controls}
    </>;
  }
  return (
    <div className="arrival-wrap">
      {arrived && <div className="landed">{children}{controls}</div>}
      {!arrived && (
        <div className="arrival" role="status" aria-live="polite">
          <svg className="glyph" viewBox="5 -4 214 244" aria-hidden="true">
            <path d="M103.01 13.21 Q112 8 120.99 13.21 L198.01 57.79 Q207 63 207 73.39 L207 162.61 Q207 173 198.01 178.21 L120.99 222.79 Q112 228 103.01 222.79 L25.99 178.21 Q17 173 17 162.61 L17 73.39 Q17 63 25.99 57.79 Z" fill="none" stroke="currentColor" strokeWidth="24" strokeLinejoin="round" />
            <path d="M112 70 154 94v48l-42 24-42-24V94Z" fill="currentColor" />
          </svg>
          <ol>
            {list.map((s, i) => {
              const state = i < checked ? "done" : i === checked ? "now" : "later";
              return (
                <li key={s.label} className={state}>
                  <span className={`tick${s.warn && state === "done" ? " warn" : ""}`} aria-hidden="true" />
                  <span className="what">{s.label}</span>
                  {state === "done" && s.detail && <span className="detail">{s.detail}</span>}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}

function Message({ title, text }: { title: string; text: string }) {
  return (
    <div className="arrival-wrap">
      <div className="empty"><div><b>{title}</b>{text}</div></div>
    </div>
  );
}

/** While sessions are read: how far along. Once all are in, says so for a moment, then goes. */
export function Progress({ loading, counts }: { loading: Loading; counts: { sessions: number; screens: number } }) {
  const wasLoading = useRef(!loading.done);
  const [after, setAfter] = useState(false);
  useEffect(() => {
    if (!loading.done) { wasLoading.current = true; setAfter(false); return; }
    if (!wasLoading.current) return;
    wasLoading.current = false;
    setAfter(true);
    const t = setTimeout(() => setAfter(false), 2600);
    return () => clearTimeout(t);
  }, [loading.done]);

  if (loading.done && !after) return null;
  const pct = loading.total ? Math.min(100, Math.round((100 * loading.read) / loading.total)) : 0;
  return (
    <div className={`progress${loading.done ? " finished" : ""}`} role="status" aria-live="polite">
      <div className="bar"><i style={{ width: `${loading.done ? 100 : Math.max(4, pct)}%` }} /></div>
      <span>
        {loading.done
          ? <>All caught up · {counts.sessions} sessions · {counts.screens} screens</>
          : <>Reading your sessions · <span className="mono">{pct}%</span> · {counts.sessions} with screens so far</>}
      </span>
    </div>
  );
}
