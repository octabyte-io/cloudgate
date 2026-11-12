/**
 * The chart palette, and the one place a chart's colour is chosen.
 *
 * There are **two** vocabularies here and keeping them apart is the whole
 * point of the file.
 *
 * 1. **Tone — state.** A plot of one series that goes `hot` when the thing it
 *    measures is in trouble, `mute` when nothing is reporting, `dead` when the
 *    series has stopped. These read `--chart-1..5`, which are brand / ok / warn
 *    / bad / tx-4: our status colours, used for status. Every tone is rendered
 *    beside a word — a status pill, a "no data" label — never on its own.
 *
 * 2. **Slot — identity.** A total split by its parts, where the colour says
 *    *which part* and nothing about how it is doing. These read `--series-1..4`,
 *    a categorical ramp validated in both themes with our status hues
 *    excluded, so a segment can never be mistaken for a state. See section 1b
 *    of `globals.css` for the measurements and for why there are four of them
 *    and not five.
 *
 * Three rules follow from the split, and breaking any of them is how a chart
 * starts lying:
 *
 * - **A slot belongs to the entity, not to its rank.** Assign by a stable key,
 *   in a fixed order. Filtering a part out must not repaint the survivors.
 * - **A fifth part is not a fifth hue.** It folds into `other`, which is
 *   deliberately achromatic. Never generate a hue for a sixth.
 * - **Text never wears the data colour.** Labels, values and legends take text
 *   tokens; identity comes from the mark *beside* the word. A light categorical
 *   hue is illegible as 12px text on `--panel`, in either theme.
 */

/* ------------------------------------------------------------------ *
 * Tone — state
 * ------------------------------------------------------------------ */

export type PlotTone = "brand" | "hot" | "mute" | "dead";

/** The line. `dead` is dashed as well as red: the shape says "stopped" too. */
export const PLOT_STROKE: Record<PlotTone, string> = {
  brand: "stroke-chart-1",
  hot: "stroke-chart-4",
  mute: "stroke-chart-5",
  dead: "stroke-chart-4",
};

/** The wash under the line, at the opacity set on the element. */
export const PLOT_FILL: Record<PlotTone, string> = {
  brand: "fill-chart-1",
  hot: "fill-chart-4",
  mute: "fill-chart-5",
  dead: "fill-none",
};

/**
 * The wash's opacity. ~10% is a wash rather than a block; a `mute` series is
 * fainter still because there is nothing to read, and a `dead` one has no fill
 * at all — its dashed line is the whole statement. One map for the plot and the
 * sparkline: a 1% difference between two charts on the same screen is not a
 * distinction anyone can see, and it is one more thing to keep in step.
 */
export const PLOT_AREA: Record<PlotTone, string> = {
  brand: "opacity-10",
  hot: "opacity-10",
  mute: "opacity-6",
  dead: "opacity-0",
};

/**
 * The scrub dot, which is HTML rather than SVG (see `plotGeometry`) and so
 * needs a `bg-` class rather than a `fill-` one. Written out rather than
 * derived from the map above: Tailwind reads the classes that literally appear
 * in the source, so a class assembled at runtime is a class that was never
 * compiled.
 */
export const PLOT_DOT: Record<PlotTone, string> = {
  brand: "bg-chart-1",
  hot: "bg-chart-4",
  mute: "bg-chart-5",
  dead: "bg-chart-4",
};

/* ------------------------------------------------------------------ *
 * Slot — identity
 * ------------------------------------------------------------------ */

export type SeriesSlot = 0 | 1 | 2 | 3 | "other";

export const SERIES_SLOTS = [0, 1, 2, 3] as const satisfies SeriesSlot[];

/** A segment of a bar, or the swatch in front of its word in the legend. */
export const SERIES_FILL: Record<SeriesSlot, string> = {
  0: "bg-series-1",
  1: "bg-series-2",
  2: "bg-series-3",
  3: "bg-series-4",
  other: "bg-series-other",
};

/**
 * The slot for the nth part of a whole. Past the fourth, everything is
 * `other` — which is the honest answer, not a shortage. Four hues is what
 * clears every pair under simulated protanopia and deuteranopia, in both
 * themes, without borrowing a status hue.
 */
export function seriesSlot(index: number): SeriesSlot {
  return index >= 0 && index <= 3 ? (index as SeriesSlot) : "other";
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/**
 * The default domain. Every telemetry series the backend streams is a
 * percentage — the stats gateway reports cpu, memory and disk that way — so a
 * plot is drawn against 0–100 and not against its own extremes. Autoscaling a
 * percentage turns 3% of jitter into a mountain range. A series that is not a
 * percentage passes its own domain, and says what the units are.
 */
export const PERCENT: readonly [number, number] = [0, 100];

export type PlotGeometry = {
  /** The `points` attribute for the line. */
  line: string;
  /** The same points, closed down to the baseline, for the wash under it. */
  area: string;
  /** Each point as a percentage of the box, for positioning HTML over the SVG. */
  at: { x: number; y: number }[];
};

/**
 * Series → SVG polyline points, in a `0 0 100 <height>` viewBox.
 *
 * The box is stretched to the panel's width by `preserveAspectRatio="none"`,
 * which is why every stroke drawn from these points needs
 * `vector-effect: non-scaling-stroke` — without it the dash pattern and the
 * line weight distort with the width of the container. It is also why a *dot*
 * on this line cannot be an SVG circle: it would come out an ellipse. `at`
 * exists so the dot and the crosshair can be HTML sitting on top instead.
 */
export function plotGeometry(
  values: number[],
  {
    height,
    domain = PERCENT,
    padTop = 1,
    padBottom = 1,
  }: {
    height: number;
    domain?: readonly [number, number];
    padTop?: number;
    padBottom?: number;
  },
): PlotGeometry {
  const [min, max] = domain;
  const span = max - min || 1;
  const floor = height - padBottom;
  const reach = floor - padTop;
  const last = Math.max(values.length - 1, 1);

  const at = values.map((value, index) => {
    const t = Math.max(0, Math.min(1, (value - min) / span));
    return { x: (index / last) * 100, y: ((floor - t * reach) / height) * 100 };
  });

  const line = at
    .map(({ x, y }) => `${x.toFixed(2)},${((y / 100) * height).toFixed(2)}`)
    .join(" ");

  return { line, area: `${line} 100,${height} 0,${height}`, at };
}
