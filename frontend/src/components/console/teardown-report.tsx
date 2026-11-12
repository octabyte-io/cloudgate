import { CopyButton } from "@/components/console/copy-button";
import { useServers } from "@/lib/api/use-servers";
import {
  UNRECLAIMED_ARTIFACT_KIND,
  bucketKeptNote,
  cloudBucketCopyPlace,
  cloudBucketMachine,
  isCloudBucketKept,
  teardownReportCount,
  teardownReportIsEmpty,
  type MachineId,
  type TeardownReport,
  type UnreclaimedArtifactKind,
} from "@/lib/api/endpoints/teardown";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

/**
 * What a delete left behind, rendered where the operator cannot miss it.
 *
 * **This is the only place these paths will ever be shown.** The row is gone
 * from the database by the time the response arrives, so the body is the last
 * place the triple (kind, machine, path) exists — there is no route that will
 * answer for a deleted Service, and nothing to come back to. Before this, the
 * console discarded the field: an operator whose Server was unreachable at
 * delete time got a 200 and no record at all.
 *
 * **It renders nothing on a healthy delete**, which is the common case and the
 * reason the fields are absent rather than empty on the wire. The caller does
 * not need to check first — an empty report returns `null` here.
 *
 * **Not a toast.** A toast is transient and this is not: `traefik-config` is
 * still advertising a public hostname that answers 404, and `file-mounts` is
 * the last copy of the operator's own file bodies. Both want a surface that
 * stays until it is dismissed and can be copied out of, which is why the
 * calling modals hold themselves open on a non-empty report rather than
 * closing and navigating away.
 */
/**
 * The panel's sentences that assume a deleted row, for a caller whose report
 * is not about one. Removing the forward-auth proxy keeps its settings
 * row, and the router it can leave answers 502 rather than 404 — the defaults
 * would say two false things there. Each is optional; an omitted one keeps
 * the delete's wording.
 */
export interface TeardownReportPanelCopy {
  /** Under the count: why this is the only record. */
  record?: string;
  /** Above the rows when a Traefik config was left behind. */
  urgent?: string;
  /** A row's note, per kind, in place of `UNRECLAIMED_ARTIFACT_KIND`'s. */
  notes?: Partial<Record<UnreclaimedArtifactKind, string>>;
}

