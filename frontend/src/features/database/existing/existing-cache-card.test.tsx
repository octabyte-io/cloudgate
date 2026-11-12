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
const update = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/lib/api/endpoints/existing-redis", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/existing-redis")>()),
  existingRedisApi: { update },
}));

const { ExistingCacheCard } = await import("./existing-cache-card");
const { existingCacheOf, existingPlaceOf } =
  await import("@/lib/api/endpoints/existing-redis");

afterEach(() => {
  cleanup();
  update.mockClear();
});

const row = {
  kind: "redis",
  databaseId: "redis-id",
  environmentId: "env-1",
  name: "cache",
  hasAuthToken: true,
  existing: {
    identifier: "acme-cache",
    cloudAccountId: "ca-1",
    region: "eu-central-1",
    madeReachable: false,
    tls: true,
    address: {
      host: "master.acme-cache.x1y2z3.euc1.cache.amazonaws.com",
      port: 6379,
    },
  },
} as unknown as Database;

function renderCard() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ExistingCacheCard row={row} existing={existingCacheOf(row)!} />
    </QueryClientProvider>,
  );
}

describe("ExistingCacheCard", () => {
  it("reads an existing cache off a redis row, and none off a postgres", () => {
    expect(existingCacheOf(row)?.identifier).toBe("acme-cache");
    expect(existingPlaceOf(row)).toMatchObject({ identifier: "acme-cache" });
    expect(
      existingCacheOf({ ...row, kind: "postgres" } as unknown as Database),
    ).toBeNull();
  });

  it("shows where it was found, its scheme and only that its token is set", () => {
    renderCard();

    expect(screen.getByText("acme-cache")).toBeTruthy();
    expect(
      screen.getByText(
        "master.acme-cache.x1y2z3.euc1.cache.amazonaws.com:6379",
      ),
    ).toBeTruthy();
    expect(screen.getByText("On (rediss://)")).toBeTruthy();
    expect(screen.getByText("Set")).toBeTruthy();
  });

  it("saves a new token, and leaves a blank one out", async () => {
    renderCard();

    fireEvent.change(screen.getByLabelText(/^AUTH token/), {
      target: { value: "another-auth-token-0123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith("redis-id", {
      identifier: "acme-cache",
      authToken: "another-auth-token-0123",
      tls: true,
      madeReachable: false,
    });
  });
});

describe("ExistingCacheCard, an existing Valkey on Google Cloud", () => {
  const command =
    "gcloud memorystore instances update orders-cache --location=europe-west1 --project=shop-prod --add-endpoints='[]'";
  const valkey = {
    ...row,
    hasAuthToken: false,
    existing: {
      identifier: "shop-prod/europe-west1/orders-cache",
      cloudAccountId: "ca-1",
      region: "europe-west1",
      madeReachable: false,
      tls: true,
      address: { host: "10.64.16.20", port: 6379 },
      registration: {
        status: "waiting",
        sentence:
          "Cloudgate's two endpoints to shop-prod/europe-west1/orders-cache are made and waiting for registration",
        command,
        checkedAt: null,
        endpoints: [],
      },
    },
  } as unknown as Database;

  function renderValkey(of: Database) {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ExistingCacheCard row={of} existing={existingCacheOf(of)!} />
      </QueryClientProvider>,
    );
  }

  it("shows the --add-endpoints command while it waits for registration, and no AUTH token", () => {
    renderValkey(valkey);

    expect(screen.getByRole("status").textContent).toContain(
      "waiting for registration",
    );
    expect(screen.getByText(command)).toBeTruthy();
    expect(
      screen.getByText(
        "Through Cloudgate's two endpoints, waiting for registration",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("AUTH token")).toBeNull();
  });

  it("shows no command once both endpoints are registered", () => {
    renderValkey({
      ...valkey,
      existing: {
        ...(valkey as unknown as { existing: object }).existing,
        registration: {
          status: "registered",
          sentence: null,
          command: null,
          checkedAt: null,
          endpoints: [],
        },
      },
    } as unknown as Database);

    expect(screen.queryByText(command)).toBeNull();
    expect(
      screen.getByText(
        "Through Cloudgate's two endpoints, registered on the instance",
      ),
    ).toBeTruthy();
  });

  it("saves only a new instance name", async () => {
    renderValkey(valkey);

    fireEvent.change(screen.getByLabelText(/Instance name/), {
      target: { value: "shop-prod/europe-west1/other-cache" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith("redis-id", {
      identifier: "shop-prod/europe-west1/other-cache",
    });
  });
});
