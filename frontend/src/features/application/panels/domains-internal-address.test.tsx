import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApplicationDetail } from "@/lib/api/endpoints/applications";

/** Where the Application this render is about runs. Set per case. */
let cloudPlace: { cloud: "aws" | "gcp" } | null = null;
/** The row's kind and internal address. Set per case. */
let configKind = "web";
let internalAddress: string | null = null;

vi.mock("../use-application", () => ({
  useApplication: () => ({
    data: {
      applicationId: "app_1",
      appName: "app-dk2ihg",
      configKind,
      internalAddress,
      serverId: null,
      server: null,
      cloudPlace,
      environment: { project: { projectId: "proj_1" } },
    } as unknown as ApplicationDetail,
  }),
  useUpdateApplication: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

// The Domains cards are their own tests' business; here, only the aside.
vi.mock("../domains/domains-card", () => ({
  DomainsCard: () => <p>Domains card</p>,
}));
vi.mock("../domains/cloud-domains-card", () => ({
  CloudDomainsCard: () => <p>Cloud Domains card</p>,
}));
vi.mock("../domains/cloud-domain-modals", () => ({
  CloudDomainFormModal: () => null,
  CloudRemoveDomainModal: () => null,
}));
vi.mock("../domains/domain-form-modal", () => ({
  DomainFormModal: () => null,
}));
vi.mock("../domains/delete-domain-modal", () => ({
  DeleteDomainModal: () => null,
}));
vi.mock("../domains/use-domains", () => ({
  useApplicationDomains: () => ({ data: [], isPending: false, error: null }),
  useCreateDomain: () => ({ mutateAsync: vi.fn() }),
  useUpdateDomain: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../traefik-status/use-config-status", () => ({
  useTraefikConfigStatus: () => ({ data: undefined }),
}));

const { default: DomainsPanel } = await import("./domains");

/**
 * The Domains tab's "Internal address" card names the Swarm overlay a
 * Service on a Server joins. A Service in a Cloud account joins none, so the
 * card is not shown there (the live walk on Cloud Run).
 */

afterEach(cleanup);

describe("the Domains tab's Internal address card", () => {
  afterEach(() => {
    configKind = "web";
    internalAddress = null;
  });

  it("shows the overlay host for a Service on a Server", () => {
    cloudPlace = null;
    render(
      <DomainsPanel id="app_1" kind={null} label="Domains" icon="globe" />,
    );

    expect(screen.getByText("Internal address")).toBeTruthy();
    expect(document.body.textContent).toContain("cloudgate-network");
  });

  it.each(["gcp", "aws"] as const)(
    "is not shown for a Service in a Cloud account (%s), which joins no overlay",
    (cloud) => {
      cloudPlace = { cloud };
      render(
        <DomainsPanel id="app_1" kind={null} label="Domains" icon="globe" />,
      );

      expect(screen.getByText("Cloud Domains card")).toBeTruthy();
      expect(screen.queryByText("Internal address")).toBeNull();
      expect(document.body.textContent).not.toContain("cloudgate-network");
    },
  );

  it("shows a Private web service's private DNS address on AWS, reached from its Environment network", () => {
    cloudPlace = { cloud: "aws" };
    configKind = "web-private";
    internalAddress = "http://inside.cloudgate.internal:4000";
    render(
      <DomainsPanel id="app_1" kind={null} label="Domains" icon="globe" />,
    );

    expect(screen.getByText("Internal address")).toBeTruthy();
    const text = document.body.textContent ?? "";
    expect(text).toContain("http://inside.cloudgate.internal:4000");
    expect(text).toContain("The Services of this Environment");
    expect(text).toContain("healthy tasks");
    expect(text).not.toContain("cloudgate-network");
  });

  it("shows a Private web service's run.app URL on Google Cloud, and that a new one answers 404 from inside for a few minutes", () => {
    cloudPlace = { cloud: "gcp" };
    configKind = "web-private";
    internalAddress =
      "https://cloudgate-tfeyly54xiuh-123456789012.europe-west1.run.app";
    render(
      <DomainsPanel id="app_1" kind={null} label="Domains" icon="globe" />,
    );

    expect(screen.getByText("Internal address")).toBeTruthy();
    const text = document.body.textContent ?? "";
    expect(text).toContain(
      "https://cloudgate-tfeyly54xiuh-123456789012.europe-west1.run.app",
    );
    expect(text).toContain("The Services of this Environment");
    expect(text).toContain("404");
    expect(text).not.toContain("healthy tasks");
    expect(text).not.toContain("cloudgate-network");
  });
});
