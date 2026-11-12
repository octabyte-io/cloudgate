import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResourceFormModal } from "@/components/console/resource-form-modal";
import {
  EVENT_FLAGS,
  notificationsApi,
  type NotificationChannel,
} from "@/lib/api/endpoints/notifications";

import { channelSpec } from "./channel-spec";

vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

/**
 * The channel form's "An enterprise license is about to expire" switch
 * shown next to the lapse switch on every channel's dialog, and what
 * it is set to is what the create and the update send as `licenseExpiring` —
 * the flag `LicenseExpiringEvent` is dispatched by. Off by default.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const LABEL = "An enterprise license is about to expire";

// By its field rather than its name: a spec-driven `Switch` has no accessible
// name of its own (previews-settings-card.test.tsx says why).
const licenseExpiring = () =>
  within(
    screen.getByText(LABEL).closest('[data-slot="field"]') as HTMLElement,
  ).getByRole("switch");

describe("the license expiring switch", () => {
  it("sits right after the license lapse switch", () => {
    render(
      <ResourceFormModal
        spec={channelSpec("slack", async () => undefined)}
        row={null}
        open
        onOpenChange={() => undefined}
      />,
    );

    const field = (text: string) =>
      screen.getByText(text).closest('[data-slot="field"]') as HTMLElement;
    const fields = Array.from(document.querySelectorAll('[data-slot="field"]'));
    expect(fields.indexOf(field(LABEL))).toBe(
      fields.indexOf(field("An enterprise license lapsed")) + 1,
    );
  });

  it("is off on an add, and a ticked one is sent on create", async () => {
    const create = vi
      .spyOn(notificationsApi, "create")
      .mockResolvedValue({} as never);
    render(
      <ResourceFormModal
        spec={channelSpec("slack", async () => undefined)}
        row={null}
        open
        onOpenChange={() => undefined}
      />,
    );

    expect(licenseExpiring().getAttribute("aria-checked")).toBe("false");
    fireEvent.change(screen.getByRole("textbox", { name: /^Name/ }), {
      target: { value: "Ops" },
    });
    fireEvent.change(screen.getByLabelText(/^Webhook URL/), {
      target: { value: "https://hooks.slack.com/services/T/B/x" },
    });
    fireEvent.click(licenseExpiring());
    fireEvent.click(screen.getByRole("button", { name: "Add Slack" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [type, body] = create.mock.calls[0];
    expect(type).toBe("slack");
    expect(body).toMatchObject({
      name: "Ops",
      licenseExpiring: true,
      licenseLapse: false,
    });
  });

  it("reads a saved channel's flag and sends it back on update", async () => {
    const update = vi
      .spyOn(notificationsApi, "update")
      .mockResolvedValue({} as never);
    const row = {
      notificationId: "n-1",
      name: "Ops",
      notificationType: "slack",
      createdAt: new Date().toISOString(),
      organizationId: "org-1",
      ...Object.fromEntries(EVENT_FLAGS.map((flag) => [flag, false])),
      licenseExpiring: true,
      slack: { slackId: "s-1", channel: null },
    } as unknown as NotificationChannel;
    render(
      <ResourceFormModal
        spec={channelSpec("slack", async () => undefined)}
        row={row}
        open
        onOpenChange={() => undefined}
      />,
    );

    expect(licenseExpiring().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(licenseExpiring());
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][2]).toMatchObject({ licenseExpiring: false });
  });
});
