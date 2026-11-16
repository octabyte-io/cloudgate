import { cleanup, fireEvent, render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useUnsavedChangesGuard } from "./use-unsaved-changes";

/**
 * **The guard is off in the same commit that says the edits are saved**.
 *
 * A save clears `dirty`, and the "Unsaved changes" line goes with that
 * commit. A guard still listening after it would ask about edits the screen
 * says are saved: in a test that clicks as soon as the line is gone, under
 * load, that was SwarmSection's "lets a link through" failing now and then
 * (#78). The probe clicks from a layout effect of that very commit, before
 * any work React leaves for later could run.
 */
function Probe({ dirty, clicks }: { dirty: boolean; clicks: boolean[] }) {
  useUnsavedChangesGuard(dirty, "Leave without saving?");
  return <ClickOnSaved dirty={dirty} clicks={clicks} />;
}

function ClickOnSaved({
  dirty,
  clicks,
}: {
  dirty: boolean;
  clicks: boolean[];
}) {
  useLayoutEffect(() => {
    if (dirty) return;
    const anchor = document.createElement("a");
    anchor.href = "/applications/app-1/deployments";
    document.body.append(anchor);
    clicks.push(fireEvent.click(anchor));
    anchor.remove();
  }, [dirty, clicks]);
  return null;
}

describe("useUnsavedChangesGuard", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lets a link through in the same commit that clears dirty, asking nothing", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const clicks: boolean[] = [];
    const { rerender } = render(<Probe dirty clicks={clicks} />);

    rerender(<Probe dirty={false} clicks={clicks} />);

    // `fireEvent` answers true when nothing prevented the default: followed.
    expect(clicks).toEqual([true]);
    expect(confirm).not.toHaveBeenCalled();
  });
});
