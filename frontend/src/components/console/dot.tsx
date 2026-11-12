import {
  statusMark,
  TONE_FILL,
  type Mark,
  type StatusKey,
} from "@/lib/design/status";
import { cn } from "@/lib/utils";

export type DotProps = { className?: string } & (
  | { status: StatusKey; mark?: never }
  | { mark: Mark; status?: never }
);

/**
 * A status where there is only room for a status (e-console.html:604-610) —
 * the left edge of a table row, beside a name in a rail.
 *
 * It always ships its word in an `sr-only` span. A bare coloured dot is not a
 * status; it is a decoration next to one, and for anyone who cannot separate
 * the two hues it is nothing at all.
 */
export function Dot({ status, mark, className }: DotProps) {
  const resolved = mark ?? statusMark(status);
  return (
    <span
      data-slot="dot"
      className={cn(
        "inline-block size-2 rounded-pill align-middle",
        TONE_FILL[resolved.tone],
        className,
      )}
    >
      <span className="sr-only">{resolved.label}</span>
    </span>
  );
}
