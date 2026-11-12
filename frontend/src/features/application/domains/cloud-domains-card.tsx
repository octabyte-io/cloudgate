import { Card } from "@/components/console/card";
import { CopyButton } from "@/components/console/copy-button";
import { StatusPill } from "@/components/console/status-pill";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type {
  CloudCertificateStatus,
  CloudDomainView,
  Domain,
  DnsRecordToCopy,
} from "@/lib/api/endpoints/domains";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import type { Mark } from "@/lib/design/status";

import { useAskAgain } from "./use-domains";
import type { CloudDomainParent } from "./use-domains";

/** Each certificate status, as a word and a tone. */
const STATUS_MARK: Record<CloudCertificateStatus, Mark> = {
  "waiting-for-dns": { glyph: "○", tone: "warn", label: "Waiting for DNS" },
  checking: { glyph: "◐", tone: "warn", label: "Checking" },
  live: { glyph: "●", tone: "ok", label: "Live" },
  failed: { glyph: "✕", tone: "bad", label: "Failed" },
};

/** "41 hours left", from now to the deadline. */
export function timeLeft(deadline: string, now: Date = new Date()): string {
  const ms = Date.parse(deadline) - now.getTime();
  if (ms <= 0) return "no time left";
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours} ${hours === 1 ? "hour" : "hours"} left`;
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"} left`;
}

/** Who issues a cloud Domain's certificate: ACM on AWS, Certificate Manager on Google Cloud. */
export function issuerWords(cloudRun: boolean): string {
  return cloudRun ? "Certificate Manager" : "ACM";
}

/** What a cloud Service's Domains are on, as the card and dialogs say it. */
export function servedByWords(cloudFront: boolean): string {
  return cloudFront ? "the CloudFront distribution" : "the load balancer";
}

/**
 * A cloud Service's Domains: each one on the AWS load balancer with
 * its own ACM certificate. Cloudgate never writes DNS, so each Domain shows
 * the two records to make at the DNS provider, ready to copy, each ticked
 * once Cloudgate has seen it. The ticks only inform.
 *
 * A `static` site on AWS (`cloudFront`) has its one Domain on its own
 * CloudFront distribution, and its distribution's `*.cloudfront.net` name
 * as its generated Domain, shown first, which needs no record.
 *
 * A `web` on Cloud Run (S11, `cloudRun`) has its own `*.run.app`
 * address as its generated Domain, shown first likewise; it always answers.
 */
