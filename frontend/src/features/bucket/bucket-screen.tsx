"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { Cols } from "@/components/console/cols";
import { lockRefusal, useConfigLock } from "@/components/console/config-lock";
import { CopyButton } from "@/components/console/copy-button";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Outcome } from "@/components/console/outcome";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import { StatusPill } from "@/components/console/status-pill";
import { useForgetVisited } from "@/components/shell/recents";
import { Button } from "@/components/ui/button";
import {
  bucketsApi,
  type Bucket,
} from "@/lib/api/endpoints/buckets";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { usePermission } from "@/lib/auth/use-permission";
import { timeExact } from "@/lib/format/time";

import { BucketAccessCard } from "./bucket-access-card";
import { BucketCloudDeleteCard } from "./bucket-cloud-delete-card";
import { BucketDomainsCard } from "./bucket-domains-card";
import { BucketKeyCard } from "./bucket-key-card";
import { BucketOriginsCard } from "./bucket-origins-card";
import { BucketVolumeBackups } from "./bucket-volume-backups";
import { DeleteBucketModal } from "./delete-bucket-modal";

// The access card moved to its own file; its tests still import it from here.
export { BucketAccessCard };

const LINK =
  "font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline";

/** How often a bucket whose deploy or key rotation is under way is read again. */
const LIVE_POLL_MS = 3_000;

/**
 * A Bucket's page: its real name, where it runs and whether its key is
 * set, which the Project config owns, and the origins trusted to upload to it
 * from a browser, which Cloudgate does. Its key is never on the wire,
 * so "set" is all this page can ever say of it (ADR-0019), and Rotate key
 * replaces it without cutting a linking Service off. Its Domains are
 * managed here like any Domain. Its Delete keeps the files unless
 * asked.
 */
export function BucketScreen({ bucketId }: { bucketId: string }) {
  const { organizationId } = useActiveOrganizationId();
  const query = useQuery({
    queryKey: keys.buckets.detail(organizationId, bucketId),
    queryFn: () => bucketsApi.findOne(bucketId),
    enabled: organizationId !== null,
    refetchInterval: (state) =>
      state.state.data?.applicationStatus === "running" ||
      state.state.data?.keyRotation?.status === "running" ||
      state.state.data?.cloudDelete?.status === "deleting"
        ? LIVE_POLL_MS
        : false,
  });
  // Rise only when the row arrives after the pending shape; a cached one is
  // already there.
  const [arrives] = useState(() => query.data === undefined);

  if (query.isError) {
    return (
      <Outcome tone="info" icon="hdd" title="This bucket is not here">
        It was destroyed by a plan, or it belongs to another Organization.
      </Outcome>
    );
  }
  const bucket = query.data;
  if (!bucket) return <BucketPending />;

  return (
    <Page>
      <PageHeader
        icon="hdd"
        title={bucket.name}
        badges={
          <>
            <StatusPill status={bucket.applicationStatus} />
            <Chip>bucket</Chip>
            {bucket.existing ? <Chip>existing</Chip> : null}
          </>
        }
        actions={<DeleteBucketAction bucket={bucket} />}
        lede={
          bucket.description ??
          (bucket.existing
            ? `${onGoogle(bucket) ? "A Cloud Storage bucket" : "An S3 bucket"} made outside Cloudgate, which this Environment uses as given. Every plan looks it up; Cloudgate never changes it or its files.`
            : "Holds files other Services read and write. It is described in the Project config, which is where it changes.")
        }
      />
      {/* The cards need the column's gap: `Page` stacks nothing on its own.
          They rise once, when the row arrives after the pending shape. */}
      <Cols className={arrives ? "animate-rise" : undefined}>
        {/* A bucket on AWS's Delete, under way or incomplete. */}
        <BucketCloudDeleteCard bucket={bucket} />
        <BucketFactsCard bucket={bucket} />
        {/* An existing bucket on Google Cloud's access, checked. */}
        {bucket.googleAccess ? (
          <BucketAccessCard
            bucketName={bucket.bucketName}
            access={bucket.googleAccess}
          />
        ) : null}
        {/* An S3 bucket has no key: a linking task role reaches it. A
            Cloud Storage bucket's key is its own service account's. */}
        {hasOwnKey(bucket) ? <BucketKeyCard bucket={bucket} /> : null}
        {/* A bucket on AWS takes no Domain: only a Server bucket's routes to its Garage. */}
        {bucket.place.kind !== "cloud" ? (
          <BucketDomainsCard bucket={bucket} />
        ) : null}
        {/* An existing bucket's CORS is the operator's, set in AWS. */}
        {bucket.existing ? null : <BucketOriginsCard bucket={bucket} />}
        {/* An S3 bucket has no volume to back up. */}
        {bucket.volumeName !== null ? (
          <BucketVolumeBackups bucket={bucket} volumeName={bucket.volumeName} />
        ) : null}
      </Cols>
    </Page>
  );
}

