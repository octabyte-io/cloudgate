import { changeMark, CHANGE_TEXT, type ChangeKey } from "@/lib/design/status";
import { cn } from "@/lib/utils";

export type GutterMarkProps = {
  /** What this row's change does: create / change / replace / destroy / noop / read. */
  change: ChangeKey;
  className?: string;
};

/**
 * The signed mark down the left edge of a plan or a diff
 * (e-console.html:790-793): `+` create, `⇆` change, `−` destroy, `○` no-op.
 *
 * Mono and semibold so the column of glyphs lines up as a column. The word
 * rides along in an `sr-only` span — `−` and `+` are one pixel apart at 13px,
 * and the difference between them is a Server.
 */
export function GutterMark({ change, className }: GutterMarkProps) {
  const mark = changeMark(change);
  return (
    <span
      data-slot="gutter-mark"
      className={cn(
        "inline-block font-mono font-semibold",
        CHANGE_TEXT[mark.tone],
        className,
      )}
    >
      <span aria-hidden="true">{mark.glyph}</span>
      <span className="sr-only">{mark.label}</span>
    </span>
  );
}
