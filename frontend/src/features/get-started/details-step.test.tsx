import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { domainsApi, type DomainValidation } from "@/lib/api/endpoints/domains";
import type { Project } from "@/lib/api/endpoints/projects";
import type { Server } from "@/lib/api/endpoints/servers";
import type {
  SetupEnvironment,
  SetupForm,
  TemplateSummary,
} from "@/lib/api/endpoints/templates";

/**
 * Step 2 at parity with Template setup (#112): the asked values, each
 * compose Domain's host (generated, or the person's own with its A record
 * and Check DNS), and the Project and setup name under More options. Copied
 * from `setup-form.test.tsx` and `setup-dns-check.test.tsx`; every address
 * below is one the fixture's generated host carries, written out by hand.
 */

const setUp = vi.hoisted(() => vi.fn());
const createEnvironment = vi.hoisted(() => vi.fn());
const reads = vi.hoisted(() => ({
  servers: [] as Server[],
  projects: [] as Project[],
  /** The setup form by the Project it is read for. */
  forms: {} as Record<string, SetupForm>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("../templates/use-templates", () => ({
  NEW_PROJECT: "new-project",
  useSetupForm: (_templateId: string, projectId: string | null) => {
    const form = projectId === null ? undefined : reads.forms[projectId];
    return form
      ? { isPending: false, error: null, data: form }
      : { isPending: projectId !== null, error: null, data: undefined };
  },
}));
vi.mock("@/lib/api/endpoints/templates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints/templates")>()),
  templatesApi: { setUp },
}));
vi.mock("@/lib/api/endpoints/environments", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/api/endpoints/environments")
  >()),
  environmentsApi: { create: createEnvironment, remove: vi.fn() },
}));
vi.mock("@/lib/api/use-projects", () => ({
  useProjects: () => ({ isPending: false, data: reads.projects }),
}));
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ project: vi.fn() }),
}));
/** The statements the caller's role holds, as `resource:action`; null for all. */
const grants = vi.hoisted(() => ({ held: null as string[] | null }));
vi.mock("@/lib/auth/use-permission", () => ({
  usePermission: (asked: Record<string, string[]>) => ({
    allowed: Object.entries(asked).every(([resource, actions]) =>
      actions.every(
        (action) =>
          grants.held === null || grants.held.includes(`${resource}:${action}`),
      ),
    ),
    pending: false,
    role: grants.held === null ? "owner" : "member",
  }),
}));
vi.mock("./use-get-started", () => ({
  useWizardServers: () => ({
    isPending: false,
    error: null,
    data: reads.servers,
  }),
  useWizardPurchases: () => ({ isPending: false, data: [] }),
  WAIT_POLL_MS: 4_000,
}));

const { DetailsStep } = await import("./details-step");

const SERVER_IP = "198.51.100.7";
const GENERATED = "ghost-ghost-1a2b3c-198-51-100-7.sslip.io";

const GHOST: TemplateSummary = {
  id: "ghost",
  revision: "r1",
  name: "Ghost",
  description: "A blog.",
  version: "5",
  tags: [],
  links: {},
  logo: "/backend/templates/uptime-kuma/logo?rev=c0ffee1",
  runsOn: ["server"],
  page: null,
};

const SERVER = {
  serverId: "srv_1",
  name: "ghost-1",
  ipAddress: SERVER_IP,
  serverType: "deploy",
  setupRanAt: "2026-11-01T00:00:00Z",
  setupOk: true,
  setupMessage: null,
  boughtServer: null,
  createdAt: "2026-11-01T00:00:00Z",
} as Server;

/** Ghost's new-Project setup form: one Domain, generated on the Server. */
const NEW_FORM: SetupForm = {
  templateId: "ghost",
  templateName: "Ghost",
  revision: "r1",
  setupName: "ghost",
  asked: [],
  domains: [{ name: "ghost", service: "ghost", port: 2368, path: "/" }],
  images: [],
  environments: [],
  deployTargets: { server: null, platformHost: null, aws: null, gcp: null },
  newProjectHosts: {
    servers: { srv_1: { ghost: GENERATED } },
    platformHost: null,
  },
};

const WEBSITE: Project = {
  projectId: "prj_9",
  name: "Website",
  description: null,
  createdAt: "2026-11-01T00:00:00Z",
  organizationId: "org_1",
  env: "",
};

function environment(
  environmentId: string,
  name: string,
  serverId: string,
): SetupEnvironment {
  return {
    environmentId,
    name,
    canTake: true,
    reason: null,
    hosts: { ghost: "ghost-ghost-9z9z9z-198-51-100-7.sslip.io" },
    cloudDomains: null,
    machine: { serverId },
  };
}

