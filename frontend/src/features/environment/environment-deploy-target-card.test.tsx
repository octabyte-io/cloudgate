import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Environment } from "@/lib/api/endpoints/environments";

const usePermission = vi.hoisted(() => vi.fn());
const useUpdateEnvironment = vi.hoisted(() => vi.fn());
const servers = vi.hoisted(() => ({ data: [] as unknown[], isPending: false }));
const cloudAccounts = vi.hoisted(() => ({
  data: [] as unknown[],
  isPending: false,
}));
const useCloudAccounts = vi.hoisted(() => vi.fn(() => cloudAccounts));

// The caller's statements, the write, and the Server list are the boundaries;
// the card itself is not doubled.
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission,
}));
vi.mock("./use-environments", async (original) => ({
  ...(await original<typeof import("./use-environments")>()),
  useUpdateEnvironment,
}));
vi.mock("@/lib/api/use-servers", () => ({ useServers: () => servers }));
vi.mock("@/lib/api/use-cloud-accounts", () => ({
  useCloudAccounts,
}));
const mode = vi.hoisted(() => ({ data: "self-hosted" as "hosted" | "self-hosted" }));
vi.mock("@/lib/api/use-instance-mode", () => ({ useInstanceMode: () => mode }));

const { roleRefusal } = await import("@/lib/auth/use-permission");
const { EnvironmentDeployTargetCard } =
  await import("./environment-deploy-target-card");

const REFUSAL = roleRefusal("change this Environment's Deploy target");

const worker = {
  serverId: "srv_1",
  name: "worker-1",
  ipAddress: "10.0.0.5",
  serverType: "deploy",
};

const production = {
  cloudAccountId: "ca_1",
  name: "Production AWS",
  cloudId: "123456789012",
};

function mount(
  deployTarget: Environment["deployTarget"],
  {
    allowed = true,
    list = [worker],
    readsClouds = true,
    clouds = [production],
  }: {
    allowed?: boolean;
    list?: unknown[];
    readsClouds?: boolean;
    clouds?: unknown[];
  } = {},
) {
  usePermission.mockImplementation((statements: Record<string, unknown>) => ({
    allowed: "cloudAccount" in statements ? readsClouds : allowed,
    pending: false,
    role: "member",
  }));
  useUpdateEnvironment.mockReturnValue({ mutateAsync: vi.fn() });
  servers.data = list;
  cloudAccounts.data = clouds;
  render(
    <EnvironmentDeployTargetCard
      environment={
        {
          environmentId: "e1",
          projectId: "p1",
          name: "staging",
          deployTarget,
        } as unknown as Environment
      }
    />,
  );
  return screen.getByRole("button", { name: "Save Deploy target" });
}

afterEach(() => {
  cleanup();
  usePermission.mockReset();
  useUpdateEnvironment.mockReset();
  useCloudAccounts.mockClear();
  mode.data = "self-hosted";
});

/**
 * The Environment Settings tab's Deploy target: it shows where a new
 * Service will be created, says that changing it moves nothing, and is off for
 * a role `PATCH /environments/:id` would refuse.
 */
