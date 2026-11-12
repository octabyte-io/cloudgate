import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bucket } from "@/lib/api/endpoints/buckets";
import { domainsApi, type Domain } from "@/lib/api/endpoints/domains";
import { settingsApi } from "@/lib/api/endpoints/settings";

/**
 * A Server bucket's Domains on its page, driven through the API
 * module: the reads and writes are spies on `domainsApi`; the card and its
 * dialogs are real.
 */

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));

vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: true, pending: false, role: "member" }),
}));

vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { BucketDomainsCard } = await import("./bucket-domains-card");

const BUCKET: Bucket = {
  bucketId: "bkt-1",
  name: "uploads",
  appName: "bucket-q7k2m9",
  configName: "uploads",
  description: null,
  bucketName: "uploads-a1b2c3d4",
  region: "us-east-1",
  place: { kind: "server", serverId: "srv-1", serverName: "worker" },
  serverId: "srv-1",
  volumeName: "bucket-q7k2m9-data",
  hasKey: true,
  origins: [],
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

const GENERATED = {
  domainId: "dom-1",
  host: "bucket-q7k2m9-1a2b3c-203-0-113-10.sslip.io",
  https: true,
  port: 3900,
  path: "/",
  internalPath: "/",
  stripPath: false,
  serviceName: null,
  domainType: "bucket",
  uniqueConfigKey: 1,
  certificateType: "letsencrypt",
  customCertResolver: null,
  customEntrypoint: null,
  middlewares: [],
  forwardAuthEnabled: false,
  createdAt: "2026-10-17T10:00:00.000Z",
  applicationId: null,
  composeId: null,
  bucketId: "bkt-1",
} satisfies Domain;

beforeEach(() => {
  vi.spyOn(settingsApi, "ip").mockResolvedValue("");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BucketDomainsCard bucket={BUCKET} />
    </QueryClientProvider>,
  );
}

describe("BucketDomainsCard", () => {
  it("lists the bucket's Domains, read by its own route", async () => {
    const byBucket = vi
      .spyOn(domainsApi, "byBucket")
      .mockResolvedValue([GENERATED]);
    mount();

    expect(await screen.findByText(GENERATED.host)).toBeTruthy();
    expect(byBucket).toHaveBeenCalledWith("bkt-1");
  });

  it("says presigned URLs and browser uploads do not work while it has none", async () => {
    vi.spyOn(domainsApi, "byBucket").mockResolvedValue([]);
    mount();

    expect(await screen.findByText("This bucket has no Domain")).toBeTruthy();
    expect(document.body.textContent).toContain(
      "presigned URLs and browser uploads do not work",
    );
  });

  it("adds one on Garage's S3 port, offering no port or path, under the bucket", async () => {
    vi.spyOn(domainsApi, "byBucket").mockResolvedValue([]);
    const create = vi
      .spyOn(domainsApi, "create")
      .mockResolvedValue({ ...GENERATED, host: "files.example.com" });
    mount();
    await screen.findByText("This bucket has no Domain");

    fireEvent.click(screen.getAllByRole("button", { name: /Add a domain/ })[0]);
    expect(screen.queryByLabelText(/Container port/)).toBeNull();
    expect(screen.queryByLabelText(/^Path/)).toBeNull();
    expect(document.body.textContent).toContain(
      "Routes the whole host to port 3900",
    );
    fireEvent.change(screen.getByLabelText(/Host/), {
      target: { value: "files.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add domain" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "files.example.com",
          port: 3900,
          path: "/",
          bucketId: "bkt-1",
        }),
      ),
    );
  });

  it("warns that removing its last Domain stops presigned URLs and browser uploads", async () => {
    vi.spyOn(domainsApi, "byBucket").mockResolvedValue([GENERATED]);
    mount();
    await screen.findByText(GENERATED.host);

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(
      await screen.findByText(/It is this bucket’s last Domain/),
    ).toBeTruthy();
  });
});
