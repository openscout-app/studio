export type FeedbackPoint = { id: string; label: string; x: number; y: number; space: "fraction" | "canvas" };
export type FeedbackTarget = FeedbackPoint | { id: string; label: string; space: "general" };
export function isPoint(value: unknown): value is FeedbackPoint;
type Context = { project: string; destination: string; label: string };
export function mountWorkspaceTools(host: HTMLElement, options: Context & {
  product: string; onModeChange?: (enabled: boolean) => void; captureContent?: boolean;
}): { start(point: FeedbackTarget): void; setContext(context: Context): void; destroy(): void };
