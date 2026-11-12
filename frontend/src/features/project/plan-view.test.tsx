import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Plan } from "@/lib/api/endpoints/project-config";

import { formatValue, sideOf, sideValue } from "./plan-field-list";
import { PlanView } from "./plan-view";

// The leftovers panel names Servers through the Organization's list.
vi.mock("@/lib/api/use-servers", () => ({
  useServers: () => ({ data: [] }),
}));

// "Build now" is the Application's lifecycle, pinned in its own test.
vi.mock("@/components/console/build-now-button", () => ({
  BuildNowButton: ({ deployment }: { deployment: { status: string } }) =>
    deployment.status === "held" ? (
      <button>Build now with saved settings</button>
    ) : null,
}));

afterEach(cleanup);

const base: Plan = {
  planId: "plan-1",
  environmentId: "env-1",
  source: "request",
  textHash: "sha256:abc",
  commitSha: null,
  branch: null,
  baseTextHash: "sha256:abc",
  settingsFingerprint: "sha256:def",
  steps: [],
  notes: [],
  status: "open",
  results: null,
  requestedBy: "user-1",
  createdAt: "2026-10-15T09:00:00.000Z",
  appliedBy: null,
  appliedAt: null,
  dismissedBy: null,
  dismissedAt: null,
};

describe("sideValue", () => {
  it("names the kind's default a native line returns to", () => {
    expect(sideValue(null, "default")).toBe("default (none)");
    expect(sideValue("rollback", "default")).toBe("default (rollback)");
    expect(sideValue(5)).toBe("5");
  });

  it("names the console's value a console-owned native line hands back to", () => {
    expect(sideValue(50, "console")).toBe("console (50)");
  });

  it("names the size's value a native size-bearing line falls back to", () => {
    expect(sideValue("db.t4g.micro", "size")).toBe("size (db.t4g.micro)");
  });

  it("reads each end's side from the API's flags", () => {
    const diff = {
      field: 'native.aws."aws_db_instance.database".instance_class',
      from: "db.r7g.xlarge",
      to: "db.t4g.medium",
      native: true as const,
      toSize: true as const,
    };
    expect(sideOf(diff, "from")).toBe("written");
    expect(sideOf(diff, "to")).toBe("size");
    expect(sideOf({ ...diff, toSize: undefined, toConsole: true }, "to")).toBe(
      "console",
    );
    expect(sideOf({ ...diff, fromDefault: true }, "from")).toBe("default");
  });
});

describe("formatValue", () => {
  it("writes a value as the config would", () => {
    expect(formatValue(null)).toBe("not set");
    expect(formatValue(8080)).toBe("8080");
    expect(formatValue("small")).toBe("small");
    expect(formatValue([])).toBe("none");
    expect(formatValue(["PORT", "NODE_ENV"])).toBe("PORT, NODE_ENV");
    expect(formatValue({ github: "acme/shop", path: "/" })).toBe(
      "github: acme/shop, path: /",
    );
    expect(formatValue(true)).toBe("true");
  });
});

