/**
 * ⌃` — Ctrl and backtick — toggles the docked terminal.
 *
 * The key VS Code and most cloud consoles give their terminal panel, so it is
 * the one an operator's hand already reaches for. It cannot clash with ⌘K
 * (`palette-keys.ts`), and on a Mac it is Control rather than Command on
 * purpose: ⌘` cycles a browser's windows, and the operating system takes it
 * before the page sees it.
 *
 * Read by two listeners, which is why it is one function: the Dock's own
 * window listener, and the emulator's key handler, which has to *decline* the
 * key — xterm otherwise turns it into a NUL for the shell and the toggle never
 * leaves the terminal.
 *
 * `code` first, because `key` for this chord varies by layout and platform
 * (`` ` ``, `Dead`, `@`); `key` second for the synthetic events that carry no
 * `code`. Shift, Alt and Meta make it a different chord.
 */
export function isDockShortcut(event: KeyboardEvent): boolean {
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
    return false;
  }
  return event.code === "Backquote" || event.key === "`";
}
