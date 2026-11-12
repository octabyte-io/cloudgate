import Link from "next/link";

import { Chip } from "@/components/console/chip";
import type {
  DeployTarget,
  PlanStep,
  StoppedDeployment,
} from "@/lib/api/endpoints/project-config";
import { Icon } from "@/lib/design/icons";

import { UseExistingBucketButton } from "@/components/console/use-existing-bucket-button";
import { UseExistingButton } from "@/components/console/use-existing-button";
import { DnsRecords } from "@/components/console/dns-records";

import { AwsLines } from "./plan-aws-lines";
import { FieldList } from "./plan-field-list";
import { TemplateLines } from "./plan-template-lines";

/** Names for a step's place: Servers and Cloud accounts by id. */
interface PlaceNames {
  readonly servers: Readonly<Record<string, string>>;
  readonly cloudAccounts?: Readonly<Record<string, string>>;
}

/**
 * One step of a plan as it would run: the Service, its kind, where a
 * create runs, and the fields a create or a change writes, as the config
 * names them.
 *
 * A cloud step adds its AWS lines under them: a `web` created in a
 * Cloud account names its place and its size beside the real Fargate pair,
 * and the Environment network made for it is a step of its own. A cloud
 * Service's change a deploy stopped on carries what that deploy read,
 * and is marked, linking back to the Deployment. A cloud Service or network
 * read for Drift shows what its read found beyond the Drift, which
 * the plan lists in a section of its own.
 */
