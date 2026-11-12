import { cn } from "@/lib/utils";

export type MeterTone = "brand" | "warn" | "alarm" | "mute";

const FILL: Record<MeterTone, string> = {
  brand: "bg-brand",
  warn: "bg-warn",
  alarm: "bg-bad",
  mute: "bg-tx-4",
};

/** The word a tone has to say out loud when the caller has not said it. */
const TONE_WORD: Partial<Record<MeterTone, string>> = {
  warn: "near its limit",
  alarm: "over its limit",
};

const TONE_TEXT: Record<MeterTone, string> = {
  brand: "text-tx-3",
  warn: "text-warn",
  alarm: "text-bad",
  mute: "text-tx-3",
};

export type MeterProps = Omit<React.ComponentProps<"div">, "children"> & {
  /** What is being measured: "Disk", "Memory", "Build minutes". */
  label: React.ReactNode;
  /** The figure, written out: "38.4 of 40 GB". Always visible. */
  value: React.ReactNode;
  /** 0–100. Clamped, because a live number occasionally arrives at 103. */
  percent: number;
  tone?: MeterTone;
  /**
   * Why the tone is what it is: "3 days left", "no headroom". Required in
   * spirit for `warn` and `alarm` — see the note below.
   */
  note?: string;
};

/**
 * How far along, or how full (e-console.html:658-662, 682-684).
 *
 * The bar is `aria-hidden`: the label and the figure above it are the same
 * information in words, already on screen, and a `role="meter"` here would
 * announce "82%" a second time in a row. The picture is for the eye.
 *
 * Which means a **tone can never be the only thing saying there is a problem**.
 * A red bar is red to someone who can see red. So `warn` and `alarm` render a
 * word beside the figure — the caller's `note` if there is one, and a plain
 * "near its limit" / "over its limit" if there is not.
 *
 * The track stays `--raise-2` rather than becoming a lighter step of the fill's
 * own hue, which is what a general chart guide would ask for. Measured, ours
 * cannot: `--warn-tint` is L 0.968 against a `--panel` of 1.0, so a tinted
 * track would disappear on a light card and the meter would lose the one thing
 * it is for — showing how much is left.
 */
export function Meter({
  className,
  label,
  value,
  percent,
  tone = "brand",
  note,
  ...props
}: MeterProps) {
  const filled = Math.max(0, Math.min(100, percent));
  const word = note ?? TONE_WORD[tone];

  return (
    <div data-slot="meter" className={className} {...props}>
      <div className="mb-1.75 flex items-baseline gap-2 text-ui">
        <span className="min-w-0 flex-1 text-tx-2">{label}</span>
        <span className="num font-medium text-tx">{value}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-pill bg-raise-2">
        <div
          aria-hidden="true"
          className={cn(
            "h-full rounded-pill transition-[width] duration-300 ease-out",
            FILL[tone],
          )}
          style={{ width: `${filled}%` }}
        />
      </div>
      {word ? (
        <p className={cn("mt-1.25 text-meta", TONE_TEXT[tone])}>{word}</p>
      ) : null}
    </div>
  );
}
