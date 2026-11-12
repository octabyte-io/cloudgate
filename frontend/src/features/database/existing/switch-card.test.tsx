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
const redisApi = vi.hoisted(() => ({
  switchToMade: vi.fn(async () => ({})),
  cancelSwitch: vi.fn(async () => ({})),
}));
vi.mock("@/lib/api/endpoints/existing-redis", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/existing-redis")>()),
  existingRedisApi: redisApi,
}));

const { DatabaseSwitchCard } = await import("./switch-card");

afterEach(() => {
  cleanup();
  redisApi.switchToMade.mockClear();
  redisApi.cancelSwitch.mockClear();
});

const madeCache = {
  kind: "redis",
  databaseId: "redis-id",
  environmentId: "env-1",
  name: "cache",
  configName: "cache",
  cloudAccountId: "ca-1",
  existing: null,
  switch: null,
} as unknown as Database;

const existingCache = {
  ...madeCache,
  cloudAccountId: null,
  existing: {
    identifier: "acme-cache",
    cloudAccountId: "ca-1",
    region: "eu-central-1",
    madeReachable: false,
    tls: true,
    address: null,
  },
} as unknown as Database;

function renderCard(row: Database) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DatabaseSwitchCard row={row} />
    </QueryClientProvider>,
  );
}

describe("DatabaseSwitchCard on a redis", () => {
  it("offers a cache Cloudgate made on ElastiCache an existing cache instead", () => {
    renderCard(madeCache);

    expect(screen.getByText("Switch cache")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Use an existing cache instead" }),
    ).toBeTruthy();
  });

  it("asks the next plan to make a cache instead of an existing one", async () => {
    renderCard(existingCache);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Switch to a cache Cloudgate makes",
      }),
    );

    await waitFor(() =>
      expect(redisApi.switchToMade).toHaveBeenCalledWith("redis-id"),
    );
  });

  it("reads a switch asked for, with its cancel", async () => {
    renderCard({
      ...existingCache,
      switch: {
        to: "made",
        identifier: null,
        sentence:
          "The next plan switches cache to a cache Cloudgate makes: its Apply removes only Cloudgate's records of acme-cache, which is left as it was, and no data is copied",
      },
    } as unknown as Database);

    expect(
      screen.getByText(
        /The next plan switches cache to a cache Cloudgate makes/,
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel the switch" }));

    await waitFor(() =>
      expect(redisApi.cancelSwitch).toHaveBeenCalledWith("redis-id"),
    );
  });

  it("shows nothing on a redis on a Server", () => {
    renderCard({ ...madeCache, cloudAccountId: null } as unknown as Database);

    expect(screen.queryByText("Switch cache")).toBeNull();
  });
});
