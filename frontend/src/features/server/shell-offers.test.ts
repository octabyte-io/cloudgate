import { describe, expect, it } from "vitest";

import type { Server } from "@/lib/api/endpoints/servers";

import { hostShellOffers, serverShellOffers } from "./shell-offers";

/**
 * What a Server page and the fleet screen put under the Dock's `+`:
 * only shells the caller may open, named the way their tab will be.
 */
const server = {
  serverId: "srv-1",
  name: "main-vps",
  ipAddress: "10.0.0.1",
  port: 22,
  username: "root",
  sshKeyId: "key-1",
} as Server;

describe("serverShellOffers", () => {
  it("offers the Server's shell, with the target its Terminal tab opens", () => {
    expect(serverShellOffers(server, { allowed: true })).toEqual([
      {
        target: {
          kind: "server",
          serverId: "srv-1",
          name: "main-vps",
          address: "root@10.0.0.1:22",
        },
      },
    ]);
  });

  it("offers nothing to a role that may not read the Server", () => {
    expect(serverShellOffers(server, { allowed: false })).toEqual([]);
  });

  it("offers nothing for a Server with no SSH key — the gateway closes it at once", () => {
    expect(
      serverShellOffers({ ...server, sshKeyId: null }, { allowed: true }),
    ).toEqual([]);
  });
});

describe("hostShellOffers", () => {
  const asked = { username: "deploy", port: 2222 };

  it("offers this host once the instance-authority read has answered", () => {
    expect(hostShellOffers({ isSuccess: true }, asked)).toEqual([
      {
        target: {
          kind: "server",
          serverId: "local",
          name: "This host",
          address: "deploy@localhost:2222",
        },
      },
    ]);
  });

  it("fails closed: nothing while that read is pending, refused or failed", () => {
    // A 403, a 500 and a read in flight all look the same here: not a
    // success. A `+` row is an offer, not a control the backend then
    // answers, so it waits for the authority to be shown rather than assumed.
    expect(hostShellOffers({ isSuccess: false }, asked)).toEqual([]);
  });

  it("offers nothing while the card's fields do not make a session", () => {
    expect(hostShellOffers({ isSuccess: true }, null)).toEqual([]);
  });
});
