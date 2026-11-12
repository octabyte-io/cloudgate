import { describe, expect, it, vi } from "vitest";

import type { TerminalTarget } from "@/components/console/terminal-target";

import { TerminalOfferRegistry } from "./terminal-offers";

/**
 * "Shells this page can open" — what the Dock's `+` lists.
 *
 * Pages register what they offer while they are on screen, and only what the
 * caller may open; the registry is the union of whatever is registered now.
 */
const server: TerminalTarget = {
  kind: "server",
  serverId: "srv-1",
  name: "main-vps",
  address: "root@10.0.0.1:22",
};
const host: TerminalTarget = {
  kind: "server",
  serverId: "local",
  name: "This host",
  address: "root@localhost:22",
};
const container: TerminalTarget = {
  kind: "container",
  containerId: "c-1",
  serverId: "srv-1",
  name: "app.1.x7",
  host: "main-vps",
  shell: "sh",
  service: { name: "storefront", environment: "production", project: "Demo" },
};

describe("TerminalOfferRegistry", () => {
  it("is empty until a page offers something", () => {
    expect(new TerminalOfferRegistry().getSnapshot()).toEqual([]);
  });

  it("lists every page's offers in the order they were registered", () => {
    const registry = new TerminalOfferRegistry();
    registry.register([{ target: container }]);
    registry.register([{ target: server }, { target: host }]);

    expect(registry.getSnapshot().map((offer) => offer.target)).toEqual([
      container,
      server,
      host,
    ]);
  });

  it("a page leaving takes its offers with it", () => {
    const registry = new TerminalOfferRegistry();
    const leave = registry.register([{ target: server }]);
    registry.register([{ target: host }]);

    leave();

    expect(registry.getSnapshot().map((offer) => offer.target)).toEqual([host]);
  });

  it("the same shell offered twice — a layout and its tab — is listed once", () => {
    const registry = new TerminalOfferRegistry();
    registry.register([{ target: server }]);
    registry.register([{ target: { ...server } }]);

    expect(registry.getSnapshot()).toHaveLength(1);
  });

  it("tells subscribers, with a new snapshot each time", () => {
    const registry = new TerminalOfferRegistry();
    const heard = vi.fn();
    registry.subscribe(heard);
    const before = registry.getSnapshot();

    const leave = registry.register([{ target: server }]);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(registry.getSnapshot()).not.toBe(before);

    leave();
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("registering nothing changes nothing", () => {
    const registry = new TerminalOfferRegistry();
    const heard = vi.fn();
    registry.subscribe(heard);

    registry.register([])();

    expect(heard).not.toHaveBeenCalled();
  });
});
