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

vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: true, pending: false, role: "member" }),
}));
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ database: vi.fn() }),
}));
const saveSettings = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/lib/api/endpoints/memorystore-redis", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/memorystore-redis")>()),
  memorystoreRedisApi: { saveSettings },
}));

const { MemorystoreSettingsCard } = await import("./memorystore-settings-card");
const { memorystoreSettingsOf } =
  await import("@/lib/api/endpoints/memorystore-redis");

afterEach(() => {
  cleanup();
  saveSettings.mockClear();
});

/** A redis on Google Cloud as the API answers it, with ElastiCache's unused columns. */
const row = {
  kind: "redis",
  databaseId: "redis-id",
  environmentId: "env-1",
  name: "redis",
  cloudAccountId: "gca-1",
  region: "europe-west1",
  nodeType: "CUSTOM_PICO",
  replica: false,
  snapshotRetentionDays: 1,
  memorystore: { highAvailability: false },
} as unknown as Database;

function renderCard() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemorystoreSettingsCard
        row={row}
        settings={memorystoreSettingsOf(row)!}
      />
    </QueryClientProvider>,
  );
}

describe("MemorystoreSettingsCard", () => {
  it("reads a redis on Memorystore's setting, and none anywhere else", () => {
    expect(memorystoreSettingsOf(row)).toEqual({ highAvailability: false });
    expect(
      memorystoreSettingsOf({
        ...row,
        memorystore: null,
      } as unknown as Database),
    ).toBeNull();
    expect(
      memorystoreSettingsOf({
        ...row,
        kind: "postgres",
      } as unknown as Database),
    ).toBeNull();
  });

  it("is off by default, saying it doubles the node cost", () => {
    renderCard();

    expect(screen.getByText("High availability")).toBeTruthy();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(screen.getByText(/doubles the node cost/)).toBeTruthy();
    // Not ElastiCache's: no replica, snapshots or machine type here.
    expect(screen.queryByText("Replica")).toBeNull();
    expect(screen.queryByText("Snapshot retention (days)")).toBeNull();
  });

  it("turns high availability on", async () => {
    renderCard();

    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith("redis-id", {
        highAvailability: true,
      }),
    );
  });
});
