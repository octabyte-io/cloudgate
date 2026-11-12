import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  portsApi,
  redirectsApi,
  securityApi,
} from "@/lib/api/endpoints/networking";
import { keys } from "@/lib/api/keys";

const useActiveOrganizationId = vi.hoisted(() => vi.fn());

// better-auth's session store, which `useInvalidate` reads at render. The
// writes themselves are replaced at their endpoint objects below.
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { useNetworkingMutations } = await import("./use-advanced");

const status = keys.traefik.configStatus("org-1", "app-1");
const file = [...keys.traefik.all("org-1"), "file"];

beforeEach(() => {
  vi.useFakeTimers();
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The Advanced tab's writes, and every key they have invalidated so far. */
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidated = vi.spyOn(client, "invalidateQueries");
  const { result } = renderHook(() => useNetworkingMutations("app-1"), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  const keysInvalidated = () =>
    invalidated.mock.calls.map(([filters]) => filters?.queryKey);
  return { mutations: result, keysInvalidated };
}

/**
 * A redirect or basic-auth save rewrites the Application's Traefik file, and
 * the Advanced tab kept showing the file as it was at page load, and the
 * Redirects card kept marking a redirect "in the chain of a router Traefik
 * refused" after the refusal was removed (both comments).
 */
describe("the Advanced tab's networking writes", () => {
  it("a redirect removal re-reads the file now and Traefik's verdict after its check", async () => {
    vi.spyOn(redirectsApi, "remove").mockResolvedValue(undefined as never);
    const { mutations, keysInvalidated } = mount();
    await act(() => mutations.current.redirects.remove.mutateAsync("r1"));

    expect(keysInvalidated()).toContainEqual(file);
    expect(keysInvalidated()).not.toContainEqual(status);

    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(keysInvalidated()).toContainEqual(status);
  });

  it("a basic-auth removal does the same", async () => {
    vi.spyOn(securityApi, "remove").mockResolvedValue(undefined as never);
    const { mutations, keysInvalidated } = mount();
    await act(() => mutations.current.security.remove.mutateAsync("s1"));
    await act(() => vi.advanceTimersByTimeAsync(3_000));

    expect(keysInvalidated()).toContainEqual(file);
    expect(keysInvalidated()).toContainEqual(status);
  });

  it("a published port, which Traefik's file does not carry, does not", async () => {
    vi.spyOn(portsApi, "remove").mockResolvedValue(undefined as never);
    const { mutations, keysInvalidated } = mount();
    await act(() => mutations.current.ports.remove.mutateAsync("p1"));
    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(
      keysInvalidated().some((key) => key?.includes("traefik")),
    ).toBe(false);
  });
});