export function CloudDomainsCard({
  parent,
  domains,
  cloudFront = false,
  cloudRun = false,
  cloudCdn = false,
  stackVm = false,
  generated = null,
  onAdd,
  onEdit,
  onRemove,
}: {
  parent: CloudDomainParent;
  domains: Domain[];
  /** A static site on AWS: its Domain is on its CloudFront distribution. */
  cloudFront?: boolean;
  /** A `web` on Cloud Run: its `run.app` address is its generated Domain. */
  cloudRun?: boolean;
  /** A static site on Google Cloud: no generated Domain at all. */
  cloudCdn?: boolean;
  /**
   * A Compose stack on its Stack VM (#1371): each Domain reaches one of its
   * services, on a port published on the Stack VM, and there is no
   * generated Domain. `cloudRun` still says which cloud's load balancer.
   */
  stackVm?: boolean;
  /** Its distribution's own name, or its `run.app` host, once made. */
  generated?: string | null;
  onAdd: () => void;
  onEdit: (domain: Domain) => void;
  onRemove: (domain: Domain) => void;
}) {
  // `POST /domains` and `PATCH /domains/:id` ask `domain: create`, and
  // `DELETE /domains/:id` asks `domain: delete`, as on a Server.
  const canAdd = usePermission({ domain: ["create"] });
  return (
    <Card>
      <Card.Header
        title="Domains"
        sub={
          stackVm
            ? `On the Environment network's ${cloudRun ? "Google Cloud" : "AWS"} load balancer, each with its own ${cloudRun ? "Google-managed" : "ACM"} certificate, reaching a service on this stack's Stack VM. A Stack VM has no generated host: each Domain is a host of your own. Each change runs at once as a short Deployment of the stack.`
            : cloudFront
            ? "On this site's CloudFront distribution, with its own ACM certificate. A static site on AWS takes one Domain; each change runs at once as its own short Deployment."
            : cloudCdn
              ? "On the Environment network's Google Cloud load balancer, each with its own Google-managed certificate, serving this site's Cloud CDN backend bucket. Each change runs at once as a short run of the Environment network."
              : cloudRun
                ? "Its own run.app address, on Google's certificate, and the Domains on the Environment network's Google Cloud load balancer, each with its own Google-managed certificate. Each change runs at once as a short run of the Environment network."
                : "On the Environment's AWS load balancer, each with its own ACM certificate. Each change runs at once as its own short Deployment."
        }
        headingLevel={2}
      />
      <Card.Body>
        {(cloudFront || cloudRun) && !stackVm && generated ? (
          <GeneratedRow
            host={generated}
            note={
              cloudRun
                ? "Cloud Run’s own address for this Service, on Google’s certificate. It always answers, with or without a Domain."
                : "CloudFront’s own name for this site, on CloudFront’s certificate. It always answers, with or without a Domain."
            }
          />
        ) : null}
        {domains.length === 0 ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-body text-tx-2">
              {stackVm
                ? "No Domain yet. A Stack VM has no generated host and no public address, so until you add a host of your own this stack is reachable only from inside the Environment network."
                : cloudFront
                ? "No Domain yet. Until one is added this site is reached at its CloudFront name."
                : cloudCdn
                  ? "No Domain yet. Until one is added this site answers nowhere: a static site on Google Cloud has no address of its own."
                  : cloudRun
                    ? "No Domain yet. Until one is added this Service is reached at its run.app address."
                    : "No Domain yet. Until one is added this Service is reached only through its load balancer."}
            </p>
            <Button
              disabled={!canAdd.allowed}
              title={canAdd.allowed ? undefined : roleRefusal("add a Domain")}
              onClick={onAdd}
            >
              Add a domain
            </Button>
          </div>
        ) : (
          <ul className="flex flex-col gap-6">
            {domains.map((domain) => (
              <CloudDomainRow
                key={domain.domainId}
                parent={parent}
                domain={domain}
                reaches={
                  stackVm && domain.serviceName
                    ? `${domain.serviceName} on port ${domain.port ?? 3000}`
                    : null
                }
                target={servedByWords(cloudFront)}
                issuer={issuerWords(cloudRun)}
                onEdit={() => onEdit(domain)}
                onRemove={() => onRemove(domain)}
              />
            ))}
          </ul>
        )}
      </Card.Body>
    </Card>
  );
}

/**
 * A generated Domain: a static site's distribution's own name, or a
 * Cloud Run web's `run.app` address (S11), on its cloud's certificate, live
 * as soon as it is made. It cannot be edited or removed, and needs no DNS
 * record.
 */
function GeneratedRow({ host, note }: { host: string; note: string }) {
  return (
    <div className="mb-6 flex flex-col gap-2 border-b border-line pb-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-body text-tx">https://{host}</span>
        <CopyButton value={`https://${host}`} label="generated address" />
        <StatusPill mark={GENERATED_MARK} />
      </div>
      <p className="text-meta text-tx-2">{note}</p>
    </div>
  );
}

const GENERATED_MARK: Mark = { glyph: "●", tone: "ok", label: "Generated" };

