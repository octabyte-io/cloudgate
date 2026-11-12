import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApplicationDetail } from "@/lib/api/endpoints/applications";
import type { PanelProps } from "@/lib/shell/tab-registry";

const kind = vi.hoisted(() => ({ configKind: "web" }));

vi.mock("../use-application", () => ({
  useApplication: () => ({
    data: {
      applicationId: "app-1",
      environmentId: "env-1",
      configKind: kind.configKind,
      isPreviewDeploymentsActive: false,
      requestedPreviewsAllowed: false,
      previewLimit: 3,
      requestedPreviewLimit: 3,
    } as unknown as ApplicationDetail,
  }),
  useUpdateApplication: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../advanced/use-advanced", () => ({
  usePreviewDeployments: () => ({}),
  usePreviewMutations: () => ({}),
}));
// Each card has its own tests; this file is about whether they are offered.
vi.mock("./previews-settings-card", () => ({
  PreviewSettingsCard: () => <h2>Preview settings</h2>,
}));
vi.mock("./previews-list-card", () => ({ PreviewListCard: () => null }));
vi.mock("./requested-previews-card", () => ({
  RequestedPreviewsCard: () => null,
}));

const { default: Panel } = await import("./previews");

function renderPanel() {
  render(
    <Panel
      {...({ id: "app-1", label: "Previews", icon: "branch" } as PanelProps)}
    />,
  );
}

afterEach(cleanup);

/** A web-private has no previews, which its API refuses. */
describe("the Previews tab", () => {
  it("offers no preview switches on a web-private, and says why", () => {
    kind.configKind = "web-private";
    renderPanel();

    expect(
      screen.queryByRole("heading", { name: "Preview settings" }),
    ).toBeNull();
    expect(document.body.textContent).toContain(
      "A Private web service has no previews",
    );
  });

  it("offers no preview switches on a Cron service, and says why", () => {
    kind.configKind = "cron";
    renderPanel();

    expect(
      screen.queryByRole("heading", { name: "Preview settings" }),
    ).toBeNull();
    expect(document.body.textContent).toContain(
      "A Cron service has no previews",
    );
  });

  it("offers them on a web", () => {
    kind.configKind = "web";
    renderPanel();

    expect(
      screen.getByRole("heading", { name: "Preview settings" }),
    ).toBeTruthy();
  });
});
