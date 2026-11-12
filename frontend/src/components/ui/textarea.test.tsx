import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { Textarea } from "./textarea";

/**
 * **A textarea never widens its container**.
 *
 * jsdom has no layout, so this pins the class rather than the width. What the
 * class does was measured in Chromium against the compiled stylesheet, on the
 * certificate dialog with a PEM pasted in: without it the dialog scrolled
 * sideways (603 wide in 598 at 1512px, 516 in 346 at 380px, Save off the
 * edge); with it the dialog fits at both. `min-w-0` and `max-w-full` alone
 * left the overflow exactly as it was.
 */

afterEach(cleanup);

it("keeps its content out of its width, and its height growing with it", () => {
  render(<Textarea aria-label="PEM" className="max-h-80 font-mono text-meta" />);
  const classes = screen.getByLabelText("PEM").classList;

  expect(classes).toContain("contain-inline-size");
  expect(classes).toContain("field-sizing-content");
  expect(classes).toContain("w-full");
});
