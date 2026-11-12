import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";

const existingReach = vi.fn();

vi.mock("@/lib/api/endpoints/buckets", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/buckets")>()),
  bucketsApi: {
    existingReach: (...args: unknown[]) => existingReach(...args),
    createExisting: vi.fn(),
  },
}));

vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org_1" }),
}));

vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: true }),
}));

vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ environment: vi.fn(), environmentPlan: vi.fn() }),
}));

const { UseExistingBucketModal } = await import("./use-existing-bucket-modal");

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function show() {
  render(
    <UseExistingBucketModal
      open
      onOpenChange={() => {}}
      environmentId="env_1"
      configName="uploads"
    />,
    { wrapper: Wrapper },
  );
}

/** Every word of the dialog, in one line. */
const text = () => (document.body.textContent ?? "").replace(/\s+/g, " ");

/**
 * Which cloud's words the dialog uses comes from the Environment's reach
 * so it says neither S3's nor Cloud Storage's while that read is
 * refused or still on its way (CODING_STANDARDS §3.5: error, then pending,
 * then the answer).
 */
describe("UseExistingBucketModal", () => {
  beforeEach(() => {
    existingReach.mockReset();
  });
  afterEach(cleanup);

  it("says why the reach could not be read, in AWS's words nowhere", async () => {
    existingReach.mockRejectedValue(
      new ApiError(403, "Your role cannot read this"),
    );
    show();

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(text()).not.toContain("S3");
    expect(text()).not.toContain("task role");
    expect(text()).toContain("A bucket you already have.");
  });

  it("names no cloud while the reach is on its way", () => {
    existingReach.mockReturnValue(new Promise(() => {}));
    show();

    expect(text()).not.toContain("S3");
    expect(text()).not.toContain("Cloud Storage");
    expect(text()).toContain("As the cloud's console lists it");
  });

  it("speaks of S3 once the reach answers for AWS", async () => {
    existingReach.mockResolvedValue({ google: null });
    show();

    expect(
      await screen.findByText(/An S3 bucket you already have/),
    ).toBeTruthy();
    expect(text()).toContain("their task role reads and writes its objects");
  });

  it("speaks of Cloud Storage and its read grant once the reach answers for Google Cloud", async () => {
    existingReach.mockResolvedValue({
      google: {
        projectId: "shop-prod",
        readGrant:
          "gcloud storage buckets add-iam-policy-binding gs://<bucket> --role=roles/storage.legacyBucketReader",
      },
    });
    show();

    expect(
      await screen.findByText(/A Cloud Storage bucket you already have/),
    ).toBeTruthy();
    expect(text()).toContain("roles/storage.legacyBucketReader");
    expect(text()).not.toContain("S3");
  });
});
