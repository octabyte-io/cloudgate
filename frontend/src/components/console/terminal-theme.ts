import type { ITheme } from "@xterm/xterm";

/**
 * The terminal's colours, out of our own tokens.
 *
 * Two things about this are decisions rather than plumbing.
 *
 * **The palette is theme-independent, and that is the `--well*` contract working.**
 * `--well` is `oklch(0.19)` in light mode and in dark mode, declared once — a rack
 * in a lit room still has black displays. So there is nothing to re-read when
 * someone switches the theme, and a terminal cannot end up as the one surface that
 * did not follow.
 *
 * **The 16 ANSI colours are left as xterm's own.** An ANSI colour is chosen by the
 * program you are talking to — `ls` paints a directory blue, `git diff` paints a
 * deletion red — so remapping them onto our ramp would be the console overruling
 * the tool it is showing, and would make `--bad` mean "a removed line" here and
 * "something is wrong" everywhere else. F12 decided the opposite way about YAML
 * highlighting, because there the colours genuinely are ours to pick. xterm's
 * defaults are designed against a dark background, which this one is.
 */

/** The four that are ours: the surface, the text, the cursor, the selection. */
export function wellTheme(): ITheme {
  return {
    background: resolveColor("var(--well)"),
    foreground: resolveColor("var(--well-tx)"),
    cursor: resolveColor("var(--well-hl)"),
    cursorAccent: resolveColor("var(--well)"),
    // F12's editor selection, for the same measured reason: `--brand-tint` is
    // stepped against `--panel`, so in light mode it is near-white and a
    // selection painted with it would swallow the text on a near-black well.
    selectionBackground: resolveColor(
      "color-mix(in oklab, var(--well-hl) 28%, transparent)",
    ),
  };
}

/** The `--font-mono` stack, so a terminal is set in the same face as a log. */
export function monoStack(): string {
  const declared = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-mono")
    .trim();
  return declared || "ui-monospace, monospace";
}

/**
 * A CSS colour, as sRGB bytes.
 *
 * Every token in this codebase is `oklch()`, and xterm parses colours with its
 * own parser rather than the browser's — one that predates CSS Color 4. Handing
 * it `oklch(0.19 0 0)` gets the value dropped and xterm's default used instead,
 * silently, on this one surface. So the browser is asked instead: paint the value
 * into a 1 × 1 canvas and read the pixel back. That is also the only thing that
 * can answer for a `color-mix()` of two custom properties.
 *
 * Two steps, and both are needed. A custom property only resolves against an
 * element in the document, so a throwaway probe does that; then the canvas turns
 * whatever the browser computed into bytes.
 *
 * The sentinel catches a value the browser could not parse: assigning a bad
 * `fillStyle` **keeps the previous value** rather than throwing, so without it an
 * unparsed token would come back as whatever was set before it — which is the
 * quietest possible way for this function to lie.
 */
export function resolveColor(value: string): string {
  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return resolved;

  const SENTINEL = "#ff00ff";
  ctx.fillStyle = SENTINEL;
  ctx.fillStyle = resolved;
  // Unparsable: hand back what the browser said and let xterm decide. A dropped
  // selection tint is cosmetic; a wrong one read as a real colour is not.
  if (ctx.fillStyle === SENTINEL && resolved !== SENTINEL) return resolved;

  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return a === 255
    ? `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`
    : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}
