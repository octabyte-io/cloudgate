import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { CodeWell } from "./code-well";
import { Modal } from "./modal";

/**
 * **A code well never widens the dialog it sits in**.
 *
 * Inspecting a container put 202 lines of `docker inspect` in a wide Modal, and
 * the `/var/lib/docker/containers/<64-hex>/…` paths made the *dialog* the
 * horizontal scroller (843 wide, 1316 scrolled) — its title and ✕ slid away and
 * its Close button sat off the right edge — while the `<pre>` meant to scroll
 * never overflowed at all. The dialog is a grid whose one implicit column takes
 * its item's min-content width, and that item's min-content was the longest
 * line.
 *
 * jsdom has no layout, so this pins the class chain rather than the widths.
 * What the chain does was measured in headless Chromium on a reproduction of
 * the dialog's styles with a 400-character line: without `contain-inline-size`
 * the dialog read `clientWidth 858, scrollWidth 3229`; with it `858, 858`, and
 * the `<pre>` was the element that overflowed (`788` in `3159`) — with the body
 * wrapped in a `<form>` too, which `min-w-0` on `Modal.Body` alone does not
 * survive.
 */

afterEach(cleanup);

it("keeps a long line inside its own scroller, not the dialog's", () => {
  render(
    <Modal open wide>
      <Modal.Header title="ui-probe-1" />
      <Modal.Body>
        <CodeWell content={"x".repeat(400)} label="docker inspect ui-probe-1" />
      </Modal.Body>
    </Modal>,
  );

  const pre = screen.getByLabelText("docker inspect ui-probe-1");
  const dialog = screen.getByRole("dialog");
  expect(dialog.contains(pre)).toBe(true);

  // The <pre> is the horizontal scroller…
  expect(pre.classList).toContain("overflow-x-auto");
  expect(pre.classList).toContain("min-w-0");

  // …and something between it and the dialog takes the content out of the
  // width the dialog's grid column is sized to.
  const chain: HTMLElement[] = [];
  for (let el = pre.parentElement; el && el !== dialog; el = el.parentElement) {
    chain.push(el);
  }
  expect(chain.some((el) => el.classList.contains("contain-inline-size"))).toBe(
    true,
  );
});
