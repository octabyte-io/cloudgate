import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Server } from "@/lib/api/endpoints/servers";
import type { TemplateSummary } from "@/lib/api/endpoints/templates";

import type { LaunchPhase } from "./wizard-model";

const search = vi.hoisted(() => ({ current: "" }));
const reads = vi.hoisted(() => ({
  templates: [] as TemplateSummary[],
  servers: [] as Server[],
  offered: true,
  canCreate: true,
  phase: { phase: "preparing" } as LaunchPhase,
  domains: [] as unknown[],
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search.current),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("../templates/use-templates", () => ({
  NEW_PROJECT: "new-project",
  useTemplateCatalogue: () => ({
    isPending: false,
    error: null,
    data: { templates: reads.templates },
  }),
  useSetupForm: () => ({ isPending: true }),
}));
vi.mock("@/lib/auth/use-permission", () => ({
  usePermission: () => ({
    allowed: reads.canCreate,
    pending: false,
    role: "member",
  }),
}));
vi.mock("../server/buy/use-bought-servers", () => ({
  useBoughtServerOffer: () => ({ offered: reads.offered, pending: false }),
  useBoughtServerCatalogue: () => ({
    data: {
      locations: [],
      storage: { minGb: 10, maxGb: 100, perGbMonthly: 0.05 },
      sizes: [
        {
          id: "cx23",
          family: "shared",
          vcpus: 2,
          memoryGb: 4,
          diskGb: 40,
          offers: [
            {
              locationId: "nbg1",
              available: true,
              monthly: 7,
              backupsMonthly: 2,
            },
          ],
        },
      ],
    },
  }),
  useCancelPurchase: () => ({ mutate: vi.fn(), isPending: false }),
  useBoughtServerToday: () => ({}),
  useBuyServer: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("./use-get-started", () => ({
  useWizardServers: () => ({
    isPending: false,
    error: null,
    data: reads.servers,
  }),
  useWizardPurchases: () => ({ isPending: false, data: [] }),
  useWizardServerRoom: () => ({ isPending: false, data: null }),
  useLaunch: () => ({
    plan: { error: null },
    phase: reads.phase,
    domains: { isPending: false, data: reads.domains },
  }),
}));

const { GetStartedScreen } = await import("./get-started-screen");

const GHOST: TemplateSummary = {
  id: "ghost",
  revision: "r1",
  name: "Ghost",
  description: "A blog.",
  version: "5",
  tags: [],
  links: {},
  logo: "data:image/svg+xml,%3Csvg/%3E",
  runsOn: ["server"],
};

function readyServer(serverId: string, name: string): Server {
  return {
    serverId,
    name,
    ipAddress: "203.0.113.7",
    serverType: "deploy",
    setupRanAt: "2026-11-01T00:00:00Z",
    setupOk: true,
    setupMessage: null,
    boughtServer: null,
    createdAt: "2026-11-01T00:00:00Z",
  } as Server;
}

function show(query: string) {
  search.current = query;
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <GetStartedScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  reads.templates = [GHOST];
  reads.servers = [];
  reads.offered = true;
  reads.canCreate = true;
  reads.phase = { phase: "preparing" };
  reads.domains = [];
});

afterEach(cleanup);

describe("GetStartedScreen", () => {
  it("sends a link with no app back to the catalogue", () => {
    show("");

    expect(
      screen.getByRole("heading", { name: "That app isn't in the catalogue" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "See all apps" }).getAttribute("href"),
    ).toBe("/templates");
  });

  it("sends a link naming an app the catalogue does not have back to it", () => {
    show("template=nope");

    expect(
      screen.getByRole("heading", { name: "That app isn't in the catalogue" }),
    ).toBeTruthy();
  });

  it("names the app, and says the first step is choosing a server", () => {
    show("template=ghost");

    expect(screen.getByRole("heading", { name: "Deploy Ghost" })).toBeTruthy();
    const steps = screen.getByRole("navigation", { name: "Steps to deploy" });
    expect(
      within(steps)
        .getByText("Choose a server")
        .closest("[aria-current='step']"),
    ).toBeTruthy();
  });

  it("offers both ways to get a server, buying first, with its starting price", () => {
    show("template=ghost");

    expect(
      screen.getByRole("heading", { name: "Where should Ghost run?" }),
    ).toBeTruthy();
    const ways = screen.getByRole("group", { name: "Ways to get a server" });
    const links = within(ways).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/get-started?template=ghost&path=buy",
      "/get-started?template=ghost&path=own",
    ]);
    expect(within(links[0]).getByText(/From \$7 a month/)).toBeTruthy();
  });

  it("leaves buying out where this instance does not sell servers", () => {
    reads.offered = false;
    show("template=ghost");

    const ways = screen.getByRole("group", { name: "Ways to get a server" });
    expect(within(ways).getAllByRole("link")).toHaveLength(1);
    expect(within(ways).queryByText("Get a server from Cloudgate")).toBeNull();
  });

  it("offers a Ready server the organization already has, going on to the details", () => {
    reads.servers = [readyServer("srv_1", "web-1")];
    show("template=ghost");

    expect(
      screen.getByRole("link", { name: "Use web-1" }).getAttribute("href"),
    ).toBe("/get-started?template=ghost&server=srv_1&step=deploy");
    expect(
      screen.queryByRole("group", { name: "Ways to get a server" }),
    ).toBeNull();
  });

  it("lets the person pick among several Ready servers", () => {
    reads.servers = [
      readyServer("srv_1", "web-1"),
      readyServer("srv_2", "web-2"),
    ];
    show("template=ghost");

    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });

  it("tells a member who cannot add a server to ask an owner or admin", () => {
    reads.canCreate = false;
    show("template=ghost");

    expect(
      screen.getByText("Ask your organization’s owner or admin"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("group", { name: "Ways to get a server" }),
    ).toBeNull();
  });

  it("follows a launch while it prepares", () => {
    show("template=ghost&server=srv_1&env=env_1");

    const stages = screen.getByRole("list", { name: "Launching Ghost" });
    expect(within(stages).getByText("Preparing Ghost")).toBeTruthy();
  });

  it("gives the running app's address and the way to open it", () => {
    reads.phase = { phase: "running" };
    reads.domains = [
      {
        host: "ghost-ab12-203-0-113-7.sslip.io",
        https: false,
        path: null,
        service: { serviceType: "compose", serviceId: "cmp_1", name: "ghost" },
      },
    ];
    show("template=ghost&server=srv_1&env=env_1");

    expect(screen.getByText("Ghost is running")).toBeTruthy();
    const open = screen.getByRole("link", { name: /Open Ghost/ });
    expect(open.getAttribute("href")).toBe(
      "http://ghost-ab12-203-0-113-7.sslip.io",
    );
    expect(open.getAttribute("target")).toBe("_blank");
    expect(
      screen
        .getByRole("link", { name: "Use your own domain" })
        .getAttribute("href"),
    ).toBe("/compose/cmp_1/domains");
  });

  it("says why a launch failed and where to look", () => {
    reads.phase = { phase: "failed", reason: "ghost did not start." };
    show("template=ghost&server=srv_1&env=env_1");

    expect(screen.getByText("ghost did not start.")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "See what happened" })
        .getAttribute("href"),
    ).toBe("/environments/env_1");
  });
});
