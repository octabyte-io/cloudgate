import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApplicationDetail } from "@/lib/api/endpoints/applications";
import type { Deployment } from "@/lib/api/endpoints/deployments";

/** The Deployments the list query answers. Set per case, moved between renders. */
let rows: Deployment[] = [];

vi.mock("../use-application", () => ({
  useApplication: () => ({
    data: {
      applicationId: "app-1",
      environmentId: "env-1",
      environment: { projectId: "proj-1" },
      sourceType: "git",
    } as unknown as ApplicationDetail,
    error: null,
  }),
  useApplicationDeployments: () => ({ data: rows, isPending: false, error: null }),
}));

// The log is `DeploymentLog`'s business and has its own test; what this screen
// decides is *which* Deployment it is handed, and whether the card is there.
vi.mock("../deploy/deployment-log", () => ({
  DeploymentLog: ({ deployment }: { deployment: Deployment }) => (
    <p>showing {deployment.deploymentId}</p>
  ),
}));
vi.mock("../deploy/deployment-modal", () => ({ DeploymentModal: () => null }));
vi.mock("../deploy/phases-card", () => ({ PhasesCard: () => null }));
vi.mock("../lifecycle/cancel-build-button", () => ({ CancelBuildButton: () => null }));
vi.mock("../lifecycle/stop-run-button", () => ({ StopRunButton: () => null }));
vi.mock("@/components/console/rows/deployment-row", () => ({
  DeploymentTable: () => null,
}));

// Deploy, reduced to what it hands the panel: the row the POST answered.
vi.mock("../deploy/deploy-button", async (original) => ({
  ...(await original<typeof import("../deploy/deploy-button")>()),
  DeployButton: ({
    onDeployed,
  }: {
    onDeployed: (deployment: Deployment) => void;
  }) => (
    <button type="button" onClick={() => onDeployed(deployment("D", "pending"))}>
      Deploy
    </button>
  ),
}));

const { default: Panel } = await import("./deployments");

afterEach(cleanup);

function deployment(id: string, status: Deployment["status"], minute = 0) {
  return {
    deploymentId: id,
    status,
    title: `Deploy ${id}`,
    createdAt: `2026-09-18T10:0${minute}:00.000Z`,
  } as Deployment;
}

// A fresh element per render: React skips re-rendering an identical one, and the
// list query's answer is what moves between renders.
const panel = () => (
  <Panel id="app-1" kind={null} label="Deployments" icon="rocket" />
);
const followNewest = () =>
  screen.queryByRole("button", { name: "Follow the newest instead" });

/**
 * The Application Deployments tab's half of the
 * stale-offer fix. Here the offer
 * rendered whenever a Deployment had been started from this tab — while it was
 * itself the one running, and after it finished, when pressing it left nothing
 * to show and removed the output card.
 */
describe("Application Deployments — Follow the newest instead", () => {
  it("is absent while the Deployment just started is the one running, and once it finishes", () => {
    rows = [deployment("D", "running")];
    const view = render(panel());
    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));
    expect(screen.getByText("showing D")).toBeTruthy();
    expect(followNewest()).toBeNull();

    rows = [deployment("D", "done")];
    view.rerender(panel());
    expect(screen.getByText("showing D")).toBeTruthy();
    expect(followNewest()).toBeNull();
  });

  it("is absent when a second Deployment has also finished, since there is nothing running to follow", () => {
    rows = [deployment("D", "running")];
    const view = render(panel());
    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));

    rows = [deployment("D", "done"), deployment("E", "done", 1)];
    view.rerender(panel());
    expect(screen.getByText("showing D")).toBeTruthy();
    expect(followNewest()).toBeNull();
  });

  it("is offered while a newer Deployment is running, and pressing it follows that one", () => {
    rows = [deployment("D", "running")];
    const view = render(panel());
    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));

    rows = [deployment("D", "done"), deployment("E", "running", 1)];
    view.rerender(panel());
    expect(screen.getByText("showing D")).toBeTruthy();

    act(() => followNewest()!.click());

    expect(screen.getByText("showing E")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Build output" })).toBeTruthy();
    expect(followNewest()).toBeNull();
  });
});
