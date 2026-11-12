import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const appRow = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

// The tab's own reads are the boundary; the cards beside the banner read their
// own things and are not what this file is about.
vi.mock("../use-application", async (original) => ({
  ...(await original<typeof import("../use-application")>()),
  useApplication: () => ({ data: appRow.current, error: null, isPending: false }),
  useSaveApplicationEnvironment: () => ({ mutateAsync: async () => undefined }),
}));
vi.mock("@/features/environment/use-environments", () => ({
  useEnvironment: () => ({ data: undefined }),
}));
vi.mock("@/features/project/use-projects", () => ({
  useProject: () => ({ data: undefined }),
}));
vi.mock("@/lib/api/use-wired-variables", () => ({
  useWiredVariables: () => ({ data: undefined }),
}));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: true, pending: false }),
}));
vi.mock("@/components/console/config-lock", async (original) => ({
  ...(await original<typeof import("@/components/console/config-lock")>()),
  useConfigLock: () => null,
}));
vi.mock("@/components/console/wired-variables-card", () => ({
  WiredVariablesCard: () => null,
}));
vi.mock("@/components/console/wired-changed-notice", () => ({
  WiredChangedNotice: () => null,
}));
vi.mock("../vars/build-arguments-card", () => ({ BuildArgumentsCard: () => null }));
vi.mock("../vars/resolution-card", () => ({ ResolutionCard: () => null }));

const { default: Panel } = await import("./variables");

afterEach(cleanup);

const row = (applicationStatus: string) => ({
  applicationId: "app-1",
  environmentId: "env-1",
  name: "web",
  env: "",
  applicationStatus,
  wiredChangedAt: null,
});

const banner = () =>
  screen.queryByText("The running container keeps the variables it started with.");

/**
 * The "needs a Deployment to take effect" banner is about a running
 * container, so it is not drawn over an Application no Deployment has started.
 */
describe("Application Variables — the redeploy banner", () => {
  it("is absent on an Application that has never run", () => {
    appRow.current = row("idle");
    render(<Panel id="app-1" kind={null} label="Variables" icon="hash" />);
    expect(screen.getByRole("heading", { name: "Variables", level: 2 })).toBeTruthy();
    expect(banner()).toBeNull();
  });

  it("is drawn once a Deployment has run it", () => {
    appRow.current = row("done");
    render(<Panel id="app-1" kind={null} label="Variables" icon="hash" />);
    expect(banner()).toBeTruthy();
  });
});
