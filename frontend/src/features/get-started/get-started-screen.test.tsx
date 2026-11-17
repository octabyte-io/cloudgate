import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerPurchase } from "@/lib/api/endpoints/bought-servers";
import type { Server } from "@/lib/api/endpoints/servers";
import type { SetupForm, TemplateSummary } from "@/lib/api/endpoints/templates";

import type { LaunchPhase } from "./wizard-model";

const search = vi.hoisted(() => ({ current: "" }));
const replace = vi.hoisted(() => vi.fn());
const buy = vi.hoisted(() => vi.fn());
const setUp = vi.hoisted(() => vi.fn());
const reads = vi.hoisted(() => ({
  templates: [] as TemplateSummary[],
  servers: [] as Server[],
  purchases: [] as ServerPurchase[],
  setupForm: null as SetupForm | null,
  offered: true,
  canCreate: true,
  phase: { phase: "preparing" } as LaunchPhase,
  domains: [] as unknown[],
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search.current),
  useRouter: () => ({ push: vi.fn(), replace }),
}));
vi.mock("../server/buy/where-you-are", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/buy/where-you-are")>()),
  browserTimeZone: () => "Europe/Berlin",
}));

/**
 * A catalogue as the backend answers it. From Berlin, Nuremberg is the
 * nearest place, and its 2 vCPU · 4 GB size the cheapest anywhere.
 */
const CATALOGUE = vi.hoisted(() => ({
  locations: [
    {
      id: "hel1",
      city: "Helsinki",
      country: "FI",
      latitude: 60.17,
      longitude: 24.94,
    },
    {
      id: "nbg1",
      city: "Nuremberg",
      country: "DE",
      latitude: 49.45,
      longitude: 11.08,
    },
  ],
  storage: { minGb: 10, maxGb: 10240, perGbMonthly: 0.05 },
  sizes: [
    {
      id: "cx23",
      family: "shared",
      architecture: "x86",
      vcpus: 2,
      memoryGb: 4,
      diskGb: 40,
      offers: [
        { locationId: "nbg1", available: true, monthly: 7, backupsMonthly: 2 },
        { locationId: "hel1", available: true, monthly: 8, backupsMonthly: 2 },
      ],
    },
  ],
  images: [
    {
      id: "ubuntu-24.04",
      label: "Ubuntu 24.04",
      architectures: ["x86", "arm"],
    },
    { id: "debian-13", label: "Debian 13", architectures: ["x86", "arm"] },
  ],
  defaultImage: "ubuntu-24.04",
}));

