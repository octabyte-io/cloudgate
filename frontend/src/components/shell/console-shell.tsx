"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { FrozenBanner } from "@/components/shell/frozen-banner";
import { LicenseBar } from "@/components/shell/license-bar";

import { CommandPalette } from "./command-palette";
import { Masthead } from "./masthead";
import { PaletteProvider } from "./palette-state";
import { ScopeProvider } from "./scope-provider";
import { ScopeRail } from "./scope-rail";
import { Dock, DockProvider } from "./dock";
import { useIsDrawer } from "./use-is-drawer";

/**
 * The console shell (e-console.html:209-216, 295-302, 403-405).
 *
 * A `100dvh` grid — masthead row, then rail + main — where **each of the two
 * scroll regions owns its own scrolling and the page itself never scrolls.**
 * That is not a detail: it is what lets the masthead stay put, what lets the rail
 * scroll independently of a long table, and what makes the breadcrumb's
 * fade-in-on-scroll possible at all, since there is one element whose offset the
 * masthead can watch.
 */
export function ConsoleShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isDrawer = useIsDrawer();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const drawerToggleRef = useRef<HTMLButtonElement>(null);

  // Both of these record *which page* they were set on, so a navigation resets
  // them without an effect and without a second source of truth — including on a
  // back button, which an `onClick` on every link would miss.
  //
  // For the breadcrumb that is not a nicety: leave a long page scrolled, go to a
  // short one, and there is no scroll event to unset it — so the masthead would
  // keep naming a page whose title is right underneath it, which is the one thing
  // the fade-in exists to avoid.
  const [scroll, setScroll] = useState({ past: false, at: pathname });
  const scrolled = scroll.past && scroll.at === pathname;

  // At drawer widths the rail is covering the thing you just asked for, so a
  // navigation closes it (e-console.html:4812-4814).
  const [drawer, setDrawer] = useState({ open: false, at: pathname });
  const drawerOpen = drawer.open && drawer.at === pathname;

  useFocusMainOnNavigation(mainRef, pathname);

  // Escape and the scrim close the drawer where you are, so focus goes back to
  // the toggle that opened it. A link closes it too, but that is a
  // navigation, and `useFocusMainOnNavigation` puts focus on the new page.
  const dismissDrawer = () => {
    setDrawer({ open: false, at: pathname });
    drawerToggleRef.current?.focus();
  };

  // Memoized because it is handed to every page through context: an identity that
  // changed on each render would re-render every consumer on every scroll event.
  const openPalette = useCallback(() => setPaletteOpen(true), []);

  return (
    <ScopeProvider>
      <DockProvider>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-40 focus:rounded-md focus:border focus:border-line focus:bg-panel focus:px-3 focus:py-2 focus:text-body focus:text-tx focus:shadow-pop"
        >
          Skip to content
        </a>

        <div className="shell-grid grid h-dvh overflow-hidden">
          <Masthead
            scrolled={scrolled}
            isDrawer={isDrawer}
            drawerOpen={drawerOpen}
            drawerToggleRef={drawerToggleRef}
            onDrawerToggle={() =>
              setDrawer({ open: !drawerOpen, at: pathname })
            }
          />

          <div className="shell-body grid min-h-0 min-w-0">
            <ScopeRail
              drawerOpen={drawerOpen}
              isDrawer={isDrawer}
              onNavigate={() => setDrawer({ open: false, at: pathname })}
              onClose={dismissDrawer}
              onSearch={openPalette}
            />

            {/* The scrim exists only while the drawer is open, so there is never an
              invisible full-page button over the console. */}
            {isDrawer && drawerOpen ? (
              <button
                type="button"
                aria-label="Close navigation"
                onClick={dismissDrawer}
                className="fixed inset-0 z-10 animate-fade bg-scrim"
              />
            ) : null}

            <main
              ref={mainRef}
              id="main"
              // The skip link's target, and where focus lands on a navigation.
              // Not in the tab order: it is a region, not a control.
              tabIndex={-1}
              onScroll={(event) =>
                setScroll({
                  past: event.currentTarget.scrollTop > CRUMB_IN,
                  at: pathname,
                })
              }
              className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto bg-ground outline-none"
            >
              {/* Every member sees why their Organization is frozen. */}
              <FrozenBanner />
              {/* Owners and admins see a Self-hosted license running out. */}
              <LicenseBar />
              <PaletteProvider open={openPalette}>{children}</PaletteProvider>
            </main>
          </div>

          {/* The Dock: the grid's third row, full width under
            the rail and the page, and the layout's rather than a page's so a
            tab in it survives navigation. */}
          <Dock />
        </div>

        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </DockProvider>
    </ScopeProvider>
  );
}

/**
 * How far `<main>` scrolls before the masthead's breadcrumb fades in
 * (e-console.html:4776). A behavioural threshold rather than a design value —
 * it sizes a gesture, not an element — so it lives beside the handler that
 * reads it rather than in the token file.
 */
const CRUMB_IN = 40;

/**
 * A client-side navigation replaces the page without moving the caret, so a
 * screen reader stays wherever it was in the old one and a keyboard user tabs on
 * from a rail item that is no longer lit. Focusing the new `<main>` is what makes
 * a route change read as a route change.
 *
 * Not on first mount: focus belongs where the browser put it when a page is
 * *opened*, and stealing it there would fight the skip link.
 */
function useFocusMainOnNavigation(
  main: React.RefObject<HTMLElement | null>,
  pathname: string,
) {
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus();
  }, [main, pathname]);
}