/** The page's shape while its row is read: a header and the facts card. */
function BucketPending() {
  return (
    <Page>
      <PageHeader icon="hdd" title="Bucket" />
      <Cols>
        <Card>
          <Card.Body>
            <div className="grid gap-2.5" aria-busy="true">
              <Skeleton className="h-row" />
              <Skeleton className="h-row" />
              <Skeleton className="h-row" />
            </div>
          </Card.Body>
        </Card>
      </Cols>
    </Page>
  );
}

/**
 * The Delete button and its dialog: `service: delete`, and refused
 * while a repository-kept config describes the bucket, which is deleted by
 * removing it from the file.
 */
function DeleteBucketAction({ bucket }: { bucket: Bucket }) {
  const router = useRouter();
  const invalidate = useInvalidate();
  const forgetVisited = useForgetVisited();
  const [deleting, setDeleting] = useState(false);
  const canDelete = usePermission({ service: ["delete"] });
  const lock = useConfigLock(bucket.environmentId, "bucket", bucket.bucketId);
  // A bucket on AWS whose Delete runs, or is incomplete.
  const underWay = bucket.cloudDelete !== null;
  const remove = useMutation({
    mutationFn: (deleteFiles: boolean) =>
      bucketsApi.remove(bucket.bucketId, deleteFiles),
    onSuccess: (answer) => {
      // On AWS a Cloud run may still be deleting it: the page stays.
      if (answer.cloudDelete) {
        // (An existing bucket's never runs in AWS; on Google Cloud
        // its run destroys only the key Cloudgate made.)
        return invalidate.bucket(bucket.bucketId);
      }
      forgetVisited([bucket.bucketId]);
      return invalidate.environment({
        environmentId: bucket.environmentId,
        projectId: bucket.environment.project.projectId,
      });
    },
  });

  return (
    <>
      <Button
        variant="dngr"
        disabled={!canDelete.allowed || lock !== null || underWay}
        title={
          !canDelete.allowed
            ? "Deleting a bucket needs service: delete."
            : lock
              ? lockRefusal(lock)
              : underWay
                ? "Its Delete is under way or incomplete: Retry or Forget it."
                : undefined
        }
        onClick={() => {
          if (canDelete.allowed && lock === null && !underWay) {
            setDeleting(true);
          }
        }}
      >
        Delete
      </Button>
      <DeleteBucketModal
        bucket={bucket}
        open={deleting}
        onOpenChange={setDeleting}
        remove={(deleteFiles) => remove.mutateAsync(deleteFiles)}
        // Its row is gone, so this screen cannot stay; its Environment can.
        onDeleted={() =>
          router.push(`/environments/${bucket.environment.environmentId}`)
        }
      />
    </>
  );
}

/** Whether the bucket is on Google Cloud. */
function onGoogle(bucket: Bucket): boolean {
  return bucket.place.kind === "cloud" && bucket.place.cloud === "gcp";
}

