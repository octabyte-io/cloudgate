import { describe, expect, it } from "vitest";

import {
  bucketKeptNote,
  cloudBucketCopyPlace,
  cloudBucketMachine,
  type CloudBucketKept,
  teardownReportCount,
  teardownReportIsEmpty,
  UNRECLAIMED_ARTIFACT_KIND,
  type TeardownReport,
  type UnreclaimedArtifactKind,
} from "./teardown";

/**
 * The predicate that decides whether an operator ever sees what a delete left
 * behind.
 *
 * **This is the whole defect, in one function.** The response body is the last
 * place a leaked path exists — the row is gone by the time it arrives, and no
 * route will ever answer for a deleted Service. So a false "empty" here is not
 * a cosmetic miss: it is the same silent discard the console did before this
 * existed, and the operator whose Server was unreachable gets nothing.
 *
 * The healthy case matters just as much in the other direction. The backend
 * sends these fields **absent rather than empty** on purpose, so that the field
 * means *"these were left behind"* and not *"this route can leak things"*. A
 * report that answered "not empty" for `{}` would put a red panel in front of
 * every successful delete in the product.
 */
describe("teardownReportIsEmpty", () => {
  it("is empty for a healthy delete, which sends none of the fields", () => {
    expect(teardownReportIsEmpty({})).toBe(true);
  });

  it("is empty for a response the caller never got", () => {
    expect(teardownReportIsEmpty(undefined)).toBe(true);
  });

  it("is empty for present-but-empty arrays, which a normalizer could produce", () => {
    expect(
      teardownReportIsEmpty({
        unreclaimedArtifacts: [],
        unreclaimedImages: [],
        orphaned: [],
        orphanedPreviews: [],
      }),
    ).toBe(true);
  });

  /**
   * One case per field, because the bug being fixed was a whole field going
   * unread. A test that only covered `unreclaimedArtifacts` would pass for a
   * predicate that dropped `orphanedPreviews` — which is exactly how
   * `orphanedPreviews` came to be its own field and exactly how it would be
   * missed again.
   */
  it.each([
    [
      "unreclaimedArtifacts",
      {
        unreclaimedArtifacts: [
          {
            kind: "traefik-config" as const,
            appName: "blog",
            serverId: null,
            path: "/etc/cloudgate/traefik/dynamic/blog.yml",
          },
        ],
      },
    ],
    [
      "unreclaimedImages",
      { unreclaimedImages: [{ serverId: "srv_1", images: ["blog:latest"] }] },
    ],
    [
      "orphaned",
      {
        orphaned: [
          { appName: "blog", serverId: "srv_1", reason: "present" as const },
        ],
      },
    ],
    [
      "orphanedPreviews",
      {
        orphanedPreviews: [
          {
            appName: "preview-blog-12",
            serverId: null,
            reason: "unknown" as const,
          },
        ],
      },
    ],
  ])("is not empty when only %s is populated", (_field, report) => {
    expect(teardownReportIsEmpty(report as TeardownReport)).toBe(false);
  });
});

describe("teardownReportCount", () => {
  it("counts images one per image rather than one per machine", () => {
    // Two machines, three images: the operator has three things to remove, and
    // the grouping is how the wire carries them, not what they act on.
    expect(
      teardownReportCount({
        unreclaimedImages: [
          { serverId: "srv_1", images: ["blog:latest", "blog:v2"] },
          { serverId: null, images: ["blog-cache"] },
        ],
      }),
    ).toBe(3);
  });

  it("sums across every field", () => {
    expect(
      teardownReportCount({
        unreclaimedArtifacts: [
          {
            kind: "file-mounts",
            appName: "blog",
            serverId: "srv_1",
            path: "/etc/cloudgate/applications/blog/files",
          },
        ],
        unreclaimedImages: [{ serverId: "srv_1", images: ["blog:latest"] }],
        orphaned: [{ appName: "blog", serverId: "srv_1", reason: "present" }],
        orphanedPreviews: [
          { appName: "preview-blog-12", serverId: null, reason: "unknown" },
        ],
      }),
    ).toBe(4);
  });
});

/**
 * Every kind the backend can send has copy here.
 *
 * `UnreclaimedArtifactKind` is a union mirrored by hand from
 * `backend/src/common/teardown-steps.ts`, so a fifth kind added there and here
 * without copy would render a bare slug — and this is the one surface where an
 * unexplained slug is expensive, because the operator has to decide what to do
 * about it with no other source of information.
 */
describe("UNRECLAIMED_ARTIFACT_KIND", () => {
  const kinds: UnreclaimedArtifactKind[] = [
    "source-tree",
    "compose-directory",
    "traefik-config",
    "patch-repo",
    "file-mounts",
    "deployment-logs",
    "network",
    "volume",
    "trace-store",
  ];

  it.each(kinds)("describes %s", (kind) => {
    expect(UNRECLAIMED_ARTIFACT_KIND[kind]?.label).toBeTruthy();
    expect(UNRECLAIMED_ARTIFACT_KIND[kind]?.note).toBeTruthy();
  });

  it("does not call a Compose's project directory a checkout that is safe to remove", () => {
    // Beside the clone it holds the Compose's file mounts and its
    // traces, which nothing regenerates.
    const { note } = UNRECLAIMED_ARTIFACT_KIND["compose-directory"];
    expect(note).toMatch(/file mounts/i);
    expect(note).not.toMatch(/safe to remove/i);
  });

  it("marks the Traefik config as the one to act on now", () => {
    // A stale dynamic-config fragment keeps advertising a public hostname that
    // answers 404 at the edge, which is the only entry that is actively wrong
    // for someone other than the operator.
    expect(
      kinds.filter((k) => UNRECLAIMED_ARTIFACT_KIND[k].urgent),
    ).toStrictEqual(["traefik-config"]);
  });
});

/**
 * A kept cloud bucket names where it stays: an AWS account, or on
 * Google Cloud its project, its key and service account destroyed.
 */
describe("a kept cloud bucket's place and note", () => {
  const onAws: CloudBucketKept = {
    bucketName: "cloudgate-uploads-1",
    because: "holds-files",
    cloud: {
      cloudAccountId: "ca-1",
      cloudAccountName: "Production AWS",
      awsAccountId: "123456789012",
      region: "eu-west-1",
    },
  };
  const onGoogle: CloudBucketKept = {
    bucketName: "cloudgate-abcdefghijkl-a1b2c3d4",
    because: "holds-files",
    cloud: {
      cloudAccountId: "ca-2",
      cloudAccountName: "Production Google",
      projectId: "shop-prod",
      region: "europe-west1",
    },
  };

  it("names an S3 bucket's AWS account", () => {
    expect(cloudBucketMachine(onAws)).toBe("AWS 123456789012, eu-west-1");
    expect(bucketKeptNote(onAws)).toContain("S3 bucket cloudgate-uploads-1");
  });

  it("names a Cloud Storage bucket's project, and says its key is gone", () => {
    expect(cloudBucketMachine(onGoogle)).toBe(
      "Google Cloud shop-prod, europe-west1",
    );
    expect(cloudBucketCopyPlace(onGoogle)).toBe("gcp shop-prod europe-west1");
    expect(bucketKeptNote(onGoogle)).toBe(
      "Cloud Storage bucket cloudgate-abcdefghijkl-a1b2c3d4 holds files, so it was kept in Google Cloud project shop-prod (Production Google), europe-west1 with Cloudgate's labels; its key and service account were destroyed. Delete it in Google Cloud once nothing needs them.",
    );
  });
});
