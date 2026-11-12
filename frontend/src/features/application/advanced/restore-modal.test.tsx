import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RestoreRefusal } from "./restore-modal";

afterEach(cleanup);

/**
 * The shape `replaceVolumeCommand` actually writes, rather than the words: an
 * `❌` headline, two continuation lines indented three spaces under it, and the
 * exit trap's cleanup line last. The words in the middle changed once already
 * (H-116 took "it is EMPTY" out of the second line), so pinning them here would
 * pin the wrong thing — what the backend sends down the wire and what X11-3
 * lost on the way to the screen is the **line structure**.
 */
const ABORT = [
  "❌ Volume restore aborted - the archive would not extract",
  "   Volume 'x11-vol-a' has already been removed and re-created, with its labels, and what it holds now is whatever the archive managed to extract before it failed. Read the 'tar' errors above for why.",
  "   The downloaded copy of 'x11vol/bad/badlink.tar' has been removed from '/etc/cloudgate/volume-backups/x11-vol-a' as this run exited, so restoring again re-downloads it from bucket 'w05-bucket'.",
  "Local backup file cleaned up ✅",
].join("\n");

describe("RestoreRefusal", () => {
  /**
   * The `\n`s were always in the text node — X11-3 was measured with computed
   * `white-space: normal` on the holder, which is a stylesheet fact jsdom has no
   * layout for. So the assertion is on the utility that decides it, and it is
   * the whole of the fix: without it the four lines are one run-on paragraph and
   * "…would not extract Volume 'x11-vol-a' has already been removed…" reads as
   * one sentence.
   */
  it("preserves the whitespace the backend wrote the abort block in", () => {
    render(<RestoreRefusal message={ABORT} />);

    expect(screen.getByRole("alert").className).toContain(
      "whitespace-pre-wrap",
    );
  });

  /**
   * `pre-wrap` over `pre-line` is the half of the decision that is about the
   * indent: the script indents its continuation lines to hang them under the
   * headline, and `pre-line` would collapse that away. Rendering the message is
   * not the same as reformatting it.
   */
  it("keeps the three spaces the script hangs its continuation lines on", () => {
    render(<RestoreRefusal message={ABORT} />);

    const holder = screen.getByRole("alert");
    expect(holder.className).not.toContain("whitespace-pre-line");
    expect(holder.textContent).toContain("\n   Volume 'x11-vol-a'");
    expect(holder.textContent).toContain("\n   The downloaded copy");
  });

  /** Nothing is rewritten on the way through — the backend's block, verbatim. */
  it("renders the message it was given and no more", () => {
    render(<RestoreRefusal message={ABORT} />);

    expect(screen.getByRole("alert").textContent).toBe(ABORT);
  });

  it("renders nothing while the restore has not been refused", () => {
    render(<RestoreRefusal message={null} />);

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
