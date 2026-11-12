import { Icon, type IconName } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

/** Which of the four things happened. Never hue alone — the heading says it too. */
export type OutcomeTone = "ok" | "bad" | "info" | "warn";

const RING: Record<OutcomeTone, string> = {
  ok: "border-ok-line bg-ok-tint text-ok",
  bad: "border-bad-line bg-bad-tint text-bad",
  info: "border-info-line bg-info-tint text-info",
  warn: "border-warn-line bg-warn-tint text-warn",
};

export type AuthOutcomeProps = {
  tone: OutcomeTone;
  icon: IconName;
  /** What happened, as a statement. Not a question, not an apology. */
  title: string;
  children?: React.ReactNode;
  /** What to do about it. A state with no way out of it is a dead end. */
  action?: React.ReactNode;
  className?: string;
  /**
   * The heading, for a screen that moves focus to the outcome after a submit
   * — without it, focus stayed on the button that was just removed,
   * which leaves it on `<body>`. Given one, the heading takes `tabIndex={-1}`.
   */
  headingRef?: React.Ref<HTMLHeadingElement>;
};

/**
 * How an auth screen ends when there is no form left to show.
 *
 * These screens are unusual in the app: several of them have terminal states that
 * are not errors and not empty — a reset link that has been spent, an invitation
 * already accepted, a reset email on its way. Each is the *whole* answer, so it
 * replaces the form rather than sitting above it.
 *
 * Not `EmptyState`, which is the same shape but carries no tone and is written for
 * "nothing here yet — go and make one". The difference that matters is the tone:
 * "we have sent you an email" and "this link is dead" cannot look the same, and
 * they cannot rely on the hue to say which, so the mark is tinted *and* the
 * heading states it in words.
 *
 * It **rises** into the card, once: it is the whole answer to what was just
 * submitted, arriving where the form stood, and the title above it does not
 * move.
 */
export function AuthOutcome({
  tone,
  icon,
  title,
  children,
  action,
  className,
  headingRef,
}: AuthOutcomeProps) {
  return (
    <div
      className={cn(
        "grid animate-rise justify-items-center gap-2.5 py-2 text-center",
        className,
      )}
    >
      <span
        className={cn(
          "mb-0.5 grid size-11 place-items-center rounded-pill border",
          RING[tone],
        )}
      >
        <Icon name={icon} size={20} />
      </span>
      <h2
        ref={headingRef}
        tabIndex={headingRef ? -1 : undefined}
        className="text-body font-semibold wrap-anywhere text-tx outline-none"
      >
        {title}
      </h2>
      {children ? (
        <p className="text-body wrap-anywhere text-tx-2">{children}</p>
      ) : null}
      {action ? <div className="mt-2 w-full">{action}</div> : null}
    </div>
  );
}
