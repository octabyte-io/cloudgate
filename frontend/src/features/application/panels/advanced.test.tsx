import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { ApplicationDetail } from "@/lib/api/endpoints/applications";
import type { PanelProps } from "@/lib/shell/tab-registry";

const apiDelete = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());
const permission = vi.hoisted(() => ({ allowed: true, pending: false }));
const facet = vi.hoisted(() => ({
  aiModel: null as unknown,
  configKind: "web",
}));

// The HTTP client is the boundary: what is pinned is the request the console
// makes, so `applicationsApi.remove` and `useDeleteApplication` stay real.
vi.mock("@/lib/api/client", async (original) => {
  const actual = await original<typeof import("@/lib/api/client")>();
  return { ...actual, api: { ...actual.api, delete: apiDelete } };
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/auth/use-permission", () => ({
  usePermission: () => ({ ...permission, role: "owner" }),
}));
// The session behind these two is better-auth's; nothing here is about it.
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ environment: vi.fn(() => Promise.resolve()) }),
}));
vi.mock("@/components/shell/recents", () => ({
  useForgetVisited: () => vi.fn(),
}));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../use-application", async (original) => {
  const actual = await original<typeof import("../use-application")>();
  return {
    ...actual,
    useApplication: () => ({
      data: {
        applicationId: "app-1",
        name: "hello",
        appName: "hello-a1b2c3",
        environmentId: "env-1",
        serverId: null,
        aiModel: facet.aiModel,
        configKind: facet.configKind,
      } as unknown as ApplicationDetail,
      error: null,
    }),
    useUpdateApplication: () => ({ mutateAsync: vi.fn() }),
  };
});

// Every other card on the tab has its own reads and its own tests; this file
// is about the one that deletes.
vi.mock("../advanced/use-advanced", () => ({
  useServers: () => ({ data: [], isPending: false }),
  useMounts: () => ({}),
  useNetworking: () => ({}),
  useMountMutations: () => ({}),
  useNetworkingMutations: () => ({ ports: {}, redirects: {}, security: {} }),
}));
vi.mock("../traefik-status/use-config-status", () => ({
  useTraefikConfigStatus: () => ({ data: undefined }),
}));
vi.mock("../advanced/mounts-spec", () => ({ mountsSpec: () => ({}) }));
vi.mock("../advanced/networking-specs", () => ({
  portsSpec: () => ({ title: "Ports" }),
  redirectsSpec: () => ({}),
  securitySpec: () => ({}),
}));
vi.mock("@/components/console/resource-list", () => ({
  ResourceList: ({ spec }: { spec: { title?: string } }) =>
    spec.title ? <h2>{spec.title}</h2> : null,
}));
vi.mock("../advanced/resources-card", () => ({ ResourcesCard: () => null }));
vi.mock("../advanced/runtime-card", () => ({
  RuntimeCard: () => <h2>Run command</h2>,
}));
vi.mock("../advanced/build-server-card", () => ({
  BuildServerCard: () => null,
}));
vi.mock("../advanced/traefik-card", () => ({ TraefikCard: () => null }));
vi.mock("../advanced/swarm/swarm-section", () => ({
  SwarmSection: () => null,
}));

const { default: Panel } = await import("./advanced");

/** The panel, opened on one of its sub-sections. */
function renderPanel(section?: string) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Panel
        {...({ id: "app-1", label: "Advanced", icon: "sliders" } as PanelProps)}
      />
    </QueryClientProvider>,
  );
  if (section) open(section);
}

const open = (section: string) =>
  fireEvent.click(screen.getByRole("tab", { name: section }));

beforeEach(() => {
  facet.aiModel = null;
  facet.configKind = "web";
  permission.allowed = true;
  apiDelete.mockReset();
  push.mockReset();
});
afterEach(cleanup);

/**
 * The Application's own screens offer Delete: a typed confirm that
 * calls `DELETE /applications/:id` and lands on the Environment.
 */
