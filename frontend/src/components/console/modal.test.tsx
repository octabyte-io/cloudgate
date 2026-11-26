import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Modal } from "./modal";

afterEach(cleanup);

/**
 * The popup is a CSS grid, and an implicit grid column is as wide as its
 * widest unbreakable line: a truncating `KVRow` holding a stack's tarball
 * path (#170) made the column wider than the dialog, so the dialog scrolled
 * sideways and every step lost its edges. One `minmax(0, 1fr)` column
 * (`grid-cols-1`) holds every child to the dialog's width, which is what
 * lets a row truncate at all. jsdom has no layout, so the assertion is on the
 * utility that decides it.
 */
describe("Modal", () => {
  it("holds its children to one column as wide as the dialog", () => {
    render(
      <Modal open onOpenChange={() => {}}>
        <Modal.Header title="Restore a volume" />
        <Modal.Body>body</Modal.Body>
      </Modal>,
    );

    const popup = document.querySelector('[data-slot="dialog-content"]');
    expect(popup?.className).toContain("grid-cols-1");
  });
});
