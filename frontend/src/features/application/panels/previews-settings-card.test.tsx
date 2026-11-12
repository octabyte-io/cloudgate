import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { ApplicationDetail } from "@/lib/api/endpoints/applications";

import type { useApplication, useUpdateApplication } from "../use-application";

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
const { PreviewSettingsCard } = await import("./previews-settings-card");

type Row = NonNullable<ReturnType<typeof useApplication>["data"]>;

const row = {
  applicationId: "app-1",
  isPreviewDeploymentsActive: false,
  previewWildcard: null,
  previewDnsChallenge: false,
  serverId: null,
  server: null,
  previewLimit: 3,
  previewPort: 3000,
  previewEnv: null,
  previewBuildArgs: null,
  requestedPreviewsAllowed: false,
  requestedPreviewLimit: 3,
} as unknown as Row;

afterEach(() => {
  cleanup();
  usePermission.mockReset();
});

function mount({
  allowed,
  overrides = {},
}: {
  allowed: boolean;
  overrides?: Partial<ApplicationDetail>;
}) {
  usePermission.mockReturnValue({ allowed, pending: false, role: "member" });
  const mutateAsync = vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined);
  render(
    <PreviewSettingsCard
      row={{ ...row, ...overrides }}
      update={{ mutateAsync } as unknown as ReturnType<typeof useUpdateApplication>}
    />,
  );
  return { mutateAsync, button: screen.getByRole("button", { name: "Save changes" }) };
}

/**
 * Preview settings' Save: `PATCH /applications/:id`, which
 * `findOwnedForUpdate` holds to `service: ['update']`.
 */
describe("PreviewSettingsCard — Save", () => {
  it("asks for service:update", () => {
    mount({ allowed: true });
    expect(usePermission).toHaveBeenCalledWith({ service: ["update"] });
  });

  it("is off with the reason for a role that cannot change the Application, and a forced submit sends nothing", async () => {
    const { mutateAsync, button } = mount({ allowed: false });

    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe(APPLICATION_SETTINGS_REFUSAL);

    // Enter in a field submits the form whatever the button says.
    fireEvent.click(button);
    fireEvent.submit(button.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(APPLICATION_SETTINGS_REFUSAL),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("is live for a role that can, and saves", async () => {
    const { mutateAsync, button } = mount({ allowed: true });

    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    expect(button.hasAttribute("title")).toBe(false);
    expect(document.body.textContent).not.toContain(APPLICATION_SETTINGS_REFUSAL);

    fireEvent.click(button);
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        isPreviewDeploymentsActive: false,
        previewWildcard: null,
        previewDnsChallenge: false,
        previewLimit: 3,
        previewPort: 3000,
        previewEnv: null,
        previewBuildArgs: null,
        requestedPreviewsAllowed: false,
        requestedPreviewLimit: 3,
      }),
    );
  });
});

/**
 * The Requested previews group: `requestedPreviewsAllowed` and
 * `requestedPreviewLimit`, both columns `PATCH /applications/:id`
 * writes under `service: ['update']`, beside the pull-request settings.
 */
