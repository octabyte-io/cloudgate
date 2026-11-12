import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CloudRead, Plan } from "@/lib/api/endpoints/project-config";

import { PlanView } from "./plan-view";

vi.mock("@/lib/api/use-servers", () => ({
  useServers: () => ({ data: [] }),
}));

// Its modal reads the API; here only where it is offered matters.
vi.mock("@/components/console/use-existing-button", () => ({
  UseExistingButton: ({
    configName,
    kind,
  }: {
    configName: string;
    kind?: "postgres" | "redis";
  }) => (
    <button type="button">
      Use an existing {kind === "redis" ? "cache" : "database"} for {configName}
    </button>
  ),
}));

// Likewise for an existing bucket.
vi.mock("@/components/console/use-existing-bucket-button", () => ({
  UseExistingBucketButton: ({ configName }: { configName: string }) => (
    <button type="button">Use an existing bucket for {configName}</button>
  ),
}));

afterEach(cleanup);

const place = {
  kind: "cloud" as const,
  cloudAccountId: "ca-1",
  region: "eu-central-1",
};

const counts = {
  create: 0,
  change: 0,
  destroy: 0,
  replace: 0,
  drift: 0,
  adopt: 0,
  briefDowntime: 0,
};

function read(
  summary: string[],
  raw: string[],
  extra: Partial<typeof counts> = {},
): CloudRead {
  return {
    status: "read",
    summary,
    raw: raw.map((address) => ({
      address,
      resourceType: address.split(".")[0],
      action: "create",
      fields: [],
      briefDowntime: false,
      drift: false,
    })),
    counts: { ...counts, create: raw.length, ...extra },
    drift: [],
    adopt: [],
    noState: [],
    imageOnly: false,
    stateId: "state-1",
    readAt: "2026-10-17T09:00:00.000Z",
  };
}

function cloudPlan(network: CloudRead, web: CloudRead): Plan {
  return {
    planId: "plan-1",
    environmentId: "env-1",
    source: "save",
    textHash: "sha256:abc",
    commitSha: null,
    branch: null,
    baseTextHash: "sha256:abc",
    settingsFingerprint: "sha256:def",
    status: "open",
    results: null,
    requestedBy: "user-1",
    createdAt: "2026-10-17T09:00:00.000Z",
    appliedBy: null,
    appliedAt: null,
    dismissedBy: null,
    dismissedAt: null,
    notes: [],
    steps: [
      {
        action: "network-create",
        cloudAccountId: "ca-1",
        region: "eu-central-1",
        cloudRead: network,
      },
      {
        action: "create",
        configName: "web",
        kind: "web",
        placement: place,
        fields: [],
        cloud: {
          size: {
            name: "small",
            pair: { runsOn: "Fargate", wording: "0.5 vCPU / 1 GB" },
          },
        },
        cloudRead: web,
      },
    ],
  };
}

const NETWORK = read(
  ["Environment network: create, about $24/month while idle"],
  ["aws_vpc.network", "aws_subnet.public", "aws_lb.network"],
);
const WEB = read(
  [
    "ECS service `web`: create, `small` → 0.5 vCPU / 1 GB, 1 task",
    "Task definition: create, new image, built by this deploy",
  ],
  ["aws_ecs_service.web", "aws_ecs_task_definition.web"],
  { briefDowntime: 1 },
);

