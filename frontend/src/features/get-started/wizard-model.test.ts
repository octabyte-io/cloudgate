import { describe, expect, it } from "vitest";

import type { CatalogueSize } from "@/lib/api/endpoints/bought-servers";
import type {
  EnvironmentDeployment,
  EnvironmentDomain,
} from "@/lib/api/endpoints/environments";
import type { Plan, PlanStepResult } from "@/lib/api/endpoints/project-config";
import type { Server } from "@/lib/api/endpoints/servers";
import type { SetupForm } from "@/lib/api/endpoints/templates";

import {
  appAddress,
  buyStageStates,
  canSetUpOn,
  freeEnvironmentName,
  freeProjectName,
  isReadyServer,
  launchParts,
  launchPhase,
  serverBeingMade,
  startingPrice,
  waitsForGeneratedHost,
} from "./wizard-model";

function server(over: Partial<Server>): Server {
  return {
    serverId: "srv_1",
    name: "web-1",
    serverType: "deploy",
    setupRanAt: null,
    setupOk: null,
    setupMessage: null,
    boughtServer: null,
    createdAt: "2026-11-01T00:00:00Z",
    ...over,
  } as Server;
}

function size(
  id: string,
  family: CatalogueSize["family"],
  memoryGb: number,
  offers: CatalogueSize["offers"],
): CatalogueSize {
  return {
    id,
    family,
    architecture: "x86",
    vcpus: 2,
    memoryGb,
    diskGb: 40,
    offers,
  };
}

const offer = (locationId: string, monthly: number, available = true) => ({
  locationId,
  monthly,
  available,
  backupsMonthly: 1,
});

describe("isReadyServer", () => {
  it("takes an own deploy Server whose setup finished", () => {
    expect(
      isReadyServer(server({ setupRanAt: "2026-11-01", setupOk: true })),
    ).toBe(true);
  });

  it("refuses an own Server never set up, or whose setup failed", () => {
    expect(isReadyServer(server({}))).toBe(false);
    expect(
      isReadyServer(server({ setupRanAt: "2026-11-01", setupOk: false })),
    ).toBe(false);
  });

  it("refuses a build Server", () => {
    expect(
      isReadyServer(
        server({ serverType: "build", setupRanAt: "x", setupOk: true }),
      ),
    ).toBe(false);
  });

  it("takes a Bought Server only once it is Ready", () => {
    const bought = (stage: "setting_up" | "ready") =>
      server({
        boughtServer: { stage, deletesOn: null, deletedAt: null },
      });

    expect(isReadyServer(bought("setting_up"))).toBe(false);
    expect(isReadyServer(bought("ready"))).toBe(true);
  });
});

describe("canSetUpOn", () => {
  const bought = (stage: "creating" | "setting_up" | "ready") =>
    server({ boughtServer: { stage, deletesOn: null, deletedAt: null } });

  it("takes a Bought Server from Setting up on, before it is Ready", () => {
    expect(canSetUpOn(bought("creating"))).toBe(false);
    expect(canSetUpOn(bought("setting_up"))).toBe(true);
    expect(canSetUpOn(bought("ready"))).toBe(true);
  });

  it("refuses a Bought Server an operator powered off, at any stage", () => {
    const poweredOff = { at: "2026-11-10T09:00:00Z", reason: "Port scan" };
    for (const stage of ["setting_up", "ready"] as const) {
      const off = server({
        boughtServer: { stage, poweredOff, deletesOn: null, deletedAt: null },
      });
      expect(canSetUpOn(off)).toBe(false);
      expect(isReadyServer(off)).toBe(false);
    }
  });

  it("takes an own Server only once its setup finished", () => {
    expect(canSetUpOn(server({}))).toBe(false);
    expect(canSetUpOn(server({ setupRanAt: "x", setupOk: true }))).toBe(true);
  });
});

describe("serverBeingMade", () => {
  it("is the newest Bought Server not Ready yet", () => {
    const servers = [
      server({
        serverId: "old",
        createdAt: "2026-11-01T00:00:00Z",
        boughtServer: { stage: "setting_up", deletesOn: null, deletedAt: null },
      }),
      server({
        serverId: "new",
        createdAt: "2026-11-02T00:00:00Z",
        boughtServer: { stage: "creating", deletesOn: null, deletedAt: null },
      }),
      server({
        serverId: "done",
        createdAt: "2026-11-03T00:00:00Z",
        boughtServer: { stage: "ready", deletesOn: null, deletedAt: null },
      }),
    ];

    expect(serverBeingMade(servers)?.serverId).toBe("new");
  });

  it("is nothing when every Server is ready or own", () => {
    expect(serverBeingMade([server({})])).toBeUndefined();
  });
});

