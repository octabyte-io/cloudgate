import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

export type SubmitButtonProps = React.ComponentProps<typeof Button> & {
  /** The submit is in flight. Says so, and stops a second one. */
  pending?: boolean;
  /** Full width — what a form's one action is on a narrow column. */
  block?: boolean;
};

/**
 * The button that submits a form, while it is submitting.
 *
 * The label does **not** change to "Saving…". A control that renames itself
 * mid-press makes the person doubt what they pressed, and on a narrow column the
 * new word is usually a different width, so the button resizes under the cursor.
 * The label is the promise; the spinner is the progress.
 *
 * `disabled` and not a `pending` class, because F03 already decided what an off
 * action looks like: `Button` defaults Base UI's `focusableWhenDisabled`, so this
 * keeps its place in the tab order, keeps its focus ring, still swallows the
 * click, and picks up the one unlayered `[aria-disabled="true"]` rule in
 * `globals.css`. `aria-busy` is the half that says *why* it is off.
 *
 * Under `prefers-reduced-motion` the spinner settles instead of turning (the
 * blanket rule in `globals.css`), which is why the inert styling has to carry the
 * message on its own — it does.
 */
export function SubmitButton({
  pending,
  block,
  variant = "pri",
  disabled,
  children,
  className,
  ...props
}: SubmitButtonProps) {
  return (
    <Button
      type="submit"
      variant={variant}
      disabled={pending || disabled}
      aria-busy={pending || undefined}
      className={cn(block && "w-full", className)}
      {...props}
    >
      {pending ? <PendingIcon /> : null}
      {children}
    </Button>
  );
}

/**
 * The spinner `SubmitButton` shows while in flight, for a button that cannot be
 * one — a dialog's confirm that is not the form's only submit. Render it only
 * on the button that was pressed, before its unchanged label.
 */
export function PendingIcon() {
  return <Icon name="refresh" size={15} className="animate-spin" />;
}
