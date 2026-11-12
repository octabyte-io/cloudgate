import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CloudBackups } from "@/lib/api/endpoints/cloud-backups";
import type { Database } from "@/lib/api/endpoints/databases";

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: true, pending: false, role: "member" }),
}));
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ database: vi.fn() }),
}));
const read = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/endpoints/cloud-backups", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/cloud-backups")>()),
  cloudBackupsApi: { read },
}));
const saveCacheSettings = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/lib/api/endpoints/elasticache-redis", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/elasticache-redis")>()),
  elastiCacheRedisApi: { saveSettings: saveCacheSettings },
}));
const saveSettings = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/lib/api/endpoints/rds-postgres", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/rds-postgres")>()),
  rdsPostgresApi: { saveSettings },
}));

const saveCloudSql = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/lib/api/endpoints/cloud-sql-postgres", async (original) => ({
  ...(await original<
    typeof import("@/lib/api/endpoints/cloud-sql-postgres")
  >()),
  cloudSqlPostgresApi: { saveSettings: saveCloudSql },
}));
const saveMemorystore = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/lib/api/endpoints/memorystore-redis", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/memorystore-redis")>()),
  memorystoreRedisApi: { saveSettings: saveMemorystore },
}));

const { CloudBackupsTab } = await import("./cloud-backups-card");
const { cloudDatabaseKind } = await import("@/lib/api/endpoints/cloud-backups");

afterEach(() => {
  cleanup();
  read.mockReset();
  saveSettings.mockClear();
  saveCacheSettings.mockClear();
  saveCloudSql.mockClear();
  saveMemorystore.mockClear();
});

const pg = {
  kind: "postgres",
  databaseId: "pg-id",
  environmentId: "env-1",
  name: "pg-1",
  cloudAccountId: "ca-1",
  region: "eu-central-1",
} as unknown as Database;

const cache = {
  ...pg,
  kind: "redis",
  databaseId: "redis-id",
  name: "cache",
} as unknown as Database;

const RDS: CloudBackups = {
  engine: "rds",
  identifier: "cloudgate-pgxid",
  region: "eu-central-1",
  made: true,
  retentionDays: 14,
  liveRetentionDays: 7,
  restorableWindow: {
    earliest: "2026-10-09T02:45:31.000Z",
    latest: "2026-10-16T11:05:00.000Z",
  },
  snapshots: [
    {
      id: "rds:cloudgate-pgxid-2026-10-15-02-45",
      type: "automated",
      createdAt: "2026-10-15T02:45:51.000Z",
      status: "available",
      size: "20 GB",
    },
    {
      id: "shop-production-pg-1-final-2026-10-02",
      type: "manual",
      createdAt: "2026-10-02T08:00:00.000Z",
      status: "available",
      size: "20 GB",
    },
  ],
  consoleUrl:
    "https://eu-central-1.console.aws.amazon.com/rds/home?region=eu-central-1#database:id=cloudgate-pgxid;is-cluster=false",
};

function renderTab(row: Database) {
  const kind = cloudDatabaseKind(row);
  if (!kind) throw new Error("not a cloud database");
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CloudBackupsTab row={row} kind={kind} />
    </QueryClientProvider>,
  );
}

