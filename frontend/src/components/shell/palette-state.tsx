import { createContext, use } from "react";

/**
 * How a *page* opens ⌘K.
 *
 * The palette belongs to the shell — it is mounted once, beside the masthead and
 * the rail (`console-shell.tsx`), because two of them would mean two ⌘K handlers
 * and two focus traps. But the rail is not the only thing that opens it: the
 * Organization home's quick-search field is the reference's own second entry
 * point (e-console.html:2812), and a page cannot reach the shell's state.
 *
 * So this is the one thing the shell hands *down* to pages. A context rather than
 * a prop because there is exactly one palette per document and a page has no
 * business receiving it as an argument, and rather than a module-level store
 * because it is React state and belongs to a mounted shell.
 */
const OpenPaletteCtx = createContext<(() => void) | null>(null);

export function PaletteProvider({
  open,
  children,
}: {
  /** Memoize this: every consumer re-renders when the value changes. */
  open: () => void;
  children: React.ReactNode;
}) {
  return (
    <OpenPaletteCtx.Provider value={open}>{children}</OpenPaletteCtx.Provider>
  );
}

/** Opens the command palette. Throws outside the console, which has no palette. */
export function useOpenPalette(): () => void {
  const open = use(OpenPaletteCtx);
  if (!open) {
    throw new Error("useOpenPalette must be used inside the console shell");
  }
  return open;
}
