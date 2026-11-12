import { useCallback, useEffect, useRef } from "react";

/**
 * The palette's keyboard and focus plumbing.
 *
 * Both of these are here rather than inline because both were *wrong* first, and
 * the reasons are worth keeping next to each other: opening a dialog and closing
 * one are the two moments a keyboard user can be stranded, and neither came free
 * from the library.
 */

/**
 * The last thing focused outside the palette — where focus belongs when it
 * closes.
 *
 * Tracked continuously rather than captured on open, because by the time React
 * has committed `open`, focus has already moved into the dialog: the element we
 * want is the one that had it *before* the keystroke, and the only place that is
 * still knowable is a running record.
 *
 * This covers both ways in — ⌘K from wherever the operator was, and the rail's
 * quick-search button — without either path having to remember to say so.
 */
export function useLastFocusOutsideDialog(): React.RefObject<HTMLElement | null> {
  const last = useRef<HTMLElement | null>(null);

  useEffect(() => {
    function onFocusIn(event: FocusEvent) {
      const node = event.target;
      if (!(node instanceof HTMLElement)) return;
      if (node.closest('[role="dialog"]')) return;
      last.current = node;
    }
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  return last;
}

/**
 * ⌘K on a Mac, Ctrl+K everywhere else, and `/` nowhere: a bare slash steals
 * the character from every text field on the page.
 */
export function useCommandShortcut(onOpenChange: (open: boolean) => void) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Not dead code: `key` is typed non-optional, but this listener is on
      // `window` and so sees *every* keydown on the page — including synthetic
      // ones from autofill, password managers, extensions and browser
      // automation, which routinely carry no `key` at all. Reading through it
      // unguarded throws.
      if (!event.key) return;
      if (event.key.toLowerCase() !== "k") return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      onOpenChange(true);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpenChange]);
}

/**
 * The palette's field ref, and a callback ref that puts the caret in it the
 * moment it exists.
 *
 * A callback ref rather than `initialFocus` or an effect, and the way both of
 * those failed is why: pressing ⌘K while focus sat on a rail link opened the
 * palette and left focus **on that link** — which the dialog had just marked
 * `aria-hidden`. ⌘K is only ever reached from the keyboard, so the one path that
 * mattered was the one that broke.
 *
 * An effect in the palette does not fix it either: Base UI mounts the popup's
 * children in a *later commit* than the one that flips `open`, so the effect runs
 * while the ref is still null. A callback ref cannot be early — it is called when
 * the node attaches, which is the only moment guaranteed to exist.
 */
export function usePaletteField() {
  const field = useRef<HTMLInputElement | null>(null);
  const attach = useCallback((node: HTMLInputElement | null) => {
    field.current = node;
    node?.focus();
  }, []);

  return { field, attach };
}

/**
 * And keep it there, because the callback ref above **does not always win**.
 *
 * F07 found this by opening the palette from the home page's quick-search button
 * rather than with ⌘K: the dialog opened with focus on the popup's own container
 * (`role="dialog"`, `tabindex="-1"`), typing went nowhere, and Escape did nothing
 * either — the field owns Escape, and the field did not have the caret. Exactly
 * F05's first defect, through a door F05 did not have.
 *
 * The asymmetry is the clue. `initialFocus` is read in the commit that flips
 * `open`, one commit *before* the popup's children mount, so the ref it reads is
 * still null and Base UI falls back to focusing the container. With ⌘K nothing
 * outside held focus, so its fallback never fired and the callback ref was the
 * only thing that moved the caret. Open it from a **button**, which does hold
 * focus, and the fallback runs — after the callback ref, undoing it.
 *
 * So rather than race the library, this states the invariant: *the container is
 * never a focus target*. If focus lands on it, it belongs in the field. That is
 * true however the palette was opened and whatever order the two passes run in,
 * which is why it is a listener and not another attempt at timing.
 */
export function useCaretInField(
  field: React.RefObject<HTMLInputElement | null>,
  open: boolean,
) {
  useEffect(() => {
    if (!open) return;

    function onFocusIn(event: FocusEvent) {
      const node = event.target;
      if (!(node instanceof HTMLElement)) return;
      if (!node.matches('[role="dialog"]')) return;
      field.current?.focus();
    }

    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [field, open]);
}
