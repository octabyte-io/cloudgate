import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SetupForm } from "@/lib/api/endpoints/templates";

const replace = vi.hoisted(() => vi.fn());
const reads = vi.hoisted(() => ({
  hosted: true,
  servers: [] as unknown[],
  projects: [] as unknown[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
}));
vi.mock("@/lib/api/use-instance-mode", () => ({
  useInstanceMode: () => ({
    data: reads.hosted ? "hosted" : "self-hosted",
    isPending: false,
  }),
}));
vi.mock("@/lib/api/use-servers", () => ({
  useServers: () => ({ data: reads.servers, isPending: false }),
}));
vi.mock("@/lib/api/use-projects", () => ({
  useProjects: () => ({ data: reads.projects, isPending: false }),
}));
vi.mock("@/lib/api/use-cloud-accounts", () => ({
  useCloudAccounts: () => ({ data: [], isPending: false }),
}));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: true, refusal: "" }),
}));

const FORM: SetupForm = {
  templateId: "flatnotes",
  templateName: "flatnotes",
  revision: "abc1234",
  setupName: "flatnotes",
  asked: [],
  domains: [],
  environments: [
    {
      environmentId: "env-prod",
      name: "production",
      canTake: true,
      reason: null,
      hosts: null,
      cloudDomains: null,
      machine: { serverId: "srv-1" },
    },
  ],
  deployTargets: { server: null, platformHost: null, aws: null, gcp: null },
  images: [],
  newProjectHosts: null,
};

vi.mock("./use-templates", async (original) => ({
  ...(await original<typeof import("./use-templates")>()),
  useSetupForm: () => ({ isPending: false, error: null, data: FORM }),
  useSetUpTemplate: () => ({ data: undefined, reset: vi.fn() }),
}));

const { TemplateSetup } = await import("./template-setup");

const SERVER = {
  serverId: "srv-1",
  name: "edge-1",
  ipAddress: "203.0.113.4",
  serverType: "deploy",
};

beforeEach(() => {
  reads.hosted = true;
  reads.servers = [];
  reads.projects = [];
});
afterEach(() => {
  cleanup();
  replace.mockReset();
});

function show(from?: {
  projectId: string | null;
  environmentId: string | null;
}) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TemplateSetup
        templateId="flatnotes"
        template={undefined}
        cataloguePending={false}
        from={from}
      />
    </QueryClientProvider>,
  );
}

describe("TemplateSetup", () => {
  it("sends a new Project with nowhere to deploy to Get started, replacing itself", async () => {
    // A Hosted customer with no Server and no Cloud account: the form could
    // not be submitted, so the wizard that gets them a server is where to go.
    show();

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/get-started?template=flatnotes"),
    );
    expect(screen.queryByLabelText("Project name")).toBeNull();
  });

  it("opens the form when the Organization has a Server to deploy to", () => {
    reads.servers = [SERVER];
    show();

    expect(screen.getByLabelText("Project name")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /edge-1/ })).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it("opens the form on Self-hosted with no Server, offering this Cloudgate host", () => {
    reads.hosted = false;
    show();

    expect(
      screen.getByRole("radio", { name: /This Cloudgate host/ }),
    ).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it("never sends a setup placed in an existing Project away", () => {
    reads.projects = [{ projectId: "prj-1", name: "Notes" }];
    show({ projectId: "prj-1", environmentId: "env-prod" });

    expect(screen.getByRole("radio", { name: /production/ })).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });
});
