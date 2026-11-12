import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const usePermission = vi.hoisted(() => vi.fn());
const points = vi.hoisted(() => ({ current: [] as unknown[] }));
const rollbackMutate = vi.hoisted(() => vi.fn());
const mutateAsync = vi.hoisted(() => vi.fn());
const appRow = vi.hoisted(() => ({
  current: {
    applicationId: "app-1",
    environmentId: "env-1",
    rollbackActive: false,
  } as Record<string, unknown>,
}));

// The caller's effective statements, and the reads behind the tab. The
// "Keep rollback points" card is real.
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission,
}));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("../use-application", async (original) => ({
  ...(await original<typeof import("../use-application")>()),
  useApplication: () => ({ data: appRow.current, error: null }),
  useUpdateApplication: () => ({ mutateAsync }),
}));
vi.mock("../advanced/use-advanced", () => ({
  useRollbacks: () => ({ data: points.current, isPending: false, error: null }),
  useRollbackMutations: () => ({
    rollback: { mutateAsync: rollbackMutate },
    remove: { mutateAsync: vi.fn() },
  }),
}));

const { APPLICATION_SETTINGS_REFUSAL } = await import("../use-application");
const { default: Panel } = await import("./rollbacks");

afterEach(() => {
  cleanup();
  usePermission.mockReset();
  mutateAsync.mockReset();
  rollbackMutate.mockReset();
  points.current = [];
});

function mount({ allowed }: { allowed: boolean }) {
  usePermission.mockReturnValue({ allowed, pending: false, role: "member" });
  render(<Panel id="app-1" kind={null} label="Rollbacks" icon="rocket" />);
  return { button: screen.getByRole("button", { name: "Save changes" }) };
}

/**
 * Keep rollback points' Save: `PATCH /applications/:id` with
 * `rollbackActive`, which `findOwnedForUpdate` holds to `service: ['update']`.
 */
describe("Panel — Keep rollback points", () => {
  it("asks for service:update", () => {
    mount({ allowed: true });
    expect(usePermission).toHaveBeenCalledWith({ service: ["update"] });
  });

  it("is off with the reason for a role that cannot change the Application, and a forced submit sends nothing", async () => {
    const { button } = mount({ allowed: false });

    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe(APPLICATION_SETTINGS_REFUSAL);

    // Enter in a field submits the form whatever the button says.
    fireEvent.click(button);
    fireEvent.submit(button.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        APPLICATION_SETTINGS_REFUSAL,
      ),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("is live for a role that can, and saves", async () => {
    mutateAsync.mockResolvedValue(undefined);
    const { button } = mount({ allowed: true });

    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    expect(button.hasAttribute("title")).toBe(false);
    expect(document.body.textContent).not.toContain(
      APPLICATION_SETTINGS_REFUSAL,
    );

    fireEvent.click(button);
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({ rollbackActive: false }),
    );
  });
});

/**
 * A Server rollback leaves the Application's settings as they are (CONTEXT.md,
 * "Rollback": no Deployment of its own), so the next Deployment builds from
 * them again and the newer version comes back. The dialog says so before the
 * operator confirms (#1416).
 */
describe("Panel — rolling back on a Server", () => {
  it("says in the confirm dialog that the next Deployment builds from the Application's current settings", async () => {
    usePermission.mockReturnValue({
      allowed: true,
      pending: false,
      role: "owner",
    });
    appRow.current = {
      applicationId: "app-1",
      environmentId: "env-1",
      name: "web",
      rollbackActive: true,
      buildType: "dockerfile",
    };
    points.current = [
      {
        rollbackId: "rb-1",
        deploymentId: "dep-1",
        version: 1,
        image: "web:v1",
        fullContext: { sourceType: "docker", dockerImage: "nginx:1.26" },
        folder: null,
        createdAt: "2026-11-12T09:00:00.000Z",
      },
    ];
    render(<Panel id="app-1" kind={null} label="Rollbacks" icon="rocket" />);

    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      "This Application\u2019s settings are not changed, so the next Deployment builds from them as they are now: to stay on v1, change its source first.",
    );
  });
});

