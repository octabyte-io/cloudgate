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
import type { ElastiCacheRedisSettings } from "@/lib/api/endpoints/elasticache-redis";

vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: true, pending: false, role: "member" }),
}));
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ database: vi.fn() }),
}));
const saveSettings = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/lib/api/endpoints/elasticache-redis", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/elasticache-redis")>()),
  elastiCacheRedisApi: { saveSettings },
}));

const { ElastiCacheSettingsCard } = await import("./elasticache-settings-card");
const { elastiCacheSettingsOf } =
  await import("@/lib/api/endpoints/elasticache-redis");

afterEach(() => {
  cleanup();
  saveSettings.mockClear();
});

const row = {
  kind: "redis",
  databaseId: "redis-id",
  environmentId: "env-1",
  name: "redis",
  cloudAccountId: "ca-1",
  region: "eu-central-1",
  nodeType: null,
  replica: false,
  snapshotRetentionDays: 1,
} as unknown as Database;

function renderCard(settings: ElastiCacheRedisSettings) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ElastiCacheSettingsCard row={row} settings={settings} />
    </QueryClientProvider>,
  );
}

const settings = elastiCacheSettingsOf(row)!;

describe("ElastiCacheSettingsCard", () => {
  it("reads a redis on ElastiCache's settings, and none off ElastiCache", () => {
    expect(settings).toEqual({
      nodeType: null,
      replica: false,
      snapshotRetentionDays: 1,
    });
    expect(
      elastiCacheSettingsOf({
        ...row,
        cloudAccountId: null,
      } as unknown as Database),
    ).toBeNull();
    expect(
      elastiCacheSettingsOf({
        ...row,
        kind: "postgres",
      } as unknown as Database),
    ).toBeNull();
  });

  it("offers no machine type when the config's size decides it", () => {
    renderCard(settings);

    expect(screen.queryByText("Machine type")).toBeNull();
    expect(screen.getByText(/Its node type comes from size/)).toBeTruthy();
  });

  it("offers the machine type when the entry has no size", () => {
    renderCard({ ...settings, nodeType: "cache.t4g.micro" });

    expect(screen.getByText("Machine type")).toBeTruthy();
  });

  it("refuses a retention above 35 before it is sent", async () => {
    renderCard(settings);

    fireEvent.change(screen.getByLabelText("Snapshot retention (days)"), {
      target: { value: "36" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("saves 0 as snapshots off, without a node type the size decides", async () => {
    renderCard(settings);

    fireEvent.change(screen.getByLabelText("Snapshot retention (days)"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith("redis-id", {
        replica: false,
        snapshotRetentionDays: 0,
      }),
    );
  });

  it("turns the replica on", async () => {
    renderCard(settings);

    // The card's one switch, beside its "Replica" label.
    expect(screen.getByText("Replica")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith("redis-id", {
        replica: true,
        snapshotRetentionDays: 1,
      }),
    );
  });
});
