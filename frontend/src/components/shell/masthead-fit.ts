import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Whether the wordmark fits beside the Organization's name in the masthead's
 * Organization cell, which is exactly the rail's width (#129).
 *
 * **The name wins.** The wordmark is the first thing to go, down to the glyph,
 * which is what the masthead already shows below `lbl` and on the icon strip;
 * only a name that does not fit even then truncates. Decided from rendered
 * widths, never from a character count, because the type is proportional.
 *
 * - `nameWidth`: the name's whole width (its `scrollWidth`, which a
 *   truncated span still reports in full).
 * - `nameRoom`: the width the name has now (its `clientWidth`).
 * - `wordWidth`: what showing the wordmark takes from the name, read the last
 *   time it was shown; null before it ever was.
 *
 * While the wordmark is shown the name fits or it does not. Once it is
 * dropped, the name's room includes what the wordmark gave back, so it returns
 * only if the name would still fit with that much less: the two never take
 * turns.
 */
export function wordmarkFits({
  shown,
  nameWidth,
  nameRoom,
  wordWidth,
}: {
  shown: boolean;
  nameWidth: number;
  nameRoom: number;
  wordWidth: number | null;
}): boolean {
  if (shown) return nameWidth <= nameRoom;
  if (wordWidth === null) return true;
  return nameWidth + wordWidth <= nameRoom;
}

/**
 * {@link wordmarkFits}, measured in the cell: re-read when the cell resizes,
 * when its text changes (the Organization switched, the name arrived), and
 * once the web font has loaded. The name is the cell's `[data-org-name]`, and
 * the wordmark is `[data-wordmark]`'s word, measured with the gap before it.
 *
 * While CSS hides the word for its own reasons (below `lbl`, the icon strip),
 * it has no width to read and nothing is decided: those layouts are unchanged.
 */
export function useWordmarkFits(cell: RefObject<HTMLElement | null>): boolean {
  const [shown, setShown] = useState(true);
  const [wordWidth, setWordWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const root = cell.current;
    if (!root) return;

    function measure() {
      const name = root?.querySelector<HTMLElement>("[data-org-name]");
      const mark = root?.querySelector<HTMLElement>("[data-wordmark]");
      const word = mark?.lastElementChild as HTMLElement | null | undefined;
      if (!name || !word) return;
      let width = wordWidth;
      if (shown) {
        // Hidden by CSS: not this rule's layout.
        if (word.offsetWidth === 0) return;
        const gap = parseFloat(getComputedStyle(mark!).columnGap) || 0;
        width = word.offsetWidth + gap;
        if (width !== wordWidth) setWordWidth(width);
      }
      const next = wordmarkFits({
        shown,
        nameWidth: name.scrollWidth,
        nameRoom: name.clientWidth,
        wordWidth: width,
      });
      if (next !== shown) setShown(next);
    }

    measure();
    const resized =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    resized?.observe(root);
    const changed =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(measure);
    changed?.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) measure();
    });
    return () => {
      live = false;
      resized?.disconnect();
      changed?.disconnect();
    };
  }, [cell, shown, wordWidth]);

  return shown;
}
