import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bucketsApi,
  type Bucket,
  type BucketCloudDelete,
} from "@/lib/api/endpoints/buckets";

/**
 * A bucket on AWS's Delete on its page: Deleting while its Cloud run
 * runs, and Delete incomplete — a bucket "partly emptied" — with Retry and
 * Forget, each a spy on `bucketsApi`.
 */

const push = vi.hoisted(() => vi.fn());
const permission = vi.hoisted(() => ({ allowed: true }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));
vi.mock("@/lib/auth/use-permission", () => ({
  usePermission: () => ({ ...permission, pending: false, role: "owner" }),
}));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { BucketCloudDeleteCard, BUCKET_FORGET_WARNING } =
  await import("./bucket-cloud-delete-card");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  push.mockReset();
  permission.allowed = true;
});

const BUCKET_NAME = "uploads-k3f9a2qd-123456789012-eu-central-1-an";

const partlyEmptied: BucketCloudDelete = {
  status: "incomplete",
  deploymentId: "dep-1",
  deleteFiles: true,
  unfinished: null,
  left: [
    {
      type: "s3",
      awsId: `arn:aws:s3:::${BUCKET_NAME}`,
      region: "eu-central-1",
      tag: "cloudgate:state=st-1",
      because: "partly-emptied",
    },
  ],
};

function mount(cloudDelete: BucketCloudDelete | null) {
  const bucket = {
    bucketId: "bkt-1",
    name: "uploads",
    bucketName: BUCKET_NAME,
    environmentId: "env-1",
    environment: {
      environmentId: "env-1",
      name: "production",
      project: { projectId: "prj-1", name: "Shop" },
    },
    cloudDelete,
  } as unknown as Bucket;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BucketCloudDeleteCard bucket={bucket} />
    </QueryClientProvider>,
  );
}

describe("BucketCloudDeleteCard", () => {
  it("shows nothing without a Delete", () => {
    const { container } = mount(null);
    expect(container.textContent).toBe("");
  });

  it("reads Deleting while its Cloud run empties and destroys it", () => {
    mount({ ...partlyEmptied, status: "deleting", left: [] });
    expect(screen.getByText("Deleting uploads")).toBeTruthy();
    expect(
      screen.getByText("A Cloud run is emptying it, then destroying it."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("lists a partly emptied bucket as left, and Retry empties it again", async () => {
    const retry = vi
      .spyOn(bucketsApi, "retryDelete")
      .mockResolvedValue({ volumeLeftBehind: false });
    mount(partlyEmptied);

    expect(screen.getByText("Delete incomplete")).toBeTruthy();
    expect(screen.getByText(`arn:aws:s3:::${BUCKET_NAME}`)).toBeTruthy();
    expect(
      screen.getByText("Partly emptied: it still holds files"),
    ).toBeTruthy();
    expect(
      screen.getByText(/Retry empties the bucket again, then destroys it/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith("bkt-1"));
  });

  it("Forget warns that what is left may bill, then drops the bucket", async () => {
    const forget = vi
      .spyOn(bucketsApi, "forgetDelete")
      .mockResolvedValue({ bucketId: "bkt-1", forgotten: partlyEmptied.left });
    mount(partlyEmptied);

    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(screen.getByText(BUCKET_FORGET_WARNING)).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: "Forget" });
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(forget).toHaveBeenCalledWith("bkt-1"));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/environments/env-1"),
    );
  });

  it("refuses Retry and Forget without service: delete", () => {
    permission.allowed = false;
    mount(partlyEmptied);
    for (const name of ["Retry", "Forget"]) {
      const button = screen.getByRole("button", { name });
      expect(
        (button as HTMLButtonElement).disabled ||
          button.getAttribute("aria-disabled") === "true",
      ).toBe(true);
    }
    expect(
      screen.getByText(
        "Retry and Forget need service: delete, as the Delete does.",
      ),
    ).toBeTruthy();
  });
});
