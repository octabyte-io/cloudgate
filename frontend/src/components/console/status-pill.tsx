import {
  statusMark,
  TONE_PILL,
  type Mark,
  type StatusKey,
} from "@/lib/design/status";
import { cn } from "@/lib/utils";

export type StatusPillProps = { className?: string } & (
  | {
      /** One of our own enum values. A wrong key is a compile error. */
      status: StatusKey;
      mark?: never;
    }
  | {
      /**
       * A mark resolved from free text — `containerMark(row.state)`,
       * `taskMark(task.desiredState)`. Docker's vocabulary is not ours, and it
       * arrives over SSH as whatever the daemon printed.
       */
      mark: Mark;
      status?: never;
    }
);

/**
 * A status, in a word (e-console.html:577-590).
 *
 * There is no colour prop and there never will be: the key decides the tone,
 * so the same state cannot read as green on one screen and amber on the next.
 * The glyph is decoration — the word beside it is the status.
 */
export function StatusPill({ status, mark, className }: StatusPillProps) {
  const resolved = mark ?? statusMark(status);
  return (
    <span
      data-slot="status-pill"
      className={cn(
        "inline-flex h-pill items-center gap-1.25 rounded-pill border py-0 pr-2 pl-1.5 text-chip font-medium whitespace-nowrap",
        TONE_PILL[resolved.tone],
        className,
      )}
    >
      <span aria-hidden="true" className="text-glyph">
        {resolved.glyph}
      </span>
      {resolved.label}
    </span>
  );
}
