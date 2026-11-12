import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { Server } from "@/lib/api/endpoints/servers";
import type { RuntimeInfo } from "@/lib/api/endpoints/settings";

import type { RuntimeInfoQuery } from "../runtime-info";

const useRuntimeInfo = vi.hoisted(() => vi.fn());

vi.mock("../runtime-info", async (original) => ({
  ...(await original<typeof import("../runtime-info")>()),
  useRuntimeInfo,
}));

const { FleetAside } = await import("./fleet-aside");

afterEach(() => {
  cleanup();
  useRuntimeInfo.mockReset();
});

/**
 * A `runtime-info` document with only the two readings this card indexes into.
 *
 * `observed` and `drift` are parameters rather than hardcoded nulls because
 * once every case here was a document with nothing to disagree about, so
 * the one decision this card makes — declared only, whatever the host says —
 * was asserted by nothing.
 */
function answered(
  docker: string | null,
  traefik: string | null,
  observed: { docker?: string; traefik?: string } = {},
) {
  return {
    data: {
      docker: {
        declared: docker,
        observed: observed.docker ?? null,
        scope: "host",
        drift: observed.docker !== undefined && observed.docker !== docker,
      },
      traefik: {
        declared: traefik,
        observed: observed.traefik ?? null,
        scope: "host",
        drift: observed.traefik !== undefined && observed.traefik !== traefik,
      },
    } as unknown as RuntimeInfo,
    error: null,
    isPending: false,
  } as unknown as RuntimeInfoQuery;
}

/** One Server row — only the two columns the tiles count are read. */
const aServer = {
  serverId: "srv-1",
  name: "carrier",
  serverStatus: "active",
  serverType: "deploy",
} as unknown as Server;

function said(
  query: RuntimeInfoQuery,
  fleet: { servers?: Server[]; pending?: boolean } = {},
) {
  useRuntimeInfo.mockReturnValue(query);
  render(
    <FleetAside
      servers={fleet.servers ?? []}
      pending={fleet.pending ?? false}
    />,
  );
  return document.body.textContent ?? "";
}

/**
 * *What setup installs* — declared only, and never a refusal in place of a card.
 *
 * The card describes **every** Server in the fleet while `runtime-info` answers
 * about **one** host, so an observed reading here would be the platform host's
 * version presented as a fleet-wide fact — the same category error as the
 * deleted literal, one level up. What reading the runtime does fix is that the
 * two numbers are no longer written down in this file at all.
 */
describe("FleetAside — what setup installs", () => {
  it("reads both pinned versions off the instance rather than a literal", () => {
    const text = said(answered("28.5.0", "3.6.7"));

    expect(text).toContain("28.5.0");
    expect(text).toContain("Traefik 3.6.7");
    // Declared only: nothing on this card claims to have looked at a machine.
    expect(text).toContain("not a reading off any machine");
  });

  it("keeps the whole card for a plain member, losing only the two numbers", () => {
    const text = said({
      data: undefined,
      error: new ApiError(
        403,
        "Only owners and admins can manage web server settings",
      ),
      isPending: false,
    } as unknown as RuntimeInfoQuery);

    // A refusal is not an empty card. The two rows with no version to show say
    // why, and the two that are names are untouched by the query.
    expect(text).toContain("Docker");
    expect(text).toContain("Traefik");
    expect(text).toContain("version needs owner or admin");
    expect(text).toContain("cloudgate-network");
    expect(text).toContain("/etc/cloudgate");
  });

  it("still names the ingress when nothing pins a version", () => {
    const text = said(answered(null, null));

    expect(text).toContain("no version pinned");
    expect(text).toContain("cloudgate-network");
  });

  it("renders the pin and not the platform host's own Docker, even when the two disagree", () => {
    // The stock install: `deploy/install.sh` installs the platform host's
    // Docker with no `--version`, while `server-setup.ts` pins a Server's — so
    // `docker.drift` is true on virtually every instance and says nothing about
    // what setup will do to a Server. This card must never grow the drift idiom
    // `IngressRow` uses.
    const text = said(answered("28.5.0", "3.6.7", { docker: "29.7.2" }));

    expect(text).toContain("28.5.0");
    expect(text).not.toContain("29.7.2");
    expect(text).not.toContain("declared");
  });
});

/**
 * The footer's last sentence sent a reader to a Server's Infrastructure
 * tab — a screen that only exists under a `[serverId]` route, and so does not
 * exist at all on an instance with no Server rows. That is the stock
 * single-host state, and it is exactly the state in which this card is the only
 * version surface the console has. Every test above renders `servers={[]}` and
 * none of them read the sentence.
 */
describe("FleetAside — where a reading off a real machine comes from", () => {
  it("sends a reader to a Server's Infrastructure tab only when a Server exists", () => {
    const text = said(answered("28.5.0", "3.6.7"), {
      servers: [],
      pending: false,
    });

    expect(text).toContain("once a Server is added");
    expect(text).not.toContain("checks what is really there");
  });

  it("points at the Infrastructure tab once there is a Server to open", () => {
    const text = said(answered("28.5.0", "3.6.7"), {
      servers: [aServer],
      pending: false,
    });

    expect(text).toContain("checks what is really there");
    expect(text).not.toContain("once a Server is added");
  });

  it("does not claim there are no Servers while the list is still loading", () => {
    // The F07 rule the tiles above follow, applied to copy instead of a figure:
    // an in-flight list is not an empty one.
    const text = said(answered("28.5.0", "3.6.7"), {
      servers: [],
      pending: true,
    });

    expect(text).toContain("checks what is really there");
    expect(text).not.toContain("once a Server is added");
  });
});
