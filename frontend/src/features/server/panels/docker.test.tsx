import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { Server } from "@/lib/api/endpoints/servers";

import type { RuntimeInfoQuery } from "../runtime-info";

const useServerAudit = vi.hoisted(() => vi.fn());
const useRuntimeInfo = vi.hoisted(() => vi.fn());
const useSwarmServices = vi.hoisted(() => vi.fn());

vi.mock("../use-server", async (original) => ({
  ...(await original<typeof import("../use-server")>()),
  useServerAudit,
}));
vi.mock("../runtime-info", async (original) => ({
  ...(await original<typeof import("../runtime-info")>()),
  useRuntimeInfo,
}));
vi.mock("../docker/use-server-docker", async (original) => ({
  ...(await original<typeof import("../docker/use-server-docker")>()),
  useSwarmServices,
}));

const { DockerAside, SwarmServicesCard } = await import("./docker");

afterEach(() => {
  cleanup();
  useServerAudit.mockReset();
  useRuntimeInfo.mockReset();
  useSwarmServices.mockReset();
});

function server(sshKeyId: string | null): Server {
  return { serverId: "srv-1", sshKeyId, command: "" } as unknown as Server;
}

/** `useServerAudit` is disabled without a key, and a disabled query never settles. */
const neverSettles = { data: undefined, error: null, isPending: true };

const traefikAnswered = {
  data: {
    traefik: { declared: "3.6.7", observed: "3.6.7", drift: false },
  },
  error: null,
  isPending: false,
} as unknown as RuntimeInfoQuery;

/**
 * The Ingress row does not read the audit, so it must not wait for it.
 *
 * A Server with no SSH key leaves `useServerAudit` disabled, and TanStack reports
 * a disabled query as pending **forever** — so while this row lived inside the
 * audit's pending branch it was never reached on such a Server, and the paragraph
 * under the card went on describing a row that was not there. The criterion is
 * that the row shows the observed version, and a key is not what it reads.
 */
describe("the Ingress row is not gated on the audit", () => {
  it("renders the observed version on a Server whose audit never settles", () => {
    useServerAudit.mockReturnValue(neverSettles);
    useRuntimeInfo.mockReturnValue(traefikAnswered);

    render(<DockerAside server={server(null)} />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("Ingress");
    expect(text).toContain("3.6.7");
  });

  /**
   * Found in a browser, not by a test: a keyless Server held two grey bars
   * forever, because `useServerAudit` is disabled without a key and a disabled
   * query never leaves `isPending`. The Infrastructure tab already said why in
   * the same situation; this card said nothing, and the Ingress row — which
   * renders regardless — put a live value beside the permanent skeleton, which
   * made the silence read as breakage.
   */
  it("says why the audit rows are absent when the Server has no key", () => {
    useServerAudit.mockReturnValue(neverSettles);
    useRuntimeInfo.mockReturnValue(traefikAnswered);

    render(<DockerAside server={server(null)} />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("There is no SSH key on this Server");
    expect(text).toContain("Access tab");
    // The explanation replaces the skeleton rather than joining it.
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("still shows the audit's own rows once the audit answers", () => {
    useServerAudit.mockReturnValue({
      data: {
        docker: { enabled: true, version: "28.5.0" },
        isSwarmActive: true,
        isNetworkInstalled: true,
      },
      error: null,
      isPending: false,
    });
    useRuntimeInfo.mockReturnValue(traefikAnswered);

    render(<DockerAside server={server("key-1")} />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("28.5.0");
    expect(text).toContain("Ingress");
  });
});

/**
 * X11-4. `GET /swarm/apps` answered `200 []` for a Server the SSH connection never
 * reached, and this card read that as an empty Swarm — so the two sentences below
 * were both said about a machine nothing had spoken to: *"No Swarm services are
 * running here"*, and (once the route began answering nothing at all) the
 * manager-only diagnosis written for a worker.
 */
describe("SwarmServicesCard", () => {
  const swarmServer = { serverId: "srv-1", name: "vps-a" } as unknown as Server;

  const notReached = new ApiError(503, "This Server could not be reached", {
    code: "HOST_UNREACHABLE",
  });

  it("says the Server was not reached rather than that its Swarm is empty", () => {
    useSwarmServices.mockReturnValue({
      data: undefined,
      error: notReached,
      isPending: false,
    });

    render(<SwarmServicesCard server={swarmServer} />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("Cloudgate could not reach this Server");
    expect(text).not.toContain("No Swarm services are running here");
    expect(text).not.toContain("works only on a manager");
  });

  it("keeps the manager-only sentence for a host that answered on stderr", () => {
    useSwarmServices.mockReturnValue({
      data: null,
      error: null,
      isPending: false,
    });

    render(<SwarmServicesCard server={swarmServer} />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("works only on a manager");
    expect(text).not.toContain("Cloudgate could not reach this Server");
  });

  it("says the Swarm is empty when Docker answered with no services", () => {
    useSwarmServices.mockReturnValue({
      data: [],
      error: null,
      isPending: false,
    });

    render(<SwarmServicesCard server={swarmServer} />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("No Swarm services are running here");
  });

  it("has the Refresh its two neighbours on the tab have", () => {
    const refetch = vi.fn();
    useSwarmServices.mockReturnValue({
      data: [],
      error: null,
      isPending: false,
      isFetching: false,
      refetch,
    });

    render(<SwarmServicesCard server={swarmServer} />);

    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
