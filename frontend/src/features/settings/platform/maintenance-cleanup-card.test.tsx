import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const useActiveOrganizationId = vi.hoisted(() => vi.fn());

// One system boundary, replaced rather than driven: better-auth's session
// store, which `useInvalidate` reads at render. Nothing of the card's own is
// doubled — these assertions are about the words it ships.
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { CleanupCard } = await import("./maintenance-cleanup-card");
const { settingsApi } = await import("@/lib/api/endpoints/settings");
const { keys } = await import("@/lib/api/keys");

afterEach(() => {
  cleanup();
  useActiveOrganizationId.mockReset();
  vi.restoreAllMocks();
});

function said(): string {
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(wrap(<CleanupCard />));
  return document.body.textContent ?? "";
}

/**
 * The card is the honest half of a warning that is told at two distances, and
 * this is the half that pins it.
 *
 * `RemoveContainersModal` recommends this control from a compose stack's Remove
 * containers dialog, and it borrows the sentence below **word for word** rather
 * than paraphrasing it — a second, prettier formulation of the same warning is
 * how the two screens drift apart. `CLEANUPS` is module-private and exporting it
 * for a test would be worked-around-in-the-test rather than designed-for (§1.7),
 * so both sides assert the same substring instead and neither can move alone.
 */
describe("CleanupCard", () => {
  it("keeps the blast radius sentence the Remove containers dialog quotes", () => {
    expect(said()).toContain("Every volume with no container attached");
  });

  it("still says why it is the one cleanup that must never be scheduled", () => {
    // `cleanup.service.ts` backs this up rather than only promising it: `volumes`
    // is in `excludedCleanupAllCommands`, so no nightly path prunes them.
    expect(said()).toContain("including a stopped database's data");
    expect(said()).toContain("Never run on a schedule for that reason.");
  });

  /**
   * "Delete metrics" emptied the monitoring directory and left every
   * stored row, while promising the Monitoring screen's history restarted. The
   * route now deletes the host's rows too; the copy has to say which rows, and
   * that a Server's are not among them.
   */
  it("says Delete metrics deletes this host's stored samples and keeps a Server's", () => {
    const text = said();
    expect(text).toContain("Deletes every sample stored for this host");
    expect(text).toContain(
      "a Server's samples are kept until its own retention deletes them",
    );
    // The live stream writes no directory any more, so the control no
    // longer empties one and must not say it does.
    expect(text).not.toContain("monitoring directory");
  });

  /**
   * The host's stored series lives under `monitoring`, not `instance`, and
   * a stopped host's series is not polled — so after the delete it has to be
   * dropped, or /monitoring keeps drawing rows that are gone.
   */
  it("drops the cached host series when Delete metrics succeeds", async () => {
    // The HTTP call is the boundary; the invalidation is the card's own.
    vi.spyOn(settingsApi, "cleanup").mockResolvedValue(true as never);
    useActiveOrganizationId.mockReturnValue({
      organizationId: "org-1",
      pending: false,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const series = keys.monitoring.serverMetrics("org-1", "web-server", "a..b");
    client.setQueryData(series, []);
    render(
      <QueryClientProvider client={client}>
        <CleanupCard />
      </QueryClientProvider>,
    );

    const button = Array.from(document.querySelectorAll("button")).find(
      (element) => element.textContent === "Delete metrics",
    );
    fireEvent.click(button!);

    await waitFor(() =>
      expect(client.getQueryState(series)?.isInvalidated).toBe(true),
    );
  });
});