describe("buyStageStates", () => {
  it("marks the stages before the current one done and the rest to do", () => {
    expect(buyStageStates("creating").map((stage) => stage.state)).toEqual([
      "done",
      "now",
      "todo",
      "todo",
    ]);
  });

  it("marks every stage done once Ready", () => {
    expect(
      buyStageStates("ready").every((stage) => stage.state === "done"),
    ).toBe(true);
  });
});

describe("startingPrice", () => {
  it("is the lowest price on sale now, ignoring sold-out offers", () => {
    expect(
      startingPrice({
        locations: [],
        storage: { minGb: 10, maxGb: 100, perGbMonthly: 0.05 },
        images: [],
        defaultImage: "ubuntu-24.04",
        sizes: [
          size("a", "shared", 2, [offer("x", 5, false), offer("y", 7)]),
          size("b", "shared", 4, [offer("x", 9)]),
        ],
      }),
    ).toBe(7);
  });

  it("is null when nothing is on sale", () => {
    expect(
      startingPrice({
        locations: [],
        storage: { minGb: 10, maxGb: 100, perGbMonthly: 0.05 },
        images: [],
        defaultImage: "ubuntu-24.04",
        sizes: [size("a", "shared", 2, [offer("x", 5, false)])],
      }),
    ).toBeNull();
  });
});

function plan(over: Partial<Plan>): Plan {
  return { status: "applied", results: [], ...over } as Plan;
}

function deployment(
  ownerId: string,
  status: EnvironmentDeployment["status"],
): EnvironmentDeployment {
  return {
    status,
    owner: { type: "compose", id: ownerId, name: `${ownerId}-name` },
  } as EnvironmentDeployment;
}

const queued = {
  configName: "ghost-app",
  status: "applied",
  deploy: { status: "queued", deploymentId: "dep_1" },
} as PlanStepResult;

describe("launchPhase", () => {
  it("is preparing while the plan is unread or open", () => {
    expect(launchPhase(undefined, undefined).phase).toBe("preparing");
    expect(launchPhase(plan({ status: "open" }), undefined).phase).toBe(
      "preparing",
    );
  });

  it("is starting while a queued Deployment has not ended", () => {
    expect(
      launchPhase(plan({ results: [queued] }), [deployment("a", "running")])
        .phase,
    ).toBe("starting");
    expect(launchPhase(plan({ results: [queued] }), []).phase).toBe("starting");
  });

  it("reads only each Service's newest Deployment, the feed being newest first", () => {
    expect(
      launchPhase(plan({ results: [queued] }), [
        deployment("a", "done"),
        deployment("a", "error"),
      ]).phase,
    ).toBe("running");
  });

  it("is running once every newest Deployment is done", () => {
    expect(
      launchPhase(plan({ results: [queued] }), [
        deployment("a", "done"),
        deployment("b", "done"),
      ]).phase,
    ).toBe("running");
  });

  it("fails on a Deployment that failed, naming the Service", () => {
    expect(
      launchPhase(plan({ results: [queued] }), [deployment("a", "error")]),
    ).toEqual({ phase: "failed", reason: "a-name did not start." });
  });

  it("fails on a plan step that failed, with its message", () => {
    expect(
      launchPhase(
        plan({
          status: "partly-applied",
          results: [
            { ...queued, status: "failed", message: "Port 80 is taken" },
          ],
        }),
        undefined,
      ),
    ).toEqual({ phase: "failed", reason: "Port 80 is taken" });
  });

  it("fails on a dismissed plan", () => {
    expect(launchPhase(plan({ status: "dismissed" }), undefined).phase).toBe(
      "failed",
    );
  });

  it("says what Cloudgate waits for while the plan is open", () => {
    expect(
      launchPhase(plan({ status: "open" }), undefined, {
        status: "waiting",
        waitingFor: "Blog server is still being set up",
        message: null,
      }),
    ).toEqual({
      phase: "preparing",
      waitingFor: "Blog server is still being set up.",
    });
  });

  it("fails on a refused Apply though the plan is still open", () => {
    // Without this the wizard would say "Preparing" for ever: the plan
    // stays open, waiting for a person to review it.
    expect(
      launchPhase(plan({ status: "open" }), undefined, {
        status: "refused",
        waitingFor: null,
        message: "The plan holds more than this app",
      }),
    ).toEqual({
      phase: "failed",
      reason: "The plan holds more than this app.",
    });
  });

  it("follows the plan, not a stale refusal, once the plan is applied", () => {
    expect(
      launchPhase(plan({ results: [queued] }), [deployment("a", "done")], {
        status: "applied",
        waitingFor: null,
        message: null,
      }).phase,
    ).toBe("running");
  });
});

