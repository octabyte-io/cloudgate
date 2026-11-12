import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { Database } from "@/lib/api/endpoints/databases";

// The toast renders through a portal nothing here reads.
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { RebuildModal } = await import("./rebuild-modal");

afterEach(cleanup);

const database = {
  databaseId: "db-1",
  name: "ui-rd",
  appName: "redis-b8hgsp",
  dockerImage: "redis:8",
} as unknown as Database;

/** Types the name, presses Rebuild, and returns what the dialog says after. */
async function rebuildFailingWith(error: unknown) {
  render(
    <RebuildModal
      database={database}
      kind="redis"
      open
      onOpenChange={() => {}}
      rebuild={() => Promise.reject(error)}
    />,
  );
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "ui-rd" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Rebuild and delete the data" }),
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Rebuild and delete the data" })
        .getAttribute("aria-busy"),
    ).toBeNull(),
  );
  // The refusal is rendered in the same pass that clears the busy flag.
  await waitFor(() =>
    expect(document.body.textContent).toMatch(/Rebuild (stopped|again)/),
  );
  return document.body.textContent ?? "";
}

/**
 * A rebuild does its work in steps, so a failure part way has already
 * changed something — the service is gone before the volume is deleted. The
 * dialog must never say nothing changed, and must say where to look.
 */
describe("RebuildModal, when the rebuild fails", () => {
  it("shows the backend's own account of which step stopped it", async () => {
    const said = await rebuildFailingWith(
      new ApiError(
        409,
        "Rebuild stopped at deleting the data volume redis-b8hgsp-data: it was still in use by d4c9e1 after 60 seconds. The service was removed and the data is still there, so the Redis is offline. Rebuild again to finish, or Deploy to bring it back on the data it had.",
      ),
    );

    expect(said).toContain(
      "Rebuild stopped at deleting the data volume redis-b8hgsp-data",
    );
    expect(said).toContain("Rebuild again to finish");
  });

  it.each([
    ["a 500", new ApiError(500, "Internal server error")],
    ["a 504 from the proxy", new ApiError(504, "Gateway Timeout")],
    ["a dropped connection", new TypeError("Failed to fetch")],
  ])(
    "does not claim nothing changed after %s, and points at the status",
    async (_, error) => {
      const said = await rebuildFailingWith(error);

      expect(said).not.toMatch(/nothing changed/i);
      expect(said).not.toMatch(/could not reach the backend/i);
      expect(said).toMatch(/may still be running/i);
      expect(said).toMatch(/Rebuild again/);
    },
  );
});
