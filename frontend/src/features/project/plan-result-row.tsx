import Link from "next/link";

import { BuildNowButton } from "@/components/console/build-now-button";
import { StatusPill } from "@/components/console/status-pill";
import { TeardownReportPanel } from "@/components/console/teardown-report";
import type {
  HeldBuild,
  PlanStepResult,
} from "@/lib/api/endpoints/project-config";
import { DnsRecords } from "@/components/console/dns-records";
import {
  bucketKeptNote,
  isCloudBucketKept,
  type BucketLeftBehind,
} from "@/lib/api/endpoints/teardown";
import { Icon } from "@/lib/design/icons";
import { domainPortMoveSentence } from "@/lib/format/domain-port-move";
import { cn } from "@/lib/utils";

const RESULT_VERB: Record<PlanStepResult["action"], string> = {
  "network-create": "made",
  "network-change": "put back",
  create: "created",
  change: "changed",
  redeploy: "redeployed",
  destroy: "deleted",
  "network-remove": "being removed",
};

/**
 * A build the plan holds or held: what it is, its status now, where
 * to follow it, and, while held, "Build now with saved settings".
 */
export function HeldBuildRow({ build }: { build: HeldBuild }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-body font-medium">
        {build.configName}
      </span>
      <StatusPill status={build.status} />
      <span className="min-w-0 flex-1 truncate text-meta text-tx-3">
        {build.description ?? build.title}
      </span>
      <BuildNowButton deployment={build} applicationId={build.applicationId} />
      <Link
        href={`/applications/${build.applicationId}/deployments`}
        className="text-meta font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
      >
        Deployments
      </Link>
    </div>
  );
}

/** One step as it ran: what happened, and where to follow it. */
export function ResultRow({ result }: { result: PlanStepResult }) {
  const failed = result.status === "failed";
  const running = result.status === "running";
  // A change to a stopped RDS instance: not tried, not failed.
  const blocked = result.status === "blocked";
  // A deleted Service has nowhere to open.
  const gone = result.action === "destroy" && !failed;
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <StatusPill status="running" className="flex-none" />
        ) : (
          <Icon
            name={failed ? "x" : blocked ? "alert" : "check"}
            className={cn(
              "flex-none",
              failed ? "text-bad" : blocked ? "text-warn" : "text-ok",
            )}
          />
        )}
        <span className="font-mono text-body font-medium">
          {result.configName}
        </span>
        <span className="text-meta text-tx-3">
          {running ? "being made" : RESULT_VERB[result.action]}
          {failed ? ", failed" : blocked ? ", blocked" : ""}
        </span>
        {result.serviceId && !gone ? (
          <Link
            href={serviceHref(result)}
            className="text-meta font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
          >
            Open
          </Link>
        ) : null}
      </div>
      <div className="ml-6 grid gap-0.5 text-meta text-tx-2">
        {result.message ? (
          <p className={blocked ? "text-warn" : "text-bad"}>{result.message}</p>
        ) : null}
        {result.domain ? (
          <p>
            Domain <span className="font-mono">{result.domain}</span>
          </p>
        ) : null}
        {result.domainPortMove ? (
          // A `web.port` change moved its Domains on the old port (ADR-0068).
          <p>{domainPortMoveSentence(result.domainPortMove)}</p>
        ) : null}
        {result.deploy && result.action !== "network-remove" ? (
          <DeployLine result={result} />
        ) : null}
        {result.network && result.action === "network-create" ? (
          <NetworkLine running={running} />
        ) : null}
        {result.action === "network-remove" && !failed ? (
          <p>
            Its destroy-only Cloud run is a Deployment of the Environment
            network, whose log opens from the network’s card on the
            Environment’s Services tab. The network goes once AWS is checked and
            nothing is left.
          </p>
        ) : null}
        {result.dnsRecordsLeft && result.dnsRecordsLeft.length > 0 ? (
          <DnsRecords records={result.dnsRecordsLeft} />
        ) : null}
        {result.leftovers?.volumeLeftBehind === true ? (
          <p>Its data volume was kept on the Server, as Delete keeps it.</p>
        ) : null}
        {result.leftovers?.bucketLeftBehind ? (
          <BucketKept kept={result.leftovers.bucketLeftBehind} />
        ) : null}
        {result.leftovers?.bucketLeftAsItWas ? (
          // An existing bucket's destroy: nothing reached AWS.
          <p>{result.leftovers.bucketLeftAsItWas.message}</p>
        ) : null}
        {result.leftovers?.volumeLeftBehind === null ? (
          <p>
            Whether its data volume is still on the Server could not be read.
          </p>
        ) : null}
      </div>
      {result.leftovers ? (
        <TeardownReportPanel
          report={result.leftovers}
          className="ml-6"
          copy={{
            record:
              "The Service is deleted. These stay listed on this plan's results.",
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Where the Environment network's run is followed: it is a Deployment
 * of the network, whose log opens from the network's card on the
 * Environment. While it runs, the rest of the Apply waits on it.
 */
function NetworkLine({ running }: { running: boolean }) {
  return (
    <p>
      {running
        ? "Its Cloud run is making it now; the other steps wait until it is made and their AWS plans are read again with its ids. "
        : ""}
      Its run is a Deployment of the Environment network, whose log opens from
      the network’s card on the Environment’s Services tab.
    </p>
  );
}

function DeployLine({ result }: { result: PlanStepResult }) {
  const deploy = result.deploy;
  if (!deploy) return null;
  switch (deploy.status) {
    case "queued":
      // A bucket on AWS's Cloud run has no Deployments tab: its
      // page shows it, and a Delete's Deleting or Delete incomplete.
      if (result.serviceType === "bucket") {
        return (
          <p>
            Its Cloud run is queued.{" "}
            <Link
              href={`/buckets/${result.serviceId}`}
              className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
            >
              Open the bucket
            </Link>
          </p>
        );
      }
      return (
        <p>
          A Deployment is queued.{" "}
          <Link
            href={`/applications/${result.serviceId}/deployments`}
            className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
          >
            Follow it in Deployments
          </Link>
        </p>
      );
    case "started":
      return (
        <p>
          Deploying; a database writes no Deployment, so its status is on its
          own page.
        </p>
      );
    case "not-deployed":
      return <p>Not deployed: {deploy.message}</p>;
  }
}

/**
 * A bucket its destroy kept: on a Server its volume, on AWS the S3
 * bucket in its account and region, which the note names.
 */
function BucketKept({ kept }: { kept: BucketLeftBehind }) {
  return (
    <p>
      {bucketKeptNote(kept)}
      {isCloudBucketKept(kept) ? null : (
        <>
          {" "}
          Its volume is <span className="font-mono">{kept.volumeName}</span>.
        </>
      )}
    </p>
  );
}

/** Where a Service a plan wrote is opened in the console. */
function serviceHref(result: PlanStepResult): string {
  return result.serviceType === "application"
    ? `/applications/${result.serviceId}`
    : `/databases/${result.serviceType}/${result.serviceId}`;
}