export function StepRow({
  step,
  serverNames,
  cloudAccountNames = {},
  stopped,
  environmentId,
}: {
  step: PlanStep;
  serverNames: Readonly<Record<string, string>>;
  cloudAccountNames?: Readonly<Record<string, string>>;
  /** The deploy that stopped on this step, which it marks and links to. */
  stopped?: StoppedDeployment;
  /**
   * The plan's Environment, on a plan an operator can act on: a `postgres`
   * created in a Cloud account then offers "Use an existing database",
   * and a `bucket` "Use an existing bucket".
   */
  environmentId?: string;
}) {
  if (step.action === "network-remove") {
    return (
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body font-medium">Environment network</span>
          <Chip variant="mono">network</Chip>
          <span className="text-meta text-tx-3">
            {placementText(
              {
                kind: "cloud",
                cloudAccountId: step.cloudAccountId,
                region: step.region,
              },
              { servers: serverNames, cloudAccounts: cloudAccountNames },
            )}
          </span>
        </div>
        <p className="text-meta">
          Neither a Service nor the Deploy target is there any more, but its
          load balancer still bills. Applying removes it in a Cloud run that
          only destroys.
        </p>
        <DnsRecords records={step.dnsRecordsLeft} />
      </div>
    );
  }
  if (step.action === "network-create" || step.action === "network-change") {
    return (
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body font-medium">Environment network</span>
          <Chip variant="mono">network</Chip>
          <span className="text-meta text-tx-3">
            {placementText(
              {
                kind: "cloud",
                cloudAccountId: step.cloudAccountId,
                region: step.region,
              },
              { servers: serverNames, cloudAccounts: cloudAccountNames },
            )}
          </span>
        </div>
        <p className="text-meta text-tx-3">
          {step.action === "network-create"
            ? "The VPC, subnets and load balancer this Environment's cloud Services share, made first because this plan creates the first one here."
            : step.privateLinks?.includes("private-dns")
              ? "The private DNS namespace this Environment's Private web services are reached by, added to its network first because this plan creates the first one. It stays until the network goes."
              : step.privateLinks?.length
                ? "The private link this Environment's databases get their private address through, added to its network first because this plan creates the first database that needs it."
                : "The VPC, subnets and load balancer this Environment's cloud Services share, read for what differs from what Cloudgate made."}
        </p>
        <AwsLines aws={step.cloudRead} />
      </div>
    );
  }
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-body font-medium">
          {step.configName}
        </span>
        <Chip variant="mono">{step.kind}</Chip>
        {step.action === "create" ? (
          <span className="text-meta text-tx-3">
            {placementText(step.placement, {
              servers: serverNames,
              cloudAccounts: cloudAccountNames,
            })}
          </span>
        ) : (
          <span className="text-meta text-tx-3">{step.name}</span>
        )}
      </div>
      {(step.action === "create" || step.action === "change") &&
      step.fields.length > 0 ? (
        <FieldList fields={step.fields} created={step.action === "create"} />
      ) : null}
      {step.action === "change" && step.blocked ? (
        <p className="text-meta font-medium text-warn">
          Blocked: {step.blocked}
        </p>
      ) : null}
      {(step.action === "redeploy" || step.action === "change") &&
      step.because?.length ? (
        <p className="text-meta text-tx-2">
          <span className="font-mono">{step.configName}</span> redeploys:{" "}
          {step.because.map((link, at) => (
            <span key={link}>
              {at > 0 ? ", " : null}
              <span className="font-mono">{link}</span>
            </span>
          ))}{" "}
          changed
        </p>
      ) : null}
      {step.action === "create" && step.cloud ? (
        <p className="text-meta text-tx-2">
          Size{" "}
          {step.cloud.size.name ? (
            <span className="font-mono">{step.cloud.size.name} → </span>
          ) : null}
          <span className="font-mono">{step.cloud.size.pair.wording}</span>
          {step.cloud.size.pair.roundedUpFrom
            ? ` (rounded up from ${step.cloud.size.pair.roundedUpFrom})`
            : null}{" "}
          on {step.cloud.size.pair.runsOn}
          {step.cloud.size.pair.notes?.map((note) => ` · ${note}`)}.{" "}
          {cloudReach(step)}
        </p>
      ) : step.action === "change" && step.cloud?.size.pair.notes?.length ? (
        <p className="text-meta text-tx-2">
          Size {step.cloud.size.pair.notes.join(" · ")}.
        </p>
      ) : step.action === "create" && step.database ? (
        <p className="text-meta text-tx-2">
          RDS for PostgreSQL{" "}
          <span className="font-mono">
            {machineLine(
              step.database.size.name,
              step.database.size.instanceClass,
              step.database.size.machine,
              step.database.size.native,
            )}
          </span>
          {step.database.size.smallest ? " (smallest)" : null}
          {step.database.size.native ? ", set by native" : null}, never publicly
          reachable.
        </p>
      ) : step.action === "create" && step.cache ? (
        <p className="text-meta text-tx-2">
          ElastiCache for Valkey{" "}
          <span className="font-mono">
            {machineLine(
              step.cache.size.name,
              step.cache.size.nodeType,
              step.cache.size.machine,
              step.cache.size.native,
            )}
          </span>
          {step.cache.size.smallest ? " (smallest)" : null}
          {step.cache.size.native ? ", set by native" : null}, Valkey{" "}
          {step.cache.version.engineVersion}, TLS only, never publicly
          reachable.
        </p>
      ) : step.action === "create" &&
        step.kind === "web" &&
        step.template?.host ? (
        // A Template web whose values name its URL: the host its setup made.
        <p className="text-meta text-tx-3">
          Gets the generated Domain{" "}
          <span className="font-mono">{step.template.host}</span> on port{" "}
          {createdPort(step)}, made at setup for the values that name it.
        </p>
      ) : step.action === "create" && step.kind === "web" ? (
        <p className="text-meta text-tx-3">
          Gets a generated sslip.io Domain on port {createdPort(step)}.
        </p>
      ) : step.action === "create" && step.kind === "bucket" ? (
        <p className="text-meta text-tx-3">
          Gets a generated sslip.io Domain over HTTPS, which is its endpoint, so
          presigned URLs and browser uploads work.
        </p>
      ) : step.action === "create" && step.kind === "web-private" ? (
        <p className="text-meta text-tx-3">
          No Domain: only the Services on its Server reach it, at
          http://&lt;appName&gt;:{createdPort(step)}.
        </p>
      ) : null}
      {step.action === "create" && step.template ? (
        <TemplateLines template={step.template} />
      ) : null}
      {(step.action === "create" || step.action === "change") &&
      step.stackVm &&
      step.stackVm.lines.length > 0 ? (
        // A Stack VM's machine, cost, resize, grown disk or replace, in the
        // plan's own words (#1368): what its cloud read cannot say.
        <ul aria-label="Stack VM" className="grid gap-0.5 text-meta text-tx-2">
          {step.stackVm.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {stopped ? (
        <p
          aria-label="Stopped deploy"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-warn-line bg-warn-tint px-2.5 py-1.5 text-meta text-warn"
        >
          <Icon name="alert" size={14} className="flex-none" />
          <span>
            Its deploy stopped here before changing anything: AWS differs from
            what Cloudgate made. Apply approves what it found.
          </span>
          <Link
            href={`/applications/${stopped.applicationId}/deployments`}
            className="font-medium underline-offset-3 hover:underline focus-visible:underline"
          >
            The stopped Deployment →
          </Link>
        </p>
      ) : null}
      {(step.action === "create" || step.action === "change") &&
      step.cloudRead &&
      // An Existing database's or bucket's lookup has its own section.
      !(step.action === "change" && step.existing) ? (
        <AwsLines aws={step.cloudRead} />
      ) : null}
      {step.action === "create" && step.bucket ? (
        step.kind === "static" ? (
          <p className="text-meta text-tx-3">
            Its files go in{" "}
            <span className="font-mono">{step.bucket.name}</span> in AWS account{" "}
            <span className="font-mono">{step.bucket.awsAccountId}</span>,{" "}
            {step.bucket.region}: a private bucket only its CloudFront
            distribution reads.{" "}
            {step.site?.spa
              ? "A missing path answers /index.html (spa)."
              : "A missing path answers 404."}
          </p>
        ) : step.bucket.awsAccountId ? (
          <p className="text-meta text-tx-3">
            Made as <span className="font-mono">{step.bucket.name}</span> in AWS
            account{" "}
            <span className="font-mono">{step.bucket.awsAccountId}</span>,{" "}
            {step.bucket.region}: a name only that account can hold, which
            Cloudgate keeps. Linking Services reach it through their own role.
          </p>
        ) : (
          <p className="text-meta text-tx-3">
            Made as <span className="font-mono">{step.bucket.name}</span>, a
            name Cloudgate keeps, with one key that reads and writes it.
          </p>
        )
      ) : null}
      {step.action === "change" && step.cors ? (
        <p className="text-meta text-tx-3">
          Browser-upload origins, set on the bucket&rsquo;s page:{" "}
          {originList(step.cors.from)} → {originList(step.cors.to)}
        </p>
      ) : null}
      {step.action === "create" && step.existing ? (
        <p className="text-meta text-tx-3">
          Uses the existing database{" "}
          <span className="font-mono">{step.existing.identifier}</span>: nothing
          is made in AWS, and the next plan looks it up.
        </p>
      ) : step.action === "create" && step.kind === "postgres" ? (
        <p className="text-meta text-tx-3">
          Gets a generated password, kept by Cloudgate.
        </p>
      ) : null}
      {step.action === "create" && step.database && environmentId ? (
        <UseExistingButton
          environmentId={environmentId}
          configName={step.configName}
          kind={step.kind === "mysql" ? "mysql" : "postgres"}
        />
      ) : null}
      {step.action === "create" &&
      step.kind === "bucket" &&
      step.bucket?.awsAccountId &&
      environmentId ? (
        <UseExistingBucketButton
          environmentId={environmentId}
          configName={step.configName}
        />
      ) : null}
      {step.action === "create" && step.cache && environmentId ? (
        <UseExistingButton
          environmentId={environmentId}
          configName={step.configName}
          kind="redis"
        />
      ) : null}

      {step.action === "create" && step.kind === "mysql" ? (
        <p className="text-meta text-tx-3">
          Gets generated root and user passwords, kept by Cloudgate.
        </p>
      ) : null}
    </div>
  );
}

/**
 * A created database's size beside the machine it runs on:
 * `small → db.t4g.micro (2 vCPU, 1 GB)`. A machine its `native.aws` sets
 * is beside the size it wins over, or alone with no size, its CPU
 * and memory shown when the class table knows them.
 */
function machineLine(
  sizeName: string | null,
  machine: string,
  resources: string | null,
  native?: true,
): string {
  const size = sizeName ?? (native ? null : "no size");
  return `${size ? `${size} → ` : ""}${machine}${resources ? ` (${resources})` : ""}`;
}

/**
 * How a Service a plan creates in a Cloud account is reached: a `web` by a
 * Domain added once it is deployed, a Private web service at its
 * internal address from its own Environment network, a Worker by nothing.
 */
function cloudReach(step: Extract<PlanStep, { action: "create" }>): string {
  switch (step.kind) {
    case "web-private":
      return `No Domain: only the Services of this Environment network reach it, at http://${step.configName}.cloudgate.internal:${createdPort(step)}.`;
    case "worker":
      return "No Domain: a worker serves no HTTP.";
    default:
      return "No Domain yet; add one in the console once its first deploy is done.";
  }
}

/** The port a created `web` or `web-private` listens on: the config's, else 3000. */
function createdPort(step: Extract<PlanStep, { action: "create" }>): number {
  const port = step.fields.find((diff) => diff.field === "port")?.to;
  return typeof port === "number" ? port : 3000;
}

function placementText(placement: DeployTarget, names: PlaceNames): string {
  switch (placement.kind) {
    case "server":
      return `on Server ${names.servers[placement.serverId] ?? placement.serverId}`;
    case "cloud": {
      const account = names.cloudAccounts?.[placement.cloudAccountId];
      return account
        ? `in Cloud account ${account}, ${placement.region}`
        : `in a Cloud account, ${placement.region}`;
    }
    default:
      return "on the platform host";
  }
}

/** A bucket's origins as a CORS change names them. */
function originList(origins: string[]): string {
  return origins.length === 0 ? "none" : origins.join(", ");
}