/** The Today box's answer on a plan: $5.10 now. */
const TODAY = vi.hoisted(() => ({
  state: "plan" as const,
  plan: null,
  addOn: null,
  today: 510,
  monthly: 1200,
  currency: "usd",
  from: Date.UTC(2026, 10, 10, 12) / 1000,
  to: Date.UTC(2026, 11, 1, 12) / 1000,
  prorationDate: 1_794_000_000,
}));
vi.mock("../templates/use-templates", () => ({
  NEW_PROJECT: "new-project",
  useTemplateCatalogue: () => ({
    isPending: false,
    error: null,
    data: { templates: reads.templates },
  }),
  useSetupForm: () =>
    reads.setupForm
      ? { isPending: false, error: null, data: reads.setupForm }
      : { isPending: true },
}));
vi.mock("@/lib/api/endpoints/templates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints/templates")>()),
  templatesApi: { setUp },
}));
vi.mock("@/lib/api/use-projects", () => ({
  useProjects: () => ({ isPending: false, data: [] }),
}));
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ project: vi.fn(), boughtServers: vi.fn() }),
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
  useBoughtServerCatalogue: () => ({ data: CATALOGUE }),
  useCancelPurchase: () => ({ mutate: vi.fn(), isPending: false }),
  useBoughtServerToday: (choice: unknown) => ({
    data: choice ? TODAY : undefined,
  }),
  useBuyServer: () => ({ mutate: buy, isPending: false }),
}));
vi.mock("./use-get-started", () => ({
  useWizardServers: () => ({
    isPending: false,
    error: null,
    data: reads.servers,
  }),
  useWizardPurchases: () => ({ isPending: false, data: reads.purchases }),
  useWizardSetupForm: () =>
    reads.setupForm
      ? { isPending: false, error: null, data: reads.setupForm }
      : { isPending: true },
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

/** A Bought Server whose Server row exists: from Setting up on. */
function boughtServer(
  serverId: string,
  name: string,
  stage: "setting_up" | "ready",
  poweredOff: { at: string; reason: string } | null = null,
): Server {
  return {
    ...readyServer(serverId, name),
    setupRanAt: null,
    setupOk: null,
    boughtServer: { stage, poweredOff, deletesOn: null, deletedAt: null },
  } as Server;
}

/** A purchase not made yet: before its Server row exists. */
function purchase(
  id: string,
  name: string,
  stage: "waiting_for_payment" | "creating" | "failed",
): ServerPurchase {
  return {
    id,
    name,
    stage,
    monthlyCents: 700,
    createdAt: "2026-11-17T00:00:00Z",
  };
}

/** Ghost's new-Project setup form: no asked values, no Domains. */
const GHOST_SETUP: SetupForm = {
  templateId: "ghost",
  templateName: "Ghost",
  revision: "r1",
  setupName: "ghost",
  asked: [],
  domains: [],
  images: [],
  environments: [],
  deployTargets: { server: null, platformHost: null, aws: null, gcp: null },
  newProjectHosts: null,
};

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
  reads.purchases = [];
  reads.setupForm = null;
  reads.offered = true;
  reads.canCreate = true;
  reads.phase = { phase: "preparing" };
  reads.domains = [];
});

afterEach(() => {
  cleanup();
  replace.mockReset();
  buy.mockReset();
  setUp.mockReset();
  vi.unstubAllGlobals();
});

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

  describe("buying a server", () => {
    /** Base UI's trigger opens on `mousedown`, so a bare click is what opens it. */
    async function chooseImage(name: string) {
      fireEvent.click(screen.getByRole("combobox"));
      const option = await screen.findByRole("option", { name });
      fireEvent.pointerDown(option, { pointerType: "mouse" });
      fireEvent.click(option, { detail: 1 });
      await waitFor(() =>
        expect(screen.queryAllByRole("option")).toHaveLength(0),
      );
    }

    function pressBuy() {
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByRole("button", { name: "Buy" }));
    }

    it("offers every buy option, with the summary and Buy in a column beside them", () => {
      show("template=ghost&path=buy");

      for (const name of [
        "Suggested",
        "1. Location",
        "2. Size in Nuremberg",
        "3. Operating system",
        "4. Extras",
      ]) {
        expect(screen.getByRole("heading", { name })).toBeTruthy();
      }
      expect(
        screen.getByRole("list", { name: "Suggested Servers" }),
      ).toBeTruthy();
      expect(
        screen.getByRole("list", { name: "Locations, nearest first" }),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Standard" })).toBeTruthy();
      expect(screen.getByRole("combobox").textContent).toMatch(/Ubuntu 24\.04/);
      expect(screen.getByRole("switch", { name: "Backups" })).toBeTruthy();
      expect(screen.getByLabelText(/Extra storage/)).toBeTruthy();
      const rail = screen.getByRole("complementary", { name: "Summary" });
      expect(within(rail).getByRole("button", { name: "Buy" })).toBeTruthy();
    });

    it("opens on the closest suggestion", () => {
      show("template=ghost&path=buy");

      expect(
        screen
          .getByRole("radio", { name: "2 vCPU · 4 GB RAM · 40 GB disk" })
          .matches(":checked"),
      ).toBe(true);
      expect(
        screen.getByText("Server, 2 vCPU · 4 GB, Nuremberg, Ubuntu 24.04"),
      ).toBeTruthy();
    });

    it("keeps the summary in view beside the options, and under them in one column on a phone", () => {
      show("template=ghost&path=buy");

      const rail = screen.getByRole("complementary", { name: "Summary" });
      const summary = within(rail).getByRole("heading", { name: "Summary" });
      // jsdom lays nothing out, so the classes that do it are what is pinned:
      // a rail only as tall as its card (`items-start`) leaves sticky no room.
      expect(rail.parentElement!.className).toMatch(/\bitems-stretch\b/);
      expect(rail.parentElement!.className).not.toMatch(/\bitems-start\b/);
      expect(summary.closest(".cols\\:sticky")).not.toBeNull();
      // Under 1040px the grid is one column, the summary after the options.
      expect(rail.parentElement!.className).toMatch(/(^|\s)grid-cols-1\b/);
      // Two columns need more than the wizard's one-column measure.
      expect(rail.closest(".max-w-3xl")).toBeNull();
    });

    it("buys the image, backups and extra storage picked, and comes back to the wizard", async () => {
      show("template=ghost&path=buy");
      await chooseImage("Debian 13");
      fireEvent.click(screen.getByRole("switch", { name: "Backups" }));
      fireEvent.change(screen.getByLabelText(/Extra storage/), {
        target: { value: "50" },
      });

      pressBuy();

      expect(buy).toHaveBeenCalledTimes(1);
      const [input, { onSuccess }] = buy.mock.calls[0];
      expect(input).toEqual({
        serverType: "cx23",
        location: "nbg1",
        image: "debian-13",
        backups: true,
        storageGb: 50,
        termsAccepted: true,
        prorationDate: 1_794_000_000,
        returnTo: "/get-started?template=ghost&path=buy",
      });
      onSuccess({ id: "bs_1", stage: "creating", payUrl: null });
      expect(replace).toHaveBeenCalledWith(
        "/get-started?template=ghost&path=buy&server=bs_1&step=deploy",
      );
    });

    it("goes to the page to pay on when the purchase answers one", () => {
      const went = vi.fn();
      vi.stubGlobal("location", {
        set href(url: string) {
          went(url);
        },
      });
      show("template=ghost&path=buy");

      pressBuy();
      const [, { onSuccess }] = buy.mock.calls[0];
      onSuccess({
        id: "bs_1",
        stage: "waiting_for_payment",
        payUrl: "https://checkout.stripe.com/c/pay/cs_1",
      });

      expect(went).toHaveBeenCalledWith(
        "https://checkout.stripe.com/c/pay/cs_1",
      );
      expect(replace).not.toHaveBeenCalled();
    });
  });

  describe("after Buy", () => {
    const DETAILS =
      "/get-started?template=ghost&path=buy&server=bs_1&step=deploy";

    function currentStep() {
      const steps = screen.getByRole("navigation", { name: "Steps to deploy" });
      return within(steps)
        .getAllByRole("listitem")
        .find((item) => item.querySelector("[aria-current='step']"))
        ?.textContent;
    }

    function strip() {
      return screen.getByRole("region", { name: "Your server" });
    }

    it("is on step 2, with the server's stage in a strip above the details", () => {
      reads.purchases = [purchase("bs_1", "ghost-1", "creating")];
      reads.setupForm = GHOST_SETUP;
      show(DETAILS.slice("/get-started?".length));

      expect(currentStep()).toMatch(/Set up Ghost/);
      expect(strip().textContent).toMatch(
        /Your server: 1 of 4 steps done, now Creating your server/,
      );
      expect(screen.getByRole("form", { name: "Deploy Ghost" })).toBeTruthy();
    });

    it("says the app starts on its own and the page can be left, with no button to set it up now", () => {
      reads.servers = [boughtServer("bs_1", "ghost-1", "setting_up")];
      reads.setupForm = GHOST_SETUP;
      show(DETAILS.slice("/get-started?".length));

      expect(strip().textContent).toMatch(/now Setting it up/);
      expect(strip().textContent).toMatch(
        /Ghost starts on its own once the server is ready\./,
      );
      expect(strip().textContent).toMatch(/you can leave this page/);
      expect(screen.queryByText(/Set up Ghost now/)).toBeNull();
      expect(screen.queryByText(/No need to wait/)).toBeNull();
    });

    it("waits for payment in the strip, with the way to finish paying", () => {
      reads.purchases = [purchase("bs_1", "ghost-1", "waiting_for_payment")];
      reads.setupForm = GHOST_SETUP;
      show(DETAILS.slice("/get-started?".length));

      expect(currentStep()).toMatch(/Set up Ghost/);
      expect(strip().textContent).toMatch(/now Payment/);
      expect(
        within(strip()).getByRole("button", { name: "Finish paying" }),
      ).toBeTruthy();
    });

    it("says the payment page was left, back from a cancelled Checkout while payment waits", () => {
      reads.purchases = [purchase("bs_1", "ghost-1", "waiting_for_payment")];
      reads.setupForm = GHOST_SETUP;
      show(`${DETAILS.slice("/get-started?".length)}&checkout=cancelled`);

      expect(strip().textContent).toMatch(
        /You left the payment page before paying: finish paying to get the server, or cancel it and nothing is charged\./,
      );
      expect(
        within(strip()).getByRole("button", { name: "Finish paying" }),
      ).toBeTruthy();
    });

    it("says nothing of a left payment page without a cancelled Checkout", () => {
      reads.purchases = [purchase("bs_1", "ghost-1", "waiting_for_payment")];
      reads.setupForm = GHOST_SETUP;
      show(DETAILS.slice("/get-started?".length));

      expect(strip().textContent).not.toMatch(/You left the payment page/);
    });

    it("says a server that could not be made can't be used, and goes back to choosing one", () => {
      reads.purchases = [purchase("bs_1", "ghost-1", "failed")];
      reads.setupForm = GHOST_SETUP;
      show(DETAILS.slice("/get-started?".length));

      expect(screen.getByText(/We couldn't create this server/)).toBeTruthy();
      expect(
        screen
          .getByRole("link", { name: "Choose a server again" })
          .getAttribute("href"),
      ).toBe("/get-started?template=ghost");
      expect(screen.queryByRole("form", { name: "Deploy Ghost" })).toBeNull();
    });

    describe("leaving and coming back", () => {
      it("resumes on step 2 from the bare link while the server is made", () => {
        reads.purchases = [purchase("bs_1", "ghost-1", "creating")];
        show("template=ghost");

        expect(replace).toHaveBeenCalledWith(DETAILS);
      });

      it("resumes on step 2 from the address the buy path had before", () => {
        reads.servers = [boughtServer("bs_1", "ghost-1", "setting_up")];
        show("template=ghost&path=buy&server=bs_1");

        expect(replace).toHaveBeenCalledWith(DETAILS);
        expect(screen.queryByText(/Set up Ghost now/)).toBeNull();
      });

      it("goes on to step 2 back from Checkout, in the one-column width", () => {
        reads.purchases = [purchase("bs_1", "ghost-1", "waiting_for_payment")];
        const { container } = show("template=ghost&path=buy&checkout=success");

        expect(replace).toHaveBeenCalledWith(DETAILS);
        expect(container.querySelector(".max-w-6xl")).toBeNull();
      });

      it("goes on to step 2 back from a cancelled Checkout, keeping that the payment page was left", () => {
        reads.purchases = [purchase("bs_1", "ghost-1", "waiting_for_payment")];
        show("template=ghost&path=buy&checkout=cancelled");

        expect(replace).toHaveBeenCalledWith(`${DETAILS}&checkout=cancelled`);
      });
    });

    describe("the app is applied once the server is ready (ADR-0073)", () => {
      it("cannot be deployed before the server is set up, which has no Server to name yet", () => {
        reads.purchases = [purchase("bs_1", "ghost-1", "creating")];
        reads.setupForm = GHOST_SETUP;
        show(DETAILS.slice("/get-started?".length));

        // An off button stays focusable: Base UI marks it `aria-disabled`.
        expect(
          screen
            .getByRole("button", { name: "Deploy Ghost" })
            .getAttribute("aria-disabled"),
        ).toBe("true");
        expect(
          screen.getByText("You can deploy once the server is created."),
        ).toBeTruthy();
      });

      it("deploys at Setting up with the setup Cloudgate applies by itself", async () => {
        reads.servers = [boughtServer("bs_1", "ghost-1", "setting_up")];
        reads.setupForm = GHOST_SETUP;
        setUp.mockResolvedValue({
          pendingSetup: { environmentId: "env_1" },
        });
        show(DETAILS.slice("/get-started?".length));

        fireEvent.click(screen.getByRole("button", { name: "Deploy Ghost" }));

        await waitFor(() => expect(setUp).toHaveBeenCalledTimes(1));
        expect(setUp.mock.calls[0][0]).toEqual({
          templateId: "ghost",
          newProject: {
            name: "Ghost",
            deployTarget: { kind: "server", serverId: "bs_1" },
          },
          setupName: "ghost",
          values: {},
          autoApply: true,
        });
      });

      it("does not take a powered-off server at Setting up", () => {
        reads.servers = [
          boughtServer("bs_1", "ghost-1", "setting_up", {
            at: "2026-11-10T09:00:00Z",
            reason: "Port scan",
          }),
        ];
        reads.setupForm = GHOST_SETUP;
        show(DETAILS.slice("/get-started?".length));

        expect(
          screen.getByText("That server isn’t ready for an app yet."),
        ).toBeTruthy();
        expect(screen.queryByRole("form", { name: "Deploy Ghost" })).toBeNull();
      });
    });
  });
});
