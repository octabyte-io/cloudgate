import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SetupForm } from "@/lib/api/endpoints/templates";

const api = vi.hoisted(() => ({
  setUp: vi.fn(),
  setupForm: vi.fn(),
  createProject: vi.fn(),
  removeProject: vi.fn(),
  createEnvironment: vi.fn(),
}));

vi.mock("@/lib/api/endpoints/templates", () => ({
  templatesApi: { setUp: api.setUp, setupForm: api.setupForm },
}));
vi.mock("@/lib/api/endpoints/projects", () => ({
  projectsApi: { create: api.createProject, remove: api.removeProject },
}));
vi.mock("@/lib/api/endpoints/environments", () => ({
  environmentsApi: { create: api.createEnvironment },
}));

const { DeployRefusal, deployTemplate } = await import("./deploy-template");

function form(over: Partial<SetupForm>): SetupForm {
  return {
    templateId: "ghost",
    templateName: "Ghost",
    revision: "r1",
    setupName: "ghost",
    asked: [],
    domains: [],
    environments: [],
    deployTargets: { server: null, platformHost: null, aws: null, gcp: null },
    ...over,
  };
}

const DOMAIN = { name: "ghost", service: "ghost", port: 2368, path: "/" };

beforeEach(() => {
  vi.clearAllMocks();
  api.setUp.mockResolvedValue({ pendingSetup: { environmentId: "env_1" } });
  api.createProject.mockResolvedValue({ projectId: "prj_1" });
  api.removeProject.mockResolvedValue({});
  api.createEnvironment.mockResolvedValue({ environmentId: "env_1" });
});

describe("deployTemplate", () => {
  it("sets a template with no Domain up in a new Project in one request, applied by itself", async () => {
    await deployTemplate({
      templateId: "ghost",
      form: form({}),
      projectName: "Ghost",
      serverId: "srv_1",
      values: { ADMIN_EMAIL: "a@b.co" },
    });

    expect(api.createProject).not.toHaveBeenCalled();
    expect(api.setUp).toHaveBeenCalledWith({
      templateId: "ghost",
      newProject: {
        name: "Ghost",
        deployTarget: { kind: "server", serverId: "srv_1" },
      },
      setupName: "ghost",
      values: { ADMIN_EMAIL: "a@b.co" },
      autoApply: true,
    });
  });

  it("makes the Project and Environment first for a template with Domains, and uses the hosts they generate", async () => {
    api.setupForm.mockResolvedValue(
      form({
        domains: [DOMAIN],
        environments: [
          {
            environmentId: "env_1",
            name: "production",
            canTake: true,
            reason: null,
            hosts: { ghost: "ghost-ab12-203-0-113-7.sslip.io" },
            cloudDomains: null,
          },
        ],
      }),
    );

    await deployTemplate({
      templateId: "ghost",
      form: form({ domains: [DOMAIN] }),
      projectName: "Ghost",
      serverId: "srv_1",
      values: {},
    });

    expect(api.createEnvironment).toHaveBeenCalledWith({
      projectId: "prj_1",
      name: "production",
      deployTarget: { kind: "server", serverId: "srv_1" },
    });
    expect(api.setupForm).toHaveBeenCalledWith("ghost", "prj_1");
    expect(api.setUp).toHaveBeenCalledWith({
      templateId: "ghost",
      projectId: "prj_1",
      environmentId: "env_1",
      setupName: "ghost",
      values: {},
      hosts: { ghost: "ghost-ab12-203-0-113-7.sslip.io" },
      autoApply: true,
    });
    expect(api.removeProject).not.toHaveBeenCalled();
  });

  it("deletes the Project it made when the setup is refused", async () => {
    api.setupForm.mockResolvedValue(
      form({
        domains: [DOMAIN],
        environments: [
          {
            environmentId: "env_1",
            name: "production",
            canTake: true,
            reason: null,
            hosts: { ghost: "h.sslip.io" },
            cloudDomains: null,
          },
        ],
      }),
    );
    const refusal = new Error("refused");
    api.setUp.mockRejectedValue(refusal);

    await expect(
      deployTemplate({
        templateId: "ghost",
        form: form({ domains: [DOMAIN] }),
        projectName: "Ghost",
        serverId: "srv_1",
        values: {},
      }),
    ).rejects.toBe(refusal);
    expect(api.removeProject).toHaveBeenCalledWith("prj_1");
  });

  it("refuses in words, and deletes the Project, when the Server generates no host", async () => {
    api.setupForm.mockResolvedValue(
      form({
        domains: [DOMAIN],
        environments: [
          {
            environmentId: "env_1",
            name: "production",
            canTake: true,
            reason: null,
            hosts: null,
            cloudDomains: null,
          },
        ],
      }),
    );

    await expect(
      deployTemplate({
        templateId: "ghost",
        form: form({ domains: [DOMAIN] }),
        projectName: "Ghost",
        serverId: "srv_1",
        values: {},
      }),
    ).rejects.toBeInstanceOf(DeployRefusal);
    expect(api.setUp).not.toHaveBeenCalled();
    expect(api.removeProject).toHaveBeenCalledWith("prj_1");
  });
});
