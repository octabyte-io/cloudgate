import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ComposeDetail } from "@/lib/api/endpoints/compose";

const mode = vi.hoisted(() => ({
  data: "self-hosted" as "hosted" | "self-hosted",
}));
vi.mock("@/lib/api/use-instance-mode", () => ({ useInstanceMode: () => mode }));

const { ComposeFactsCard } = await import("./compose-facts-card");

beforeEach(() => {
  mode.data = "self-hosted";
});

afterEach(cleanup);

/** A raw stack on This Cloudgate host: no Server, no Cloud account. */
function stack(): ComposeDetail {
  return {
    composeId: "cmp_1",
    name: "wiki",
    appName: "compose-wiki-x1",
    configName: "wiki",
    environmentId: "env_1",
    composeStatus: "done",
    composeType: "docker-compose",
    sourceType: "raw",
    composePath: "./docker-compose.yml",
    isolatedDeployment: false,
    createdAt: "2026-11-10T10:00:00.000Z",
    serverId: null,
    server: null,
    environment: {
      environmentId: "env_1",
      name: "production",
      project: { projectId: "prj_1", name: "Shop" },
    },
    cloudAccountId: null,
    region: null,
    stackVmFacts: null,
  } as unknown as ComposeDetail;
}

/** Whether the card shows the Same-machine warning (spec #146). */
function warns(compose: ComposeDetail): boolean {
  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <ComposeFactsCard compose={compose} />
    </QueryClientProvider>,
  );
  return /Cloudgate itself runs on this machine/.test(
    container.textContent ?? "",
  );
}

/**
 * The Same-machine warning (#148): a stack already on This Cloudgate host
 * says so on its facts card, so a setup from before the warning sees it
 * too.
 */
describe("ComposeFactsCard's Same-machine warning", () => {
  it("warns for a stack on This Cloudgate host", () => {
    expect(warns(stack())).toBe(true);
  });

  it("does not warn for a stack on a Server", () => {
    expect(
      warns({
        ...stack(),
        serverId: "srv_1",
        server: { serverId: "srv_1", name: "worker-1" },
      } as unknown as ComposeDetail),
    ).toBe(false);
  });

  it("does not warn for a stack on its Stack VM in a Cloud account", () => {
    expect(
      warns({ ...stack(), cloudAccountId: "ca_1", region: "eu-west-1" }),
    ).toBe(false);
  });

  it("never warns on the Hosted instance", () => {
    mode.data = "hosted";

    expect(warns(stack())).toBe(false);
  });
});