describe("PreviewSettingsCard — Requested previews", () => {
  // By its field rather than its name: a spec-driven `Switch` is not given the
  // label's id or the hint's (`Field` clones them onto the `Controller`), so
  // it has no accessible name to be found by. Pre-existing, and not this card's.
  const allowField = () =>
    screen
      .getByText("Allow requested previews")
      .closest('[data-slot="field"]') as HTMLElement;
  const allowSwitch = () => within(allowField()).getByRole("switch");
  const cap = () => screen.getByLabelText(/^Most requested previews at once/);

  it("sits in its own group on the card", () => {
    mount({ allowed: true });
    expect(screen.getByText("Requested previews")).toBeTruthy();
  });

  it("reads both back off the row", () => {
    mount({
      allowed: true,
      overrides: { requestedPreviewsAllowed: true, requestedPreviewLimit: 5 },
    });
    expect(allowSwitch().getAttribute("aria-checked")).toBe("true");
    expect((cap() as HTMLInputElement).value).toBe("5");
  });

  it("saves the switch and the cap", async () => {
    const { mutateAsync, button } = mount({ allowed: true });

    fireEvent.click(allowSwitch());
    fireEvent.change(cap(), { target: { value: "7" } });
    fireEvent.click(button);

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      requestedPreviewsAllowed: true,
      requestedPreviewLimit: 7,
    });
  });

  it("refuses a cap of 0, since none is the switch", async () => {
    const { mutateAsync, button } = mount({ allowed: true });

    fireEvent.change(cap(), { target: { value: "0" } });
    // Submitted directly: the box's own `min` would have the browser hold a
    // click back, and the schema is what has to refuse it.
    fireEvent.submit(button.closest("form") as HTMLFormElement);

    await waitFor(() =>
      expect(cap().getAttribute("aria-invalid")).toBe("true"),
    );
    expect(document.body.textContent).toContain("turn requested previews off");
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("warns on the switch that a requested preview runs against this Application's storage and environment", () => {
    mount({ allowed: true });
    const hint = allowField().textContent ?? "";
    expect(hint).toContain("this Application's storage and environment");
    expect(hint).toContain("unless the preview variables");
  });

  it("says the pull-request limit counts pull-request previews only", () => {
    mount({ allowed: true });
    const hint = describedBy(screen.getByLabelText(/^Most previews at once/));
    expect(hint).toContain("pull-request previews only");
  });

  it("is off with the reason for a role that cannot change the Application, and a forced submit sends neither", async () => {
    const { mutateAsync, button } = mount({ allowed: false });

    fireEvent.click(allowSwitch());
    fireEvent.change(cap(), { target: { value: "7" } });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe(APPLICATION_SETTINGS_REFUSAL);

    fireEvent.submit(button.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(APPLICATION_SETTINGS_REFUSAL),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});

/**
 * The DNS-01 switch: `previewDnsChallenge`, written by the same
 * `PATCH /applications/:id`. The backend refuses it on without a preview
 * wildcard or without a DNS-01 setup on the Application's machine.
 */
describe("PreviewSettingsCard — DNS-01", () => {
  const dnsField = () =>
    screen
      .getByText("Issue the wildcard certificate through DNS-01 (Let's Encrypt)")
      .closest('[data-slot="field"]') as HTMLElement;
  const dnsSwitch = () => within(dnsField()).getByRole("switch");
  const wildcard = () => screen.getByLabelText(/^Wildcard host/);
  const isOff = (control: HTMLElement) =>
    control.hasAttribute("disabled") || control.getAttribute("aria-disabled") === "true" ||
    control.hasAttribute("data-disabled");

  it("is off, and says why, while the form holds no wildcard", () => {
    mount({ allowed: true });
    expect(isOff(dnsSwitch())).toBe(true);
    expect(dnsField().textContent).toContain("Off until a wildcard host is set above.");
  });

  it("comes on once a wildcard is typed", () => {
    mount({ allowed: true });
    fireEvent.change(wildcard(), { target: { value: "*.preview.example.com" } });
    expect(isOff(dnsSwitch())).toBe(false);
    expect(dnsField().textContent).not.toContain("Off until a wildcard host is set above.");
  });

  it("points at where the machine's DNS-01 setup lives", () => {
    mount({ allowed: true });
    const platform = within(dnsField()).getByRole("link");
    expect(platform.getAttribute("href")).toBe("/settings/traefik");
    cleanup();

    mount({
      allowed: true,
      overrides: {
        serverId: "srv-1",
        server: { name: "edge-1" } as ApplicationDetail["server"],
      },
    });
    const server = within(dnsField()).getByRole("link");
    expect(server.getAttribute("href")).toBe("/servers/srv-1/settings");
    expect(server.textContent).toContain("edge-1");
  });

  it("saves it on with a wildcard", async () => {
    const { mutateAsync, button } = mount({
      allowed: true,
      overrides: { previewWildcard: "*.preview.example.com" },
    });
    fireEvent.click(dnsSwitch());
    fireEvent.click(button);

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      previewWildcard: "*.preview.example.com",
      previewDnsChallenge: true,
    });
  });

  it("sends it off when the wildcard is emptied, rather than asking to be refused", async () => {
    const { mutateAsync, button } = mount({
      allowed: true,
      overrides: { previewWildcard: "*.preview.example.com", previewDnsChallenge: true },
    });
    fireEvent.change(wildcard(), { target: { value: "" } });
    fireEvent.click(button);

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      previewWildcard: null,
      previewDnsChallenge: false,
    });
  });

  it("shows the backend's refusal on save", async () => {
    const refusal =
      "There is no DNS-01 setup on the machine this Application runs on. Add one in its Traefik settings first.";
    const { mutateAsync, button } = mount({
      allowed: true,
      overrides: { previewWildcard: "*.preview.example.com" },
    });
    mutateAsync.mockRejectedValue(new ApiError(400, refusal));
    fireEvent.click(dnsSwitch());
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(refusal));
  });
});

/** The text of whatever the control names as its description. */
function describedBy(control: HTMLElement) {
  return (control.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}
