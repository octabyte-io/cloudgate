import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const listing = vi.hoisted(() => ({
  current: {
    data: undefined as unknown,
    error: null as unknown,
    isPending: false,
  },
}));

vi.mock("./use-service-containers", () => ({
  useServiceContainers: () => listing.current,
}));
// The shared terminal is xterm behind `next/dynamic`; what this tab owes it is
// the target, so the double prints that.
vi.mock("@/components/console/terminal", () => ({
  Terminal: ({ target }: { target: unknown }) => (
    <pre data-testid="terminal">{JSON.stringify(target)}</pre>
  ),
}));

const { ApiError } = await import("@/lib/api/api-error");
const { ServiceShell, chosenContainer, shellTarget } = await import(
  "./service-shell"
);
type ShellService = import("./service-shell").ShellService;

afterEach(() => {
  cleanup();
  listing.current = { data: undefined, error: null, isPending: false };
});

const STOREFRONT: ShellService = {
  serviceType: "application",
  serviceId: "app_1",
  name: "storefront",
  environment: "production",
  project: "Demo Shop",
  serverId: null,
  serverName: null,
  noun: "Application",
  overviewHref: "/applications/app_1",
  deploymentsHref: "/applications/app_1/deployments",
};

const REPLICAS = [
  { containerId: "aaa111aaa111ff", name: "app-storefront.1.x1", state: "running" },
  { containerId: "bbb222bbb222ff", name: "app-storefront.2.x2", state: "running" },
];

const mount = (service: ShellService | null = STOREFRONT) =>
  render(
    <ServiceShell
      service={service}
      error={null}
      pending={false}
      label="Shell"
      icon="term"
    />,
  );

const target = () =>
  JSON.parse(screen.getByTestId("terminal").textContent ?? "{}") as {
    containerId: string;
    serverId: string | null;
    shell: string;
    service: { name: string; environment: string; project: string };
  };

describe("the Shell tab", () => {
  it("opens sh in the one running container, with no picker", () => {
    listing.current.data = [REPLICAS[0]];

    mount();

    expect(target()).toMatchObject({
      kind: "container",
      containerId: "aaa111aaa111ff",
      serverId: null,
      shell: "sh",
      service: {
        name: "storefront",
        environment: "production",
        project: "Demo Shop",
      },
    });
    expect(screen.queryByText("Container")).toBeNull();
  });

  it("says leaving ends the shell only when it is not docked", () => {
    listing.current.data = [REPLICAS[0]];

    mount();

    const lede = document.body.textContent ?? "";
    expect(lede).toContain("Leaving this tab ends the shell, unless you Dock it");
    expect(lede).not.toContain("Leaving this tab ends the shell;");
  });

  it("offers a picker over two replicas, with the first preselected", () => {
    listing.current.data = REPLICAS;

    mount();

    expect(screen.getByText("Container")).toBeTruthy();
    expect(target().containerId).toBe("aaa111aaa111ff");
  });

  it("says no container is running, and points at Overview and Deployments, rather than drawing a terminal", () => {
    listing.current.data = [];

    mount();

    expect(screen.getByText("No container of storefront is running")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Overview" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "See Deployments" })).toBeTruthy();
    expect(screen.queryByTestId("terminal")).toBeNull();
  });

  it("words a refused listing as the role, not as a broken terminal", () => {
    listing.current.error = new ApiError(
      403,
      "Container not found or not permitted",
    );

    mount();

    expect(screen.getByRole("alert").textContent).toMatch(
      /Your role in this Organization cannot open a shell in this Application/,
    );
    expect(screen.queryByTestId("terminal")).toBeNull();
  });

  it("says the Server could not be reached, in the console's own words", () => {
    listing.current.error = new ApiError(503, "This Server could not be reached", {
      code: "HOST_UNREACHABLE",
    });

    mount({ ...STOREFRONT, serverId: "srv_1", serverName: "worker-1" });

    expect(screen.getByText("Cloudgate could not reach this Server.")).toBeTruthy();
    expect(screen.queryByTestId("terminal")).toBeNull();
  });

  it("names the compose service in a stack's picker", () => {
    listing.current.data = [
      { ...REPLICAS[0], composeService: "web" },
      { ...REPLICAS[1], composeService: "worker" },
    ];

    mount({ ...STOREFRONT, serviceType: "compose", noun: "Compose stack" });

    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.getAllByText("worker").length).toBeGreaterThan(0);
  });
});

describe("chosenContainer", () => {
  it("keeps a choice while it is still running, and falls back to the first", () => {
    expect(chosenContainer(REPLICAS, "bbb222bbb222ff")?.containerId).toBe(
      "bbb222bbb222ff",
    );
    expect(chosenContainer(REPLICAS, "gone")?.containerId).toBe("aaa111aaa111ff");
    expect(chosenContainer([], null)).toBeNull();
  });
});

describe("shellTarget", () => {
  it("names the Server the container is on, or this host", () => {
    expect(shellTarget(STOREFRONT, REPLICAS[0]).host).toBe("this host");
    expect(
      shellTarget({ ...STOREFRONT, serverId: "srv_1", serverName: "worker-1" }, REPLICAS[0]),
    ).toMatchObject({ serverId: "srv_1", host: "worker-1" });
  });
});
