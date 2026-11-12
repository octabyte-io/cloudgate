import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bucketsApi,
  type Bucket,
  type KeyRotation,
} from "@/lib/api/endpoints/buckets";

/**
 * A bucket's Rotate key, driven through the API module: the press is
 * a spy on `bucketsApi.rotateKey`; the card and its dialog are real.
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

const { BucketKeyCard, ROTATE_REFUSAL } = await import("./bucket-key-card");

function bucket(keyRotation: KeyRotation | null, hasKey = true): Bucket {
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
    hasKey,
    origins: [],
    keyRotation,
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

const redeploy = (configName: string, outcome: "done" | "failed" | null) => ({
  configName,
  serviceType: "application" as const,
  serviceId: `app-${configName}`,
  deploymentId: `dep-${configName}`,
  queuedAt: "2026-10-17T10:00:00.000Z",
  outcome,
});

const rotation = (change: Partial<KeyRotation>): KeyRotation => ({
  status: "running",
  phase: "redeploying",
  startedAt: "2026-10-17T10:00:00.000Z",
  finishedAt: null,
  queued: true,
  redeploys: [],
  putBacks: [],
  failed: [],
  message: null,
  ...change,
});

let rotate: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  refused.current = false;
  rotate = vi.spyOn(bucketsApi, "rotateKey").mockResolvedValue(bucket(null));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(found: Bucket) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BucketKeyCard bucket={found} />
    </QueryClientProvider>,
  );
}

const rotateButton = () =>
  screen.getAllByRole("button", { name: "Rotate key" })[0];

describe("BucketKeyCard", () => {
  it("rotates only once the dialog is confirmed", async () => {
    mount(bucket(null));
    expect(screen.getByText("Never rotated")).toBeTruthy();
    fireEvent.click(rotateButton());
    expect(rotate).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/the old key stays, the new one is removed/),
    ).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: "Rotate key" });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(rotate).toHaveBeenCalledWith("bkt-1"));
  });

  it("lists each redeploy of a running rotation, and is off until it ends", () => {
    mount(
      bucket(
        rotation({
          redeploys: [redeploy("web", "done"), redeploy("api", null)],
        }),
      ),
    );
    expect(
      screen.getByText("Running — redeploying the Services that link it"),
    ).toBeTruthy();
    const list = screen.getByRole("list", { name: "Redeploys" });
    expect(list.textContent).toContain("webDeployed");
    expect(list.textContent).toContain("apiDeploying");
    expect(rotateButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("names the Service whose redeploy failed", () => {
    const message =
      "The redeploy of web failed, so the old key stays in use and the new key was removed — fix web, then rotate again";
    mount(
      bucket(
        rotation({
          status: "failed",
          phase: null,
          finishedAt: "2026-10-17T10:05:00.000Z",
          failed: ["web"],
          message,
        }),
      ),
    );
    expect(screen.getByText(message)).toBeTruthy();
    expect(rotateButton().getAttribute("aria-disabled")).not.toBe("true");
  });

  it("rotates a Cloud Storage bucket's HMAC key, saying the old one is turned off and deleted", async () => {
    const onGoogle: Bucket = {
      ...bucket(null),
      bucketName: "cloudgate-33lu2dv74xuy-k3f9a2qd",
      region: "europe-west1",
      volumeName: null,
      place: {
        kind: "cloud",
        cloudAccountId: "ca-2",
        cloudAccountName: "Production Google",
        cloudId: "shop-prod",
        cloud: "gcp",
        region: "europe-west1",
        bucketProjectNumber: null,
      },
    };
    mount(onGoogle);
    fireEvent.click(rotateButton());
    expect(
      await screen.findByText(
        "Cloudgate makes a new HMAC key for the bucket's own service account, beside the one in use.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/old key turned off and deleted/)).toBeTruthy();
    expect(screen.queryByText(/Garage/)).toBeNull();
    const buttons = screen.getAllByRole("button", { name: "Rotate key" });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(rotate).toHaveBeenCalledWith("bkt-1"));
    cleanup();

    mount({ ...onGoogle, hasKey: false });
    expect(rotateButton().getAttribute("title")).toBe(
      "This bucket's Cloud run makes its key with it; there is none to rotate yet.",
    );
  });

  it("is off, saying why, for a role without service update and for a bucket with no key", () => {
    refused.current = true;
    mount(bucket(null));
    expect(rotateButton().getAttribute("aria-disabled")).toBe("true");
    expect(rotateButton().getAttribute("title")).toBe(ROTATE_REFUSAL);
    cleanup();

    refused.current = false;
    mount(bucket(null, false));
    expect(rotateButton().getAttribute("aria-disabled")).toBe("true");
  });
});