describe("PlanView", () => {
  it("shows a Stack VM's own lines on its stack's create and change: its machine and cost, its resize, its grown disk", () => {
    render(
      <PlanView
        plan={{
          ...base,
          steps: [
            {
              action: "create",
              configName: "wiki",
              kind: "compose",
              placement: {
                kind: "cloud",
                cloudAccountId: "ca-1",
                region: "eu-central-1",
              },
              fields: [],
              stackVm: {
                lines: [
                  "wiki Stack VM: medium → t3.small (2 vCPU, 2 GB) in eu-central-1",
                  "wiki Stack VM cost: about $19.40 a month",
                ],
              },
            },
            {
              action: "change",
              configName: "docs",
              kind: "compose",
              serviceType: "compose",
              serviceId: "cs-1",
              name: "docs",
              fields: [{ field: "size", from: "medium", to: "large" }],
              stackVm: {
                lines: [
                  "docs Stack VM: t3.small → t3.large, restarts the Stack VM",
                  "docs Stack VM data disk: 20 GB → 40 GB, grown in place with no restart; a data disk never shrinks",
                ],
              },
            },
          ],
        }}
      />,
    );

    const lines = screen.getAllByLabelText("Stack VM").map((list) =>
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    );
    expect(lines).toEqual([
      [
        "wiki Stack VM: medium → t3.small (2 vCPU, 2 GB) in eu-central-1",
        "wiki Stack VM cost: about $19.40 a month",
      ],
      [
        "docs Stack VM: t3.small → t3.large, restarts the Stack VM",
        "docs Stack VM data disk: 20 GB → 40 GB, grown in place with no restart; a data disk never shrinks",
      ],
    ]);
  });

  it("lists the builds a push held for the plan, offering Build now on a held one", () => {
    render(
      <PlanView
        plan={{
          ...base,
          source: "push",
          heldBuilds: [
            {
              deploymentId: "dep-1",
              applicationId: "app-1",
              configName: "shop",
              title: "Automatic deployment",
              description: "Push to main by grace · c0000002 · feat: 9090",
              status: "held",
              createdAt: "2026-10-15T09:00:00.000Z",
            },
            {
              deploymentId: "dep-0",
              applicationId: "app-2",
              configName: "api",
              title: "Automatic deployment",
              description: null,
              status: "pending",
              createdAt: "2026-10-15T08:00:00.000Z",
            },
          ],
        }}
      />,
    );

    const held = screen.getByRole("region", { name: "Held builds" });
    expect(within(held).getByText("shop")).toBeTruthy();
    expect(within(held).getByText("held")).toBeTruthy();
    expect(within(held).getByText("pending")).toBeTruthy();
    expect(
      within(held).getAllByRole("button", {
        name: "Build now with saved settings",
      }),
    ).toHaveLength(1);
  });

  it("shows no held builds section for a plan that holds none", () => {
    render(<PlanView plan={{ ...base, heldBuilds: [] }} />);
    expect(screen.queryByRole("region", { name: "Held builds" })).toBe(null);
  });

  it("lists a redeploy among the changes, saying which link changed", () => {
    render(
      <PlanView
        plan={{
          ...base,
          steps: [
            {
              action: "redeploy",
              configName: "web",
              kind: "web",
              serviceType: "application",
              serviceId: "app-1",
              name: "Web",
              because: ["pg-1.url"],
            },
          ],
        }}
      />,
    );
    const line = screen.getByText(/redeploys:/);
    expect(line.textContent).toBe("web redeploys: pg-1.url changed");
  });

  it("says a created mysql gets generated passwords, kept by Cloudgate", () => {
    render(
      <PlanView
        plan={{
          ...base,
          steps: [
            {
              action: "create",
              configName: "shop-db",
              kind: "mysql",
              placement: { kind: "server", serverId: "srv-1" },
              fields: [],
            },
          ],
        }}
      />,
    );
    expect(
      screen.getByText(
        "Gets generated root and user passwords, kept by Cloudgate.",
      ),
    ).toBeTruthy();
  });

  it("lists creates, changes with each field, destroys apart, and notes", () => {
    render(
      <PlanView
        plan={{
          ...base,
          steps: [
            {
              action: "create",
              configName: "cache",
              kind: "redis",
              placement: { kind: "platform-host" },
              fields: [],
            },
            {
              action: "change",
              configName: "shop",
              kind: "web",
              serviceType: "application",
              serviceId: "app-1",
              name: "Shop",
              fields: [{ field: "port", from: 3000, to: 8080 }],
            },
            {
              action: "destroy",
              configName: "db",
              kind: "postgres",
              serviceType: "postgres",
              serviceId: "pg-1",
              name: "Orders DB",
            },
          ],
          notes: [
            {
              kind: "console-managed-unlisted",
              configName: "docs",
              line: "docs:\n  kind: mongo\n  managed: console",
              message:
                "docs is a mongo Service the config does not list; paste the line to keep the config complete",
            },
          ],
        }}
      />,
    );

    const creates = screen.getByRole("region", { name: "Creates" });
    expect(within(creates).getByText("cache")).toBeTruthy();
    expect(within(creates).getByText(/platform host/)).toBeTruthy();

    const changes = screen.getByRole("region", { name: "Changes" });
    expect(within(changes).getByText("port")).toBeTruthy();
    expect(within(changes).getByText("3000")).toBeTruthy();
    expect(within(changes).getByText("8080")).toBeTruthy();

    const destroys = screen.getByRole("region", { name: "Destroys" });
    expect(within(destroys).getByText("db")).toBeTruthy();
    expect(destroys.className).toContain("text-bad");

    const notes = screen.getByRole("region", { name: "Notes" });
    expect(within(notes).getByText(/does not list/)).toBeTruthy();
    expect(within(notes).getByText(/managed: console/)).toBeTruthy();
  });

  it("shows that a console-managed MySQL can now be described beside nothing to change, with no line to paste", () => {
    render(
      <PlanView
        plan={{
          ...base,
          status: "unchanged",
          notes: [
            {
              kind: "mysql-can-be-described",
              configName: "shop-db",
              message:
                "shop-db: mysql can now be described; remove managed: console to hand it to the config",
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Nothing to change")).toBeTruthy();
    const notes = screen.getByRole("region", { name: "Notes" });
    expect(
      within(notes).getByText(
        "shop-db: mysql can now be described; remove managed: console to hand it to the config",
      ),
    ).toBeTruthy();
    expect(within(notes).queryByRole("button")).toBeNull();
  });

  it("says a plan with nothing to change does so", () => {
    render(<PlanView plan={{ ...base, status: "unchanged" }} />);

    expect(screen.getByText("Nothing to change")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Destroys" })).toBeNull();
  });

  it("names a Server placement and says a created web gets a Domain on its port", () => {
    render(
      <PlanView
        plan={{
          ...base,
          steps: [
            {
              action: "create",
              configName: "shop",
              kind: "web",
              placement: { kind: "server", serverId: "srv-1" },
              fields: [{ field: "port", from: null, to: 8080 }],
            },
          ],
        }}
        serverNames={{ "srv-1": "worker" }}
      />,
    );

    const creates = screen.getByRole("region", { name: "Creates" });
    expect(within(creates).getByText("on Server worker")).toBeTruthy();
    expect(
      within(creates).getByText(/sslip\.io Domain on port 8080/),
    ).toBeTruthy();
  });

  it("names the host a Template web's setup made for the values that name its URL", () => {
    render(
      <PlanView
        plan={{
          ...base,
          steps: [
            {
              action: "create",
              configName: "ghost-app",
              kind: "web",
              placement: { kind: "platform-host" },
              fields: [{ field: "port", from: null, to: 2368 }],
              template: {
                pendingSetupId: "ps-1",
                templateId: "ghost",
                templateName: "Ghost",
                setupName: "ghost",
                values: [
                  { list: "env", variable: "PUBLIC_URL", made: "fixed" },
                ],
                host: "ghost-app-a1b2c3-198-51-100-7.sslip.io",
              },
            },
          ],
        }}
      />,
    );

    const creates = screen.getByRole("region", { name: "Creates" });
    expect(
      within(creates).getByText("ghost-app-a1b2c3-198-51-100-7.sslip.io"),
    ).toBeTruthy();
    expect(
      within(creates).getByText(/on port 2368, made at setup/),
    ).toBeTruthy();
  });

  it("says a created web-private gets no Domain, and is reached on its port", () => {
    render(
      <PlanView
        plan={{
          ...base,
          steps: [
            {
              action: "create",
              configName: "api",
              kind: "web-private",
              placement: { kind: "server", serverId: "srv-1" },
              fields: [{ field: "port", from: null, to: 4000 }],
            },
          ],
        }}
        serverNames={{ "srv-1": "worker" }}
      />,
    );

    const creates = screen.getByRole("region", { name: "Creates" });
    expect(within(creates).queryByText(/sslip\.io/)).toBeNull();
    expect(
      within(creates).getByText(/No Domain: only the Services on its Server/),
    ).toBeTruthy();
    expect(creates.textContent).toContain("http://<appName>:4000");
  });

  it("leads an applied plan with each step's result, its Domain and its Deployment", () => {
    render(
      <PlanView
        plan={{
          ...base,
          status: "partly-applied",
          results: [
            {
              configName: "shop",
              action: "create",
              status: "applied",
              message: null,
              serviceType: "application",
              serviceId: "app-1",
              domain: "app-x-1a2b3c-203-0-113-10.sslip.io",
              deploy: { status: "queued", deploymentId: "dep-1" },
              leftovers: null,
            },
            {
              configName: "db",
              action: "create",
              status: "failed",
              message: "A Service named db already exists in this Environment",
              serviceType: null,
              serviceId: null,
              domain: null,
              deploy: null,
              leftovers: null,
            },
          ],
        }}
      />,
    );

    const results = screen.getByRole("region", { name: "Results" });
    expect(
      within(results).getByText("app-x-1a2b3c-203-0-113-10.sslip.io"),
    ).toBeTruthy();
    expect(
      within(results)
        .getByRole("link", { name: "Follow it in Deployments" })
        .getAttribute("href"),
    ).toBe("/applications/app-1/deployments");
    expect(within(results).getByText(/already exists/)).toBeTruthy();
    expect(within(results).getByText(/created, failed/)).toBeTruthy();
  });

  describe("applying destroys", () => {
    const destroying: Plan = {
      ...base,
      steps: [
        {
          action: "create",
          configName: "cache",
          kind: "postgres",
          placement: { kind: "platform-host" },
          fields: [],
        },
        {
          action: "destroy",
          configName: "cache",
          kind: "redis",
          serviceType: "redis",
          serviceId: "rd-1",
          name: "Cache",
        },
        {
          action: "destroy",
          configName: "db",
          kind: "postgres",
          serviceType: "postgres",
          serviceId: "pg-1",
          name: "Orders DB",
        },
      ],
    };

    const applyButton = () => screen.getByRole("button", { name: "Apply" });
    const type = (label: string, value: string) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } });

    it("keeps Apply disabled until each destroyed Service's name is typed", () => {
      const onApply = vi.fn();
      render(<PlanView plan={destroying} onApply={onApply} />);

      expect(applyButton().getAttribute("aria-disabled")).toBe("true");
      type("Type Cache to confirm", "Cache");
      expect(applyButton().getAttribute("aria-disabled")).toBe("true");
      type("Type Orders DB to confirm", "Orders");
      expect(applyButton().getAttribute("aria-disabled")).toBe("true");
      type("Type Orders DB to confirm", "Orders DB");
      expect(applyButton().getAttribute("aria-disabled")).not.toBe("true");

      fireEvent.click(applyButton());
      expect(onApply).toHaveBeenCalledWith({
        destroy: ["cache", "db"],
        upgrade: [],
        deleteFilesOf: [],
        deleteDataOf: [],
      });
    });

    it("removes an Environment network nothing uses, typed-confirmed by its confirm name, naming its DNS records", () => {
      const onApply = vi.fn();
      render(
        <PlanView
          plan={{
            ...base,
            steps: [
              {
                action: "network-remove",
                environmentNetworkId: "net-1",
                cloudAccountId: "ca-1",
                region: "eu-central-1",
                confirmName: "network-eu-central-1",
                dnsRecordsLeft: [
                  {
                    name: "shop.example.com",
                    type: "CNAME",
                    value: "cg-1.elb.amazonaws.com",
                  },
                ],
              },
            ],
          }}
          cloudAccountNames={{ "ca-1": "Production AWS" }}
          onApply={onApply}
        />,
      );

      expect(screen.getByText("Environment network")).toBeTruthy();
      expect(
        screen.getByText("CNAME shop.example.com → cg-1.elb.amazonaws.com"),
      ).toBeTruthy();
      expect(applyButton().getAttribute("aria-disabled")).toBe("true");
      type("Type network-eu-central-1 to confirm", "network-eu-central-1");
      fireEvent.click(applyButton());
      expect(onApply).toHaveBeenCalledWith({
        destroy: ["network-eu-central-1"],
        upgrade: [],
        deleteFilesOf: [],
        deleteDataOf: [],
      });
    });

    it("applies a plan with no destroys at once, confirming nothing", () => {
      const onApply = vi.fn();
      render(
        <PlanView
          plan={{ ...destroying, steps: destroying.steps.slice(0, 1) }}
          onApply={onApply}
        />,
      );

      fireEvent.click(applyButton());
      expect(onApply).toHaveBeenCalledWith({
        destroy: [],
        upgrade: [],
        deleteFilesOf: [],
        deleteDataOf: [],
      });
    });

    describe("a cloud database's destroy", () => {
      const databases: Plan = {
        ...base,
        steps: [
          {
            action: "destroy" as const,
            configName: "pg-1",
            kind: "postgres" as const,
            serviceType: "postgres",
            serviceId: "pg-x",
            name: "pg-1",
            finalSnapshot: {
              name: "shop-production-pg-1-final-2026-10-17",
              monthlyUsd: 1.9,
            },
          },
        ],
      };

      it("keeps a final snapshot, named with its cost, until its box is ticked", () => {
        const onApply = vi.fn();
        render(<PlanView plan={databases} onApply={onApply} />);
        type("Type pg-1 to confirm", "pg-1");

        expect(screen.getByLabelText("Final snapshot").textContent).toBe(
          "Keeps a final snapshot shop-production-pg-1-final-2026-10-17, about $1.90 a month, until you delete it in AWS.",
        );
        fireEvent.click(
          screen.getByRole("checkbox", {
            name: /Also delete the data of pg-1/,
          }),
        );
        expect(screen.getByLabelText("Final snapshot").textContent).toBe(
          "Data deleted for good",
        );
        fireEvent.click(applyButton());

        expect(onApply).toHaveBeenCalledWith({
          destroy: ["pg-1"],
          upgrade: [],
          deleteFilesOf: [],
          deleteDataOf: ["pg-1"],
        });
      });

      it("on Google Cloud keeps a final backup, until deleted in Google Cloud", () => {
        const [step] = databases.steps;
        render(
          <PlanView
            plan={{
              ...databases,
              steps: [
                {
                  ...step,
                  finalSnapshot: {
                    cloud: "gcp",
                    name: "shop-production-pg-1-final-2026-10-26",
                    monthlyUsd: 0.8,
                  },
                } as (typeof databases.steps)[number],
              ],
            }}
            onApply={vi.fn()}
          />,
        );
        type("Type pg-1 to confirm", "pg-1");

        expect(screen.getByLabelText("Final snapshot").textContent).toBe(
          "Keeps a final backup shop-production-pg-1-final-2026-10-26, about $0.80 a month, until you delete it in Google Cloud.",
        );
        expect(
          screen.getByRole("checkbox", {
            name: /Also delete the data of pg-1 \(no final backup\)/,
          }),
        ).toBeTruthy();
      });
    });

    describe("a Compose stack's destroy", () => {
      it("names the volumes its Delete removes, or says no deploy has recorded them", () => {
        const stacks: Plan = {
          ...base,
          steps: (
            [["compose-analytics-x1_data", "uploads"], [], null] as const
          ).map((volumes, i) => ({
            action: "destroy" as const,
            configName: ["analytics", "docs", "fresh"][i],
            kind: "compose" as const,
            serviceType: "compose",
            serviceId: `cs-${i}`,
            name: ["Analytics", "Docs", "Fresh"][i],
            volumes: volumes === null ? null : [...volumes],
          })),
        };
        render(<PlanView plan={stacks} />);

        expect(
          screen
            .getAllByLabelText("Volumes removed")
            .map((row) => row.textContent),
        ).toEqual([
          "Removes its volumes and their data: compose-analytics-x1_data, uploads",
          "Removes no volume.",
          "Removes the volumes its compose file declares; no deploy has recorded them yet.",
        ]);
      });

      it("on a Stack VM says what goes, keeps its volumes in a priced final snapshot of its data disk, until its box is ticked", () => {
        const onApply = vi.fn();
        render(
          <PlanView
            plan={{
              ...base,
              steps: [
                {
                  action: "destroy" as const,
                  configName: "analytics",
                  kind: "compose" as const,
                  serviceType: "compose",
                  serviceId: "cs-1",
                  name: "analytics",
                  volumes: ["analytics_data"],
                  stackVm: {
                    cloud: "gcp",
                    region: "europe-west1",
                    dataDiskGb: 20,
                    finalSnapshotMonthlyUsd: 1,
                    lines: [
                      "analytics Stack VM goes from europe-west1 with everything in its Infrastructure state",
                      "analytics data disk (20 GB, its volumes): kept as a final snapshot",
                    ],
                  },
                  finalSnapshot: {
                    cloud: "gcp",
                    name: "shop-production-analytics-final-2026-11-10",
                    monthlyUsd: 1,
                    of: "data-disk",
                  },
                },
              ],
            }}
            onApply={onApply}
          />,
        );
        type("Type analytics to confirm", "analytics");

        expect(screen.getByLabelText("Stack VM removed").textContent).toBe(
          "analytics Stack VM goes from europe-west1 with everything in its Infrastructure state",
        );
        expect(screen.getByLabelText("Volumes removed").textContent).toBe(
          "Removes its volumes, kept in its final snapshot: analytics_data",
        );
        // A disk snapshot on Google Cloud too, never a database's backup.
        expect(screen.getByLabelText("Final snapshot").textContent).toBe(
          "Keeps a final snapshot shop-production-analytics-final-2026-11-10, about $1.00 a month, until you delete it in Google Cloud.",
        );
        fireEvent.click(
          screen.getByRole("checkbox", {
            name: /Also delete the data of analytics \(no final snapshot\)/,
          }),
        );
        expect(screen.getByLabelText("Volumes removed").textContent).toBe(
          "Removes its volumes and their data: analytics_data",
        );
        fireEvent.click(applyButton());

        expect(onApply).toHaveBeenCalledWith({
          destroy: ["analytics"],
          upgrade: [],
          deleteFilesOf: [],
          deleteDataOf: ["analytics"],
        });
      });
    });

    describe("a bucket's destroy", () => {
      const buckets: Plan = {
        ...base,
        steps: (["holds-files", "empty", "unknown"] as const).map(
          (files, i) => ({
            action: "destroy" as const,
            configName: ["uploads", "avatars", "exports"][i],
            kind: "bucket" as const,
            serviceType: "bucket",
            serviceId: `bk-${i}`,
            name: ["Uploads", "Avatars", "Exports"][i],
            files,
          }),
        ),
      };

      it("says whether each bucket holds files, is empty or can't tell", () => {
        render(<PlanView plan={buckets} />);

        const rows = screen
          .getAllByLabelText("Bucket files")
          .map((row) => row.textContent);
        expect(rows).toEqual([
          "Holds filesKept with its volume and named in the result, unless you tick the box.",
          "EmptyRemoved with its volume.",
          "Can't tellKept as if it holds files, unless you tick the box.",
        ]);
        expect(screen.queryByRole("checkbox")).toBeNull();
      });

      it("sends the buckets ticked to have their files deleted, and only those", () => {
        const onApply = vi.fn();
        render(<PlanView plan={buckets} onApply={onApply} />);
        for (const name of ["Uploads", "Avatars", "Exports"]) {
          type(`Type ${name} to confirm`, name);
        }

        expect(screen.getAllByRole("checkbox")).toHaveLength(3);
        fireEvent.click(
          screen.getByRole("checkbox", {
            name: /Also delete the files of exports/,
          }),
        );
        fireEvent.click(applyButton());

        expect(onApply).toHaveBeenCalledWith({
          destroy: ["uploads", "avatars", "exports"],
          upgrade: [],
          deleteFilesOf: ["exports"],
          deleteDataOf: [],
        });
      });

      it("names a bucket its destroy kept, with its volume, on the result", () => {
        render(
          <PlanView
            plan={{
              ...buckets,
              status: "applied",
              results: [
                {
                  configName: "uploads",
                  action: "destroy",
                  status: "applied",
                  message: null,
                  serviceType: "bucket",
                  serviceId: "bk-0",
                  domain: null,
                  deploy: null,
                  leftovers: {
                    bucketLeftBehind: {
                      bucketName: "uploads-k3f9a2qd",
                      volumeName: "bucket-abc123-data",
                      serverId: "srv-1",
                      because: "partly-emptied",
                    },
                  },
                },
              ],
            }}
          />,
        );

        const results = screen.getByRole("region", { name: "Results" });
        expect(results.textContent).toContain(
          "Bucket uploads-k3f9a2qd was partly emptied",
        );
        expect(results.textContent).toContain("bucket-abc123-data");
      });
    });

    it("offers no Apply on a plan that is not open", () => {
      render(
        <PlanView
          plan={{ ...destroying, status: "applied", results: [] }}
          onApply={vi.fn()}
        />,
      );

      expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
      expect(screen.queryByLabelText("Type Cache to confirm")).toBeNull();
    });

    it("shows what a destroy's Delete left behind on its result", () => {
      render(
        <PlanView
          plan={{
            ...base,
            status: "partly-applied",
            results: [
              {
                configName: "cache",
                action: "destroy",
                status: "applied",
                message: null,
                serviceType: "redis",
                serviceId: "rd-1",
                domain: null,
                deploy: null,
                leftovers: {
                  unreclaimedArtifacts: [
                    {
                      kind: "file-mounts",
                      appName: "redis-abc",
                      serverId: null,
                      path: "/etc/cloudgate/applications/redis-abc/files",
                    },
                  ],
                  volumeLeftBehind: true,
                },
              },
              {
                configName: "db",
                action: "destroy",
                status: "failed",
                message: "Swarm service postgres-xyz is still running",
                serviceType: "postgres",
                serviceId: "pg-1",
                domain: null,
                deploy: null,
                leftovers: null,
              },
            ],
          }}
        />,
      );

      const results = screen.getByRole("region", { name: "Results" });
      expect(within(results).getByText(/deleted$/)).toBeTruthy();
      expect(within(results).getByText(/deleted, failed/)).toBeTruthy();
      expect(
        within(results).getByText(
          "/etc/cloudgate/applications/redis-abc/files",
        ),
      ).toBeTruthy();
      expect(within(results).getByText(/data volume was kept/i)).toBeTruthy();
      expect(within(results).getByText(/still running/)).toBeTruthy();
    });
  });
});
