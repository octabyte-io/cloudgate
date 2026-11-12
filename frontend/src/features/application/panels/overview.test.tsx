import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApplicationDetail } from "@/lib/api/endpoints/applications";
import type { Deployment } from "@/lib/api/endpoints/deployments";

/** The Deployments the list query answers. Set per case, moved between renders. */
let rows: Deployment[] = [];
/** The Application's own status, which is what draws the failure banner. */
let status: ApplicationDetail["applicationStatus"] = "done";
/** What the service's task read found running — `null` when it could not say. */
let running: number | null = null;
const runningAsked = vi.fn();
/** What the GPU-wait read answered — `null` when not waiting. */
let gpuWait: { free: number; cards: number } | null = null;
/** A Cron service's read; `null` for any other Application. */
let cronService: { waitingForFirstBuild: boolean } | null = null;
/** Where the code comes from: a repository unless a case says so. */
let source: Partial<ApplicationDetail> = {
  sourceType: "github",
  repository: "acme/hello",
};

vi.mock("../use-application", () => ({
  useApplication: () => ({
    data: {
      applicationId: "app-1",
      name: "hello",
      appName: "hello-a1b2c3",
      description: null,
      applicationStatus: status,
      environmentId: "env-1",
      serverId: null,
      cronService,
      ...source,
      environment: { name: "production", project: { name: "web" } },
    } as unknown as ApplicationDetail,
    error: null,
  }),
  useApplicationDeployments: () => ({ data: rows, isPending: false }),
  useUpdateApplication: () => ({ mutateAsync: vi.fn() }),
  useGpuWait: () => gpuWait,
  useRunningTasks: (...args: unknown[]) => {
    runningAsked(...args);
    return running;
  },
}));

// The log is `DeploymentLog`'s business and has its own test; what this screen
// decides is *which* Deployment it is handed.
vi.mock("../deploy/deployment-log", () => ({
  DeploymentLog: ({ deployment }: { deployment: Deployment }) => (
    <p>showing {deployment.deploymentId}</p>
  ),
}));

// Deploy, reduced to what it hands the panel: the row the POST answered.
// `hasBuilt` is carried out as an attribute: which controls it unlocks is
// `application-actions.test.tsx`'s to assert, and what it is computed from is
// this screen's.
vi.mock("../lifecycle/application-actions", () => ({
  ApplicationActions: ({
    onDeployed,
    hasBuilt,
  }: {
    onDeployed: (deployment: Deployment) => void;
    hasBuilt: boolean;
  }) => (
    <button
      type="button"
      data-has-built={String(hasBuilt)}
      onClick={() => onDeployed(deployment("D", "pending"))}
    >
      Deploy
    </button>
  ),
}));

vi.mock("../deploy/deploy-button", async (original) => ({
  ...(await original<typeof import("../deploy/deploy-button")>()),
  DeployButton: () => <button type="button">Deploy from the empty state</button>,
}));
vi.mock("../lifecycle/redeploy-button", () => ({ RedeployButton: () => null }));
vi.mock("../lifecycle/cancel-build-button", () => ({ CancelBuildButton: () => null }));
vi.mock("../lifecycle/stop-run-button", () => ({ StopRunButton: () => null }));
vi.mock("../application-facts-card", () => ({
  ApplicationFactsCard: () => null,
  DeployTargetCard: () => null,
}));
vi.mock("../domains/domains-aside", () => ({ DomainsAside: () => null }));
vi.mock("../source/source-card", () => ({ SourceCard: () => null }));
vi.mock("../source/build-card", () => ({ BuildCard: () => null }));
vi.mock("../cloud-resources-card", () => ({ CloudResourcesCard: () => null }));
vi.mock("../cron/cron-timetable-card", () => ({ CronTimetableCard: () => null }));
vi.mock("../cron/run-now-button", () => ({ RunNowButton: () => null }));

const { default: Panel } = await import("./overview");

