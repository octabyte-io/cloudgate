import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bucket } from "@/lib/api/endpoints/buckets";
import { destinationsApi } from "@/lib/api/endpoints/destinations";
import { volumeBackupsApi } from "@/lib/api/endpoints/volume-backups";

/**
 * A Server bucket's volume backups: the list, Run now and the run
 * history every Service has, and a Restore whose dialog unpacks a tarball
 * over the bucket's volume, its Garage stopped by the restore itself.
 */

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));

const refused = vi.hoisted(() => ({ current: false }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: (required: Record<string, string[]>) => ({
    allowed: !(refused.current && required.volumeBackup?.includes("restore")),
    pending: false,
    role: "member",
  }),
}));

vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { BucketVolumeBackups, RESTORE_REFUSAL } =
  await import("./bucket-volume-backups");

const uploads: Bucket = {
  bucketId: "bkt-1",
  name: "uploads",
  appName: "bucket-q7k2m9",
  configName: "uploads",
  description: null,
  bucketName: "uploads-a1b2c3d4",
  region: "us-east-1",
  place: { kind: "server", serverId: "srv-1", serverName: "storage-box" },
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

function renderBackups() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BucketVolumeBackups bucket={uploads} volumeName="bucket-q7k2m9-data" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  refused.current = false;
  vi.spyOn(volumeBackupsApi, "listByService").mockResolvedValue([]);
  vi.spyOn(destinationsApi, "list").mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BucketVolumeBackups", () => {
  it("offers a Restore that says the bucket is stopped while its volume is replaced", async () => {
    renderBackups();

    const open = await screen.findByRole("button", {
      name: /Restore a volume/,
    });
    expect(document.body.textContent).toContain(
      "The restore stops the bucket for the unpack and starts it again",
    );

    fireEvent.click(open);

    expect(
      await screen.findByRole("dialog", { name: "Restore a volume" }),
    ).toBeTruthy();
  });

  it("holds Restore back from a role without volume backup restore", async () => {
    refused.current = true;
    renderBackups();

    const open = await screen.findByRole("button", {
      name: /Restore a volume/,
    });
    expect(open.getAttribute("aria-disabled")).toBe("true");
    expect(open.getAttribute("title")).toBe(RESTORE_REFUSAL);
  });
});