describe("EnvironmentDeployTargetCard", () => {
  it("shows the saved Server and says a change moves nothing", () => {
    const save = mount({ kind: "server", serverId: "srv_1" });

    expect(screen.getByText("worker-1")).toBeTruthy();
    expect(document.body.textContent).toContain(
      "Changing it moves nothing that already runs",
    );
    // Nothing changed yet, so there is nothing to save.
    expect(
      save.hasAttribute("disabled") ||
        save.getAttribute("aria-disabled") === "true",
    ).toBe(true);
  });

  it("shows the platform host as a choice", () => {
    mount({ kind: "platform-host" });

    expect(screen.getByText("This Cloudgate host")).toBeTruthy();
  });

  it("names a saved Server the caller cannot list as a Server, not as the platform host", () => {
    mount({ kind: "server", serverId: "srv_9" }, { list: [] });

    expect(screen.getByText("A Server you cannot list")).toBeTruthy();
  });

  it("holds Save off for a role without environment:update, and says why", () => {
    const save = mount({ kind: "platform-host" }, { allowed: false });

    expect(usePermission).toHaveBeenCalledWith({ environment: ["update"] });
    expect(save.getAttribute("title")).toBe(REFUSAL);
    expect(document.body.textContent).toContain(REFUSAL);
  });

  it("shows a saved Cloud account with its region, and says what it creates", () => {
    mount({ kind: "cloud", cloudAccountId: "ca_1", region: "eu-west-1" });

    expect(screen.getByText("Production AWS")).toBeTruthy();
    expect(screen.getByText("eu-west-1")).toBeTruthy();
    expect(document.body.textContent).toContain(
      "Saving checks the deploy role in this region",
    );
    expect(document.body.textContent).toContain(
      "Web Services, postgres, redis, buckets and static sites can be created in an AWS account; worker, cron, web-private and mysql not yet.",
    );
    expect(document.body.textContent).not.toContain("Only web Services");
  });

  it("offers no Cloud account to a role without cloudAccount:read, and asks none of the API", () => {
    mount(
      { kind: "cloud", cloudAccountId: "ca_1", region: "eu-west-1" },
      { readsClouds: false },
    );

    expect(usePermission).toHaveBeenCalledWith({ cloudAccount: ["read"] });
    expect(useCloudAccounts).toHaveBeenCalledWith({ enabled: false });
    expect(screen.queryByText("Production AWS")).toBeNull();
    expect(screen.getByText("A Cloud account you cannot list")).toBeTruthy();
  });

  it("shows a saved Google Cloud account with its Google region, says what saving checks there and what it creates", () => {
    mount(
      { kind: "cloud", cloudAccountId: "ca_2", region: "europe-west1" },
      {
        clouds: [
          production,
          {
            cloudAccountId: "ca_2",
            name: "Production Google",
            cloud: "gcp",
            cloudId: "shop-prod",
          },
        ],
      },
    );

    expect(screen.getByText("Production Google")).toBeTruthy();
    expect(screen.getByText("europe-west1")).toBeTruthy();
    expect(screen.getByText("Google Cloud region")).toBeTruthy();
    expect(document.body.textContent).toContain(
      "Saving checks that Cloud Run and Artifact Registry are offered in this region",
    );
    expect(document.body.textContent).toContain(
      "Web Services, postgres and redis can be created in a Google Cloud account; buckets and static sites not yet.",
    );
    expect(document.body.textContent).not.toContain("AWS region");
  });

  it("shows no region field for a Server", () => {
    mount({ kind: "server", serverId: "srv_1" });

    expect(document.body.textContent).not.toContain("AWS region");
  });
});

/**
 * ADR-0053: the Hosted instance never offers its own host as a Deploy
 * target. It is left out, not greyed, and an Environment saved there before
 * reads as not chosen.
 */
describe("EnvironmentDeployTargetCard on the Hosted instance", () => {
  it("offers no Cloudgate host", async () => {
    mode.data = "hosted";
    mount({ kind: "server", serverId: "srv_1" });

    fireEvent.click(screen.getByRole("combobox", { name: "Deploy target" }));
    await waitFor(() =>
      expect(screen.queryAllByRole("option").length).toBeGreaterThan(0),
    );
    const options = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(options.some((option) => option.includes("worker-1"))).toBe(true);
    expect(options.some((option) => option.includes("This Cloudgate host"))).toBe(false);
  });

  it("shows a platform-host target from before as not chosen yet", () => {
    mode.data = "hosted";
    mount({ kind: "platform-host" });

    expect(screen.queryByText("This Cloudgate host")).toBeNull();
    expect(screen.getByText("Choose a Server or a Cloud account")).toBeTruthy();
  });
});
