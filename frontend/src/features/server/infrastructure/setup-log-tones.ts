import type { LogLine, LogTone } from "@/components/console/log-well";
import { stripTerminalEscapes } from "@/components/console/terminal-escapes";

/**
 * Setup output, given tones.
 *
 * Keyed to what **this** script prints, which is why it is not
 * `deploy/log-tones.ts`: that file's own doc says it is keyed to the build
 * commands, and BuildKit step headers have nothing to do with `apt-get`. Four
 * rules, because the script only has four kinds of line.
 */
const STEP_HEADER = /^\d\.\s/;

export function toSetupLines(lines: readonly string[]): LogLine[] {
  return lines.map((raw) => {
    const text = stripTerminalEscapes(raw);
    return { text, tone: setupTone(text) };
  });
}

function setupTone(text: string): LogTone | undefined {
  if (text.includes("❌")) return "bad";
  if (text.includes("✅")) return "ok";
  // `1. Installing required packages` — the same six numbers as the list above.
  if (STEP_HEADER.test(text)) return "hl";
  if (text.startsWith("Skipping ")) return "warn";
  return undefined;
}
