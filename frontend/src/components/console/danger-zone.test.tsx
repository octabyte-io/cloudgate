import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DangerZone, type DangerAction } from "./danger-zone";

afterEach(cleanup);

/** Lets a handler that was not refused get as far as its first `await`. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const REASON = "Nothing newer than this version has been published.";

function action(overrides: Partial<DangerAction> = {}): DangerAction {
  return {
    id: "update-server",
    title: "Update this instance",
    description: "Replaces the running image with the newest published one.",
    button: "Update and restart",
    run: vi.fn(async () => undefined),
    done: "Updating.",
    ...overrides,
  };
}

/**
 * **An unavailable action is off in every way a reader can tell** (Settings →
 * Instance → "Update and restart").
 *
 * Its handler was already guarded, so a press did nothing — but the button's
 * `aria-disabled` was written by hand and carried no pointer to its reason, so a
 * screen reader heard "unavailable" with nothing after it and a mouse got no
 * tooltip. The shape is now the same as the resource dialog's test button: our
 * `Button`'s `disabled` (inert look, focusable, click swallowed), the reason as
 * `title`, and `aria-describedby` at the sentence already on the row.
 */
describe("DangerZone", () => {
  it("opens nothing for an unavailable action, and names why on the button", async () => {
    const run = vi.fn(async () => undefined);
    render(<DangerZone actions={[action({ unavailable: REASON, run })]} />);

    const button = screen.getByRole("button", { name: "Update and restart" });
    fireEvent.click(button);
    await settle();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(run).not.toHaveBeenCalled();

    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("title")).toBe(REASON);
    const reason = document.getElementById(
      button.getAttribute("aria-describedby") ?? "",
    );
    expect(reason?.textContent).toBe(REASON);
  });

  it("opens the confirmation for an available one", async () => {
    render(<DangerZone actions={[action()]} />);

    const button = screen.getByRole("button", { name: "Update and restart" });
    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    expect(button.getAttribute("title")).toBeNull();
    fireEvent.click(button);

    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("is off in the attribute the one inert rule in globals.css keys on", () => {
    // The look is not something jsdom can compute, so what is pinned is the
    // contract: the button carries `data-slot="button"` and
    // `aria-disabled="true"`, and globals.css flattens exactly that pair.
    render(<DangerZone actions={[action({ unavailable: REASON })]} />);
    const button = screen.getByRole("button", { name: "Update and restart" });
    expect(button.getAttribute("data-slot")).toBe("button");

    const css = readFileSync(
      join(process.cwd(), "src/app/globals.css"),
      "utf8",
    );
    expect(css).toContain('[data-slot="button"][aria-disabled="true"]');
  });
});
