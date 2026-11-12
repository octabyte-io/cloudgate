import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/console/toast";
import type { Bucket, BucketDeleteReport } from "@/lib/api/endpoints/buckets";

// The toast renders through a portal nothing here reads.
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { DeleteBucketModal } = await import("./delete-bucket-modal");

afterEach(() => {
  cleanup();
  vi.mocked(toast.done).mockClear();
});

const uploads = {
  bucketId: "bkt-1",
  name: "uploads",
  appName: "bucket-q7k2m9",
  bucketName: "uploads-a1b2c3d4",
  place: { kind: "server", serverId: "srv-1", serverName: "web-1" },
} as unknown as Bucket;

/** Confirms the dialog, ticking the box when asked; what it sent and the toast said. */
async function deleteIt(answer: BucketDeleteReport, tick = false) {
  const remove = vi.fn(() => Promise.resolve(answer));
  const onDeleted = vi.fn();
  render(
    <DeleteBucketModal
      bucket={uploads}
      open
      onOpenChange={() => {}}
      remove={remove}
      onDeleted={onDeleted}
    />,
  );
  if (tick) {
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Also delete its files/ }),
    );
  }
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "uploads" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Delete bucket" }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  const [, options] = vi.mocked(toast.done).mock.calls[0];
  return { sent: remove.mock.calls[0], toast: options?.description ?? "" };
}

describe("DeleteBucketModal", () => {
  it("keeps the files unless the box is ticked, and names the bucket it kept", async () => {
    const { sent, toast: said } = await deleteIt({
      volumeLeftBehind: false,
      bucketLeftBehind: {
        bucketName: "uploads-a1b2c3d4",
        volumeName: "bucket-q7k2m9-data",
        serverId: "srv-1",
        because: "holds-files",
      },
    });

    expect(sent).toEqual([false]);
    expect(said).toContain("Bucket uploads-a1b2c3d4 holds files");
    expect(said).toContain("bucket-q7k2m9-data");
  });

  it('sends "also delete its files" when ticked, and says nothing is left', async () => {
    const { sent, toast: said } = await deleteIt(
      { volumeLeftBehind: false },
      true,
    );

    expect(sent).toEqual([true]);
    expect(said).toBe("It held no files, so nothing is left on the Server.");
  });

  it("says a bucket was kept partly emptied", async () => {
    const { toast: said } = await deleteIt(
      {
        volumeLeftBehind: false,
        bucketLeftBehind: {
          bucketName: "uploads-a1b2c3d4",
          volumeName: "bucket-q7k2m9-data",
          serverId: "srv-1",
          because: "partly-emptied",
        },
      },
      true,
    );

    expect(said).toContain("was partly emptied");
  });
});