describe("DeleteApplicationCard", () => {
  it("offers Delete, and confirming calls DELETE /applications/:id and goes to the Environment", async () => {
    apiDelete.mockResolvedValue({ applicationId: "app-1" });
    renderPanel("Danger zone");

    fireEvent.click(screen.getByRole("button", { name: /Delete hello/ }));
    const confirm = screen.getByRole("button", { name: "Delete Application" });
    expect(confirm.getAttribute("aria-disabled")).toBe("true");

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hello" },
    });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/environments/env-1"),
    );
    expect(apiDelete).toHaveBeenCalledTimes(1);
    // The volumes switch is off unless it is turned on.
    expect(apiDelete).toHaveBeenCalledWith("/applications/app-1", {
      query: { deleteVolumes: "false" },
    });
  });

  it("offers Delete its volumes too, off by default, and sends it when turned on", async () => {
    apiDelete.mockResolvedValue({ applicationId: "app-1" });
    renderPanel("Danger zone");

    fireEvent.click(screen.getByRole("button", { name: /Delete hello/ }));
    const toggle = screen.getByRole("switch", {
      name: /Delete its volumes too/,
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete Application" }));

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/environments/env-1"),
    );
    expect(apiDelete).toHaveBeenCalledWith("/applications/app-1", {
      query: { deleteVolumes: "true" },
    });
  });

  it("shows a volume the delete kept, with the reason it gives", async () => {
    const reason =
      "Kept: also used by the application Service 'Worker' (worker) on the same Server";
    apiDelete.mockResolvedValue({
      applicationId: "app-1",
      unreclaimedArtifacts: [
        {
          kind: "volume",
          appName: "hello-a1b2c3",
          serverId: null,
          path: "shared-uploads",
          reason,
        },
      ],
    });
    renderPanel("Danger zone");

    fireEvent.click(screen.getByRole("button", { name: /Delete hello/ }));
    fireEvent.click(
      screen.getByRole("switch", { name: /Delete its volumes too/ }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete Application" }));

    await waitFor(() =>
      expect(document.body.textContent).toContain("shared-uploads"),
    );
    expect(document.body.textContent).toContain(reason);
    expect(push).not.toHaveBeenCalled();
  });

  it("holds the report on screen before leaving when the teardown left something behind", async () => {
    apiDelete.mockResolvedValue({
      applicationId: "app-1",
      unreclaimedImages: [{ serverId: null, images: ["hello-a1b2c3:latest"] }],
    });
    renderPanel("Danger zone");

    fireEvent.click(screen.getByRole("button", { name: /Delete hello/ }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete Application" }));

    await waitFor(() =>
      expect(document.body.textContent).toContain("hello-a1b2c3:latest"),
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps the refusal in the dialog and stays on the page", async () => {
    const refusal =
      "Cloudgate could not reach Docker to confirm swarm service hello-a1b2c3 is gone, so the Application was kept";
    apiDelete.mockRejectedValue(new ApiError(409, refusal));
    renderPanel("Danger zone");

    fireEvent.click(screen.getByRole("button", { name: /Delete hello/ }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete Application" }));

    await waitFor(() => expect(document.body.textContent).toContain(refusal));
    expect(
      screen.getByRole("button", { name: "Delete Application" }),
    ).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it("is off, with the reason, for a role that cannot delete a Service", () => {
    permission.allowed = false;
    renderPanel("Danger zone");

    const button = screen.getByRole("button", { name: /Delete hello/ });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain(
      "Your role in this Organization cannot delete an Application",
    );
    fireEvent.click(button);
    expect(
      screen.queryByRole("button", { name: "Delete Application" }),
    ).toBeNull();
  });
});

/** An AI model is not offered what its API refuses. */
describe("on an AI model", () => {
  it("offers no Run command and no published Ports, and says why", () => {
    facet.aiModel = { runtime: "ollama", model: "smollm2:135m" };
    renderPanel("Runtime");

    expect(screen.queryByRole("heading", { name: "Run command" })).toBeNull();
    open("Routing");
    expect(screen.queryByRole("heading", { name: "Ports" })).toBeNull();
    expect(document.body.textContent).toMatch(
      /run command, published ports, networks, health\s+check and endpoint spec are the platform/,
    );
  });

  it("leaves both on a plain Application", () => {
    renderPanel("Runtime");

    expect(screen.getByRole("heading", { name: "Run command" })).toBeTruthy();
    open("Routing");
    expect(screen.getByRole("heading", { name: "Ports" })).toBeTruthy();
  });
});

/** A web-private publishes no port, which its API refuses. */
describe("on a web-private", () => {
  it("offers no published Ports, and says why, keeping the Run command", () => {
    facet.configKind = "web-private";
    renderPanel("Routing");

    expect(screen.queryByRole("heading", { name: "Ports" })).toBeNull();
    open("Runtime");
    expect(screen.getByRole("heading", { name: "Run command" })).toBeTruthy();
    expect(document.body.textContent).toContain(
      "A Private web service publishes no port",
    );
  });
});

/**
 * The tab was one ~8,750px page with three ways of saving and nothing
 * saying which card used which. It is five sub-sections now, one shown at a
 * time, each opening on how its cards save.
 */
describe("the Advanced sub-sections", () => {
  it("offers Resources, Runtime, Routing, Docker Swarm and Danger zone, opening on Resources", () => {
    renderPanel();

    expect(
      screen.getAllByRole("tab").map((tab) => tab.textContent),
    ).toEqual(["Resources", "Runtime", "Routing", "Docker Swarm", "Danger zone"]);
    expect(
      screen.getByRole("tab", { name: "Resources" }).getAttribute("aria-selected"),
    ).toBe("true");
    // Delete is no longer under everything else, nor on the first screen.
    expect(screen.queryByRole("button", { name: /Delete hello/ })).toBeNull();
  });

  // Every sub-section stays mounted, so what is *shown* is what is outside a
  // hidden panel.
  const shown = (text: RegExp) =>
    screen.queryAllByText(text).filter((node) => !node.closest("[hidden]"));

  it("says how each sub-section saves before anything on it is touched", () => {
    renderPanel();
    expect(shown(/Each card saves on its own/)).toHaveLength(1);
    expect(shown(/Each row saves on its own/)).toHaveLength(0);

    open("Routing");
    expect(shown(/Each row saves on its own/)).toHaveLength(1);
    expect(shown(/Each card saves on its own/)).toHaveLength(0);

    open("Docker Swarm");
    expect(shown(/One form, one Save/)).toHaveLength(1);
  });
});