afterEach(() => {
  cleanup();
  rows = [];
  status = "done";
  running = null;
  gpuWait = null;
  cronService = null;
  source = { sourceType: "github", repository: "acme/hello" };
  runningAsked.mockReset();
});

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
const panel = () => <Panel id="app-1" kind={null} label="Overview" icon="rocket" />;
const showNewest = () => screen.queryByRole("button", { name: "Show the newest" });

/**
 * "Show the newest" is offered only while it would show something else
 * It used to grow
 * on every finished deploy started here, over the newest Deployment, and pressing
 * it re-showed the same one.
 */
describe("Application Overview — Show the newest", () => {
  it("is absent once the Deployment just started finishes and nothing newer exists", () => {
    rows = [];
    const view = render(panel());
    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));

    rows = [deployment("D", "running")];
    view.rerender(panel());
    expect(screen.getByText("showing D")).toBeTruthy();
    expect(showNewest()).toBeNull();

    rows = [deployment("D", "done")];
    view.rerender(panel());
    expect(screen.getByText("showing D")).toBeTruthy();
    expect(showNewest()).toBeNull();
  });

  it("is offered while a newer Deployment exists, and pressing it shows that one", () => {
    rows = [deployment("D", "running")];
    const view = render(panel());
    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));

    rows = [deployment("D", "done"), deployment("E", "done", 1)];
    view.rerender(panel());
    expect(screen.getByText("showing D")).toBeTruthy();

    act(() => showNewest()!.click());

    expect(screen.getByText("showing E")).toBeTruthy();
    expect(showNewest()).toBeNull();
  });
});

/**
 * The failure banner says whether anything is serving, and only what it knows.
 *
 * It said "The previous Deployment is still serving traffic" for every `error`,
 * including an Application whose first Deployment had just failed — nothing had
 * ever run — and one Swarm had rolled back to a spec no node could schedule,
 * where the service was 0/1 and the domain answered 502.
 */
describe("Application Overview — the failed-Deployment banner", () => {
  const banner = () =>
    document.querySelector("[data-slot=banner]")?.textContent ?? "";

  it("does not claim a previous Deployment is serving when none was ever done", () => {
    status = "error";
    rows = [deployment("A", "error")];
    render(panel());

    expect(banner()).not.toContain("still serving traffic");
    expect(banner()).toContain("This Application has never run.");
  });

  it("keeps the previous-Deployment copy when an earlier one is done", () => {
    status = "error";
    rows = [deployment("A", "done"), deployment("B", "error", 1)];
    running = 1;
    render(panel());

    expect(banner()).toContain("The previous Deployment is still serving traffic.");
  });

  it("keeps it when an earlier one is done and the task read cannot say", () => {
    status = "error";
    rows = [deployment("A", "done"), deployment("B", "error", 1)];
    running = null;
    render(panel());

    expect(banner()).toContain("The previous Deployment is still serving traffic.");
  });

  it("says nothing is serving when an earlier one is done but no task is running", () => {
    status = "error";
    rows = [deployment("A", "done"), deployment("B", "error", 1)];
    running = 0;
    render(panel());

    expect(banner()).not.toContain("still serving traffic");
    expect(banner()).toContain("Nothing is serving traffic.");
  });

  it("does not call a running task a previous Deployment when none was ever done", () => {
    // A first Deployment whose container started and then failed its health
    // check: the task is up, but it is the failed release, and there is no
    // previous one for it to be.
    status = "error";
    rows = [deployment("B", "error", 1)];
    running = 1;
    render(panel());

    expect(banner()).not.toContain("previous");
    expect(banner()).not.toContain("swapped in");
    expect(banner()).toContain(
      "No Deployment of this Application has succeeded yet.",
    );
  });

  it("speaks of a Cron service's runs, not of serving traffic, and reads no tasks", () => {
    status = "error";
    cronService = { waitingForFirstBuild: false };
    rows = [deployment("A", "done"), deployment("B", "error", 1)];
    render(panel());

    expect(banner()).not.toContain("serving traffic");
    expect(banner()).toContain(
      "Its runs still start from the last build that succeeded.",
    );
    expect(runningAsked).toHaveBeenLastCalledWith(expect.anything(), false);
  });

  it("says a Cron service with no successful build is waiting for its first", () => {
    status = "error";
    cronService = { waitingForFirstBuild: true };
    rows = [deployment("B", "error", 1)];
    render(panel());

    expect(banner()).toContain(
      "This Cron service is waiting for its first build.",
    );
    expect(banner()).not.toContain("never run");
  });

  it("asks for the tasks only while the banner is up", () => {
    status = "done";
    rows = [deployment("A", "done")];
    render(panel());

    expect(banner()).toBe("");
    expect(runningAsked).toHaveBeenLastCalledWith(
      expect.objectContaining({ appName: "hello-a1b2c3" }),
      false,
    );
  });
});

