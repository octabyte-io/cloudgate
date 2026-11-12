import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/console/toast";
import { settingsApi } from "@/lib/api/endpoints/settings";
import type { Gate } from "@/lib/auth/use-permission";

const useActiveOrganizationId = vi.hoisted(() => vi.fn());
const useLicenseStatus = vi.hoisted(() => vi.fn());
const useInstanceGate = vi.hoisted(() => vi.fn<() => Gate>());

// One system boundary, replaced rather than driven: better-auth's session
// store, which `useInvalidate` reads at render for this card's mutation.
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

// Only for the Concurrent builds card, rendered beside this one to show the two
// are gated alike.
vi.mock("@/features/enterprise/use-license", () => ({ useLicenseStatus }));

// The instance-authority read (ADR-0013) is the boundary for the gate; the
// mutations stay real, so the request is what the spy on `settingsApi` sees.
vi.mock("./use-platform", async (original) => ({
  ...(await original<typeof import("./use-platform")>()),
  useInstanceGate,
}));

const { RequestedPreviewMaxTtlCard } = await import(
  "./requested-preview-max-ttl-card"
);
const { ConcurrentBuildsCard } = await import("./concurrent-builds-card");

const REFUSAL = "Only an administrator of this instance can change this.";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useActiveOrganizationId.mockReset();
  useLicenseStatus.mockReset();
  useInstanceGate.mockReset();
});

function mount(
  value: number,
  { allowed = true, beside = false }: { allowed?: boolean; beside?: boolean } = {},
) {
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
  useLicenseStatus.mockReturnValue({
    data: { licensed: true },
    isPending: false,
    error: null,
  });
  useInstanceGate.mockReturnValue({
    allowed,
    refusal: allowed ? "" : REFUSAL,
  });

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(
    wrap(
      <>
        {beside ? <ConcurrentBuildsCard value={1} /> : null}
        <RequestedPreviewMaxTtlCard value={value} />
      </>,
    ),
  );
}

const box = () => screen.getByLabelText(/^Longest a requested preview lives/);
const card = () =>
  screen
    .getByRole("heading", { name: "Requested preview lifetime" })
    .closest('[data-slot="card"]') as HTMLElement;

/**
 * The instance maximum TTL: `web_server_settings.
 * requested_preview_max_ttl_minutes`, written by
 * `POST /settings/requested-preview-max-ttl` behind the same instance
 * authority as `POST /settings/builds-concurrency`.
 */
describe("the Requested preview lifetime card", () => {
  it("reads the stored maximum back, and says what 1440 minutes is", () => {
    mount(1440);

    expect((box() as HTMLInputElement).value).toBe("1440");
    expect(card().textContent).toContain("24 hours");
  });

  it("holds exactly one number: the default of 60 minutes is fixed, not a field", () => {
    mount(1440);

    expect(within(card()).getAllByRole("spinbutton")).toHaveLength(1);
    expect(card().textContent).toContain("60 minutes");
  });

  it("saves the maximum and says so", async () => {
    mount(1440);
    const save = vi
      .spyOn(settingsApi, "updateRequestedPreviewMaxTtl")
      .mockResolvedValue(true as never);
    const done = vi.spyOn(toast, "done").mockImplementation(() => "");

    fireEvent.change(box(), { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(save).toHaveBeenCalledWith(120));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(done.mock.calls[0]?.[0]).toBe(
      "The requested preview maximum lifetime is saved.",
    );
  });

  it.each([
    ["0", "At least one minute."],
    ["10081", "A week (10080 minutes) is the most this accepts."],
  ])("refuses %s before it is sent", async (typed, sentence) => {
    mount(1440);
    const save = vi.spyOn(settingsApi, "updateRequestedPreviewMaxTtl");

    fireEvent.change(box(), { target: { value: typed } });
    fireEvent.submit(box().closest("form") as HTMLFormElement);

    await waitFor(() => expect(card().textContent).toContain(sentence));
    expect(save).not.toHaveBeenCalled();
  });

  it("is gated exactly as Concurrent builds is: Save off with the same reason, and a forced submit sends nothing", async () => {
    mount(1440, { allowed: false, beside: true });
    const save = vi.spyOn(settingsApi, "updateRequestedPreviewMaxTtl");

    const buttons = screen.getAllByRole("button", { name: "Save changes" });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("title")).toBe(REFUSAL);
    }

    fireEvent.submit(box().closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(within(card()).getByRole("alert").textContent).toContain(REFUSAL),
    );
    expect(save).not.toHaveBeenCalled();
  });
});