/** A cloud Service's tab says rollback is not there, whatever the switch says. */
describe("Panel — a Service in a Cloud account", () => {
  it("says rollback is not available on AWS yet, and offers neither the switch nor a snapshot", () => {
    usePermission.mockReturnValue({
      allowed: true,
      pending: false,
      role: "owner",
    });
    appRow.current = {
      applicationId: "app-1",
      environmentId: "env-1",
      rollbackActive: true,
      buildType: "dockerfile",
      cloudPlace: {
        cloudAccountId: "ca-1",
        cloudAccountName: "Production AWS",
        region: "eu-central-1",
      },
    };
    render(<Panel id="app-1" kind={null} label="Rollbacks" icon="rocket" />);

    expect(
      screen.getByText("Rollback is not available on AWS yet"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(document.body.textContent).not.toContain(
      "Capture a snapshot on every successful Deployment",
    );
  });
});

describe("Panel — a web on Cloud Run", () => {
  it("says rollback is not available on Google Cloud yet: only the live image is kept", () => {
    usePermission.mockReturnValue({
      allowed: true,
      pending: false,
      role: "owner",
    });
    appRow.current = {
      applicationId: "app-1",
      environmentId: "env-1",
      rollbackActive: true,
      buildType: "dockerfile",
      cloudPlace: {
        cloudAccountId: "ca-1",
        cloudAccountName: "Production Google",
        cloud: "gcp",
        region: "europe-west1",
      },
    };
    render(<Panel id="app-1" kind={null} label="Rollbacks" icon="rocket" />);

    expect(
      screen.getByText("Rollback is not available on Google Cloud yet"),
    ).toBeTruthy();
    expect(document.body.textContent).toContain(
      "Each deploy keeps only its live image",
    );
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });
});

/**
 * A `static` site on AWS's points are folders of its bucket, and
 * rolling back to one is a Deployment that restores files only. Reached
 * through the Panel, which hands such a site to `StaticRollbacks`.
 */
describe("StaticRollbacks", () => {
  function mountStatic() {
    usePermission.mockReturnValue({
      allowed: true,
      pending: false,
      role: "owner",
    });
    appRow.current = {
      applicationId: "app-1",
      environmentId: "env-1",
      name: "docs",
      rollbackActive: true,
      buildType: "static",
      cloudPlace: {
        cloudAccountId: "ca-1",
        cloudAccountName: "Production AWS",
        region: "eu-central-1",
      },
    };
    points.current = [
      {
        rollbackId: "rb-1",
        deploymentId: "dep-1",
        version: 3,
        image: null,
        fullContext: null,
        folder: "dep-1",
        createdAt: "2026-10-17T09:00:00.000Z",
      },
    ];
    render(<Panel id="app-1" kind={null} label="Rollbacks" icon="rocket" />);
  }

  it("lists each point's folder and says rolling back restores this version's files", () => {
    mountStatic();

    expect(
      screen.queryByText("Rollback is not available on AWS yet"),
    ).toBeNull();
    expect(screen.getByText("deployments/dep-1/")).toBeTruthy();
    expect(document.body.textContent).toContain(
      "Rolling back restores this version's files. The distribution's settings stay as the Project config says.",
    );
    expect(
      screen.getByRole("button", { name: "Roll back" }).getAttribute("title"),
    ).toBe("Restores this version's files");
    // Not a Server's image snapshot.
    expect(document.body.textContent).not.toContain("Swarm");
  });

  it("rolls back from the dialog, which says it restores this version's files", async () => {
    rollbackMutate.mockResolvedValue({ deploymentId: "dep-9" });
    mountStatic();

    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("restores this version's files");
    expect(dialog.textContent).toContain("Deployment");

    fireEvent.click(
      screen.getByRole("button", { name: "Restore v3\u2019s files" }),
    );
    await waitFor(() => expect(rollbackMutate).toHaveBeenCalledWith("rb-1"));
  });
});
