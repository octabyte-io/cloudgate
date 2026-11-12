import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApplicationDetail } from "@/lib/api/endpoints/applications";

const usePermission = vi.hoisted(() => vi.fn());

// The caller's effective statements are the boundary; the card is real.
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission,
}));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { APPLICATION_SETTINGS_REFUSAL } = await import("../use-application");
const { CopyRangeCard } = await import("./copy-range-card");

const application = {
  applicationId: "app-1",
  minCopies: 1,
  maxCopies: 3,
  cloudPlace: {
    cloudAccountId: "cloud-1",
    cloudAccountName: "Production Google",
    cloud: "gcp",
    region: "europe-west1",
  },
} as unknown as ApplicationDetail;

afterEach(() => {
  cleanup();
  usePermission.mockReset();
});

function mount({ allowed }: { allowed: boolean }) {
  usePermission.mockReturnValue({ allowed, pending: false, role: "member" });
  const save = vi.fn(async () => undefined);
  render(<CopyRangeCard application={application} save={save} />);
  return { save, button: screen.getByRole("button", { name: "Save changes" }) };
}

const field = (label: string) =>
  screen.getByLabelText(label, { exact: false }) as HTMLInputElement;

/**
 * S10: a Cloud Run Service's copy range on its Advanced tab,
 * saved through `PUT /applications/:id/copy-range`, `service: ['update']`.
 */
describe("CopyRangeCard", () => {
  it("shows the Service's range and asks for service:update", () => {
    mount({ allowed: true });

    expect(usePermission).toHaveBeenCalledWith({ service: ["update"] });
    expect(field("Fewest copies").value).toBe("1");
    expect(field("Most copies").value).toBe("3");
    expect(document.body.textContent).toContain(
      "Set on Cloud Run as soon as it is saved, without a Deployment",
    );
  });

  it("saves the range as numbers", async () => {
    const { save, button } = mount({ allowed: true });

    fireEvent.change(field("Fewest copies"), { target: { value: "2" } });
    fireEvent.change(field("Most copies"), { target: { value: "5" } });
    fireEvent.click(button);

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ minCopies: 2, maxCopies: 5 }),
    );
  });

  it("refuses fewer than it runs at most, sending nothing", async () => {
    const { save, button } = mount({ allowed: true });

    fireEvent.change(field("Fewest copies"), { target: { value: "4" } });
    fireEvent.click(button);

    expect(
      await screen.findByText(
        "The fewest copies cannot be more than the most copies.",
      ),
    ).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("is off with the reason for a role that cannot change the Service", async () => {
    const { save, button } = mount({ allowed: false });

    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe(APPLICATION_SETTINGS_REFUSAL);
    fireEvent.submit(button.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        APPLICATION_SETTINGS_REFUSAL,
      ),
    );
    expect(save).not.toHaveBeenCalled();
  });
});