export function TeardownReportPanel({
  report,
  className,
  copy,
}: {
  report: TeardownReport | undefined;
  className?: string;
  copy?: TeardownReportPanelCopy;
}) {
  const { data: servers } = useServers();

  if (!report || teardownReportIsEmpty(report)) return null;

  /**
   * A Server's name, falling back to its id.
   *
   * The fallback is load-bearing rather than defensive: a delete can leave
   * artifacts on a Server that the caller's `useServers` read does not carry —
   * it is scoped to the active Organization, and the read may not have landed.
   * An id an operator can paste into `cloudgate servers` beats "unknown".
   */
  const machine = (serverId: MachineId) => {
    if (serverId === null) return "this host";
    const named = servers?.find((s) => s.serverId === serverId);
    return named ? named.name : serverId;
  };

  const artifacts = report.unreclaimedArtifacts ?? [];
  const images = report.unreclaimedImages ?? [];
  const workloads = [
    ...(report.orphaned ?? []),
    ...(report.orphanedPreviews ?? []),
  ];
  const buckets = report.bucketsLeftBehind ?? [];
  const urgent = artifacts.some(
    (a) => UNRECLAIMED_ARTIFACT_KIND[a.kind]?.urgent,
  );

  /** Everything, one path or image reference per line, for the copy button. */
  const asText = [
    ...artifacts.map(
      (a) =>
        `${a.kind}\t${machine(a.serverId)}\t${a.path}${a.reason ? `\t${a.reason}` : ""}`,
    ),
    ...images.flatMap((e) =>
      e.images.map((i) => `image\t${machine(e.serverId)}\t${i}`),
    ),
    ...workloads.map(
      (w) => `workload:${w.reason}\t${machine(w.serverId)}\t${w.appName}`,
    ),
    ...buckets.map((b) =>
      isCloudBucketKept(b)
        ? `bucket:${b.because}\t${cloudBucketCopyPlace(b)}\t${b.bucketName}`
        : `bucket:${b.because}\t${machine(b.serverId)}\t${b.volumeName}\t${b.bucketName}`,
    ),
  ].join("\n");

  return (
    <section
      data-slot="teardown-report"
      className={cn(
        "rounded-lg border border-bad-line bg-bad-tint px-3.5 py-3",
        className,
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Icon
            name="alert"
            className="mt-0.5 size-4 shrink-0 text-bad"
            aria-hidden
          />
          <div>
            <h3 className="text-body font-medium text-tx">
              {teardownReportCount(report)} thing
              {teardownReportCount(report) === 1 ? "" : "s"} were left behind
            </h3>
            <p className="mt-0.5 text-meta text-tx-2">
              {copy?.record ??
                "The row is deleted. This is the only record of these — copy it before you close this."}
            </p>
          </div>
        </div>
        <CopyButton value={asText} label="what was left behind" />
      </header>

      {urgent ? (
        <p className="mt-3 text-meta text-bad">
          {copy?.urgent ??
            "A Traefik config is still advertising this service’s hostnames. Until it is removed, those hostnames answer 404 at the edge rather than going away."}
        </p>
      ) : null}

      <dl className="mt-3 space-y-2">
        {artifacts.map((a, i) => {
          const kind = UNRECLAIMED_ARTIFACT_KIND[a.kind];
          return (
            <Row
              key={`artifact-${i}`}
              label={kind?.label ?? a.kind}
              urgent={kind?.urgent ?? false}
              machine={machine(a.serverId)}
              value={a.path}
              // A per-entry reason says more than the kind's copy.
              note={a.reason ?? copy?.notes?.[a.kind] ?? kind?.note}
            />
          );
        })}

        {images.flatMap((entry) =>
          entry.images.map((image, i) => (
            <Row
              key={`image-${entry.serverId}-${i}`}
              label="Image"
              urgent={false}
              machine={machine(entry.serverId)}
              value={image}
              note="Still on the machine's Docker daemon, holding its layers' disk."
            />
          )),
        )}

        {workloads.map((w, i) => (
          <Row
            key={`workload-${i}`}
            label={w.reason === "present" ? "Still running" : "Unconfirmed"}
            urgent={w.reason === "present"}
            machine={machine(w.serverId)}
            value={w.appName}
            note={
              w.reason === "present"
                ? "The workload was still there when the row was dropped. It is now unmanaged."
                : "Cloudgate could not reach the machine to confirm this stopped."
            }
          />
        ))}

        {buckets.map((b, i) => (
          <Row
            key={`bucket-${i}`}
            label="Bucket kept"
            urgent={false}
            machine={
              isCloudBucketKept(b) ? cloudBucketMachine(b) : machine(b.serverId)
            }
            value={isCloudBucketKept(b) ? b.bucketName : b.volumeName}
            note={bucketKeptNote(b)}
          />
        ))}
      </dl>
    </section>
  );
}

function Row({
  label,
  machine,
  value,
  note,
  urgent,
}: {
  label: string;
  machine: string;
  value: string;
  note?: string;
  urgent: boolean;
}) {
  return (
    <div className="rounded-md border border-line bg-panel px-3 py-2">
      <dt className="flex items-baseline gap-2">
        <span
          className={cn(
            "text-meta font-medium",
            urgent ? "text-bad" : "text-tx-2",
          )}
        >
          {label}
        </span>
        <span className="text-meta text-tx-3">on {machine}</span>
      </dt>
      <dd className="mt-1">
        <code className="block break-all font-mono text-meta text-tx">
          {value}
        </code>
        {note ? <p className="mt-1 text-meta text-tx-3">{note}</p> : null}
      </dd>
    </div>
  );
}
