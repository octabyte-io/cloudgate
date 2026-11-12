import { useOpenPalette } from "@/components/shell/palette-state";
import { Icon } from "@/lib/design/icons";

/**
 * The home page's hero, and the reference's second entry to ⌘K
 * (e-console.html:2808-2814).
 *
 * **It is a button, not an input.** It opens the command palette, which is where
 * the typing happens — and a text field that steals your first keystroke into a
 * dialog is a field that loses it. The reference makes the same choice, and it is
 * why this can advertise the shortcut: `⌘K` beside a real input would be a
 * promise the input could not keep.
 *
 * The heading is the reference's own, and it is the right register for a screen
 * whose whole job is to get someone into their work: this page has nothing to
 * report until they have deployed something.
 */
export function QuickSearch() {
  const openPalette = useOpenPalette();

  return (
    <div className="pt-3.5 pb-6.5 text-center">
      <h1 className="mb-4.5 text-disp text-tx">Time to deploy something.</h1>

      <button
        type="button"
        onClick={openPalette}
        className="mx-auto flex h-11.5 w-full max-w-140 items-center gap-2.5 rounded-lg border border-line bg-panel px-3.5 text-left text-lead text-tx-3 shadow-panel transition-colors duration-100 hover:border-line-2 hover:text-tx-2"
      >
        <Icon name="search" size={17} className="flex-none" />
        <span className="min-w-0 flex-1 truncate">
          Search Servers, Projects and Environments
        </span>
        <kbd className="flex-none rounded-md border border-line bg-panel-2 px-1.5 py-0.5 font-sans text-chip text-tx-3 max-hd:hidden">
          ⌘K
        </kbd>
      </button>
    </div>
  );
}