describe("CloudBackupsTab", () => {
  it("is for a postgres, mysql or redis in a Cloud account only", () => {
    expect(cloudDatabaseKind(pg)).toBe("postgres");
    expect(cloudDatabaseKind(cache)).toBe("redis");
    expect(
      cloudDatabaseKind({ ...pg, kind: "mysql" } as unknown as Database),
    ).toBe("mysql");
    expect(
      cloudDatabaseKind({ ...pg, cloudAccountId: null } as unknown as Database),
    ).toBeNull();
    expect(
      cloudDatabaseKind({ ...pg, kind: "mongo" } as unknown as Database),
    ).toBeNull();
  });

  it("shows what RDS holds, the Server-only sentence and the RDS console link", async () => {
    read.mockResolvedValue(RDS);
    renderTab(pg);

    expect(
      await screen.findByText("shop-production-pg-1-final-2026-10-02"),
    ).toBeTruthy();
    expect(read).toHaveBeenCalledWith("postgres", "pg-id");
    expect(screen.getByText("Kept")).toBeTruthy();
    expect(screen.getByText("Automatic")).toBeTruthy();
    expect(
      screen.getByText("7 days (14 days after the next Cloud run)"),
    ).toBeTruthy();
    expect(screen.getByText("Earliest restorable")).toBeTruthy();
    expect(
      screen.getByText(/Dump backups to a Destination are Server-only for now/),
    ).toBeTruthy();
    const link = screen.getByText("Open in the RDS console").closest("a");
    expect(link?.getAttribute("href")).toBe(RDS.consoleUrl);
    expect(link?.getAttribute("target")).toBe("_blank");
    // No Restore button: a restore makes a new instance, in the console.
    expect(screen.queryByRole("button", { name: /Restore/ })).toBeNull();
  });

  it("edits an RDS retention through its RDS settings", async () => {
    read.mockResolvedValue(RDS);
    renderTab(pg);

    fireEvent.change(await screen.findByLabelText("Days"), {
      target: { value: "21" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith("postgres", "pg-id", {
        backupRetentionDays: 21,
      }),
    );
  });

  it("shows ElastiCache's snapshots with no restorable window or console link, and edits its snapshot retention", async () => {
    read.mockResolvedValue({
      ...RDS,
      engine: "elasticache",
      identifier: "cloudgate-redisxid",
      retentionDays: 1,
      liveRetentionDays: 1,
      restorableWindow: null,
      consoleUrl: null,
      snapshots: [
        {
          id: "automatic.cloudgate-redisxid-2026-10-15-05-00",
          type: "automated",
          createdAt: "2026-10-15T05:03:12.000Z",
          status: "available",
          size: "5 MB",
        },
      ],
    } satisfies CloudBackups);
    renderTab(cache);

    expect(
      await screen.findByText("automatic.cloudgate-redisxid-2026-10-15-05-00"),
    ).toBeTruthy();
    expect(screen.queryByText("Earliest restorable")).toBeNull();
    expect(screen.queryByText("Open in the RDS console")).toBeNull();

    fireEvent.change(screen.getByLabelText("Days"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(saveCacheSettings).toHaveBeenCalledWith("redis-id", {
        snapshotRetentionDays: 0,
      }),
    );
  });

  it("says AWS has nothing yet before the first Cloud run", async () => {
    read.mockResolvedValue({
      ...RDS,
      made: false,
      liveRetentionDays: null,
      restorableWindow: { earliest: null, latest: null },
      snapshots: [],
    } satisfies CloudBackups);
    renderTab(pg);

    expect(await screen.findByText(/AWS has nothing to list yet/)).toBeTruthy();
  });

  describe("on Google Cloud", () => {
    const CLOUD_SQL: CloudBackups = {
      engine: "cloud-sql",
      identifier: "cloudgate-pgxid",
      region: "europe-west1",
      made: true,
      retentionDays: 7,
      liveRetentionDays: 7,
      restorableWindow: {
        earliest: "2026-10-19T03:00:00.000Z",
        latest: "2026-10-26T11:05:00.000Z",
      },
      snapshots: [
        {
          id: "1761447600000",
          type: "automated",
          createdAt: "2026-10-26T03:00:00.000Z",
          status: "successful",
          size: "1.4 MB",
        },
      ],
      consoleUrl:
        "https://console.cloud.google.com/sql/instances/cloudgate-pgxid/backups?project=shop-prod",
    };

    it("shows what Cloud SQL holds and links to the Google Cloud console, with no Restore", async () => {
      read.mockResolvedValue(CLOUD_SQL);
      renderTab(pg);

      expect(await screen.findByText("1761447600000")).toBeTruthy();
      expect(screen.getByText("In Cloud SQL")).toBeTruthy();
      expect(screen.getByText("Earliest restorable")).toBeTruthy();
      expect(screen.getByText("Name in Google Cloud")).toBeTruthy();
      const link = screen
        .getByText("Open in the Google Cloud console")
        .closest("a");
      expect(link?.getAttribute("href")).toBe(CLOUD_SQL.consoleUrl);
      expect(screen.queryByRole("button", { name: /Restore/ })).toBeNull();
    });

    it("edits a Cloud SQL retention up to 365 days through its Cloud SQL settings", async () => {
      read.mockResolvedValue(CLOUD_SQL);
      renderTab(pg);

      fireEvent.change(await screen.findByLabelText("Days"), {
        target: { value: "365" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() =>
        expect(saveCloudSql).toHaveBeenCalledWith("postgres", "pg-id", {
          backupRetentionDays: 365,
        }),
      );
      expect(saveSettings).not.toHaveBeenCalled();
    });

    it("edits a Memorystore retention, 0 turning it off, through its Memorystore settings", async () => {
      read.mockResolvedValue({
        ...CLOUD_SQL,
        engine: "memorystore",
        identifier: "cloudgate-redisxid",
        retentionDays: 1,
        liveRetentionDays: 1,
        consoleUrl:
          "https://console.cloud.google.com/memorystore/valkey/locations/europe-west1/instances/cloudgate-redisxid/details?project=shop-prod",
      } satisfies CloudBackups);
      renderTab(cache);

      expect(await screen.findByText("In Memorystore")).toBeTruthy();
      fireEvent.change(screen.getByLabelText("Days"), {
        target: { value: "0" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() =>
        expect(saveMemorystore).toHaveBeenCalledWith("redis-id", {
          backupRetentionDays: 0,
        }),
      );
      expect(saveCacheSettings).not.toHaveBeenCalled();
    });
  });
});
