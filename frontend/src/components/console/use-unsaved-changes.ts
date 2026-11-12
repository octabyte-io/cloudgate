import { useEffect } from "react";

/**
 * **Warn before leaving a form with edits nobody has saved**.
 *
 * Built for the Docker Swarm section of an Application's Advanced tab, where
 * eleven cards share one Save at the bottom: an edit to the first card, then a
 * click on another tab, used to drop it without a word.
 *
 * Two ways out, two listeners, both on only while `dirty`:
 *
 * - **Leaving the page** — a reload, a closed tab, a typed address — is
 *   `beforeunload`, where the browser shows its own prompt and ignores any
 *   text given to it.
 * - **Following a link inside the console** never unloads anything: Next's
 *   `Link` swaps the route in place. So a click on a same-origin `<a href>` is
 *   caught in the **capture** phase on `document`, before React's own listener
 *   at the root sees it, and stopped there unless the operator confirms. A
 *   click that opens a new tab or window (a modifier, a middle button, a
 *   `target`) leaves this page where it is and is let through.
 *
 * Rejected: patching `history.pushState`, which would also catch a
 * programmatic `router.push` — none of the ways out of this screen is one, and
 * wrapping a global the router owns is how the next Next release breaks it.
 */
export function useUnsavedChangesGuard(dirty: boolean, message: string) {
  useEffect(() => {
    if (!dirty) return;

    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };

    const click = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.origin !== window.location.origin) return;
      // A link to this same page, a `#section` on it, leaves nothing behind.
      if (
        anchor.pathname === window.location.pathname &&
        anchor.search === window.location.search
      ) {
        return;
      }
      if (window.confirm(message)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
    };
  }, [dirty, message]);
}
