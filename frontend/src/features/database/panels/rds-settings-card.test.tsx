import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/api/endpoints/databases";
import type { RdsPostgresSettings } from "@/lib/api/endpoints/rds-postgres";

vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: true, pending: false, role: "member" }),
}));
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ database: vi.fn() }),
}));
const saveSettings = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/lib/api/endpoints/rds-postgres", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/rds-postgres")>()),
  rdsPostgresApi: { saveSettings },
}));

const { RdsSettingsCard } = await import("./rds-settings-card");
const { rdsSettingsOf } = await import("@/lib/api/endpoints/rds-postgres");

afterEach(() => {
  cleanup();
  saveSettings.mockClear();
});

const row = {
  kind: "postgres",
  databaseId: "pg-id",
  environmentId: "env-1",
  name: "pg-1",
  cloudAccountId: "ca-1",
  region: "eu-central-1",
  instanceClass: null,
  storageGb: 20,
  maxStorageGb: 200,
  multiAz: false,
  backupRetentionDays: 7,
} as unknown as Database;

function renderCard(settings: RdsPostgresSettings, on: Database = row) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RdsSettingsCard row={on} settings={settings} />
    </QueryClientProvider>,
  );
}

const settings = rdsSettingsOf(row)!;

describe("RdsSettingsCard", () => {
  it("reads a postgres on RDS's settings, and none off RDS", () => {
    expect(settings).toEqual({
      instanceClass: null,
      storageGb: 20,
      maxStorageGb: 200,
      multiAz: false,
      backupRetentionDays: 7,
    });
    expect(
      rdsSettingsOf({ ...row, cloudAccountId: null } as unknown as Database),
    ).toBeNull();
  });

  it("offers no machine type when the config's size decides it", () => {
    renderCard(settings);

    expect(screen.queryByText("Machine type")).toBeNull();
    expect(screen.getByText(/Its class comes from size/)).toBeTruthy();
  });

  it("offers the machine type when the entry has no size", () => {
    renderCard({ ...settings, instanceClass: "db.t4g.micro" });

    expect(screen.getByText("Machine type")).toBeTruthy();
  });

  it("refuses a retention of 0 before it is sent", async () => {
    renderCard(settings);

    fireEvent.change(screen.getByLabelText("Backup retention (days)"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    // The field's own `min` holds it, or the schema's sentence does.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("saves the settings, without a class the size decides", async () => {
    renderCard(settings);

    fireEvent.change(screen.getByLabelText("Storage (GB)"), {
      target: { value: "50" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith("postgres", "pg-id", {
        storageGb: 50,
        maxStorageGb: 200,
        multiAz: false,
        backupRetentionDays: 7,
      }),
    );
  });

  it("reads and saves a mysql on RDS's settings through its own route", async () => {
    const mysql = { ...row, kind: "mysql", databaseId: "my-id" } as Database;
    const own = rdsSettingsOf(mysql)!;
    expect(own).toEqual(settings);
    renderCard(own, mysql);

    expect(screen.getByText(/How RDS runs this mysql/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Storage (GB)"), {
      target: { value: "50" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith("mysql", "my-id", {
        storageGb: 50,
        maxStorageGb: 200,
        multiAz: false,
        backupRetentionDays: 7,
      }),
    );
  });
});
