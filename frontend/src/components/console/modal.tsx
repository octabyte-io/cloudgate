import type { ComponentProps } from "react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type ModalProps = ComponentProps<typeof DialogContent> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Optional — a modal opened from code passes `open` instead. */
  trigger?: React.ReactNode;
  /** 860px instead of 600px, for a form with two columns or a diff. */
  wide?: boolean;
  /**
   * Refuse to close on a click outside or on Escape (F16).
   *
   * **Set it only while the dialog holds something the person cannot get back.**
   * A modal you cannot dismiss by clicking away is a modal that has taken the
   * page hostage, and the reflex to click the backdrop is deep enough that
   * turning it off feels like a bug. The exceptions are the reveals of a value
   * no route hands out again: the two-factor enrolment's ten backup codes, a
   * new personal key, an Agent's first key — and a few dialogs holding pasted
   * credentials or a teardown report while they matter.
   *
   * A backdrop click and a single Escape press are both the *accidental*
   * gesture, so both are refused (Escape cost a key in testing). The
   * close button and the dialog's own buttons still work — this is not about
   * trapping anybody.
   */
  keepOpen?: boolean;
};

/**
 * Everything a Tab can land on. Our `Button` marks an off action
 * `aria-disabled` rather than `disabled` (F03's one inert rule) precisely so it
 * keeps its place in the tab order, so this deliberately does not filter those
 * out. `[tabindex="0"]` catches base-ui's `Switch`, which is a `span`.
 */
export const TABBABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex^="-"])';

function tabbablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) =>
      !el.hasAttribute("inert") &&
      !el.closest("[inert]") &&
      el.getClientRects().length > 0,
  );
}

/**
 * Keep Tab inside the dialog.
 *
 * **F19 added this, after measuring that nothing else was doing it.** Base UI
 * renders its focus guards — two `[data-base-ui-focus-guard]` spans, present in
 * the DOM — and marks everything outside the popup `aria-hidden`, but tabbing
 * past the last control in an open dialog walked straight out: guard, then the
 * skip link, then the wordmark, the Organization switcher and the whole rail.
 * Driven on the Add-a-domain dialog: sixteen Tabs from the Host field ended on
 * "Your account" in the masthead, with the dialog still open.
 *
 * That combination is worse than either half alone. The background is
 * `aria-hidden`, so a screen reader following that focus is told **nothing** at
 * all while it moves through six controls; and the controls it lands on are the
 * ones behind a scrim that exists to say they are unavailable. It applies to
 * every dialog in the console and to ⌘K, which is built on this component — one
 * of the two things the phase index calls the product's signature.
 *
 * So containment lives here rather than being assumed of the library. It is the
 * plain wrap: from the last control forward goes to the first, from the first
 * backward goes to the last, and focus that has already escaped is pulled back.
 */
export function containTab(event: React.KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab" || event.defaultPrevented) return;

  const root = event.currentTarget;
  const stops = tabbablesIn(root);
  if (stops.length === 0) return;

  const first = stops[0];
  const last = stops[stops.length - 1];
  const active = document.activeElement;
  const inside = active instanceof Node && root.contains(active);

  if (event.shiftKey ? active === first || !inside : active === last || !inside) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

/**
 * A dialog (e-console.html:876-895).
 *
 * It sits high on the page rather than centred, and it scrolls *inside itself*
 * — the page behind it never moves, so dismissing a long modal does not land
 * you somewhere else in the list you came from. Base UI's dialog underneath:
 * restore-on-close, Escape and the backdrop are all its work. **The focus trap
 * is ours** — see `containTab`, and the measurement that put it there.
 */
export function Modal({
  open,
  onOpenChange,
  trigger,
  wide,
  keepOpen,
  className,
  children,
  onKeyDown,
  ...props
}: ModalProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (!next && keepOpen && details.reason === "escape-key") {
          details.cancel();
          return;
        }
        onOpenChange?.(next);
      }}
      disablePointerDismissal={keepOpen}
    >
      {trigger ? (
        <DialogTrigger render={trigger as React.ReactElement} />
      ) : null}
      <DialogContent
        onKeyDown={(event) => {
          onKeyDown?.(event);
          containTab(event);
        }}
        className={cn(
          "top-modal-top max-h-modal-h w-full translate-y-0 gap-0 overflow-auto rounded-xl border border-line bg-panel p-0 shadow-pop ring-0",
          // Only the wide cap is ours. Below 640px base-nova's own
          // `max-w-[calc(100%-2rem)]` is what keeps a 16px gutter down each
          // side of a phone, which is exactly the reference's padding.
          wide ? "sm:max-w-215" : "sm:max-w-150",
          className,
        )}
        {...props}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}

export type ModalHeaderProps = Omit<ComponentProps<"div">, "title"> & {
  title: React.ReactNode;
  /** One sentence saying what this dialog will do, in the same words as the button. */
  description?: React.ReactNode;
};

function ModalHeader({
  title,
  description,
  className,
  children,
  ...props
}: ModalHeaderProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 px-5 pt-4.5 pb-3.5 max-hd:px-3.75",
        className,
      )}
      {...props}
    >
      <div className="min-w-0 flex-1">
        {/* The close button is absolutely positioned in the top-right corner,
            so the title reserves room for it rather than running under it. */}
        <DialogTitle className="pr-8 text-sect wrap-anywhere text-tx">
          {title}
        </DialogTitle>
        {description ? (
          // `wrap-anywhere` like the title: a description names the thing too,
          // and a long name with no space in it must not widen the dialog.
          <DialogDescription className="mt-1.25 text-body wrap-anywhere text-tx-2">
            {description}
          </DialogDescription>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function ModalBody({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3.5 px-5 pb-4.5 max-hd:px-3.75",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Sticky, which is the one place this leaves the reference. The box scrolls
 * as the reference has it, but a dialog whose "Delete this Application"
 * button is below the fold is a dialog people scroll past and then hunt for.
 * The actions stay on screen; the reading scrolls under them.
 */
function ModalFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-line bg-panel-2 px-5 py-3.5 max-hd:px-3.75",
        className,
      )}
      {...props}
    />
  );
}

/** The spring in a footer: notes on the left, buttons on the right. */
function ModalGap() {
  return <div aria-hidden="true" className="flex-1" />;
}

Modal.Header = ModalHeader;
Modal.Body = ModalBody;
Modal.Footer = ModalFooter;
Modal.Gap = ModalGap;
Modal.Close = DialogClose;

export { ModalHeader, ModalBody, ModalFooter, ModalGap, DialogClose as ModalClose };
