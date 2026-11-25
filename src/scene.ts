// Where everything sits, in world units, on Scout's canvas grid: each repository is a frame, each
// session an area in it, and an area's screens are cards four across, newest first. Frames fill
// two columns, the shorter one first.
import type { CanvasData, Project, Screen, Session, Show } from "./api";
import { groupShows, type ShowGroup } from "./folio";

export const CARD_W = 232;
export const MEDIA_H = 145;
export const CARD_H = MEDIA_H + 50;
export const GAP = 16;
export const LABEL_H = 70;
export const COLS = 4;
/** cards an area shows until it's opened out */
export const SHOWN = 8;
const AREA_W = COLS * CARD_W + (COLS - 1) * GAP;
const AREA_GAP = 36;
export const FRAME_HEAD = 56;
const PAD = 24;
export const FRAME_W = AREA_W + 2 * PAD;
const COLUMN_GAP = 72;
const ORIGIN = 40;

export type Box = { x: number; y: number; w: number; h: number };
export type Card = { screen: Screen; box: Box };
export type ShowCard = ShowGroup & { box: Box };
export type Area = { session: Session; project: Project; box: Box; cards: Card[]; shows: ShowCard[]; hidden: number };
export type Frame = { project: Project; box: Box; areas: Area[] };

export function layout(
  data: CanvasData,
  opened: Set<string>,
  keep: (s: Screen) => boolean = () => true,
  fanned: ReadonlySet<string> = new Set(),
): { frames: Frame[]; bounds: Box } {
  const cols = [ORIGIN, ORIGIN];
  const frames: Frame[] = [];
  for (const project of data.projects) {
    const c = cols[0] <= cols[1] ? 0 : 1;
    const x = ORIGIN + c * (FRAME_W + COLUMN_GAP);
    let y = cols[c] + FRAME_HEAD;
    const areas: Area[] = [];
    for (const session of project.sessions) {
      const all = session.screens.filter(keep).slice().reverse();
      const docs = groupShows(session.shows || [], fanned);
      if (!all.length && !docs.length) continue;
      const shown = opened.has(session.id) ? all : all.slice(0, SHOWN);
      const at = (i: number) => ({ x: x + PAD + (i % COLS) * (CARD_W + GAP), y: y + LABEL_H + Math.floor(i / COLS) * (CARD_H + GAP), w: CARD_W, h: CARD_H });
      const shows: ShowCard[] = docs.map((group, i) => ({ ...group, box: at(i) }));
      const cards = shown.map((screen, i) => ({ screen, box: at(docs.length + i) }));
      const rows = Math.ceil((docs.length + shown.length) / COLS);
      const h = LABEL_H + rows * CARD_H + (rows - 1) * GAP;
      areas.push({ session, project, box: { x: x + PAD, y, w: AREA_W, h }, cards, shows, hidden: all.length - shown.length });
      y += h + AREA_GAP;
    }
    if (!areas.length) continue;
    const box = { x, y: cols[c], w: FRAME_W, h: y - AREA_GAP + PAD - cols[c] };
    frames.push({ project, box, areas });
    cols[c] = box.y + box.h + COLUMN_GAP;
  }
  const right = frames.reduce((m, f) => Math.max(m, f.box.x + f.box.w), 0);
  const bottom = Math.max(...cols);
  return { frames, bounds: { x: 0, y: 0, w: right + ORIGIN, h: bottom } };
}
