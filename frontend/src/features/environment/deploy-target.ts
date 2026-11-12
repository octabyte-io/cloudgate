import type { PickerOption } from "@/components/console/picker";
import { CLOUD_NAMES } from "@/lib/api/endpoints/cloud-accounts";
import type { Cloud, CloudAccount } from "@/lib/api/endpoints/cloud-accounts";
import type { DeployTarget } from "@/lib/api/endpoints/environments";
import { notReadyYet } from "@/lib/api/endpoints/servers";
import type { Server } from "@/lib/api/endpoints/servers";

/**
 * The Deploy target as a `Picker` value, and back.
 *
 * The platform host is a value of its own rather than the Picker's `""`,
 * because on a new Environment `""` already means "not chosen yet" — and
 * `CONTEXT.md` is plain that the platform host is a choice made, never an
 * unset one. A Server id is a nanoid, which never spells this.
 */
export const PLATFORM_HOST_VALUE = "platform-host";

/**
 * A Cloud account's Picker value: its id behind a prefix, so it never reads as
 * a Server id.
 * The region is a field of its own.
 */
const CLOUD_PREFIX = "cloud:";

export function toPickerValue(target: DeployTarget): string {
  switch (target.kind) {
    case "server":
      return target.serverId;
    case "cloud":
      return `${CLOUD_PREFIX}${target.cloudAccountId}`;
    default:
      return PLATFORM_HOST_VALUE;
  }
}

/** The Cloud account a Picker value names, or `null` for a Server or the platform host. */
export function cloudAccountOf(value: string): string | null {
  return value.startsWith(CLOUD_PREFIX)
    ? value.slice(CLOUD_PREFIX.length)
    : null;
}

/** `null` for nothing chosen, or a Cloud account with no region yet. */
export function fromPickerValue(
  value: string,
  region = "",
): DeployTarget | null {
  if (value === "") return null;
  if (value === PLATFORM_HOST_VALUE) return { kind: "platform-host" };
  const cloudAccountId = cloudAccountOf(value);
  if (cloudAccountId === null) return { kind: "server", serverId: value };
  return region === "" ? null : { kind: "cloud", cloudAccountId, region };
}

/**
 * The Servers a Service can be created on. A build Server runs nothing, so the
 * API refuses it as a Deploy target and it is not offered.
 */
export function deployServers(
  servers: readonly Server[] | undefined,
): Server[] {
  return (servers ?? []).filter((server) => server.serverType === "deploy");
}

/**
 * The Deploy targets to offer: the platform host, then the deploy Servers, then
 * the Cloud accounts. A Bought Server that is not Ready yet is greyed out,
 * saying why ("Setting up"): the API refuses a deploy to it until then.
 *
 * `platformHost: false` on the Hosted instance, where the platform host is
 * never a Deploy target (ADR-0053): the
 * option is left out, not shown greyed, since a choice that never works is noise.
 */
export function deployTargetOptions(
  servers: readonly Server[] | undefined,
  cloudAccounts: readonly CloudAccount[] | undefined = [],
  { platformHost = true }: { platformHost?: boolean } = {},
): PickerOption[] {
  return [
    ...(platformHost
      ? [{ value: PLATFORM_HOST_VALUE, label: "This Cloudgate host" }]
      : []),
    ...deployServers(servers).map((server) => {
      const notReady = notReadyYet(server);
      return {
        value: server.serverId,
        label: server.name,
        detail: notReady ?? server.ipAddress,
        disabled: notReady !== null,
      };
    }),
    ...(cloudAccounts ?? []).map((account) => ({
      value: `${CLOUD_PREFIX}${account.cloudAccountId}`,
      label: account.name,
      detail: `${CLOUDS[account.cloud ?? "aws"].name} ${account.cloudId}`,
    })),
  ];
}

