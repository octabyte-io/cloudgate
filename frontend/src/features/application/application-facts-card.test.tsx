import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ApplicationDetail,
  ApplicationStatus,
} from "@/lib/api/endpoints/applications";

import {
  ApplicationFactsCard,
  DeployTargetCard,
} from "./application-facts-card";

afterEach(cleanup);

function row(applicationStatus: ApplicationStatus, replicas = 1) {
  return {
    applicationId: "app-1",
    name: "storefront",
    appName: "storefront-a1b2c3",
    description: null,
    applicationStatus,
    replicas,
    createdAt: "2026-09-17T10:00:00.000Z",
    environmentId: "env-1",
    serverId: null,
    server: null,
    buildServer: null,
    environment: {
      environmentId: "env-1",
      name: "staging",
      project: { projectId: "prj-1", name: "shop" },
    },
  } as unknown as ApplicationDetail;
}

/** The card's text, with the whitespace the JSX fragments introduce collapsed. */
function read(applicationStatus: ApplicationStatus, replicas?: number) {
  const { container } = render(
    <ApplicationFactsCard application={row(applicationStatus, replicas)} />,
  );
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

/**
 * What the Application card says about an Application that is not running
 * — the `DatabaseFactsCard` reading, one module over.
 *
 * **What broke.** Stop scaled the Swarm service to 0 and wrote `idle`, the
 * column's own default, so this card described a stopped Application and one
 * never deployed with the same two facts: `Status ○ idle` and `Replicas 1`.
 * The status was the value the row was created with, and `replicas` is the
 * *configured* count that becomes `Mode.Replicated.Replicas`, which a Stop
 * does not touch — so an operator who had just pressed Stop was shown a card
 * claiming one replica. Both halves are pinned, because a change that narrowed
 * `stopped` back to `idle` and one that restored the bare count are different
 * mistakes with the same symptom.
 */
describe("ApplicationFactsCard", () => {
  describe("a stopped Application", () => {
    it("names the state in a word a never-deployed Application cannot wear", () => {
      const stopped = read("stopped");
      const neverDeployed = read("idle");

      expect(stopped).toContain("stopped");
      expect(neverDeployed).toContain("idle");
      expect(neverDeployed).not.toContain("stopped");
    });

    it("does not claim a running replica", () => {
      expect(read("stopped")).toContain("0 of 1 running");
      expect(read("stopped", 3)).toContain("0 of 3 running");
    });
  });

  describe("an Application that is not stopped", () => {
    it("says the replica count is the configured one, not a live reading", () => {
      expect(read("done")).toContain("1 configured");
      expect(read("idle", 2)).toContain("2 configured");
      expect(read("done")).not.toContain("running");
    });
  });
});

/**
 * **No deploy webhook**. The card used to read `Deploy webhook · Set ·
 * Rotate`, and Rotate's dialog called the secret "the part of the deploy
 * webhook URL" and said it could be "read here again". No screen showed a URL
 * and no route accepted one — `application.refreshToken` is minted and never
 * checked — so the row, its control and its dialog advertised a trigger that
 * does not exist.
 */
describe("DeployTargetCard", () => {
  it("offers no deploy webhook and nothing to rotate", () => {
    const { container } = render(
      <DeployTargetCard
        application={
          { ...row("done"), refreshToken: "tok-1" } as ApplicationDetail
        }
      />,
    );
    const text = container.textContent ?? "";

    expect(text).not.toMatch(/webhook/i);
    expect(text).not.toContain("Rotate");
    expect(container.querySelector("button")).toBeNull();
  });
});

/** Where the other Services on its Server reach a web-private. */
describe("ApplicationFactsCard, internal address", () => {
  it("shows a web-private's internal address, with a copy control", () => {
    const { container, getByRole } = render(
      <ApplicationFactsCard
        application={{
          ...row("done"),
          internalAddress: "http://storefront-a1b2c3:4000",
        }}
      />,
    );

    expect(container.textContent).toContain("Internal address");
    expect(container.textContent).toContain("http://storefront-a1b2c3:4000");
    expect(getByRole("button", { name: /internal address/i })).toBeTruthy();
  });

  it("shows none on any other kind", () => {
    const { container } = render(
      <ApplicationFactsCard
        application={{ ...row("done"), internalAddress: null }}
      />,
    );

    expect(container.textContent).not.toContain("Internal address");
  });
});

/** A Service in a Cloud account runs there and builds on the platform host. */
describe("DeployTargetCard, a cloud Service", () => {
  it("names its Cloud account and region, and no Server", () => {
    const { container } = render(
      <DeployTargetCard
        application={{
          ...row("done"),
          cloudPlace: {
            cloudAccountId: "ca-1",
            cloudAccountName: "Production AWS",
            region: "eu-central-1",
          },
        }}
      />,
    );
    const text = (container.textContent ?? "").replace(/\s+/g, " ");

    expect(text).toContain("Production AWS");
    expect(text).toContain("eu-central-1");
    expect(text).toContain("Cloudgate's own host");
    expect(text).not.toContain("Traefik");
  });
});