describe("PlanView, a plan that reads AWS", () => {
  it("leads with the totals strip and shows each step's plain summary, its raw AWS lines folded", () => {
    render(
      <PlanView
        plan={cloudPlan(NETWORK, WEB)}
        cloudAccountNames={{ "ca-1": "Production AWS" }}
        onApply={() => undefined}
      />,
    );

    expect(screen.getByLabelText("Totals").textContent).toBe(
      "5 create · 0 change · 0 destroy · 0 drift · 1 brief downtime",
    );
    expect(screen.getByText("Environment network")).toBeTruthy();
    expect(
      screen.getAllByText("in Cloud account Production AWS, eu-central-1"),
    ).toHaveLength(2);
    expect(
      screen.getByText(
        "Environment network: create, about $24/month while idle",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Task definition: create, new image, built by this deploy",
      ),
    ).toBeTruthy();
    expect(screen.getByText("0.5 vCPU / 1 GB")).toBeTruthy();
    const fold = screen.getByText("Show 3 AWS resources");
    expect(fold.closest("details")?.open).toBe(false);
    expect(screen.getByText("Show 2 AWS resources")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Apply" })
        .getAttribute("aria-disabled"),
    ).not.toBe("true");
  });

  it("names a web's size on its cloud's own pair, noting a rounding up (S17)", () => {
    const sizeLine = () =>
      screen.getByText((_, element) =>
        Boolean(
          element?.tagName === "P" && element.textContent?.startsWith("Size "),
        ),
      ).textContent;
    render(
      <PlanView
        plan={cloudPlan(NETWORK, WEB)}
        cloudAccountNames={{ "ca-1": "Production AWS" }}
        onApply={() => undefined}
      />,
    );
    expect(sizeLine()).toBe(
      "Size small → 0.5 vCPU / 1 GB on Fargate. No Domain yet; add one in the console once its first deploy is done.",
    );
    cleanup();

    const plan = cloudPlan(NETWORK, WEB);
    const rounded: Plan = {
      ...plan,
      steps: plan.steps.map((step) =>
        step.action === "create"
          ? {
              ...step,
              cloud: {
                size: {
                  name: "small",
                  pair: {
                    runsOn: "Cloud Run",
                    wording: "1 CPU / 1 GB",
                    roundedUpFrom: "0.5 CPU",
                    notes: [
                      "CPU only during requests",
                      "0–10 copies: scales to zero, so the first request after idle waits for a start",
                    ],
                  },
                },
              },
            }
          : step,
      ),
    };
    render(
      <PlanView
        plan={rounded}
        cloudAccountNames={{ "ca-1": "Production" }}
        onApply={() => undefined}
      />,
    );
    expect(sizeLine()).toBe(
      "Size small → 1 CPU / 1 GB (rounded up from 0.5 CPU) on Cloud Run · CPU only during requests · 0–10 copies: scales to zero, so the first request after idle waits for a start. No Domain yet; add one in the console once its first deploy is done.",
    );
  });

  it('says "reading AWS…" on a step still reading, and greys Apply out naming it', () => {
    render(
      <PlanView
        plan={cloudPlan(NETWORK, { status: "reading" })}
        onApply={() => undefined}
      />,
    );

    expect(screen.getByText("reading AWS…")).toBeTruthy();
    expect(
      screen.getByText("Waiting for AWS to be read for web."),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Apply" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("shows a failed read's reason, and greys Apply out until AWS can be read", () => {
    render(
      <PlanView
        plan={cloudPlan(
          { status: "failed", reason: "AccessDenied: ecs:CreateService" },
          WEB,
        )}
        onApply={() => undefined}
      />,
    );

    expect(
      screen.getByText("Could not read AWS: AccessDenied: ecs:CreateService"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Apply is refused until AWS can be read for the Environment network (eu-central-1). Check for changes to read it again.",
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Apply" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });
});

describe("PlanView, a plan a stopped deploy opened", () => {
  const stoppedPlan = (): Plan => ({
    ...cloudPlan(NETWORK, WEB),
    source: "deploy",
    requestedBy: null,
    steps: [
      {
        action: "change",
        configName: "web",
        kind: "web",
        serviceType: "application",
        serviceId: "app-1",
        name: "web",
        fields: [],
        cloudRead: read(
          ["Security group: put back, changed by hand"],
          ["aws_security_group.web"],
        ),
      },
    ],
    stoppedDeployment: {
      deploymentId: "dep-1",
      applicationId: "app-1",
      configName: "web",
      title: "fix: the checkout button",
      status: "error",
      createdAt: "2026-10-17T09:00:00.000Z",
    },
  });

  it("names the stopped deploy, links to it, and marks the step it stopped on with what it read", () => {
    render(<PlanView plan={stoppedPlan()} onApply={() => undefined} />);

    const named = screen.getByLabelText("Opened by a stopped deploy");
    expect(named.textContent).toContain("fix: the checkout button");
    expect(named.textContent).toContain(
      "stopped on this plan: AWS differs from what Cloudgate made.",
    );
    expect(
      screen
        .getByRole("link", { name: "Its Deployment →" })
        .getAttribute("href"),
    ).toBe("/applications/app-1/deployments");
    expect(screen.getByLabelText("Stopped deploy").textContent).toContain(
      "Its deploy stopped here",
    );
    expect(
      screen.getByText("Security group: put back, changed by hand"),
    ).toBeTruthy();
    expect(screen.getByText("Show 1 AWS resource")).toBeTruthy();
  });

  it("names no deploy on a plan no deploy opened", () => {
    render(
      <PlanView plan={cloudPlan(NETWORK, WEB)} onApply={() => undefined} />,
    );

    expect(screen.queryByLabelText("Opened by a stopped deploy")).toBeNull();
    expect(screen.queryByLabelText("Stopped deploy")).toBeNull();
  });
});

describe("PlanView, a postgres on RDS", () => {
  it("shows the class its size lands on beside its AWS lines", () => {
    const plan = cloudPlan(NETWORK, WEB);
    const pg = read(
      [
        "pg-1 small → db.t4g.micro (2 vCPU, 1 GB)",
        "pg-1 storage: 20 GB gp3, grows to 200 GB",
      ],
      ["aws_db_instance.database"],
    );
    plan.steps = [
      {
        action: "create",
        configName: "pg-1",
        kind: "postgres",
        placement: place,
        fields: [],
        database: {
          size: {
            name: "small",
            instanceClass: "db.t4g.micro",
            machine: "2 vCPU, 1 GB",
            smallest: false,
          },
          version: {
            written: "17",
            engineVersion: "17",
            autoMinorUpgrade: true,
          },
          login: { user: "app_pg_1", database: "pg_1" },
        },
        cloudRead: pg,
      },
    ];

    render(<PlanView plan={plan} onApply={() => undefined} />);

    expect(
      screen.getByText("small → db.t4g.micro (2 vCPU, 1 GB)"),
    ).toBeTruthy();
    expect(
      screen.getByText("pg-1 small → db.t4g.micro (2 vCPU, 1 GB)"),
    ).toBeTruthy();
    expect(
      screen.getByText("pg-1 storage: 20 GB gp3, grows to 200 GB"),
    ).toBeTruthy();
    // The row that would create it offers an existing one instead.
    expect(
      screen.getByRole("button", {
        name: "Use an existing database for pg-1",
      }),
    ).toBeTruthy();
  });
});

describe("PlanView, a class native.aws sets on RDS", () => {
  it("names the size beside the native class it gives way to", () => {
    const plan = cloudPlan(NETWORK, WEB);
    plan.steps = [
      {
        action: "create",
        configName: "pg-1",
        kind: "postgres",
        placement: place,
        fields: [],
        database: {
          size: {
            name: "medium",
            instanceClass: "db.r7g.xlarge",
            machine: "4 vCPU, 32 GB",
            smallest: false,
            native: true,
          },
          version: {
            written: "17",
            engineVersion: "17",
            autoMinorUpgrade: true,
          },
          login: { user: "app_pg_1", database: "pg_1" },
        },
        cloudRead: read(
          ["pg-1 medium → db.r7g.xlarge (4 vCPU, 32 GB), set by native"],
          ["aws_db_instance.database"],
        ),
      },
    ];

    render(<PlanView plan={plan} onApply={() => undefined} />);

    expect(
      screen.getByText("medium → db.r7g.xlarge (4 vCPU, 32 GB)"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "pg-1 medium → db.r7g.xlarge (4 vCPU, 32 GB), set by native",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText((_, element) =>
        Boolean(
          element?.tagName === "P" &&
          element.textContent?.startsWith("RDS for PostgreSQL") &&
          element.textContent.includes(", set by native, never"),
        ),
      ),
    ).toBeTruthy();
  });
});

describe("PlanView, a redis on ElastiCache", () => {
  it("shows the node type its size lands on and the Valkey it runs", () => {
    const plan = cloudPlan(NETWORK, WEB);
    plan.steps = [
      {
        action: "create",
        configName: "redis",
        kind: "redis",
        placement: place,
        fields: [],
        cache: {
          size: {
            name: "small",
            nodeType: "cache.t4g.small",
            machine: "2 vCPU, 1.37 GB",
            smallest: false,
          },
          version: {
            written: "7",
            engineVersion: "7.2",
            parameterFamily: "valkey7",
          },
        },
        cloudRead: read(
          ["redis small → Valkey on cache.t4g.small (2 vCPU, 1.37 GB)"],
          ["aws_elasticache_replication_group.cache"],
        ),
      },
    ];

    render(<PlanView plan={plan} onApply={() => undefined} />);

    expect(
      screen.getByText("small → cache.t4g.small (2 vCPU, 1.37 GB)"),
    ).toBeTruthy();
    expect(screen.getByText(/Valkey 7\.2, TLS only/)).toBeTruthy();
    expect(
      screen.getByText(
        "redis small → Valkey on cache.t4g.small (2 vCPU, 1.37 GB)",
      ),
    ).toBeTruthy();
    // The row that would create it offers an existing cache instead.
    expect(
      screen.getByRole("button", { name: "Use an existing cache for redis" }),
    ).toBeTruthy();
  });
});

describe("PlanView, a plan that found Drift", () => {
  const base = read([], []) as Extract<CloudRead, { status: "read" }>;
  const quiet: CloudRead = { ...base, liveImage: null };
  const drifted: CloudRead = {
    ...base,
    raw: [
      {
        address: "aws_ecs_service.web",
        resourceType: "aws_ecs_service",
        action: "replace",
        fields: ["launch_type"],
        briefDowntime: true,
        drift: true,
      },
      {
        address: "aws_security_group.web",
        resourceType: "aws_security_group",
        action: "change",
        fields: ["ingress"],
        briefDowntime: false,
        drift: true,
      },
    ],
    counts: { ...counts, drift: 2, briefDowntime: 1 },
    drift: [
      {
        address: "aws_ecs_service.web",
        resourceType: "aws_ecs_service",
        line: "ECS service `web`: changed outside Cloudgate, will be put back, brief downtime",
        deleted: false,
        replaceForcing: true,
        fields: [
          { field: "launch_type", hand: "(none)", cloudgate: "FARGATE" },
        ],
      },
      {
        address: "aws_security_group.web",
        resourceType: "aws_security_group",
        line: "`aws_security_group.web`: changed outside Cloudgate, will be put back",
        deleted: false,
        replaceForcing: false,
        fields: [{ field: "desired_count", hand: "3", cloudgate: "1" }],
      },
    ],
    noState: [
      {
        arn: "arn:aws:elasticloadbalancing:eu-central-1:1:targetgroup/cg-old/1",
        line: "found in AWS, in no state: arn:aws:elasticloadbalancing:eu-central-1:1:targetgroup/cg-old/1",
      },
    ],
    liveImage: "dep-live",
  };
  const checked = (web: CloudRead, status: Plan["status"] = "open"): Plan => ({
    ...cloudPlan(NETWORK, WEB),
    source: "request",
    status,
    steps: [
      {
        action: "network-change",
        environmentNetworkId: "net-1",
        cloudAccountId: "ca-1",
        region: "eu-central-1",
        cloudRead: quiet,
      },
      {
        action: "change",
        configName: "web",
        kind: "web",
        serviceType: "application",
        serviceId: "app-1",
        name: "web",
        fields: [],
        cloudRead: web,
      },
    ],
  });

  it("lists Drift in its own section after the Destroys, a replace-forcing one in red, and offers Apply: put AWS back", () => {
    render(<PlanView plan={checked(drifted)} onApply={() => undefined} />);

    expect(screen.getByLabelText("Totals").textContent).toBe(
      "0 create · 0 change · 0 destroy · 2 drift · 1 brief downtime",
    );
    // Neither the quiet network nor the drift-only Service is a change.
    expect(screen.queryByLabelText("Changes")).toBeNull();
    const drift = screen.getByLabelText("Drift");
    expect(drift.textContent).toContain(
      "ECS service `web`: changed outside Cloudgate, will be put back, brief downtime",
    );
    expect(drift.textContent).toContain("3→1");
    const [replaced, changed] = screen.getAllByLabelText("Drift of web");
    expect(replaced.className).toContain("text-bad");
    expect(changed.className).not.toContain("text-bad");
    const apply = screen.getByRole("button", { name: "Apply: put AWS back" });
    const notes = screen.getByLabelText("Notes");
    // Creates → Changes → Destroys → Drift → Apply → Notes.
    expect(
      drift.compareDocumentPosition(apply) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      apply.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(notes.textContent).toContain(
      "found in AWS, in no state: arn:aws:elasticloadbalancing:eu-central-1:1:targetgroup/cg-old/1",
    );
  });

  it("says there is nothing to change once every read finds AWS as Cloudgate made it", () => {
    render(<PlanView plan={checked(quiet, "unchanged")} />);

    expect(screen.getByText("Nothing to change")).toBeTruthy();
    expect(screen.queryByLabelText("Changes")).toBeNull();
    expect(screen.queryByLabelText("Drift")).toBeNull();
  });

  it("names Google Cloud, not AWS, on a Google plan: its Drift, Apply: put Google Cloud back, and a step still reading", () => {
    const plan = checked(drifted);
    const { unmount } = render(
      <PlanView
        plan={plan}
        cloudName="Google Cloud"
        onApply={() => undefined}
      />,
    );

    expect(screen.getByLabelText("Drift").textContent).toContain(
      "Changed by hand in Google Cloud",
    );
    expect(
      screen.getByRole("button", { name: "Apply: put Google Cloud back" }),
    ).toBeTruthy();
    unmount();

    render(
      <PlanView
        plan={cloudPlan(NETWORK, { status: "reading" })}
        cloudName="Google Cloud"
        onApply={() => undefined}
      />,
    );

    expect(screen.getByRole("status").textContent).toBe(
      "reading Google Cloud…",
    );
    expect(screen.getByText("Show 3 Google Cloud resources")).toBeTruthy();
    expect(
      screen.getByText("Waiting for Google Cloud to be read for web."),
    ).toBeTruthy();
    expect(screen.queryByText(/AWS/)).toBeNull();
  });
});

describe("PlanView, the private link added to a Google network", () => {
  it("lists the network's change as the link its databases need, with its pieces at $0/month", () => {
    const link = read(
      [
        "Private link subnet `cloudgate-abc-psc` (10.64.16.0/24): create, $0/month",
        "Private link for Cloud SQL (service connection policy `cloudgate-abc-psc-sql`): create, $0/month",
        "Private link: lets this Environment's databases get a private address; made once, kept until the Environment is deleted",
      ],
      [
        "google_compute_subnetwork.private_link",
        "google_network_connectivity_service_connection_policy.cloud_sql",
      ],
    );
    render(
      <PlanView
        plan={{
          ...cloudPlan(link, link),
          steps: [
            {
              action: "network-change",
              environmentNetworkId: "net-1",
              cloudAccountId: "ca-1",
              region: "europe-west1",
              privateLinks: ["cloud-sql"],
              cloudRead: link,
            },
          ],
        }}
      />,
    );

    const changes = screen.getByLabelText("Changes");
    expect(changes.textContent).toContain(
      "The private link this Environment's databases get their private address through",
    );
    expect(changes.textContent).toContain(
      "Private link for Cloud SQL (service connection policy `cloudgate-abc-psc-sql`): create, $0/month",
    );
    expect(changes.textContent).toContain(
      "made once, kept until the Environment is deleted",
    );
  });

  it("adds the private DNS namespace for a first web-private on AWS, priced, and gives the web-private's internal address", () => {
    const namespace = read(
      [
        "Private DNS namespace `cloudgate.internal`: create, for this Environment's Private web services, about $0.50/month; kept until the Environment network goes",
      ],
      ["aws_service_discovery_private_dns_namespace.network"],
    );
    const inside = read(
      [
        "Private DNS name `inside.cloudgate.internal`: create, one record per healthy task, reached from this Environment network only",
      ],
      ["aws_service_discovery_service.service", "aws_ecs_service.service"],
    );
    render(
      <PlanView
        plan={{
          ...cloudPlan(namespace, inside),
          steps: [
            {
              action: "network-change",
              environmentNetworkId: "net-1",
              cloudAccountId: "ca-1",
              region: "eu-central-1",
              privateLinks: ["private-dns"],
              cloudRead: namespace,
            },
            {
              action: "create",
              configName: "inside",
              kind: "web-private",
              placement: {
                kind: "cloud",
                cloudAccountId: "ca-1",
                region: "eu-central-1",
              },
              fields: [{ field: "port", from: null, to: 4000 }],
              cloud: {
                size: {
                  name: "small",
                  pair: { runsOn: "Fargate", wording: "0.5 vCPU / 1 GB" },
                },
              },
              cloudRead: inside,
            },
          ],
        }}
      />,
    );

    const text = document.body.textContent ?? "";
    expect(text).toContain(
      "The private DNS namespace this Environment's Private web services are reached by",
    );
    expect(text).toContain("about $0.50/month");
    expect(text).toContain(
      "No Domain: only the Services of this Environment network reach it, at http://inside.cloudgate.internal:4000.",
    );
    expect(text).not.toContain("add one in the console");
  });
});

describe("PlanView, a change to a postgres on RDS", () => {
  const change = (
    summary: string[],
    outages: { kind: "restart" | "major-upgrade"; line: string }[],
    majorUpgrade?: { from: string; to: string },
  ): Plan => ({
    ...cloudPlan(NETWORK, WEB),
    steps: [
      {
        action: "change",
        configName: "pg-1",
        kind: "postgres",
        serviceType: "postgres",
        serviceId: "pg-id",
        name: "pg-1",
        fields: [],
        ...(majorUpgrade ? { majorUpgrade } : {}),
        cloudRead: {
          ...(read(summary, ["aws_db_instance.database"]) as Extract<
            CloudRead,
            { status: "read" }
          >),
          outages: outages.map((outage) => ({
            ...outage,
            serviceName: "pg-1",
          })),
        },
      },
    ],
  });
  const applyButton = () => screen.getByRole("button", { name: "Apply" });

  it("marks a class change's restart line as an outage", () => {
    render(
      <PlanView
        plan={change(
          [
            "pg-1 large → db.t4g.medium (2 vCPU, 4 GB), from db.t4g.micro",
            "restarts pg-1: a few minutes offline",
          ],
          [{ kind: "restart", line: "restarts pg-1: a few minutes offline" }],
        )}
        onApply={() => undefined}
      />,
    );

    expect(
      screen.getByLabelText("Outage: restarts pg-1: a few minutes offline"),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Major upgrades")).toBeNull();
  });

  it("shows a major upgrade apart, and applies it only once its name is typed", () => {
    const line =
      "pg-1 major upgrade: PostgreSQL 17.4 → 18, offline during the upgrade, cannot be undone";
    const onApply = vi.fn();
    render(
      <PlanView
        plan={change([line], [{ kind: "major-upgrade", line }], {
          from: "17",
          to: "18",
        })}
        onApply={onApply}
      />,
    );

    expect(screen.getByLabelText("Major upgrades")).toBeTruthy();
    expect(screen.queryByLabelText("Changes")).toBeNull();
    expect(screen.getByLabelText(`Outage: ${line}`)).toBeTruthy();
    expect(applyButton().getAttribute("aria-disabled")).toBe("true");

    fireEvent.change(screen.getByLabelText("Type pg-1 to confirm"), {
      target: { value: "pg-1" },
    });
    fireEvent.click(applyButton());

    expect(onApply).toHaveBeenCalledWith({
      destroy: [],
      upgrade: ["pg-1"],
      deleteFilesOf: [],
      deleteDataOf: [],
    });
  });
});

describe("PlanView, a change to a redis on ElastiCache", () => {
  const change = (
    summary: string[],
    outages: { kind: "restart" | "major-upgrade"; line: string }[],
    majorUpgrade?: { from: string; to: string },
  ): Plan => ({
    ...cloudPlan(NETWORK, WEB),
    steps: [
      {
        action: "change",
        configName: "redis",
        kind: "redis",
        serviceType: "redis",
        serviceId: "redis-id",
        name: "redis",
        // The console's replica: no config field moves.
        fields: [],
        cache: {
          nodeType: null,
          version: null,
          settings: [{ setting: "replica", from: false, to: true }],
        },
        ...(majorUpgrade ? { majorUpgrade } : {}),
        cloudRead: {
          ...(read(summary, [
            "aws_elasticache_replication_group.cache",
          ]) as Extract<CloudRead, { status: "read" }>),
          outages: outages.map((outage) => ({
            ...outage,
            serviceName: "redis",
          })),
        },
      },
    ],
  });

  it("shows a console setting's change as a change, not a Drift check", () => {
    const line =
      "redis replica: off → on, one replica in another zone with automatic failover";
    render(<PlanView plan={change([line], [])} onApply={() => undefined} />);

    expect(screen.getByLabelText("Changes")).toBeTruthy();
    expect(screen.getByText(line)).toBeTruthy();
    expect(screen.queryByLabelText(`Outage: ${line}`)).toBeNull();
  });

  it("marks a resize as an outage", () => {
    const line = "redis: may drop connections briefly while it resizes";
    render(
      <PlanView
        plan={change([line], [{ kind: "restart", line }])}
        onApply={() => undefined}
      />,
    );

    expect(screen.getByLabelText(`Outage: ${line}`)).toBeTruthy();
  });

  it("shows a major upgrade apart, confirmed by typing its name", () => {
    const line =
      "redis major upgrade: Valkey 7.2.4 → 8.1, may drop connections briefly, cannot be undone";
    const onApply = vi.fn();
    render(
      <PlanView
        plan={change([line], [{ kind: "major-upgrade", line }], {
          from: "7",
          to: "8",
        })}
        onApply={onApply}
      />,
    );

    expect(screen.getByLabelText("Major upgrades")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Type redis to confirm"), {
      target: { value: "redis" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(onApply).toHaveBeenCalledWith({
      destroy: [],
      upgrade: ["redis"],
      deleteFilesOf: [],
      deleteDataOf: [],
    });
  });
});

describe("PlanView, a bucket on AWS", () => {
  const NAME = "uploads-k3f9a2qd-123456789012-eu-central-1-an";

  it("names the bucket it makes, its AWS account and region, beside its AWS lines", () => {
    const plan = cloudPlan(NETWORK, WEB);
    plan.steps = [
      {
        action: "create",
        configName: "uploads",
        kind: "bucket",
        placement: place,
        fields: [],
        bucket: {
          name: NAME,
          awsAccountId: "123456789012",
          region: "eu-central-1",
        },
        cloudRead: read(
          [
            "S3 bucket `" +
              NAME +
              "`: create, versioning off, S3's default encryption, Block Public Access on",
          ],
          ["aws_s3_bucket.bucket"],
        ),
      },
    ];

    render(<PlanView plan={plan} onApply={() => undefined} />);

    expect(screen.getByText(NAME)).toBeTruthy();
    expect(screen.getByText("123456789012")).toBeTruthy();
    expect(
      screen.getByText(/eu-central-1: a name only that account can hold/),
    ).toBeTruthy();
    // The row that would create it offers an existing one instead.
    expect(
      screen.getByRole("button", {
        name: "Use an existing bucket for uploads",
      }),
    ).toBeTruthy();
  });

  it("shows origins edited on the bucket's page as a CORS change, applied as such", () => {
    const plan = cloudPlan(NETWORK, WEB);
    plan.steps = [
      {
        action: "change",
        configName: "uploads",
        kind: "bucket",
        serviceType: "bucket",
        serviceId: "bkt-1",
        name: "uploads",
        fields: [],
        cors: { from: [], to: ["https://app.example.com"] },
        cloudRead: read(
          ["Browser uploads (CORS): allow https://app.example.com"],
          ["aws_s3_bucket_cors_configuration.bucket"],
        ),
      },
    ];

    render(<PlanView plan={plan} onApply={() => undefined} />);

    expect(
      screen.getByText(
        /Browser-upload origins, set on the bucket’s page: none → https:\/\/app\.example\.com/,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
  });
});

describe("PlanView, a static site on AWS", () => {
  const NAME = "docs-p4x8m2rt-123456789012-eu-central-1-an";

  it("names its own bucket, private to its distribution, and how a missing path answers", () => {
    const plan = cloudPlan(NETWORK, WEB);
    plan.steps = [
      {
        action: "create",
        configName: "docs",
        kind: "static",
        placement: place,
        fields: [],
        bucket: {
          name: NAME,
          awsAccountId: "123456789012",
          region: "eu-central-1",
        },
        site: { spa: true },
        cloudRead: read(
          [
            "CloudFront distribution: create, HTTPS only, error responses 403 → 200 /index.html, 404 → 200 /index.html",
          ],
          ["aws_cloudfront_distribution.site"],
        ),
      },
    ];
    plan.notes = [
      {
        kind: "ignored-on-s3",
        configName: "docs",
        fields: ["size", "env"],
        message:
          "docs: `size`, `env` have no meaning on S3 + CloudFront, so they are ignored",
      },
    ];

    render(<PlanView plan={plan} onApply={() => undefined} />);

    expect(screen.getByText(NAME)).toBeTruthy();
    expect(
      screen.getByText(
        /a private bucket only its CloudFront distribution reads/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/A missing path answers \/index\.html \(spa\)/),
    ).toBeTruthy();
    expect(screen.queryByText(/a name only that account can hold/)).toBeNull();
    expect(
      screen.getByText(/have no meaning on S3 \+ CloudFront/),
    ).toBeTruthy();
  });
});