describe("appAddress", () => {
  const domain = (over: Partial<EnvironmentDomain>) =>
    ({
      host: "ghost.example.com",
      https: true,
      path: null,
      ...over,
    }) as EnvironmentDomain;

  it("is the first Domain as a URL, with its scheme", () => {
    expect(appAddress([domain({})])).toBe("https://ghost.example.com");
    expect(appAddress([domain({ https: false, host: "a.sslip.io" })])).toBe(
      "http://a.sslip.io",
    );
  });

  it("keeps a path other than the root", () => {
    expect(appAddress([domain({ path: "/blog" })])).toBe(
      "https://ghost.example.com/blog",
    );
    expect(appAddress([domain({ path: "/" })])).toBe(
      "https://ghost.example.com",
    );
  });

  it("is null with no Domain", () => {
    expect(appAddress([])).toBeNull();
    expect(appAddress(undefined)).toBeNull();
  });

  it("is the first Domain of a compose service, when one is named (#140)", () => {
    const domains = [
      domain({ host: "logto.example.com", serviceName: "app" }),
      domain({ host: "admin.example.com", serviceName: "admin" }),
      domain({ host: "admin-2.example.com", serviceName: "admin" }),
    ];

    expect(appAddress(domains, "admin")).toBe("https://admin.example.com");
    expect(appAddress(domains, undefined)).toBe("https://logto.example.com");
    // A service with no Domain here names no address, rather than another's.
    expect(appAddress(domains, "keycloak")).toBeNull();
  });
});

describe("freeProjectName", () => {
  it("is the app's name when no Project has it", () => {
    expect(freeProjectName("Ghost", ["Blog"])).toBe("Ghost");
  });

  it("numbers the name past every Project that has it, ignoring case", () => {
    expect(freeProjectName("Ghost", ["ghost", "Ghost 2"])).toBe("Ghost 3");
  });
});

describe("freeEnvironmentName", () => {
  it("is production when the Project has none by that name", () => {
    expect(freeEnvironmentName(["staging"])).toBe("production");
  });

  it("numbers production past every Environment that has it, ignoring case", () => {
    expect(freeEnvironmentName(["Production", "production-2"])).toBe(
      "production-3",
    );
  });
});

describe("waitsForGeneratedHost", () => {
  const form = (servers: Record<string, Record<string, string>> | null) =>
    ({
      newProjectHosts:
        servers === null ? null : { servers, platformHost: null },
    }) as SetupForm;

  it("waits while the new-Project form has no host generated on the Server", () => {
    expect(waitsForGeneratedHost(form({}), "srv_1")).toBe(true);
  });

  it("stops once the Server has its generated host", () => {
    expect(
      waitsForGeneratedHost(
        form({ srv_1: { ghost: "ghost-1.sslip.io" } }),
        "srv_1",
      ),
    ).toBe(false);
  });

  it("does not wait before the form is read, or for a form with no new-Project hosts", () => {
    expect(waitsForGeneratedHost(undefined, "srv_1")).toBe(false);
    expect(waitsForGeneratedHost(form(null), "srv_1")).toBe(false);
  });
});

describe("launchParts", () => {
  const row = (deploymentId: string, status: EnvironmentDeployment["status"]) =>
    ({
      deploymentId,
      status,
      owner: { type: "compose", id: "c", name: "c" },
    }) as EnvironmentDeployment;
  const database = {
    configName: "db",
    status: "applied",
    deploy: { status: "started" },
  } as PlanStepResult;
  const network = {
    configName: "Environment network (eu-west-1)",
    status: "applied",
    deploy: null,
  } as PlanStepResult;

  it("is empty before the plan is applied", () => {
    expect(launchParts(undefined, undefined)).toEqual([]);
    expect(launchParts(plan({ status: "open", results: null }), [])).toEqual(
      [],
    );
  });

  it("reads the Deployment a queued deploy names, not the Service's newest", () => {
    expect(
      launchParts(plan({ results: [queued] }), [
        row("dep_2", "error"),
        row("dep_1", "running"),
      ]),
    ).toEqual([
      { name: "ghost-app", state: "starting", deploymentId: "dep_1" },
    ]);
  });

  it("waits for a Deployment the feed does not show yet, and names none to follow", () => {
    expect(launchParts(plan({ results: [queued] }), [])).toEqual([
      { name: "ghost-app", state: "waiting", deploymentId: null },
    ]);
    expect(
      launchParts(plan({ results: [queued] }), [row("dep_1", "pending")]),
    ).toEqual([{ name: "ghost-app", state: "waiting", deploymentId: null }]);
  });

  it("says started, or failed, once the Deployment has ended", () => {
    expect(
      launchParts(plan({ results: [queued] }), [row("dep_1", "done")])[0].state,
    ).toBe("started");
    expect(
      launchParts(plan({ results: [queued] }), [row("dep_1", "cancelled")])[0]
        .state,
    ).toBe("failed");
  });

  it("takes a database's own started, and leaves out steps that deploy nothing", () => {
    expect(launchParts(plan({ results: [network, database] }), [])).toEqual([
      { name: "db", state: "started", deploymentId: null },
    ]);
  });
});
