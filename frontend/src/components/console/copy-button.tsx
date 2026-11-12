import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

/**
 * Put a value on the clipboard, and say that it worked.
 *
 * F11 is the phase that needs one: a Credentials tab is a column of strings
 * whose whole purpose is to be pasted somewhere else, and a 16-character
 * generated password is not a thing anyone should be retyping. The reference
 * has the affordance on its own credentials panel
 * (`e-console.html` — the `copy` glyph beside a `KVRow`), and F04's `KVList`
 * already has an `action` slot shaped exactly for it.
 *
 * Three details, each of which is the reason this is a component rather than an
 * `onClick` at four call sites:
 *
 * 1. **It confirms in place, not in a toast.** The feedback belongs where the
 *    eye already is; a corner toast for "copied" is the most interrupting
 *    possible way to acknowledge the least consequential action on the screen.
 *    The mark becomes a tick for two seconds and the accessible name changes
 *    with it, so the confirmation is not colour-and-shape only.
 * 2. **`type="button"`.** These sit inside forms — the Credentials tab is a
 *    form with a copy control on every row — and a bare `<button>` in a form
 *    submits it. F06 paid for this lesson once already, on `PasswordInput`.
 * 3. **It copies on an insecure origin, and a failure stays until it is
 *    dealt with**.
 *    A stock install serves the console at `http://<host>:3000`, which is not a
 *    secure context, so `navigator.clipboard` is `undefined` there — every copy
 *    control on the default install failed, one-time secrets included, and the
 *    failure showed as a two-second icon swap with nothing selected. So:
 *    - the Clipboard API is tried first where it exists;
 *    - where it does not, or it refuses (the document is not focused), the value
 *      is put in an off-screen `<textarea>` beside the button, selected, and
 *      copied with `document.execCommand("copy")` — deprecated, and still the
 *      one route that works on an insecure origin inside the click gesture. The
 *      scratch field goes next to the button rather than on `<body>`, because a
 *      modal's focus trap pulls focus back out of anything outside it, and the
 *      selection goes with the focus;
 *    - if that fails too, a popover under the button shows the value in a
 *      read-only field, focused and **selected**, with a visible line saying to
 *      press ⌘C or Ctrl+C. It is a popover rather than text beside the button
 *      because several callers never render the value — a teardown report's
 *      text, an id in a table — and a fix inside this component is a fix at
 *      every call site at once. It has no timer: it stays until the operator
 *      copies from it (which counts as the copy, and confirms), clicks anywhere
 *      else, or presses Escape. A two-second failure is the one an operator who
 *      glanced away never sees, and then they paste the *previous* thing they
 *      copied into a production connection string.
 */
export function CopyButton({
  value,
  /**
   * What is being copied — "password", "connection string". The **noun**, not a
   * sentence: every name below wraps it, so a label of "Copy backup codes" is
   * announced "Copy the Copy backup codes". Eleven sites read that way, so
   * `cloudgate/copy-button-label-is-a-noun` now holds it.
   */
  label,
  size = "icon-sm",
  className,
}: {
  value: string;
  label: string;
  size?: "icon-sm" | "icon-xs";
  className?: string;
}) {
  const [state, setState] = React.useState<"idle" | "done" | "failed">("idle");
  const button = React.useRef<HTMLButtonElement>(null);
  const field = React.useRef<HTMLTextAreaElement>(null);

  // A copy that lands while a previous confirmation is still counting down must
  // not be reset early by the first timer, and one that unmounts mid-countdown
  // must not set state on a gone component. Only the confirmation counts down:
  // a failure is not over until the operator has done something about it.
  React.useEffect(() => {
    if (state !== "done") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  function copy() {
    const bySelection = () =>
      setState(copyBySelection(value, button.current) ? "done" : "failed");
    // Optional chaining is the insecure-origin case, not caution: there,
    // `navigator.clipboard` is `undefined`. And the fallback runs synchronously
    // when there is nothing to await, so it is still inside the click.
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(value).then(() => setState("done"), bySelection);
    } else {
      bySelection();
    }
  }

  const said =
    state === "done"
      ? `${label} copied`
      : state === "failed"
        ? `Could not copy the ${label}. It is selected below — press ⌘C, or Ctrl+C.`
        : `Copy the ${label}`;

  return (
    <Popover
      open={state === "failed"}
      // Only ever closes from here — opening is `copy()`'s to decide, so a click
      // on the trigger is a copy and not a toggle.
      onOpenChange={(open) => {
        if (!open) setState("idle");
      }}
    >
      <PopoverTrigger
        render={
          <Button
            ref={button}
            type="button"
            variant="qt"
            size={size}
            onClick={copy}
            aria-label={said}
            className={cn(state === "done" && "text-ok", className)}
          >
            {/* Keyed by state, so the tick replaces the copy glyph in place
                rather than snapping; back to idle is instant. */}
            <Icon
              key={state}
              name={
                state === "done" ? "check" : state === "failed" ? "alert" : "copy"
              }
              size={14}
              className={state === "idle" ? undefined : "animate-fade"}
            />
          </Button>
        }
      />
      {/*
        The tick is decoration — `Icon` is aria-hidden and the label only
        changes on the element that already had focus, which a screen reader
        does not re-announce. This is the part that actually gets spoken.
      */}
      <span aria-live="polite" className="sr-only">
        {state === "idle" ? "" : said}
      </span>
      <PopoverContent
        align="end"
        initialFocus={field}
        className="w-80 rounded-xl border border-line bg-panel p-2.5 shadow-pop ring-0"
      >
        <p className="text-meta text-tx">{said}</p>
        <textarea
          ref={field}
          readOnly
          aria-label={label}
          value={value}
          rows={Math.min(value.split("\n").length, 8)}
          onFocus={(event) => event.currentTarget.select()}
          onCopy={() => setState("done")}
          className="w-full resize-none rounded-md border border-line bg-panel-2 px-2 py-1.5 font-mono text-meta break-all text-tx outline-none"
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * `execCommand("copy")` from a selected, off-screen `<textarea>` — the copy an
 * insecure origin still allows inside a user gesture. Answers whether it worked.
 *
 * Put beside `near` rather than on `<body>`: inside a modal, a focus trap
 * returns focus to the dialog from anything outside it, and the selection being
 * copied is the focused field's. Focus goes back to `near` afterwards so a
 * keyboard user is where they were.
 */
function copyBySelection(value: string, near: HTMLElement | null): boolean {
  if (typeof document.execCommand !== "function") return false;
  const scratch = document.createElement("textarea");
  scratch.value = value;
  // No on-screen keyboard on a phone, and no layout shift anywhere.
  scratch.setAttribute("readonly", "");
  scratch.setAttribute("aria-hidden", "true");
  scratch.style.position = "fixed";
  scratch.style.top = "0";
  scratch.style.left = "-9999px";
  (near?.parentElement ?? document.body).appendChild(scratch);
  try {
    scratch.focus({ preventScroll: true });
    scratch.setSelectionRange(0, value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    scratch.remove();
    near?.focus({ preventScroll: true });
  }
}
