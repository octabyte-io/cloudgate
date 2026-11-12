import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { domainsApi, type Domain } from "@/lib/api/endpoints/domains";
import { keys } from "@/lib/api/keys";

const useActiveOrganizationId = vi.hoisted(() => vi.fn());

// better-auth's session store, which the query keys and `useInvalidate` read
// at render. The writes themselves are replaced at `domainsApi` below.
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { useCreateDomain, useDeleteDomain, useUpdateDomain } = await import(
  "./use-domains"
);

const status = keys.traefik.configStatus("org-1", "app-1");

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

/** A client, and every key it has been asked to invalidate so far. */
function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidated = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const keysInvalidated = () =>
    invalidated.mock.calls.map(([filters]) => filters?.queryKey);
  return { wrapper, keysInvalidated };
}

/**
 * The Traefik notice kept its page-load reading after a domain save, next to a
 * toast saying Traefik already had the route. A save rewrites the
 * Application's Traefik file, and the backend's check of it lands about two
 * seconds after the request returns (`RELOAD_GRACE_MS`), so the verdict has to
 * be read again after that — and not before, when it is still the old one.
 */
describe("an Application's domain writes", () => {
  const cases = [
    {
      name: "a create",
      run: async (wrapper: (p: { children: ReactNode }) => ReactNode) => {
        vi.spyOn(domainsApi, "create").mockResolvedValue({} as Domain);
        const { result } = renderHook(() => useCreateDomain("app-1"), {
          wrapper,
        });
        await act(() => result.current.mutateAsync({ host: "a.example.com" }));
      },
    },
    {
      name: "an edit",
      run: async (wrapper: (p: { children: ReactNode }) => ReactNode) => {
        vi.spyOn(domainsApi, "update").mockResolvedValue({} as Domain);
        const { result } = renderHook(() => useUpdateDomain("app-1"), {
          wrapper,
        });
        await act(() =>
          result.current.mutateAsync({ domainId: "d1", input: { port: 81 } }),
        );
      },
    },
    {
      name: "a removal",
      run: async (wrapper: (p: { children: ReactNode }) => ReactNode) => {
        vi.spyOn(domainsApi, "remove").mockResolvedValue({} as Domain);
        const { result } = renderHook(
          () => useDeleteDomain({ applicationId: "app-1" }),
          { wrapper },
        );
        await act(() => result.current.mutateAsync("d1"));
      },
    },
  ];

  for (const { name, run } of cases) {
    it(`${name} reads Traefik's verdict again once its check has run`, async () => {
      const { wrapper, keysInvalidated } = harness();
      await run(wrapper);

      // The file view is stale at once: the write finished inside the request.
      expect(keysInvalidated()).toContainEqual([
        ...keys.traefik.all("org-1"),
        "file",
      ]);
      // The verdict is not, yet — reading it now returns the previous one.
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      expect(keysInvalidated()).not.toContainEqual(status);

      await act(() => vi.advanceTimersByTimeAsync(1_000));
      expect(keysInvalidated()).toContainEqual(status);
    });
  }

  it("leaves Traefik alone for a stack's domain, which has no verdict of its own", async () => {
    const { wrapper, keysInvalidated } = harness();
    vi.spyOn(domainsApi, "remove").mockResolvedValue({} as Domain);
    const { result } = renderHook(
      () => useDeleteDomain({ composeId: "cmp-1" }),
      { wrapper },
    );
    await act(() => result.current.mutateAsync("d1"));
    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(
      keysInvalidated().some((key) => key?.includes("traefik")),
    ).toBe(false);
  });
});
