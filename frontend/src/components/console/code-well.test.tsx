import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { CodeWell } from "./code-well";
import { Modal } from "./modal";

/**
 * **A code well never widens the dialog it sits in, and never scrolls
 * sideways.**
 *
 * Inspecting a container put 202 lines of `docker inspect` in a wide Modal, and
 * the `/var/lib/docker/containers/<64-hex>/…` paths made the *dialog* the
 * horizontal scroller (843 wide, 1316 scrolled) — its title and ✕ slid away and
 * its Close button sat off the right edge. The dialog is a grid whose one
 * implicit column takes its item's min-content width, and that item's
 * min-content was the longest line. `contain-inline-size` fixed that (measured
 * in headless Chromium: `clientWidth 858, scrollWidth 3229` without it, `858,
 * 858` with it). The `<pre>` was then the sideways scroller; it now wraps
 * instead, as every code and text view in the console does.
 *
 * jsdom has no layout, so this pins the class chain rather than the widths.
 */

afterEach(cleanup);

it("wraps a long line instead of scrolling, and keeps the dialog its own width", () => {
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

  // The <pre> wraps, keeping its whitespace, and breaks a token with no spaces…
  expect(pre.classList).toContain("whitespace-pre-wrap");
  expect(pre.classList).toContain("wrap-anywhere");
  expect(pre.classList).not.toContain("overflow-x-auto");

  // …and something between it and the dialog takes the content out of the
  // width the dialog's grid column is sized to, and nothing scrolls sideways.
  const chain: HTMLElement[] = [];
  for (let el = pre.parentElement; el && el !== dialog; el = el.parentElement) {
    chain.push(el);
  }
  expect(chain.some((el) => el.classList.contains("contain-inline-size"))).toBe(
    true,
  );
  for (const el of [pre, ...chain]) {
    expect(el.classList).not.toContain("overflow-x-auto");
    expect(el.classList).not.toContain("overflow-auto");
  }
});

it("is still one <pre> holding the file, one block per line, each hanging at its indentation", () => {
  const content = "services:\n  web:\n    image: nginx\n\nvolumes: {}\n";
  render(<CodeWell content={content} label="compose" />);

  const pre = screen.getByLabelText("compose");
  // The numbers are generated content, not text, so copying gets the file.
  expect(pre.textContent).toBe(content.replace(/\n$/, ""));

  const lines = pre.querySelectorAll<HTMLElement>("[data-line]");
  expect(lines).toHaveLength(5);
  expect([...lines].map((line) => line.style.getPropertyValue("--hang"))).toEqual(
    ["0ch", "2ch", "4ch", "0ch", "0ch"],
  );
});