/**
 * Whether the bucket has a key of its own, which Rotate key replaces: a
 * Server bucket's Garage key, or on Google Cloud its own service
 * account's HMAC key. An S3 bucket has none.
 */
export function hasOwnKey(bucket: Bucket): boolean {
  return bucket.place.kind !== "cloud" || bucket.place.cloud === "gcp";
}

/**
 * What a bucket is: its real name, its place and region, and its key as
 * "Set" only — the read carries no key to show.
 */
export function BucketFactsCard({ bucket }: { bucket: Bucket }) {
  const { environment } = bucket;
  return (
    <Card>
      <Card.Header title="Bucket" headingLevel={2} />
      <Card.Body>
        <KVList>
          <KVRow
            label="Real name"
            value={bucket.bucketName}
            title={bucket.bucketName}
            mono
            action={<CopyButton value={bucket.bucketName} label="bucket name" />}
          />
          {bucket.existing ? (
            <KVRow
              label="Existing bucket"
              value={
                bucket.applicationStatus === "done"
                  ? "Made outside Cloudgate; found by the last plan's lookup and never changed"
                  : "Made outside Cloudgate; no plan has looked it up yet — Check for changes"
              }
              title={bucket.applicationStatus === "done"
                  ? "Made outside Cloudgate; found by the last plan's lookup and never changed"
                  : "Made outside Cloudgate; no plan has looked it up yet — Check for changes"}
            />
          ) : null}
          <KVRow
            label="Config name"
            value={bucket.configName}
            title={bucket.configName}
            mono
          />
          <KVRow
            label={bucket.place.kind === "cloud" ? "Cloud account" : "Runs on"}
            value={placeOf(bucket)}
          />
          <KVRow label="Region" value={bucket.region} mono />
          {bucket.place.kind === "cloud" && bucket.place.cloud === "gcp" ? (
            <KVRow label="Key" value={bucket.hasKey ? "Set" : "Not made yet"} />
          ) : bucket.place.kind === "cloud" ? (
            <KVRow
              label="Access"
              value="Through each linking Service's own task role; no key"
            />
          ) : (
            <>
              <KVRow
                label="Key"
                value={bucket.hasKey ? "Set" : "Not made yet"}
              />
              <KVRow
                label="Swarm service"
                value={bucket.appName}
                title={bucket.appName}
                mono
              />
            </>
          )}
          <KVRow
            label="Environment"
            value={
              <Link
                href={`/environments/${environment.environmentId}`}
                className={LINK}
              >
                {environment.project.name} / {environment.name}
              </Link>
            }
          />
          <KVRow
            label="Created"
            value={timeExact(bucket.createdAt) ?? bucket.createdAt}
            title={timeExact(bucket.createdAt) ?? bucket.createdAt}
          />
        </KVList>
      </Card.Body>
    </Card>
  );
}

/**
 * Its place in words (ADR-0035): a Server by name, the platform host, or in
 * a Cloud account with the AWS account its name is made in or its
 * Google Cloud project. An existing bucket on Google Cloud in another
 * project is named in that project, its key in the Cloud account's.
 */
function placeOf(bucket: Bucket): React.ReactNode {
  if (bucket.place.kind === "platform-host") return "The platform host";
  if (bucket.place.kind === "cloud") {
    const account = (
      <Link href="/settings/cloud-accounts" className={LINK}>
        {bucket.place.cloudAccountName} (
        {bucket.place.cloud === "gcp" ? "Google Cloud project" : "AWS"}{" "}
        {bucket.place.cloudId})
      </Link>
    );
    if (bucket.place.bucketProjectNumber === null) return account;
    return (
      <>
        Google Cloud project number{" "}
        <span className="font-mono">{bucket.place.bucketProjectNumber}</span>;
        its key is made in {account}
      </>
    );
  }
  return (
    <Link href={`/servers/${bucket.place.serverId}`} className={LINK}>
      {bucket.place.serverName}
    </Link>
  );
}
