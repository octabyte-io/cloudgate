import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  setUp: vi.fn(),
  createProject: vi.fn(),
  createEnvironment: vi.fn(),
  removeEnvironment: vi.fn(),
}));

vi.mock("@/lib/api/endpoints/templates", () => ({
  templatesApi: { setUp: api.setUp },
}));
vi.mock("@/lib/api/endpoints/projects", () => ({
  projectsApi: { create: api.createProject },
}));
vi.mock("@/lib/api/endpoints/environments", () => ({
  environmentsApi: {
    create: api.createEnvironment,
    remove: api.removeEnvironment,
  },
}));

const { deployTemplate } = await import("./deploy-template");

const SERVER = { kind: "server", serverId: "srv_1" };

beforeEach(() => {
  vi.clearAllMocks();
  api.setUp.mockResolvedValue({ pendingSetup: { environmentId: "env_1" } });
  api.createEnvironment.mockResolvedValue({ environmentId: "env_new" });
  api.removeEnvironment.mockResolvedValue({});
});

describe("deployTemplate", () => {
  it("sets the template up in a new Project in one request, with the chosen name, setup name and hosts, applied by itself", async () => {
    await deployTemplate({
      templateId: "ghost",
      serverId: "srv_1",
      place: { newProject: { name: "My blog" } },
      setupName: "blog",
      values: { ADMIN_EMAIL: "a@b.co" },
      hosts: { ghost: "blog.example.com" },
    });

    expect(api.createProject).not.toHaveBeenCalled();
    expect(api.createEnvironment).not.toHaveBeenCalled();
    expect(api.setUp).toHaveBeenCalledWith({
      templateId: "ghost",
      newProject: { name: "My blog", deployTarget: SERVER },
      setupName: "blog",
      values: { ADMIN_EMAIL: "a@b.co" },
      hosts: { ghost: "blog.example.com" },
      autoApply: true,
    });
  });

  it("sends no hosts for a template with no Domain", async () => {
    await deployTemplate({
      templateId: "ghost",
      serverId: "srv_1",
      place: { newProject: { name: "Ghost" } },
      setupName: "ghost",
      values: {},
    });

    expect(api.setUp).toHaveBeenCalledWith({
      templateId: "ghost",
      newProject: { name: "Ghost", deployTarget: SERVER },
      setupName: "ghost",
      values: {},
      autoApply: true,
    });
  });

  it("sets the template up in an existing Project's Environment on the Server", async () => {
    await deployTemplate({
      templateId: "ghost",
      serverId: "srv_1",
      place: { projectId: "prj_9", environmentId: "env_9" },
      setupName: "ghost-2",
      values: {},
      hosts: { ghost: "ghost-ab12-203-0-113-7.sslip.io" },
    });

    expect(api.createEnvironment).not.toHaveBeenCalled();
    expect(api.setUp).toHaveBeenCalledWith({
      templateId: "ghost",
      projectId: "prj_9",
      environmentId: "env_9",
      setupName: "ghost-2",
      values: {},
      hosts: { ghost: "ghost-ab12-203-0-113-7.sslip.io" },
      autoApply: true,
    });
  });

  it("makes a new Environment on the Server in an existing Project with none there, and sets up into it", async () => {
    await deployTemplate({
      templateId: "ghost",
      serverId: "srv_1",
      place: { projectId: "prj_9", newEnvironment: "production-2" },
      setupName: "ghost",
      values: {},
      hosts: { ghost: "blog.example.com" },
    });

    expect(api.createEnvironment).toHaveBeenCalledWith({
      projectId: "prj_9",
      name: "production-2",
      deployTarget: SERVER,
    });
    expect(api.setUp).toHaveBeenCalledWith({
      templateId: "ghost",
      projectId: "prj_9",
      environmentId: "env_new",
      setupName: "ghost",
      values: {},
      hosts: { ghost: "blog.example.com" },
      autoApply: true,
    });
    expect(api.removeEnvironment).not.toHaveBeenCalled();
  });

  it("deletes the Environment it made when the setup is refused, and leaves the Project", async () => {
    const refusal = new Error("refused");
    api.setUp.mockRejectedValue(refusal);

    await expect(
      deployTemplate({
        templateId: "ghost",
        serverId: "srv_1",
        place: { projectId: "prj_9", newEnvironment: "production" },
        setupName: "ghost",
        values: {},
      }),
    ).rejects.toBe(refusal);
    expect(api.removeEnvironment).toHaveBeenCalledWith("env_new");
  });
});