/**
 * Restart and Stop wait for a Deployment that released
 * The gate was
 * "any Deployment", and a failed one is a row — so an Application whose only
 * build had failed was offered two buttons that could only answer "service not
 * found".
 */
describe("Application Overview — the lifecycle controls", () => {
  const hasBuilt = () =>
    screen.getByRole("button", { name: "Deploy" }).dataset.hasBuilt;

  it("counts no Deployment as built while none is done", () => {
    status = "error";
    rows = [deployment("A", "error"), deployment("B", "running", 1)];
    render(panel());

    expect(hasBuilt()).toBe("false");
  });

  it("counts the Application as built once any Deployment is done", () => {
    status = "error";
    rows = [deployment("A", "done"), deployment("B", "error", 1)];
    render(panel());

    expect(hasBuilt()).toBe("true");
  });
});

/**
 * An Application waiting for a GPU outside a deploy says so, with its
 * Server's free and total cards; one that is not waiting says nothing.
 */
describe("Application Overview — waiting for a GPU", () => {
  it("says it is waiting for a GPU, with the Server's free and total cards", () => {
    gpuWait = { free: 0, cards: 2 };
    render(panel());
    expect(
      screen.getByText("Waiting for a GPU: this Server has 0 free of 2"),
    ).toBeTruthy();
    expect(screen.getByText("Needs attention:")).toBeTruthy();
  });

  it("says nothing of a GPU when the read is not waiting", () => {
    render(panel());
    expect(screen.queryByText(/Waiting for a GPU/)).toBeNull();
  });
});

/**
 * The output card speaks of the source it has. An image is deployed and
 * never built, and with no source the next step is choosing one — Deploy would
 * only be refused.
 */
describe("Application Overview — before the first Deployment", () => {
  const card = () => screen.getByRole("heading", { level: 2, name: /output/ });

  it("asks for a source, and offers no Deploy, while none is chosen", () => {
    source = { sourceType: "github", repository: null };
    render(panel());

    expect(screen.getByText("No source is chosen yet")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Deploy from the empty state" }),
    ).toBeNull();
  });

  it("speaks of deploying an image, not building it, once one is set", () => {
    source = { sourceType: "docker", dockerImage: "nginx:1.27" };
    render(panel());

    expect(card().textContent).toBe("Last Deployment output");
    expect(screen.getByText("Nothing has been deployed yet")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Set the source below/);
    expect(
      screen.getByRole("button", { name: "Deploy from the empty state" }),
    ).toBeTruthy();
  });

  it("keeps the build words for a repository", () => {
    render(panel());

    expect(card().textContent).toBe("Last build output");
    expect(screen.getByText("Nothing has been built yet")).toBeTruthy();
  });
});

/**
 * The row still says `error` from the last attempt until the worker
 * picks the new build up, and the banner said "The last Deployment failed"
 * over a log card streaming the new one. The live Deployment is the newer fact.
 */
describe("Application Overview — a Deployment in flight after a failure", () => {
  it("draws no failure banner while the newest Deployment is live", () => {
    status = "error";
    rows = [deployment("A", "error"), deployment("B", "running", 1)];
    render(panel());

    expect(document.querySelector("[data-slot=banner]")).toBeNull();
    expect(screen.getByText("showing B")).toBeTruthy();
  });
});