function show() {
  const client = new QueryClient();
  const ui = () => (
    <QueryClientProvider client={client}>
      <DetailsStep template={GHOST} serverId="srv_1" bought={false} />
    </QueryClientProvider>
  );
  const view = render(ui());
  return { again: () => view.rerender(ui()) };
}

const hostField = () =>
  screen.getByLabelText(/ghost’s Domain/) as HTMLInputElement;

const typeInto = (field: HTMLElement, value: string) =>
  fireEvent.change(field, { target: { value } });

/** The record's three fields, as the DNS panel's `dl` lists them. */
function record(): Record<string, string> {
  const list = screen
    .getByText("The record to create at your DNS provider")
    .parentElement!.querySelector("dl")!;
  const terms = [...list.querySelectorAll("dt")].map((dt) => dt.textContent!);
  const values = [...list.querySelectorAll("dd")].map((dd) => dd.textContent!);
  return Object.fromEntries(terms.map((term, at) => [term, values[at]]));
}

const summary = () =>
  screen.getByRole("region", { name: "Where it goes" }).textContent;

const deploy = () =>
  fireEvent.click(screen.getByRole("button", { name: "Deploy Ghost" }));

beforeEach(() => {
  grants.held = null;
  reads.servers = [SERVER];
  reads.projects = [];
  reads.forms = { "new-project": NEW_FORM };
  setUp.mockResolvedValue({ pendingSetup: { environmentId: "env_1" } });
  createEnvironment.mockResolvedValue({ environmentId: "env_new" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("DetailsStep, the web address", () => {
  it("starts on the Server's generated host, with no record to create", () => {
    show();

    expect(hostField().value).toBe(GENERATED);
    expect(screen.queryByRole("button", { name: "Check DNS" })).toBeNull();
    expect(screen.queryByText(/The record to create/)).toBeNull();
  });

  it("shows the A record for an own domain, pointing at the Server's address, and Check DNS", () => {
    show();
    typeInto(hostField(), "blog.example.com");

    expect(record()).toEqual({ Type: "A", Name: "blog", Value: SERVER_IP });
    expect(screen.getByRole("button", { name: "Check DNS" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Generate one for me" }),
    ).toBeTruthy();
  });

  it("checks the typed host against the Server's address", async () => {
    const validate = vi.spyOn(domainsApi, "validate").mockResolvedValue({
      isValid: true,
      resolvedIp: SERVER_IP,
    } as DomainValidation);
    show();
    typeInto(hostField(), "blog.example.com");

    fireEvent.click(screen.getByRole("button", { name: "Check DNS" }));

    expect(
      await screen.findByText("blog.example.com points here."),
    ).toBeTruthy();
    expect(validate).toHaveBeenCalledWith("blog.example.com", SERVER_IP);
  });

  it("puts the generated host back with Generate one for me", () => {
    show();
    typeInto(hostField(), "blog.example.com");

    fireEvent.click(
      screen.getByRole("button", { name: "Generate one for me" }),
    );

    expect(hostField().value).toBe(GENERATED);
  });

  it("takes the Server's generated host once the form has one", () => {
    reads.forms["new-project"] = {
      ...NEW_FORM,
      newProjectHosts: { servers: {}, platformHost: null },
    };
    const { again } = show();
    expect(hostField().value).toBe("");

    reads.forms["new-project"] = NEW_FORM;
    again();

    expect(hostField().value).toBe(GENERATED);
  });
});

describe("DetailsStep, More options", () => {
  it("keeps the Project and the setup name folded, said in one line", () => {
    show();

    expect(summary()).toContain(
      "A new Project, Ghost, on ghost-1, set up as ghost.",
    );
    expect(screen.queryByLabelText("Project name")).toBeNull();
    expect(screen.queryByLabelText("Setup name")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More options" }));

    expect(
      (screen.getByLabelText("Project name") as HTMLInputElement).value,
    ).toBe("Ghost");
    expect(
      (screen.getByLabelText("Setup name") as HTMLInputElement).value,
    ).toBe("ghost");
  });

  it("opens again on a setup name the setup would refuse", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    typeInto(screen.getByLabelText("Setup name"), "My Blog");
    fireEvent.click(screen.getByRole("button", { name: "Fewer options" }));

    deploy();

    expect(
      await screen.findByText(
        "Use lowercase letters, digits and hyphens, starting with a letter",
      ),
    ).toBeTruthy();
    expect(setUp).not.toHaveBeenCalled();
  });
});

describe("DetailsStep, Deploy", () => {
  it("sends the typed host, the Project name and the setup name chosen", async () => {
    show();
    typeInto(hostField(), "blog.example.com");
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    typeInto(screen.getByLabelText("Project name"), "My blog");
    typeInto(screen.getByLabelText("Setup name"), "blog");

    deploy();

    await waitFor(() => expect(setUp).toHaveBeenCalledTimes(1));
    expect(setUp.mock.calls[0][0]).toEqual({
      templateId: "ghost",
      newProject: {
        name: "My blog",
        deployTarget: { kind: "server", serverId: "srv_1" },
      },
      setupName: "blog",
      values: {},
      hosts: { ghost: "blog.example.com" },
      autoApply: true,
    });
  });

  it("sets up into an existing Project's Environment on the Server", async () => {
    reads.projects = [WEBSITE];
    reads.forms.prj_9 = {
      ...NEW_FORM,
      newProjectHosts: null,
      environments: [
        environment("env_other", "staging", "srv_2"),
        environment("env_9", "production", "srv_1"),
      ],
    };
    show();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(screen.getByRole("button", { name: /Website/ }));

    expect(summary()).toContain(
      "The Website Project’s production Environment, on ghost-1, set up as ghost.",
    );
    deploy();

    await waitFor(() => expect(setUp).toHaveBeenCalledTimes(1));
    expect(createEnvironment).not.toHaveBeenCalled();
    expect(setUp.mock.calls[0][0]).toEqual({
      templateId: "ghost",
      projectId: "prj_9",
      environmentId: "env_9",
      setupName: "ghost",
      values: {},
      hosts: { ghost: GENERATED },
      autoApply: true,
    });
  });

  it("makes a new Environment on the Server in an existing Project with none there", async () => {
    reads.projects = [WEBSITE];
    reads.forms.prj_9 = {
      ...NEW_FORM,
      newProjectHosts: null,
      environments: [environment("env_other", "production", "srv_2")],
    };
    show();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(screen.getByRole("button", { name: /Website/ }));

    expect(summary()).toContain(
      "A new production-2 Environment in the Website Project, on ghost-1, set up as ghost.",
    );
    deploy();

    await waitFor(() => expect(setUp).toHaveBeenCalledTimes(1));
    expect(createEnvironment).toHaveBeenCalledWith({
      projectId: "prj_9",
      name: "production-2",
      deployTarget: { kind: "server", serverId: "srv_1" },
    });
    expect(setUp.mock.calls[0][0]).toMatchObject({
      projectId: "prj_9",
      environmentId: "env_new",
    });
  });
});

describe("DetailsStep, what the role allows", () => {
  const button = () => screen.getByRole("button", { name: "Deploy Ghost" });
  const asked = () => screen.queryByText(/Ask your organization/);

  function chooseWebsite(environments: SetupEnvironment[]) {
    reads.projects = [WEBSITE];
    reads.forms.prj_9 = { ...NEW_FORM, newProjectHosts: null, environments };
    show();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(screen.getByRole("button", { name: /Website/ }));
  }

  it("asks for a role that can create a Project, for a new one, and offers an existing one", () => {
    grants.held = ["service:create", "environment:create"];
    reads.projects = [WEBSITE];
    show();

    expect(asked()).toBeTruthy();
    expect(
      screen.getByText(
        "Your role can’t create a Project, so pick an existing one under More options, or an owner or an admin can deploy Ghost.",
      ),
    ).toBeTruthy();
    expect(button().getAttribute("aria-disabled")).toBe("true");
  });

  it("does not offer an existing Project where there is none", () => {
    grants.held = ["service:create"];
    show();

    expect(
      screen.getByText(
        "Your role can’t create a Project, so an owner or an admin can deploy Ghost.",
      ),
    ).toBeTruthy();
  });

  it("deploys into an existing Project's Environment without asking to create anything", () => {
    grants.held = ["service:create"];
    chooseWebsite([environment("env_9", "production", "srv_1")]);

    expect(asked()).toBeNull();
    expect(button().getAttribute("aria-disabled")).not.toBe("true");
  });

  it("deploys into a new Environment in an existing Project with environment: create alone", () => {
    grants.held = ["service:create", "environment:create"];
    chooseWebsite([environment("env_other", "production", "srv_2")]);

    expect(asked()).toBeNull();
    expect(button().getAttribute("aria-disabled")).not.toBe("true");
  });

  it("asks for a role that can create an Environment, for an existing Project with none on the server", () => {
    grants.held = ["service:create"];
    chooseWebsite([environment("env_other", "production", "srv_2")]);

    expect(
      screen.getByText(
        "Your role can’t create an Environment, which the Website Project needs on ghost-1, so an owner or an admin can deploy Ghost.",
      ),
    ).toBeTruthy();
    expect(button().getAttribute("aria-disabled")).toBe("true");
  });

  it("asks for a role that can add Services, wherever it goes", () => {
    grants.held = ["project:create", "environment:create"];
    show();

    expect(
      screen.getByText(
        "Your role can’t add Services, so an owner or an admin can deploy Ghost.",
      ),
    ).toBeTruthy();
    expect(button().getAttribute("aria-disabled")).toBe("true");
  });
});
