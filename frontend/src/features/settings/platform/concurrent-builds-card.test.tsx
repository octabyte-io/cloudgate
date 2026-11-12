import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/console/toast";
import { settingsApi } from "@/lib/api/endpoints/settings";

const useActiveOrganizationId = vi.hoisted(() => vi.fn());
const useLicenseStatus = vi.hoisted(() => vi.fn());

// One system boundary, replaced rather than driven: better-auth's session
// store, which `useInvalidate` reads at render for this card's mutation.
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

// `GET /license/status`, at the hook every other lock in the console reads it
// through — so what is asserted is the card's behaviour on the answer, not the
// shape of the request that fetched it.
vi.mock("@/features/enterprise/use-license", () => ({ useLicenseStatus }));

// A Self-hosted instance, where the lock points at a license.
vi.mock("@/lib/api/use-instance-mode", () => ({
  useInstanceMode: () => ({ data: "self-hosted", isPending: false }),
}));

const { ConcurrentBuildsCard } = await import("./concurrent-builds-card");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useActiveOrganizationId.mockReset();
  useLicenseStatus.mockReset();
});

/**
 * The notice the Concurrent builds card owes an unlicensed instance.
 *
 * `createBuildsConcurrencyResolver` returns 1 for every partition without a
 * valid licence, whatever is stored —
 * `backend/test/deployment-queue/concurrency.spec.ts` pins that end. This pins
 * the end an operator can see: the card said nothing about a licence at all, so
 * raising the value, saving it and watching the next Deployment queue anyway
 * was a silent contradiction with no way out of it.
 *
 * Both halves are asserted, because the notice alone is not enough to catch
 * somebody who presses Save: the toast is what they are reading at that moment.
 */
function mount(licensed: boolean | undefined) {
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
  useLicenseStatus.mockReturnValue({
    data: licensed === undefined ? undefined : { licensed },
    isPending: licensed === undefined,
    error: null,
  });

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(wrap(<ConcurrentBuildsCard value={1} />));
}

describe("the Concurrent builds card", () => {
  it("says parallel builds need a license, and links to License", () => {
    mount(false);

    const text = document.body.textContent ?? "";
    expect(text).toContain(
      "Building more than one Deployment at a time is an enterprise feature",
    );
    expect(text).toContain("builds one at a time whatever is set here");
    // A link styled as the console's button, which is how every other
    // lock offers this same way out.
    expect(
      screen.getByRole("link", { name: "Go to License" }).getAttribute("href"),
    ).toBe("/settings/license");
  });

  it("claims nothing while the license read has not landed", () => {
    mount(undefined);

    expect(document.body.textContent ?? "").not.toContain("license");
  });

  it("shows nothing about a license once the instance holds one", () => {
    mount(true);

    const text = document.body.textContent ?? "";
    expect(text).not.toContain("enterprise feature");
    expect(screen.queryByRole("link", { name: "Go to License" })).toBeNull();
  });

  it("does not report plain success when an unlicensed instance saves a 2", async () => {
    mount(false);
    const save = vi
      .spyOn(settingsApi, "updateBuildsConcurrency")
      .mockResolvedValue(true as never);
    const done = vi.spyOn(toast, "done").mockImplementation(() => "");

    fireEvent.change(screen.getByLabelText("At once"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(save).toHaveBeenCalledWith(2));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(done.mock.calls[0]?.[0]).toContain(
      "still builds one Deployment at a time",
    );
  });

  it("reports the plain save on a licensed instance", async () => {
    mount(true);
    vi.spyOn(settingsApi, "updateBuildsConcurrency").mockResolvedValue(
      true as never,
    );
    const done = vi.spyOn(toast, "done").mockImplementation(() => "");

    fireEvent.change(screen.getByLabelText("At once"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(done.mock.calls[0]?.[0]).toBe("The build concurrency is saved.");
  });
});
