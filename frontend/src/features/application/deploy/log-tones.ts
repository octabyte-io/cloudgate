import type { LogLine, LogTone } from "@/components/console/log-well";
import { stripTerminalEscapes } from "@/components/console/terminal-escapes";

/**
 * Raw build output, given tones.
 *
 * `LogWell` renders lines and deliberately does not parse them, because what
 * counts as a warning belongs to the tool writing the log. **This is that tool's
 * side of the contract**, and it is keyed to what *this* backend's own build
 * commands write, not to a general guess about build output:
 *
 * - `builders/strategies/*.strategy.ts` echo `✅ … completed.` on success and
 *   `❌ … failed` before exiting non-zero.
 * - `deployment-engine.service.ts` echoes `📦 [Enabled Registry Swarm]` /
 *   `🔑 [Enabled Build Registry]` before a push, `✅ Registry Login Success`,
 *   `✅ Image Pushed`, and on any failure appends
 *   `Error occurred ❌, check the logs for details.`
 * - the Update phase's convergence poll (`await-convergence.ts`)
 *   ends on one of
 *   `✅`, `❌` or `⚠️`. The `⚠️` line is the reason the marker below is matched
 *   at all: it is the *only* line this backend writes whose sentence carries no
 *   form of the word "warning", so the `WARNING` pattern would have left the one
 *   line an operator most needs to notice looking like ordinary output.
 * - everything else is stdout and stderr from git, docker, nixpacks or railpack,
 *   merged by `2>&1` — which is why a `warning:` from those is matched on the
 *   word rather than on a marker nobody agreed on.
 *
 * The markers stay **in** the text. They are what the backend chose to print, and
 * a screen that stripped them would be showing something other than the log.
 * **Terminal control sequences do not**
 * see
 * `terminal-escapes.ts`, which every `LogWell` line mapper shares.
 */

/** Docker BuildKit's step header — `#7 [build 3/6] RUN pnpm install`. */
const BUILDKIT_STEP = /^#\d+\s+\[/;

/**
 * One item of BuildKit's closing warning list — ` - UndefinedVar: Usage of
 * undefined variable '$NIXPACKS_PATH' (line 18)` under `1 warning found`.
 * The item is what says what is wrong, and it carries no form of the word
 * "warning" for {@link WARNING} to catch; only the header does.
 *
 * Narrow on purpose, because ` - ` starts list items in plenty of other tools'
 * output. Three things have to hold at once: exactly one space before the dash
 * (buildx's indent — a nested list is deeper), a PascalCase check-rule name
 * straight before the colon (`UndefinedVar`, `SecretsUsedInArgOrEnv`; a package
 * list's `express: 4.18.2` is lowercase), and a trailing `(line N)`, which is the
 * Dockerfile location every rule-check item ends on and ordinary lists do not.
 */
const BUILDKIT_CHECK = /^ - [A-Z][A-Za-z0-9]*: .+ \(line \d+\)$/;

/** git, npm and docker all print this the same way. */
const WARNING = /\b(warn|warning|deprecated)\b/i;

/** A line that is present but is not the point — a progress or count line. */
const NOISE = /^(\s*(#\d+\s+(sha256:|extracting|transferring|DONE|CACHED)|Progress|\.{3,}))/i;

export function toneOf(text: string): LogTone | undefined {
  if (text.includes("❌")) return "bad";
  if (text.includes("✅")) return "ok";
  if (text.includes("⚠️")) return "warn";
  if (text.includes("[Enabled ")) return "hl";
  if (text.startsWith("Starting ") || text.startsWith("Initializing ")) {
    return "hl";
  }
  if (BUILDKIT_STEP.test(text)) return "hl";
  if (WARNING.test(text) || BUILDKIT_CHECK.test(text)) return "warn";
  if (NOISE.test(text)) return "dim";
  return undefined;
}

/** The socket's or the fallback's lines, ready for the well. */
export function toBuildLines(lines: readonly string[]): LogLine[] {
  return lines.map((raw) => {
    const text = stripTerminalEscapes(raw);
    return { text, tone: toneOf(text) };
  });
}

/**
 * A finished Deployment's log arrives as **one string** — `GET /deployments/:id/logs`
 * sends `text/plain` (`api.getText`) — so it is split here rather than by the
 * socket's line buffer. A trailing newline would otherwise render as a blank
 * final line under the well's last real one, which reads as output still to come.
 */
export function splitLogText(text: string): readonly string[] {
  return text.replace(/\n$/, "").split(/\r?\n/);
}
