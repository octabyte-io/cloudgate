import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { composeApi, type StackVmStatus } from "@/lib/api/endpoints/compose";

const useActiveOrganizationId = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { StackVmRunState } = await import("./stack-vm-status");

beforeEach(() => {
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(answer: StackVmStatus | Error) {
  const read = vi
    .spyOn(composeApi, "stackVmStatus")
    .mockImplementation(() =>
      answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer),
    );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <StackVmRunState composeId="cmp-1" />
    </QueryClientProvider>,
  );
  return read;
}

/**
 * The stack page says whether the stack's Stack VM runs, read from its
 * cloud (#1370), so a VM problem is told apart from an app problem.
 */
describe("StackVmRunState", () => {
  it("says the Stack VM is running, as its cloud read it", async () => {
    const read = mount({ state: "running" });

    expect(await screen.findByText("Running")).toBeTruthy();
    expect(read).toHaveBeenCalledWith("cmp-1");
  });

  it("says a stopped Stack VM is stopped, and that Start brings it back", async () => {
    mount({ state: "stopped" });

    const chip = await screen.findByText("Stopped");
    expect(chip.getAttribute("title")).toBe(
      "Only its disk is billed while it is stopped. Start brings it back.",
    );
  });

  it("says a Stack VM the cloud no longer has is not found", async () => {
    mount({ state: "gone" });

    expect(await screen.findByText("Not found in the cloud")).toBeTruthy();
  });

  it("shows the cloud's own words when the cloud did not answer", async () => {
    mount({ state: "unknown", reason: "UnauthorizedOperation: not allowed" });

    const chip = await screen.findByText("Unknown");
    expect(chip.getAttribute("title")).toBe(
      "UnauthorizedOperation: not allowed",
    );
  });

  it("says it could not read the state when the request failed", async () => {
    mount(new Error("Bad gateway"));

    expect(await screen.findByText("Could not read")).toBeTruthy();
  });
});
