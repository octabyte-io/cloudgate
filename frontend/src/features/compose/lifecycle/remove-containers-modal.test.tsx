import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ComposeDetail } from "@/lib/api/endpoints/compose";

import { RemoveContainersModal } from "./remove-containers-modal";

afterEach(cleanup);

const compose = {
  composeId: "cmp-1",
  name: "invoices",
  appName: "invoices-a1b2c3",
  composeType: "docker-compose",
} as ComposeDetail;

function open() {
  render(
    <RemoveContainersModal
      compose={compose}
      open
      onOpenChange={() => {}}
      onConfirm={() => {}}
    />,
  );
  return document.body.textContent ?? "";
}

/**
 * The dialog's whole job is telling this rung apart from the two either side of
 * it, so what it says is worth asserting rather than eyeballing: three lifecycle
 * actions on one row read alike and do not act alike.
 */
describe("RemoveContainersModal", () => {
  it("names both lists — what goes, and what survives", () => {
    const said = open();

    expect(said).toContain("Every container in this stack is removed");
    expect(said).toContain("Named volumes kept");
    expect(said).toContain(`compose/${compose.appName}`);
    expect(said).toContain("This is not Delete.");
  });

  // The row used to read "Volumes kept — all of them", which is true of the
  // volume and false of the data in it. An unnamed mount survives the removal and
  // Start does not re-attach it, so the promise the dialog made was one only a
  // named volume keeps. These two pin the honest version so it cannot revert to
  // the shorter, wronger sentence.
  it("says an unnamed mount comes back empty and the old volume is left behind", () => {
    const said = open();

    expect(said).not.toContain("Volumes kept");
    expect(said).toContain("Unnamed volumes");
    expect(said).toContain("not re-attached");
    expect(said).toContain("Start gives the service a new empty one");
    expect(said).toContain("stays on the deploy target with nothing using it");
  });

  it("names the console control that sweeps the leftovers, not a shell command", () => {
    const said = open();

    expect(said).toContain("Settings → Maintenance → Remove unused volumes");
    expect(said).not.toContain("docker volume");
  });

  // The pointer named the remedy and not its cost. On a real target the
  // sweep it recommends would have taken 8 volumes to clear 3 orphans, and the
  // warning lived one screen away, on the card being pointed at. The whole
  // sentence is pinned rather than a phrase out of it, because what drifted last
  // time was the sentence — and JSX collapses the source's line breaks to single
  // spaces, which is how the multi-word assertions above already work.
  it("names the blast radius where it recommends the sweep, not only where it runs", () => {
    const said = open();

    expect(said).toContain(
      "Settings → Maintenance → Remove unused volumes clears those, and it does not stop at those: it takes every volume on this Cloudgate host with no container attached, including a stopped database’s data, whether or not it belongs to this stack.",
    );
    // The pointer cannot go back to being a bare pointer.
    expect(said).not.toContain("Remove unused volumes clears those.");
  });

  // The consistency claim itself rather than a restatement of it: the dialog is
  // meant to borrow `maintenance-cleanup-card.tsx`'s wording word for word, and
  // `CLEANUPS` is module-private there. Exporting it for a test would be
  // worked-around-in-the-test rather than designed-for (§1.7), so the two are
  // pinned to the same substring from either side and cannot drift apart
  // silently. The card's own half lives in `maintenance-cleanup-card.test.tsx`.
  it("borrows the Maintenance card's words rather than paraphrasing them", () => {
    expect(open()).toContain(
      "every volume on this Cloudgate host with no container attached",
    );
  });

  it("says Start is what undoes it", () => {
    expect(open()).toContain("Start brings the stack back up");
  });

  it("asks for no typed name, because Start undoes this", () => {
    open();

    // ADR-0011: the typed name is reserved for the irreversible destruction of a
    // record. Nothing here is a confirmation field, and the action keeps the name
    // of the control that opened the dialog.
    expect(screen.queryByLabelText(/to confirm$/)).toBe(null);
    expect(screen.queryByRole("textbox")).toBe(null);
    expect(screen.getByRole("button", { name: "Remove containers" })).toBeDefined();
  });
});
