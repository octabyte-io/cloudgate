/**
 * Measure what the screen is actually showing.
 *
 * The token contract makes claims about contrast — `--tx`, `--tx-2` and
 * `--tx-3` are all ≥4.5:1 on `--panel` in both themes, white on `--brand` is
 * ≥4.5:1 — and a claim nobody measures is a claim that quietly stops being
 * true. This reads the role token off the live document, resolves it to the
 * sRGB the browser paints, and computes the WCAG ratio. Used by the token
 * gallery at /dev/tokens, and by any later consistency audit.
 *
 * Browser-only: it needs a canvas to do the colour-space conversion, which is
 * also what makes it honest — the number comes from the painted pixel, not from
 * a second implementation of oklch.
 */

export type Rgb = { r: number; g: number; b: number };

let probe: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
  if (probe === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    probe = canvas.getContext("2d", { willReadFrequently: true });
  }
  return probe;
}

/** The computed value of a role token, with var() already substituted. */
export function tokenValue(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

/**
 * Any CSS colour the browser can parse — oklch, hex, rgb() — as the sRGB
 * triple it paints. Returns null when the browser cannot parse it, so a
 * failure shows as "—" rather than as a plausible wrong number.
 */
export function toRgb(color: string): Rgb | null {
  const ctx = context();
  if (!ctx || !color) return null;

  // fillStyle keeps its previous value when handed something unparseable, so
  // seed it with a known colour and check that it moved. The getter normalises
  // to six-digit hex for opaque sRGB, so the sentinel has to be compared in
  // that form.
  ctx.fillStyle = "#000000";
  ctx.fillStyle = color;
  if (ctx.fillStyle === "#000000" && !/^(#000000|#000|black)$/i.test(color)) {
    return null;
  }

  ctx.clearRect(0, 0, 1, 1);
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return { r, g, b };
}

/**
 * A role token as the sRGB hex the browser paints it. Reading the computed
 * custom property back gives you Chrome's own normalisation — `lab(98.55% 0
 * -.0000119209)` — which is accurate and unreadable. The hex is what the eye
 * gets, and it is the same length every time.
 */
export function tokenHex(name: string): string | null {
  const rgb = toRgb(tokenValue(name));
  if (!rgb) return null;
  const pair = (v: number) => v.toString(16).padStart(2, "0");
  return `#${pair(rgb.r)}${pair(rgb.g)}${pair(rgb.b)}`;
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2 relative luminance. */
export function luminance({ r, g, b }: Rgb): number {
  return (
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  );
}

/** WCAG 2 contrast ratio, 1–21. Null if either colour could not be read. */
export function contrastRatio(
  foreground: string,
  background: string,
): number | null {
  const fg = toRgb(foreground);
  const bg = toRgb(background);
  if (!fg || !bg) return null;

  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** The same, for two role tokens: contrastOf("--tx", "--panel"). */
export function contrastOf(
  foreground: string,
  background: string,
): number | null {
  return contrastRatio(tokenValue(foreground), tokenValue(background));
}
