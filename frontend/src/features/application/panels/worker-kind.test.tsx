import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ApplicationConfigKind,
  ApplicationDetail,
} from "@/lib/api/endpoints/applications";

/** The kind of the Application this render is about. Set per case. */
let configKind: ApplicationConfigKind = "worker";

vi.mock("../use-application", () => ({
  useApplication: () => ({
    data: {
      applicationId: "app_1",
      appName: "jobs",
      configKind,
      // Only a web-private has one.
      internalAddress: null,
      serverId: null,
      server: null,
      environment: { project: { projectId: "proj_1" } },
      isPreviewDeploymentsActive: false,
      requestedPreviewsAllowed: false,
      previewLimit: 3,
      requestedPreviewLimit: 3,
    } as unknown as ApplicationDetail,
  }),
  useUpdateApplication: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

// The cards a web shows are their own tests' business; here, only whether
// the panel offers them at all.
vi.mock("../domains/domains-card", () => ({
  DomainsCard: () => <p>Domains card</p>,
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
vi.mock("../advanced/use-advanced", () => ({
  usePreviewDeployments: () => ({ data: [], isPending: false, error: null }),
  usePreviewMutations: () => ({}),
}));
vi.mock("./previews-settings-card", () => ({
  PreviewSettingsCard: () => <p>Preview settings card</p>,
}));
vi.mock("./previews-list-card", () => ({ PreviewListCard: () => null }));
vi.mock("./requested-previews-card", () => ({
  RequestedPreviewsCard: () => null,
}));

const { default: DomainsPanel } = await import("./domains");
const { default: PreviewsPanel } = await import("./previews");

/**
 * A Worker serves no HTTP: its Domains and Previews tabs offer no way
 * to add a Domain or turn on a preview, and say why, pointing to the Project
 * config where the kind is changed (`config-kind.ts`). A
 * web's are unchanged.
 */

afterEach(cleanup);

describe("a worker's Domains and Previews tabs", () => {
  it("offers no Domain, and says why, pointing to the Project config", () => {
    configKind = "worker";
    render(
      <DomainsPanel id="app_1" kind={null} label="Domains" icon="globe" />,
    );

    expect(document.body.textContent).toContain(
      "A worker takes no Domain: it serves no HTTP. To serve HTTP, change its kind to web in the Project config.",
    );
    expect(
      screen
        .getByRole("button", { name: /Add a domain/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.queryByText("Domains card")).toBeNull();
  });

  it("offers no preview switch, and says why", () => {
    configKind = "worker";
    render(
      <PreviewsPanel id="app_1" kind={null} label="Previews" icon="branch" />,
    );

    expect(document.body.textContent).toContain(
      "A worker has no previews: a preview is reached at its own Domain, and a worker serves no HTTP. To serve HTTP, change its kind to web in the Project config.",
    );
    expect(screen.queryByText("Preview settings card")).toBeNull();
  });

  it("leaves a web's tabs as they are", () => {
    configKind = "web";
    render(
      <DomainsPanel id="app_1" kind={null} label="Domains" icon="globe" />,
    );
    expect(
      screen
        .getByRole("button", { name: /Add a domain/ })
        .getAttribute("aria-disabled"),
    ).not.toBe("true");
    expect(screen.getByText("Domains card")).toBeTruthy();
    cleanup();

    render(
      <PreviewsPanel id="app_1" kind={null} label="Previews" icon="branch" />,
    );
    expect(screen.getByText("Preview settings card")).toBeTruthy();
    expect(screen.queryByText(/takes no|has no previews/)).toBeNull();
  });
});
