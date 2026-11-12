import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";

import { Modal } from "@/components/console/modal";
import { DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/lib/design/icons";

import {
  useCaretInField,
  useCommandShortcut,
  useLastFocusOutsideDialog,
  usePaletteField,
} from "./palette-keys";
import { Kbd, noMatch, Row, Tips } from "./palette-rows";
import {
  filterPalette,
  usePaletteSources,
  type PaletteResult,
} from "./palette-sources";

/**
 * ⌘K (e-console.html:899-937, 2306-2434).
 *
 * A combobox, spelled the way the pattern actually requires: the field keeps
 * focus so typing never stops, the list is `aria-activedescendant`-driven rather
 * than focus-driven, and Enter takes the highlighted row.
 *
 * The focus trap and the backdrop are Base UI's dialog underneath — the same one
 * every other modal uses. **Entering the field, leaving on Escape, and where
 * focus goes afterwards are all ours**, and each one is a defect this had first;
 * `palette-keys.ts` says why.
 *
 * The typed prefixes are the reason this is worth building rather than faking:
 * they filter live API data (`palette-sources.ts`).
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocusTo = useLastFocusOutsideDialog();
  const { field: inputRef, attach: focusOnMount } = usePaletteField();

  const { results: all, pending, unavailable } = usePaletteSources(open);
  const { kind, results } = filterPalette(all, query);
  // Tips are not options, so the container is only a listbox when it holds some.
  const listing = query !== "" && results.length > 0;
  // And the keys only ever move through what is on screen. `filterPalette`
  // keeps every row for an empty term, so under the tips the whole list was
  // still there, unseen — ↓ and Enter walked it, and Enter opened a Project the
  // palette had never shown.
  const options = listing ? results : [];
  // A filter that shortens the list must not leave the highlight past its end.
  const current = Math.min(cursor, Math.max(options.length - 1, 0));
  const highlighted = options[current];

  useCommandShortcut(onOpenChange);
  useCaretInField(inputRef, open);

  /**
   * Closing clears the query, so the next ⌘K opens on the search tips rather
   * than on whatever was typed minutes ago and its by-then-stale results.
   */
  function setOpen(next: boolean) {
    if (!next) {
      setQuery("");
      setCursor(0);
    }
    onOpenChange(next);
  }

  function move(by: number) {
    if (options.length === 0) return;
    const next = (current + by + options.length) % options.length;
    setCursor(next);
    listRef.current
      ?.querySelector(`[data-index="${next}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  function choose(result: PaletteResult | undefined) {
    if (!result) return;
    setOpen(false);
    router.push(result.href);
  }

  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      showCloseButton={false}
      // No enter or exit motion: ⌘K is opened by a keystroke, many times a
      // day, and a palette that animates in is one the typing waits on.
      className="top-pal-top max-h-none overflow-visible data-open:animate-none data-closed:animate-none sm:max-w-pal"
      // Kept alongside the callback ref above: this is the prop Base UI reads
      // when it manages initial focus itself, and it costs nothing to be right
      // for both paths.
      initialFocus={inputRef}
      // Where focus goes on close. Base UI restores to a `Dialog.Trigger`, and
      // this palette has none — it is opened by a keystroke or by a button in
      // the rail — so closing it dropped focus on `<body>` and a keyboard user
      // lost their place in the rail entirely.
      finalFocus={returnFocusTo}
    >
      <DialogTitle className="sr-only">Search Cloudgate</DialogTitle>

      <div className="flex h-13 items-center gap-2.5 border-b border-line px-3">
        <Icon name="search" size={17} className="text-tx-3" />
        <input
          ref={focusOnMount}
          type="text"
          role="combobox"
          aria-expanded={listing}
          aria-controls={listId}
          aria-activedescendant={
            highlighted ? `${listId}-${current}` : undefined
          }
          aria-label="Search Cloudgate"
          autoComplete="off"
          spellCheck={false}
          placeholder="Search Projects, Environments, Servers and pages…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              move(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              move(-1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(highlighted);
            } else if (event.key === "Escape") {
              // Ours, not the dialog's. Chrome reverts a *non-empty* text field
              // on Escape and consumes the event doing it, so the dialog's own
              // dismiss never saw it — Escape closed the palette only while the
              // field was empty, which is the one case nobody needs it for.
              // Found by typing a query and then trying to leave.
              event.preventDefault();
              setOpen(false);
            }
          }}
          className="min-w-0 flex-1 border-0 bg-transparent text-lead text-tx outline-none placeholder:text-tx-3"
        />
        <Kbd className="px-1.5 py-1">Esc</Kbd>
      </div>

      <div
        ref={listRef}
        id={listId}
        role={listing ? "listbox" : undefined}
        aria-label={listing ? "Results" : undefined}
        className="max-h-pal-list overflow-auto p-1.5"
      >
        {query === "" ? (
          <Tips />
        ) : results.length === 0 ? (
          <p className="px-3.5 py-6.5 text-center text-body text-tx-2">
            {pending ? "Looking…" : noMatch(all, unavailable, kind, query)}
          </p>
        ) : (
          results.map((result, index) => (
            <Row
              key={`${result.kind}-${result.href}`}
              id={`${listId}-${index}`}
              index={index}
              result={result}
              // A prefix already says what kind everything is; repeating it on
              // every row would be the same word forty times.
              showKind={kind === null}
              current={index === current}
              onChoose={() => choose(result)}
            />
          ))
        )}
      </div>

      <div className="flex items-center gap-3.5 border-t border-line bg-panel-2 px-3.5 py-2.25 text-meta text-tx-3">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> to navigate
        </span>
        <span className="flex items-center gap-1 max-hd:hidden">
          <Kbd>↵</Kbd> to select
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Esc</Kbd> to dismiss
        </span>
      </div>
    </Modal>
  );
}