function CloudDomainRow({
  parent,
  domain,
  reaches,
  target,
  issuer,
  onEdit,
  onRemove,
}: {
  parent: CloudDomainParent;
  domain: Domain;
  /** On a Stack VM, the service and port it reaches. */
  reaches: string | null;
  /** What the Domain is on: the load balancer, or the distribution. */
  target: string;
  /** Who issues its certificate: ACM, or Google's Certificate Manager. */
  issuer: string;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const askAgain = useAskAgain(parent);
  const canEdit = usePermission({ domain: ["create"] });
  const canRemove = usePermission({ domain: ["delete"] });
  const view = domain.cloud;
  const route =
    domain.path && domain.path !== "/"
      ? `${domain.host}${domain.path}`
      : domain.host;

  return (
    <li className="flex flex-col gap-3 border-b border-line pb-6 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-body text-tx">https://{route}</span>
        {reaches ? (
          <span className="font-mono text-meta text-tx-2">→ {reaches}</span>
        ) : null}
        {view ? <StatusPill mark={STATUS_MARK[view.status]} /> : null}
        <span className="flex-1" />
        <Button
          size="sm"
          disabled={!canEdit.allowed}
          title={canEdit.allowed ? undefined : roleRefusal("edit a Domain")}
          onClick={onEdit}
        >
          Edit
        </Button>
        <Button
          size="sm"
          variant="dngr"
          disabled={!canRemove.allowed}
          title={canRemove.allowed ? undefined : roleRefusal("remove a Domain")}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
      {view ? <StatusLine view={view} target={target} issuer={issuer} /> : null}
      {view?.status === "failed" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={!canEdit.allowed || askAgain.isPending}
            aria-busy={askAgain.isPending || undefined}
            onClick={async () => {
              try {
                await askAgain.mutateAsync(domain.domainId);
                toast.done(
                  `A new certificate is requested for ${domain.host}.`,
                );
              } catch (error) {
                toast.error(error);
              }
            }}
          >
            Ask again
          </Button>
          <span className="text-meta text-tx-2">
            {"or edit or remove the Domain if the host itself is wrong."}
          </span>
        </div>
      ) : null}
      {view?.records && view.status !== "live" ? (
        <Records records={view.records} target={target} issuer={issuer} />
      ) : null}
      {view?.records &&
      view.status === "live" &&
      !view.records.pointing.seen ? (
        <Records
          records={{ validation: null, pointing: view.records.pointing }}
          target={target}
          issuer={issuer}
        />
      ) : null}
    </li>
  );
}

function StatusLine({
  view,
  target,
  issuer,
}: {
  view: CloudDomainView;
  target: string;
  issuer: string;
}) {
  switch (view.status) {
    case "waiting-for-dns":
      return (
        <p className="text-meta text-tx-2">
          {view.records?.validation
            ? `Add both records below at your DNS provider. ${issuer} checks the first one to issue the certificate`
            : `Requesting the certificate; its validation record appears here once ${issuer} names it`}
          {view.deadline ? ` — ${timeLeft(view.deadline)} of 72 hours.` : "."}
        </p>
      );
    case "checking":
      return (
        <p className="text-meta text-tx-2">
          {issuer} has the validation record and is checking it; this can take
          up to 30 minutes.
        </p>
      );
    case "live":
      return (
        <p className="text-meta text-tx-2">
          The issued certificate is on {target}.
        </p>
      );
    case "failed":
      return (
        <p className="text-meta text-bad">
          {view.failure ?? "The certificate failed."}
        </p>
      );
  }
}

function Records({
  records,
  target,
  issuer,
}: {
  records: NonNullable<CloudDomainView["records"]>;
  target: string;
  issuer: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      {records.validation ? (
        <RecordRow
          purpose={
            issuer === "ACM"
              ? "Validation, for ACM"
              : `Authorization, for ${issuer}`
          }
          record={records.validation}
        />
      ) : null}
      <RecordRow
        purpose={`Points the host at ${target}`}
        record={records.pointing}
      />
      <p className="text-meta text-tx-3">{records.pointing.note}</p>
    </div>
  );
}

function RecordRow({
  purpose,
  record,
}: {
  purpose: string;
  record: DnsRecordToCopy;
}) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1 rounded-md border border-line bg-panel-2 p-3 text-meta">
      <span
        aria-label={record.seen ? "Seen in DNS" : "Not seen in DNS yet"}
        className={record.seen ? "text-ok" : "text-tx-3"}
      >
        {record.seen ? "✓" : "○"}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-tx-2">
          {purpose} · <span className="font-mono">{record.type}</span>
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-tx" title={record.name}>
            {record.name}
          </span>
          <CopyButton value={record.name} label="record name" />
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-tx" title={record.value}>
            {record.value}
          </span>
          <CopyButton value={record.value} label="record value" />
        </span>
      </div>
    </div>
  );
}
