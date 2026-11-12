import { useEffect, useRef } from "react";

import { containTab, TABBABLE } from "@/components/console/modal";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

import { keyOf, RailEntry } from "./rail-entries";
import { RailBackTo, RailBackToPending } from "./rail-item";
import { RailTip } from "./rail-tip";
import { toggleRail, useRailCollapsed } from "./rail-state";
import { useScope } from "./scope-provider";

/**
 * The scope rail (e-console.html:295-401).
 *
 * It renders whichever nav table the current scope selects and knows nothing
 * about what is in it — which is the point: a feature phase adds a screen by
 * adding a row to `nav.ts`, and this file never changes.
 *
 * Three modes, and only one of them is React's business:
 * - **expanded**, the 259px default;
 * - **collapsed**, the 60px icon strip — CSS, off `data-rail` on `<html>`, so it
 *   is already the right width before first paint (`rail-state.ts`);
 * - **drawer**, below the `rail` breakpoint: fixed, over the page behind a
 *   scrim, and the collapsed state is ignored outright, because a drawer is
 *   never an icon strip.
 *
 * **An open drawer is a modal.** Opening it moves focus to its first
 * control, Tab is held inside it with the dialog's own `containTab`, and Escape
 * closes it — `onClose`, which hands focus back to the masthead's toggle. It
 * used to leave focus on the toggle, let Tab walk out behind the scrim, and
 * ignore Escape.
 */
export type ScopeRailProps = {
  /** Open, as a drawer. Meaningless above the `rail` breakpoint. */
  drawerOpen: boolean;
  /** True when the rail *is* a drawer — a closed one must leave the tab order. */
  isDrawer: boolean;
  onNavigate: () => void;
  /** Escape on an open drawer: close it and return focus to its toggle. */
  onClose: () => void;
  onSearch: () => void;
};

export function ScopeRail({
  drawerOpen,
  isDrawer,
  onNavigate,
  onClose,
  onSearch,
}: ScopeRailProps) {
  const { nav, exit, exitPending } = useScope();
  const collapsed = useRailCollapsed();
  const ref = useRef<HTMLElement>(null);
  const modal = isDrawer && drawerOpen;

  // After the commit that lifts `inert`, so the first control can take focus.
  useEffect(() => {
    if (modal) ref.current?.querySelector<HTMLElement>(TABBABLE)?.focus();
  }, [modal]);

  return (
    <nav
      ref={ref}
      id="scope-rail"
      aria-label="Console navigation"
      onKeyDown={
        modal
          ? (event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
                return;
              }
              containTab(event);
            }
          : undefined
      }
      // A closed drawer is moved by `translateX`, which moves ink and not focus:
      // without `inert` the whole rail stays tabbable off the left edge of a
      // phone. This is the one thing about drawer mode that CSS cannot do.
      inert={isDrawer && !drawerOpen}
      className={cn(
        "z-20 flex min-h-0 flex-col border-r border-line bg-panel",
        "max-rail:fixed max-rail:top-top max-rail:bottom-0 max-rail:left-0 max-rail:w-drawer max-rail:shadow-pop max-rail:transition-transform max-rail:duration-300 max-rail:ease-drawer",
        // **Closed is the default, in CSS** — not `isDrawer && !drawerOpen`.
        // `isDrawer` cannot be known on the server, so deriving the transform
        // from it meant a phone rendered the drawer *open* and then slid it out
        // once `useIsDrawer` reported back: a 285px panel visibly sweeping off
        // the screen on every page load. CSS knows the width on the first frame;
        // React only needs to say when it is open.
        //
        // 101%, not 100%: at exactly 100% the drawer's own `shadow-pop` still
        // peeks down the left edge of the page (e-console.html:1004).
        //
        // Two spellings matter here and both were wrong first. The sign goes
        // *outside* the brackets — `translate-x-[-101%]` generates no rule at
        // all, silently. And it is one ternary rather than two classes, because
        // tailwind-merge does not pair a negative *arbitrary* translate with
        // `translate-x-0`: both survived, the generated order decided, and the
        // drawer opened to nowhere.
        drawerOpen
          ? "max-rail:translate-x-0"
          : "max-rail:-translate-x-[101%]",
      )}
    >
      <div className="flex-none p-4 pt-3.5 pb-2 railc:px-2.5">
        <QuickSearch onSearch={onSearch} />
      </div>

      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 pb-2">
        {exit ? (
          <RailBackTo
            href={exit.href}
            label={exit.label}
            onNavigate={onNavigate}
          />
        ) : exitPending ? (
          <RailBackToPending />
        ) : null}
        {nav.map((entry, index) => (
          <RailEntry key={keyOf(entry, index)} entry={entry} onNavigate={onNavigate} />
        ))}
      </div>

      <div className="flex flex-none items-center gap-1.5 border-t border-line px-3 py-2">
        <button
          type="button"
          onClick={toggleRail}
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          aria-pressed={collapsed}
          className="grid size-7.5 flex-none place-items-center rounded-sm text-tx-3 transition-colors duration-100 hover:bg-raise hover:text-tx aria-pressed:text-brand-tx"
        >
          <Icon name="panel" size={17} />
        </button>
      </div>
    </nav>
  );
}

/** The ⌘K affordance. A button, because the field it opens lives in the dialog. */
function QuickSearch({ onSearch }: { onSearch: () => void }) {
  return (
    <RailTip label="Quick search… ⌘K">
      <button
        type="button"
        onClick={onSearch}
        className="flex h-ctl w-full items-center gap-2 rounded-lg border border-line bg-panel pr-2 pl-2.5 text-body text-tx-3 shadow-panel transition-colors duration-100 hover:border-line-2 hover:text-tx-2 railc:justify-center railc:px-0"
      >
        <Icon name="search" />
        <span className="flex-1 text-left railc:sr-only">Quick search…</span>
        {/* The hint is not the name: "⌘K" read aloud is noise, and the shortcut is
            announced by the label above it either way. On the strip it goes
            with the label, into the tooltip. */}
        <kbd
          aria-hidden="true"
          className="flex-none rounded-sm border border-line bg-panel-2 px-1.25 py-0.75 text-chip font-medium text-tx-3 railc:hidden"
        >
          ⌘K
        </kbd>
      </button>
    </RailTip>
  );
}
