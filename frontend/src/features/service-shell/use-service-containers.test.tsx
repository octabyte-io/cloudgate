import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dockerApi } from "@/lib/api/endpoints/docker";
import { makeQueryClient } from "@/lib/api/query-client";

import {
  SERVICE_CONTAINERS_STALE_MS,
  useServiceContainers,
} from "./use-service-containers";

vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org_1", pending: false }),
}));

/**
 * The lookup is a `docker ps` — over SSH for a Service on a Server — and every
 * tab of a Service page asks it, through the Dock's `+` offer as well
 * as the Shell tab. Moving between those tabs must not run it again.
 */
let now = 0;

beforeEach(() => {
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useServiceContainers", () => {
  it("one docker ps serves every tab of a Service page for its stale time", async () => {
    const ps = vi.spyOn(dockerApi, "serviceContainers").mockResolvedValue([]);
    const client = makeQueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const first = renderHook(
      () => useServiceContainers("application", "app_1"),
      { wrapper },
    );
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();

    // Past the console's 30-second default, inside this read's own.
    now += 45_000;
    expect(SERVICE_CONTAINERS_STALE_MS).toBeGreaterThan(45_000);
    const second = renderHook(
      () => useServiceContainers("application", "app_1"),
      { wrapper },
    );
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    window.dispatchEvent(new Event("focus"));

    expect(ps).toHaveBeenCalledTimes(1);

    // Past it, a fresh mount asks again: a Deploy replaces the containers.
    second.unmount();
    now += SERVICE_CONTAINERS_STALE_MS;
    renderHook(() => useServiceContainers("application", "app_1"), {
      wrapper,
    });
    await waitFor(() => expect(ps).toHaveBeenCalledTimes(2));
  });
});
