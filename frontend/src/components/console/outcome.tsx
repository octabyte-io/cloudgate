import { Page } from "@/components/console/page";
import { Icon, type IconName } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

/** Which of the four things happened. Never hue alone — the heading says it too. */
export type OutcomeTone = "ok" | "info" | "warn" | "bad";

const MARK: Record<OutcomeTone, string> = {
  ok: "border-ok-line bg-ok-tint text-ok",
  info: "border-info-line bg-info-tint text-info",
  warn: "border-warn-line bg-warn-tint text-warn",
  bad: "border-bad-line bg-bad-tint text-bad",
};

export type OutcomeProps = {
  tone: OutcomeTone;
  icon: IconName;
  /** What happened, as a statement. Not a question, not an apology. */
  title: string;
  children?: React.ReactNode;
  /** Somewhere real to go. A terminal state with no way out is a dead end. */
  action?: React.ReactNode;
  className?: string;
};

/**
 * How a console screen ends when there is no screen — a bad id, an address that
 * names nothing, a page that threw. `e-console.html` has none of these, because a
 * prototype has no bad ids.
 *
 * **Not `EmptyState`.** That one is an invitation to act on a thing that exists
 * and is empty, and its action creates the first one. Offering to *create* an
 * Application because a link was mistyped would be an appalling answer. The
 * action here goes somewhere that certainly exists.
 *
 * **Not `AuthOutcome`** either, though they are cousins and the tone reasoning is
 * the same one: the mark is tinted *and* the heading states it in words, so the
 * hue never carries the meaning. The difference is scale — that one is a
 * statement inside a 400px column, this one is a whole page and its title is the
 * page's `<h1>`. A page with no heading is a page a screen reader cannot
 * describe.
 *
 * Tone is the caller's, and the two live cases are worth naming: a missing
 * resource is `info`, because nothing failed — a row was deleted, or an address
 * belongs to another Organization — and painting that red sends an operator
 * looking for an outage. A render that threw is `bad`, because something did.
 */
export function Outcome({
  tone,
  icon,
  title,
  children,
  action,
  className,
}: OutcomeProps) {
  return (
    <Page className={cn("grid place-items-center pt-16 text-center", className)}>
      {/* Arrives once, in place of the screen that was meant to be here. */}
      <div className="grid max-w-copy animate-rise justify-items-center gap-2.5">
        <span
          className={cn(
            "mb-0.5 grid size-11 place-items-center rounded-pill border",
            MARK[tone],
          )}
        >
          <Icon name={icon} size={20} />
        </span>
        <h1 className="text-sect wrap-anywhere text-tx">{title}</h1>
        {children ? (
          <p className="text-body wrap-anywhere text-tx-2">{children}</p>
        ) : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </Page>
  );
}
