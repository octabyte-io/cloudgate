import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { terminalTitle } from "@/components/console/terminal-target";
import { DockContext, type DockApi } from "@/components/shell/dock-context";
import { TerminalOfferRegistry } from "@/components/shell/terminal-offers";

/**
 * What a Service page puts under the Dock's `+`: its shell — the one
 * its Shell tab opens first — and only to a caller the tab is there
 * for. Observed through the Dock's own offer registry, which is what the `+`
 * menu lists (`dock.test.tsx` pins the menu itself).
 */
const listing = vi.hoisted(() => ({
  current: { data: undefined as unknown },
  asked: [] as { serviceId: string; enabled: boolean }[],
}));

vi.mock("./use-service-containers", () => ({
  useServiceContainers: (
    _type: string,
    serviceId: string,
    options: { enabled?: boolean } = {},
  ) => {
    const enabled = options.enabled ?? true;
    listing.asked.push({ serviceId, enabled });
    return enabled ? listing.current : { data: undefined };
  },
}));

const { OfferServiceShell } = await import("./offer-service-shell");
type ShellService = import("./service-shell").ShellService;
type TabSubject = import("@/lib/shell/tab-registry").TabSubject;

afterEach(() => {
  cleanup();
  listing.current = { data: undefined };
  listing.asked = [];
});

const STOREFRONT: ShellService = {
  serviceType: "application",
  serviceId: "app_1",
  name: "storefront",
  environment: "production",
  project: "Demo Shop",
  serverId: "srv-1",
  serverName: "main-vps",
  noun: "Application",
  overviewHref: "/applications/app_1",
  deploymentsHref: "/applications/app_1/deployments",
};

const REPLICAS = [
  { containerId: "aaa111", name: "app-storefront.1.x1", state: "running" },
  { containerId: "bbb222", name: "app-storefront.2.x2", state: "running" },
];

function mount(
  service: ShellService | null = STOREFRONT,
  subject: TabSubject = { shellAllowed: true },
) {
  const offers = new TerminalOfferRegistry();
  const dock = { offers } as unknown as DockApi;
  const view = render(
    <DockContext.Provider value={dock}>
      <OfferServiceShell service={service} subject={subject} />
    </DockContext.Provider>,
  );
  return { offers, view };
}

describe("a Service page's `+` offer", () => {
  it("offers the shell its Shell tab opens first, named as its tab will be", () => {
    listing.current.data = REPLICAS;

    const { offers } = mount();

    expect(offers.getSnapshot()).toEqual([
      {
        target: {
          kind: "container",
          containerId: "aaa111",
          serverId: "srv-1",
          name: "app-storefront.1.x1",
          host: "main-vps",
          shell: "sh",
          service: {
            name: "storefront",
            environment: "production",
            project: "Demo Shop",
          },
        },
      },
    ]);
    expect(terminalTitle(offers.getSnapshot()[0]!.target)).toBe(
      "storefront · production · Demo Shop",
    );
  });

  it("offers nothing to a role without service:update, and does not ask for its containers", () => {
    listing.current.data = REPLICAS;

    const { offers } = mount(STOREFRONT, { shellAllowed: false });

    expect(offers.getSnapshot()).toEqual([]);
    expect(listing.asked.every((ask) => !ask.enabled)).toBe(true);
  });

  it("offers nothing for a Service in a Cloud account, and does not ask", () => {
    listing.current.data = REPLICAS;

    const { offers } = mount(STOREFRONT, {
      shellAllowed: true,
      cloudPlace: { provider: "aws" },
    });

    expect(offers.getSnapshot()).toEqual([]);
    expect(listing.asked.every((ask) => !ask.enabled)).toBe(true);
  });

  it("offers nothing while no container of it is running", () => {
    listing.current.data = [];

    expect(mount().offers.getSnapshot()).toEqual([]);
  });

  it("offers nothing before the Service's row is read", () => {
    listing.current.data = REPLICAS;

    expect(mount(null).offers.getSnapshot()).toEqual([]);
    expect(listing.asked.every((ask) => !ask.enabled)).toBe(true);
  });

  it("withdraws the offer when the page goes", () => {
    listing.current.data = REPLICAS;
    const { offers, view } = mount();

    view.unmount();

    expect(offers.getSnapshot()).toEqual([]);
  });
});
