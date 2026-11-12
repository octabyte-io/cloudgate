import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn() },
}));

const { PatchEditorModal } = await import("./patch-editor-modal");

/**
 * A diff line longer than the dialog scrolls inside the diff rather than
 * widening the dialog.
 *
 * **This is a structural assertion, not the measurement, and it says so.** jsdom
 * does not lay out: `scrollWidth` and `clientWidth` are both 0 there, so the
 * ticket's `scrollWidth === clientWidth` would pass on the broken tree too. What
 * the browser measured (headless Chrome, 300-character line, 860px dialog) is
 * that the dialog is a one-column `grid`, the column's `auto` minimum is its
 * items' content-based minimum, and the only placement that frees it is
 * `min-width: 0` on the grid item holding the diff — `Modal.Body`. The same
 * class on `DiffView`, the tab panel or the tabs root measured *unchanged*
 * (dialog 2259/860 either way), so asserting any of those would be a gate that
 * cannot fail on the real defect. This pins the one that measured.
 */

afterEach(cleanup);

const LONG = "x".repeat(300);

function renderEditor(original: string | undefined) {
  render(
    <PatchEditorModal
      filePath="README.md"
      loaded={`${LONG}\n`}
      original={original}
      pending={false}
      error={null}
      open
      onOpenChange={() => {}}
      save={async () => {}}
      markForDeletion={async () => {}}
    />,
  );
}

/** The direct child of the dialog's grid that holds `el`. */
function gridItemOf(el: HTMLElement): HTMLElement {
  const grid = el.closest<HTMLElement>('[data-slot="dialog-content"]');
  expect(grid).not.toBeNull();
  let item = el;
  while (item.parentElement && item.parentElement !== grid) {
    item = item.parentElement;
  }
  expect(item.parentElement).toBe(grid);
  return item;
}

describe("PatchEditorTabs", () => {
  it.each([
    ["Changes", /^Changes/, `${LONG}\n`],
    ["Against the repository", /^Against the repository/, "short\n"],
  ])(
    "keeps a 300-character diff line from widening the dialog on the %s tab",
    (_name, tab, original) => {
      renderEditor(original);
      // Type a change so the Changes tab has a diff to draw.
      fireEvent.change(screen.getByLabelText("Contents of README.md"), {
        target: { value: `${LONG}y\n` },
      });
      fireEvent.click(screen.getByRole("tab", { name: tab }));

      const diff = document.querySelector<HTMLElement>('[data-slot="diff"]');
      expect(diff).not.toBeNull();
      // The diff owns its scrollbar …
      expect(diff!.className).toMatch(/\boverflow-x-auto\b/);
      // … and the grid item around it may shrink below its content, which is
      // what lets that scrollbar exist instead of the dialog's.
      expect(gridItemOf(diff!).className).toMatch(/(^|\s)min-w-0(\s|$)/);
    },
  );
});
