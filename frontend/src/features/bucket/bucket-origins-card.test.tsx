import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import { bucketsApi, type Bucket } from "@/lib/api/endpoints/buckets";

/**
 * A bucket's browser-upload origins, driven through the API module:
 * the write is a spy on `bucketsApi.putOrigins`; the card is real.
 */

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));

const refused = vi.hoisted(() => ({ current: false }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: (required: Record<string, string[]>) => ({
    allowed: !(refused.current && required.service?.includes("update")),
    pending: false,
    role: "member",
  }),
}));

vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { BucketOriginsCard, ORIGINS_REFUSAL } =
  await import("./bucket-origins-card");

function bucket(origins: string[]): Bucket {
  return {
    bucketId: "bkt-1",
    name: "uploads",
    appName: "bucket-q7k2m9",
    configName: "uploads",
    description: null,
    bucketName: "uploads-a1b2c3d4",
    region: "us-east-1",
    place: { kind: "platform-host" },
    serverId: null,
    volumeName: "bucket-q7k2m9-data",
    hasKey: true,
    origins,
    keyRotation: null,
    cloudDelete: null,
    existing: false,
    googleAccess: null,
    applicationStatus: "done",
    createdAt: "2026-10-17T10:00:00.000Z",
    environmentId: "env-1",
    environment: {
      environmentId: "env-1",
      name: "production",
      project: { projectId: "prj-1", name: "storefront" },
    },
  };
}

let put: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  refused.current = false;
  put = vi.spyOn(bucketsApi, "putOrigins").mockResolvedValue(bucket([]));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(origins: string[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BucketOriginsCard bucket={bucket(origins)} />
    </QueryClientProvider>,
  );
}

describe("BucketOriginsCard", () => {
  it("says no browser can upload while no origin is trusted", () => {
    mount([]);
    expect(
      screen.getByText(/No origin is trusted, so no browser can upload/),
    ).toBeTruthy();
  });

  it("adds an origin by sending the whole list", async () => {
    mount(["https://shop.example.com"]);
    fireEvent.change(screen.getByLabelText(/^Origin/), {
      target: { value: " http://localhost:3000 " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add origin" }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("bkt-1", [
        "https://shop.example.com",
        "http://localhost:3000",
      ]),
    );
  });

  it("removes one by sending the list without it", async () => {
    mount(["https://shop.example.com", "http://localhost:3000"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove https://shop.example.com" }),
    );
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("bkt-1", ["http://localhost:3000"]),
    );
  });

  it("shows the server's refusal of a malformed origin, naming it", async () => {
    const message =
      '"shop.example.com" is not a web origin — write it as a browser sends it, scheme://host or scheme://host:port, with no path';
    put.mockRejectedValue(new ApiError(400, message));
    mount([]);
    fireEvent.change(screen.getByLabelText(/^Origin/), {
      target: { value: "shop.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add origin" }));
    expect(await screen.findByText(`${message}.`)).toBeTruthy();
  });

  it("turns both controls off, saying why, for a role without service update", () => {
    refused.current = true;
    mount(["https://shop.example.com"]);
    expect(
      screen
        .getByRole("button", { name: "Remove https://shop.example.com" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Add origin" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.getByText(ORIGINS_REFUSAL)).toBeTruthy();
  });
});