/**
 * The AWS regions a cloud Deploy target may name — the API's list
 * (`cloud-accounts/aws/regions.ts`), which refuses any other. Kept in step by
 * hand, and held equal by `backend/test/cloud-accounts/console-regions.spec.ts`:
 * a region missing here is one the console cannot offer, never one it offers
 * and the API refuses.
 */
export const AWS_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "af-south-1",
  "ap-east-1",
  "ap-south-1",
  "ap-south-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ap-southeast-5",
  "ap-southeast-7",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ca-central-1",
  "ca-west-1",
  "eu-central-1",
  "eu-central-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-south-1",
  "eu-south-2",
  "eu-north-1",
  "il-central-1",
  "me-south-1",
  "me-central-1",
  "mx-central-1",
  "sa-east-1",
] as const;

/**
 * The Google Cloud regions a cloud Deploy target may name — the API's list
 * (`cloud-accounts/gcp/regions.ts`), kept in step by hand as
 * {@link AWS_REGIONS} is. Saving one still asks the project whether Cloud Run
 * and Artifact Registry are offered there.
 */
export const GOOGLE_REGIONS = [
  "africa-south1",
  "asia-east1",
  "asia-east2",
  "asia-northeast1",
  "asia-northeast2",
  "asia-northeast3",
  "asia-south1",
  "asia-south2",
  "asia-southeast1",
  "asia-southeast2",
  "asia-southeast3",
  "australia-southeast1",
  "australia-southeast2",
  "europe-central2",
  "europe-north1",
  "europe-north2",
  "europe-southwest1",
  "europe-west1",
  "europe-west2",
  "europe-west3",
  "europe-west4",
  "europe-west6",
  "europe-west8",
  "europe-west9",
  "europe-west10",
  "europe-west12",
  "me-central1",
  "me-central2",
  "me-west1",
  "northamerica-northeast1",
  "northamerica-northeast2",
  "northamerica-south1",
  "southamerica-east1",
  "southamerica-west1",
  "us-central1",
  "us-east1",
  "us-east4",
  "us-east5",
  "us-south1",
  "us-west1",
  "us-west2",
  "us-west3",
  "us-west4",
] as const;

/** What the Deploy target card says and offers for a Cloud account, by its cloud. */
export const CLOUDS: Record<
  Cloud,
  {
    name: string;
    regionLabel: string;
    regionHint: string;
    regions: readonly string[];
  }
> = {
  aws: {
    name: CLOUD_NAMES.aws,
    regionLabel: "AWS region",
    regionHint:
      "Saving checks the deploy role in this region; it creates nothing. Web Services, postgres, redis, buckets and static sites can be created in an AWS account; worker, cron, web-private and mysql not yet.",
    regions: AWS_REGIONS,
  },
  gcp: {
    name: CLOUD_NAMES.gcp,
    regionLabel: "Google Cloud region",
    regionHint:
      "Saving checks that Cloud Run and Artifact Registry are offered in this region; it creates nothing. Web Services, postgres and redis can be created in a Google Cloud account; buckets and static sites not yet.",
    regions: GOOGLE_REGIONS,
  },
};

/** The regions a Cloud account on `cloud` may take, as Picker options. */
export function regionOptions(cloud: Cloud): PickerOption[] {
  return CLOUDS[cloud].regions.map((region) => ({
    value: region,
    label: region,
  }));
}

/**
 * The cloud of the Cloud account a Picker value names: from the listed
 * accounts, else — for one the caller cannot list — from the saved region,
 * since no region is both an AWS and a Google one.
 */
export function cloudOf(
  value: string,
  cloudAccounts: readonly CloudAccount[] | undefined,
  region: string,
): Cloud {
  const cloudAccountId = cloudAccountOf(value);
  const listed = (cloudAccounts ?? []).find(
    (account) => account.cloudAccountId === cloudAccountId,
  );
  if (listed?.cloud) return listed.cloud;
  return (GOOGLE_REGIONS as readonly string[]).includes(region) ? "gcp" : "aws";
}
