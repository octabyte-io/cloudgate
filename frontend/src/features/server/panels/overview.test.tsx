import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { Server } from "@/lib/api/endpoints/servers";

const useSwarmServices = vi.hoisted(() => vi.fn());
const useServerAudit = vi.hoisted(() => vi.fn());

vi.mock("../docker/use-server-docker", async (original) => ({
  ...(await original<typeof import("../docker/use-server-docker")>()),
  useSwarmServices,
}));

vi.mock("../use-server", async (original) => ({
  ...(await original<typeof import("../use-server")>()),
  useServerAudit,
}));

const { ReadinessCard, RunningCard } = await import("./overview");

afterEach(() => {
  cleanup();
  useSwarmServices.mockReset();
  useServerAudit.mockReset();
});

/**
 * On a Server whose SSH port was closed, "Running here" explained the
 * missing count with the Swarm-manager sentence — about a machine no Docker
 * command ever reached — while the API had already answered `503
 * HOST_UNREACHABLE`. The Docker tab's card for the same query already had the
 * unreachable arm; this one now has it too.
 */
describe("RunningCard", () => {
  const server = {
    serverId: "srv-1",
    serverType: "deploy",
  } as unknown as Server;

  const notReached = new ApiError(503, "This Server could not be reached", {
    code: "HOST_UNREACHABLE",
  });

  it("says the Server was not reached rather than blaming the Swarm", () => {
    useSwarmServices.mockReturnValue({
      data: undefined,
      error: notReached,
      isPending: false,
    });

    render(<RunningCard server={server} />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("Cloudgate could not reach this Server");
    expect(text).toContain("Check now");
    expect(text).not.toContain("Swarm manager");
  });

  it("keeps the Swarm-manager sentence for any other failure", () => {
    useSwarmServices.mockReturnValue({
      data: undefined,
      error: new ApiError(500, "Internal server error"),
      isPending: false,
    });

    render(<RunningCard server={server} />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("works only on a Swarm manager");
    expect(text).not.toContain("Cloudgate could not reach this Server");
  });

  it("keeps the Swarm-manager sentence for a host that answered with nothing", () => {
    useSwarmServices.mockReturnValue({
      data: null,
      error: null,
      isPending: false,
    });

    render(<RunningCard server={server} />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("works only on a Swarm manager");
    expect(text).not.toContain("Cloudgate could not reach this Server");
  });
});

/**
 * The audit behind this card answered a bare 500 for every SSH failure,
 * and the card said "could not reach" whatever the failure was. It now answers
 * 503 `HOST_UNREACHABLE` for a host that was not reached and a 400 naming the
 * key for a key the host refused, and the card words each for what it is.
 */
describe("ReadinessCard", () => {
  const server = {
    serverId: "srv-1",
    sshKeyId: "key-1",
  } as unknown as Server;

  function auditFailing(error: ApiError) {
    useServerAudit.mockReturnValue({
      data: undefined,
      error,
      isPending: false,
    });
    render(<ReadinessCard server={server} />);
    return document.body.textContent ?? "";
  }

  it("says the Server was not reached for a 503 HOST_UNREACHABLE", () => {
    const text = auditFailing(
      new ApiError(503, "This Server could not be reached", {
        code: "HOST_UNREACHABLE",
      }),
    );
    // The shared block: the fact, what never ran, and the way to Check now.
    expect(text).toContain("Cloudgate could not reach this Server.");
    expect(text).toContain("The readiness script never ran");
    expect(text).toContain("Check now");
  });

  it("names the key, not the network, when the host refused it", () => {
    const text = auditFailing(
      new ApiError(
        400,
        'The SSH key "ui-paste" was not accepted by this Server. Add its public half to ~/.ssh/authorized_keys for root on the Server, or choose another key on the Access tab',
      ),
    );
    expect(text).toContain(
      'The SSH key "ui-paste" was not accepted by this Server',
    );
    expect(text).not.toContain("could not reach");
  });
});
