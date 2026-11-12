import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Bucket, BucketPlace } from "@/lib/api/endpoints/buckets";

import { BucketAccessCard, BucketFactsCard, hasOwnKey } from "./bucket-screen";

afterEach(cleanup);

function bucket(place: BucketPlace, hasKey: boolean): Bucket {
  return {
    bucketId: "bkt-1",
    name: "uploads",
    appName: "bucket-q7k2m9",
    configName: "uploads",
    description: null,
    bucketName: "uploads-a1b2c3d4",
    region: "us-east-1",
    place,
    serverId: place.kind === "server" ? place.serverId : null,
    volumeName: "bucket-q7k2m9-data",
    hasKey,
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
}

function read(place: BucketPlace, hasKey = true) {
  const { container } = render(
    <BucketFactsCard bucket={bucket(place, hasKey)} />,
  );
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

describe("BucketFactsCard", () => {
  it("shows the real name, the Server it runs on, its region and its key as set", () => {
    const text = read({
      kind: "server",
      serverId: "srv-1",
      serverName: "storage-box",
    });
    expect(text).toContain("Real nameuploads-a1b2c3d4");
    expect(text).toContain("Runs onstorage-box");
    expect(text).toContain("Regionus-east-1");
    expect(text).toContain("KeySet");
  });

  it("names the platform host, and a key Garage has not made yet", () => {
    const text = read({ kind: "platform-host" }, false);
    expect(text).toContain("Runs onThe platform host");
    expect(text).toContain("KeyNot made yet");
  });

  it("names an S3 bucket's Cloud account and AWS account, and the role that reaches it, never a key", () => {
    const text = read(
      {
        kind: "cloud",
        cloudAccountId: "ca-1",
        cloudAccountName: "Production AWS",
        cloudId: "123456789012",
        cloud: "aws",
        region: "eu-central-1",
        bucketProjectNumber: null,
      },
      false,
    );
    expect(text).toContain("Cloud accountProduction AWS (AWS 123456789012)");
    expect(text).toContain("Through each linking Service's own task role");
    expect(text).not.toContain("Key");
    expect(text).not.toContain("Swarm service");
  });

  it("names a Cloud Storage bucket's Google Cloud project, and its own key as set", () => {
    const text = read({
      kind: "cloud",
      cloudAccountId: "ca-2",
      cloudAccountName: "Production Google",
      cloudId: "shop-prod",
      cloud: "gcp",
      region: "europe-west1",
      bucketProjectNumber: null,
    });
    expect(text).toContain(
      "Cloud accountProduction Google (Google Cloud project shop-prod)",
    );
    expect(text).toContain("KeySet");
    expect(text).not.toContain("task role");
    expect(text).not.toContain("Swarm service");
  });

  it("names an existing Google bucket in another project by that project, its key in the Cloud account's", () => {
    const text = read({
      kind: "cloud",
      cloudAccountId: "ca-2",
      cloudAccountName: "Production Google",
      cloudId: "shop-prod",
      cloud: "gcp",
      region: "europe-west1",
      bucketProjectNumber: "987654321098",
    });
    expect(text).toContain(
      "Cloud accountGoogle Cloud project number 987654321098; its key is made in Production Google (Google Cloud project shop-prod)",
    );
  });
});

describe("hasOwnKey", () => {
  const place = (cloud: "aws" | "gcp"): BucketPlace => ({
    kind: "cloud",
    cloudAccountId: "ca-1",
    cloudAccountName: "Production",
    cloudId: "123456789012",
    cloud,
    region: "eu-central-1",
    bucketProjectNumber: null,
  });

  it("offers Rotate key on a Server bucket and a Cloud Storage one, never on S3", () => {
    expect(hasOwnKey(bucket({ kind: "platform-host" }, true))).toBe(true);
    expect(hasOwnKey(bucket(place("gcp"), true))).toBe(true);
    expect(hasOwnKey(bucket(place("aws"), false))).toBe(false);
  });
});

describe("BucketAccessCard", () => {
  const grant =
    "gcloud storage buckets add-iam-policy-binding gs://acme-prod-uploads --member=serviceAccount:cloudgate-abc@shop-prod.iam.gserviceaccount.com --role=roles/storage.objectUser";
  const access = (
    status: "waiting" | "ok" | "no-access",
    sentence: string | null,
  ) => ({
    status,
    checkedAt: null,
    serviceAccount: "cloudgate-abc@shop-prod.iam.gserviceaccount.com",
    grant,
    sentence,
  });
  const shown = (one: ReturnType<typeof access>) => {
    const text = render(
      <BucketAccessCard bucketName="acme-prod-uploads" access={one} />,
    ).container.textContent;
    cleanup();
    return text;
  };

  it("shows an existing bucket's access, the sentence while it has none, and always the exact grant", () => {
    const waiting = shown(access("waiting", "Waiting for access: grant it"));
    expect(waiting).toContain("StatusWaiting for access");
    expect(waiting).toContain("Waiting for access: grant it");
    expect(waiting).toContain(grant);

    const ok = shown(access("ok", null));
    expect(ok).toContain("StatusIts key reaches the bucket");
    expect(ok).toContain(grant);

    const lost = shown(access("no-access", "No access: grant it again"));
    expect(lost).toContain("StatusNo access");
    expect(lost).toContain("No access: grant it again");
  });
});
