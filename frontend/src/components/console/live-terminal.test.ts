import { describe, expect, it } from "vitest";

import { localShellAddress } from "@/features/server/local/local-shell-values";

import { localDial } from "./live-terminal";
import { terminalTitle } from "./terminal-target";

/**
 * The local Server's dial parameters. `serverId=local` is the one terminal
 * target with no Server row behind it, so the gateway cannot look these up and
 * refuses the socket without them — which is what kept the gateway's local
 * terminal out of reach of this console.
 */
describe("localDial", () => {
  it("takes the user and the port off the address the frame shows", () => {
    expect(localDial("root@localhost:22")).toEqual({
      username: "root",
      port: 22,
    });
  });

  it("round-trips whatever the local shell card opened with", () => {
    // The one coupling this parse has: the card writes the address, this reads
    // it, and the frame prints it. All three are the same two values.
    const session = { username: "deploy", port: 2222 };

    expect(localDial(localShellAddress(session))).toEqual(session);
  });

  it("takes the port from the last colon, so an IPv6 host still parses", () => {
    expect(localDial("root@[::1]:22")).toEqual({ username: "root", port: 22 });
  });

  it.each([
    "localhost:22",
    "root@localhost",
    "@localhost:22",
    "root@localhost:",
    "root@localhost:0",
    "root@localhost:70000",
    "root@localhost:ssh",
    "this host",
  ])("leaves the socket closed for %o rather than dialling it", (address) => {
    // Returning null disables the hook. Dialling instead would open a socket the
    // gateway closes with 4400, which reads on screen as a terminal that failed.
    expect(localDial(address)).toBeNull();
  });
});

/**
 * The Dock's header names what the shell is in, at all times — the
 * same rule the page frame has, in a line of its own.
 */
describe("terminalTitle", () => {
  it("names a Service by Service, Environment and Project", () => {
    expect(
      terminalTitle({
        kind: "container",
        containerId: "c-1",
        serverId: "srv-1",
        name: "app-9uiusu.1.x7",
        host: "main-vps",
        service: {
          name: "storefront",
          environment: "production",
          project: "Demo Shop",
        },
      }),
    ).toBe("storefront · production · Demo Shop");
  });

  it("names a bare container by its name and host", () => {
    expect(
      terminalTitle({
        kind: "container",
        containerId: "c-1",
        serverId: null,
        name: "app-9uiusu.1.x7",
        host: "this host",
      }),
    ).toBe("container app-9uiusu.1.x7 on this host");
  });

  it("names a Server as one, and the platform's own host never as a Server", () => {
    expect(
      terminalTitle({
        kind: "server",
        serverId: "srv-1",
        name: "main-vps",
        address: "root@10.0.0.1:22",
      }),
    ).toBe("Server main-vps");
    expect(
      terminalTitle({
        kind: "server",
        serverId: "local",
        name: "This host",
        address: "root@localhost:22",
      }),
    ).toBe("This host");
  });
});
