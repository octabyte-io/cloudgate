import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";

/** A grid this small is not a terminal; the fit addon can propose 0 mid-layout. */
const MIN_COLS = 20;
const MIN_ROWS = 4;

/**
 * Size the grid to the frame, and answer what it now is.
 *
 * `fit.fit()` would do this and swallow the numbers; they are wanted, because
 * they are what the Server is told. `proposeDimensions` reads a container that is
 * mid-layout as 0 or NaN, and a grid of a handful of cells is not a terminal —
 * both are floored rather than sent.
 */
export function fitToFrame(
  instance: XTerm | null,
  fit: FitAddon | null,
): { cols: number; rows: number } | null {
  if (!instance || !fit) return null;
  const proposed = fit.proposeDimensions();
  if (!proposed) return null;
  if (!Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) {
    return null;
  }

  const cols = Math.max(MIN_COLS, proposed.cols);
  const rows = Math.max(MIN_ROWS, proposed.rows);
  if (cols !== instance.cols || rows !== instance.rows) {
    instance.resize(cols, rows);
  }
  return { cols, rows };
}
