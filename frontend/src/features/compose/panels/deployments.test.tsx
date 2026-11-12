import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComposeDetail } from "@/lib/api/endpoints/compose";
import type { Deployment } from "@/lib/api/endpoints/deployments";

/** The Deployments the list query answers. Set per case, moved between renders. */
let rows: Deployment[] = [];

vi.mock("../use-compose", () => ({
  useCompose: () => ({
    data: {
      composeId: "cmp-1",
      environmentId: "env-1",
      name: "ui-compose",
      composeType: "docker-compose",
      sourceType: "raw",
    } as unknown as ComposeDetail,
    error: null,
  }),
  useComposeDeployments: () => ({ data: rows, isPending: false, error: null }),
}));

// The log is `DeploymentLog`'s business and has its own test; what this screen
// decides is *which* Deployment it is handed, and whether the card is there.
vi.mock("@/features/application/deploy/deployment-log", () => ({
  DeploymentLog: ({ deployment }: { deployment: Deployment }) => (
    <p>showing {deployment.deploymentId}</p>
  ),
}));
vi.mock("@/features/application/deploy/deployment-modal", () => ({
  DeploymentModal: () => null,
}));
vi.mock("@/components/console/rows/deployment-row", () => ({
  DeploymentTable: () => null,
}));
vi.mock("../compose-facts-card", () => ({ ComposeFactsCard: () => null }));

// Deploy, reduced to what it hands the panel: the row the POST answered.
vi.mock("../lifecycle/compose-actions", () => ({
  ComposeActions: ({
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
  <Panel id="cmp-1" kind={null} label="Deployments" icon="rocket" />
);
const followNewest = () =>
  screen.queryByRole("button", { name: "Follow the newest instead" });

/**
 * The Compose half of the stale-offer fix
 * (U-run U-119). The offer grew on every finished deploy, because it was compared
 * against the newest *live* Deployment and that is `null` once nothing runs — and
 * pressing it then left nothing to show, so the output card went with it.
 */
describe("Compose Deployments — Follow the newest instead", () => {
  it("is absent once the Deployment just started finishes, and its output stays", () => {
    rows = [deployment("D", "running")];
    const view = render(panel());
    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));
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
    expect(
      screen.getByRole("heading", { name: "Deployment output" }),
    ).toBeTruthy();
    expect(followNewest()).toBeNull();
  });
});