describe("DeleteBucketModal, a bucket on AWS", () => {
  const onAws = {
    ...uploads,
    bucketName: "uploads-k3f9a2qd-123456789012-eu-central-1-an",
    place: {
      kind: "cloud",
      cloudAccountId: "ca-1",
      cloudAccountName: "Production AWS",
      cloudId: "123456789012",
      region: "eu-central-1",
    },
  } as unknown as Bucket;

  async function deleteOnAws(answer: BucketDeleteReport, tick = false) {
    const remove = vi.fn(() => Promise.resolve(answer));
    const onDeleted = vi.fn();
    render(
      <DeleteBucketModal
        bucket={onAws}
        open
        onOpenChange={() => {}}
        remove={remove}
        onDeleted={onDeleted}
      />,
    );
    if (tick) {
      fireEvent.click(
        screen.getByRole("checkbox", { name: /Also delete its files/ }),
      );
    }
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "uploads" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete bucket" }));
    await waitFor(() => expect(toast.done).toHaveBeenCalled());
    const [title, options] = vi.mocked(toast.done).mock.calls[0];
    return {
      sent: remove.mock.calls[0],
      title,
      toast: options?.description ?? "",
      onDeleted,
    };
  }

  it("names no Swarm service or volume, but the S3 bucket, its AWS account and region", () => {
    render(
      <DeleteBucketModal
        bucket={onAws}
        open
        onOpenChange={() => {}}
        remove={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    expect(screen.queryByText("Swarm service removed")).toBeNull();
    expect(screen.getByText("123456789012 (Production AWS)")).toBeTruthy();
    expect(screen.getByText("eu-central-1")).toBeTruthy();
  });

  it("names a kept bucket with its account and region, and leaves the page", async () => {
    const { toast: said, onDeleted } = await deleteOnAws({
      volumeLeftBehind: false,
      bucketLeftBehind: {
        bucketName: onAws.bucketName,
        because: "holds-files",
        cloud: {
          cloudAccountId: "ca-1",
          cloudAccountName: "Production AWS",
          awsAccountId: "123456789012",
          region: "eu-central-1",
        },
      },
    });

    expect(said).toContain(`S3 bucket ${onAws.bucketName} holds files`);
    expect(said).toContain("AWS account 123456789012");
    expect(said).toContain("eu-central-1");
    expect(said).not.toContain("volume");
    expect(onDeleted).toHaveBeenCalled();
  });

  it("stays on the bucket, reading Deleting, when a Cloud run destroys it", async () => {
    const {
      sent,
      title,
      toast: said,
      onDeleted,
    } = await deleteOnAws(
      {
        volumeLeftBehind: false,
        cloudDelete: { status: "deleting", deploymentId: "dep-1" },
      },
      true,
    );

    expect(sent).toEqual([true]);
    expect(title).toBe("Deleting uploads.");
    expect(said).toContain("empties it, then destroys it");
    expect(onDeleted).not.toHaveBeenCalled();
  });
});

describe("DeleteBucketModal, a bucket on Google Cloud", () => {
  it("names the Cloud Storage bucket, its Google Cloud project and region, not S3 or AWS", () => {
    render(
      <DeleteBucketModal
        bucket={
          {
            ...uploads,
            bucketName: "cloudgate-abc-k3f9a2qd",
            place: {
              kind: "cloud",
              cloudAccountId: "ca-2",
              cloudAccountName: "Production Google",
              cloudId: "shop-prod",
              cloud: "gcp",
              region: "europe-west1",
            },
          } as unknown as Bucket
        }
        open
        onOpenChange={() => {}}
        remove={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    expect(screen.getByText("Cloud Storage bucket")).toBeTruthy();
    expect(screen.getByText("Google Cloud project")).toBeTruthy();
    expect(screen.getByText("shop-prod (Production Google)")).toBeTruthy();
    expect(screen.getByText("europe-west1")).toBeTruthy();
    expect(screen.queryByText("S3 bucket")).toBeNull();
    expect(screen.queryByText("AWS account")).toBeNull();
    expect(
      screen.getByText(/It stays in Google Cloud with Cloudgate's labels/),
    ).toBeTruthy();
    // Its key goes before the bucket is touched, so a stopped emptying does
    // destroy something.
    expect(
      screen.getByText(
        "Destroys its HMAC key first, then empties the bucket, old versions included, and destroys it. If emptying stops partway, its key is already gone, and the bucket stays here as Delete incomplete, partly emptied.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/nothing is destroyed/)).toBeNull();
  });
});

describe("DeleteBucketModal, an existing bucket", () => {
  const existing = {
    ...uploads,
    configName: "uploads",
    bucketName: "acme-prod-uploads",
    existing: true,
    place: {
      kind: "cloud",
      cloudAccountId: "ca-1",
      cloudAccountName: "Production AWS",
      cloudId: "123456789012",
      region: "eu-west-1",
    },
  } as unknown as Bucket;

  it("offers no files box, deletes from Cloudgate only and says the bucket was left", async () => {
    const message =
      "acme-prod-uploads was left as it was, files and all; it is yours.";
    const remove = vi.fn(() =>
      Promise.resolve({
        volumeLeftBehind: false,
        bucketLeftAsItWas: { bucketName: "acme-prod-uploads", message },
      }),
    );
    const onDeleted = vi.fn();
    render(
      <DeleteBucketModal
        bucket={existing}
        open
        onOpenChange={() => {}}
        remove={remove}
        onDeleted={onDeleted}
      />,
    );

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText(/is left as\s+it was/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "uploads" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Delete from Cloudgate" }),
    );
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(remove).toHaveBeenCalledWith(false);
    const [, options] = vi.mocked(toast.done).mock.calls[0];
    expect(options?.description).toBe(message);
  });

  it("on Google Cloud says its key and account go and the grant is left, with no files box", () => {
    render(
      <DeleteBucketModal
        bucket={
          {
            ...existing,
            place: {
              kind: "cloud",
              cloudAccountId: "ca-1",
              cloudAccountName: "Production Google",
              cloudId: "shop-prod",
              cloud: "gcp",
              region: "europe-west1",
            },
          } as Bucket
        }
        open
        onOpenChange={() => {}}
        remove={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(
      screen.getByText(/the HMAC key and\s+service account it made for it/),
    ).toBeTruthy();
    expect(screen.getByText(/the grant you added on it/)).toBeTruthy();
  });
});
