const names: Record<string, string> = { claude: "Claude", codex: "Codex", kimi: "Kimi", antigravity: "Antigravity", cursor: "Cursor", hermes: "Hermes", pi: "pi", grok: "Grok", opencode: "OpenCode" };
const monograms: Record<string, string> = { claude: "Cl", codex: "CX", kimi: "Ki", antigravity: "AG" };
const harnessId = (harness: string) => harness.toLowerCase() === "agy" ? "antigravity" : harness.toLowerCase();

export const harnessName = (harness = "claude") => names[harnessId(harness)] || harness;

export function HarnessCoin({ size = 14, harness = "claude" }: { size?: number; harness?: string }) {
  const name = harnessName(harness);
  return (
    <span className="harness-coin" role="img" title={name} aria-label={name}
      style={{ width: size, height: size, fontSize: size * 0.53 }}>
      {monograms[harnessId(harness)] || name.slice(0, 1)}
    </span>
  );
}
