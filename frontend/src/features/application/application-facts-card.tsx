import Link from "next/link";

import { Card } from "@/components/console/card";
import { CopyButton } from "@/components/console/copy-button";
import { KVList, KVRow } from "@/components/console/kv-list";
import { StatusPill } from "@/components/console/status-pill";
import { cloudDeleteMark } from "./lifecycle/cloud-delete-card";
import type { ApplicationDetail } from "@/lib/api/endpoints/applications";
import { timeExact } from "@/lib/format/time";
import { onGoogleCloud } from "@/lib/api/endpoints/applications";
import { serverMark } from "@/lib/design/server-mark";

/**
 * What this Application is, in the rail beside whichever tab is open.
 *
 * The reference's version of this card (`e-console.html:4175-4188`) leads with
 * Runtime, Origin, "Inherited from" and Override. None of the four is a column on
 * anything: `environment.runtime` was marked proposed by the prototype itself,
 * `server.provenance` does not exist, and a per-service runtime override is a
 * proposal about a feature with no backend. What is here is what the row carries —
 * and the row carries a *relation tree*, which is why the Project and Environment
 * names are free rather than two more requests (`applications.service.ts` joins
 * `environment.project` on `findOne`).
 *
 * **`appName` is the fact worth showing most.** It names the Swarm service, its
 * volumes and its Traefik router, it is immutable, and it is the string an operator
 * types into `docker service ls` when they stop trusting the console.
 */
export function ApplicationFactsCard({
  application,
  health,
}: {
  application: ApplicationDetail;
  /**
   * The Overview's health fact line, under Status. Only the Overview
   * passes it, so the other tabs' rail stays as it was.
   */
  health?: React.ReactNode;
}) {
  const { environment } = application;

  return (
    <Card>
      <Card.Header title="Application" headingLevel={2} />
      <Card.Body>
        <KVList>
          <KVRow
            label="Status"
            value={
              application.cloudDelete ? (
                /* A cloud Delete under way or incomplete. */
                <StatusPill mark={cloudDeleteMark(application.cloudDelete)} />
              ) : (
                /* Keyed, so a change of status fades the new word in
                   rather than swapping it under the eye. */
                <StatusPill
                  key={application.applicationStatus}
                  status={application.applicationStatus}
                  className="animate-fade"
                />
              )
            }
          />
          {health}
          <KVRow
            label="Internal name"
            value={application.appName}
            title={application.appName}
            mono
          />
          {application.internalAddress ? (
            // What an operator types into a caller's variable.
            <KVRow
              label="Internal address"
              value={application.internalAddress}
              title="Only the Services on its Server, or of its Environment network in a Cloud account, reach a Private web service, at this base URL."
              mono
              action={
                <CopyButton
                  value={application.internalAddress}
                  label="internal address"
                />
              }
            />
          ) : null}
          <KVRow
            label="Config name"
            value={application.configName}
            title="Its fixed key in the Project config. Renaming the Service does not change it."
            mono
          />
          <KVRow
            label="Environment"
            title={environment.name}
            value={
              <Link
                href={`/environments/${environment.environmentId}`}
                className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
              >
                {environment.name}
              </Link>
            }
          />
          <KVRow
            label="Project"
            title={environment.project.name}
            value={
              <Link
                href={`/projects/${environment.project.projectId}`}
                className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
              >
                {environment.project.name}
              </Link>
            }
          />
          {/* **Qualified, always** (as for a database). This
              column is the *configured* count — it becomes
              `Mode.Replicated.Replicas` in the service spec — and a Stop scales
              the service to 0 and leaves it alone, so a bare `1` beside a
              stopped Application read as one replica running. The stopped row
              is the one case where the live count *is* known, so it is the one
              that states it; the Overview's banner is what reads Swarm's
              tasks, and only after a failure. */}
          <KVRow
            label="Replicas"
            value={
              application.applicationStatus === "stopped" ? (
                <>
                  <span className="num">0</span> of{" "}
                  <span className="num">{application.replicas}</span> running
                </>
              ) : (
                <>
                  <span className="num">{application.replicas}</span> configured
                </>
              )
            }
          />
          <KVRow
            label="Created"
            title={timeExact(application.createdAt)}
            value={
              <time dateTime={application.createdAt}>
                {timeExact(application.createdAt)}
              </time>
            }
          />
          {application.description ? (
            <KVRow
              label="Description"
              value={
                <span className="whitespace-normal text-tx-2">
                  {application.description}
                </span>
              }
              className="items-start"
            />
          ) : null}
        </KVList>
      </Card.Body>
    </Card>
  );
}

/**
 * Which Server this runs on, and which one builds it.
 *
 * Two columns, two different answers, and the reference collapsed them into one
 * "Deploy target" row. They are genuinely different: a build can run on a beefier
 * machine than the one serving traffic, and when it does, that is where the log
 * file lives — which is the thing that makes `/listen-deployment` work or not.
 *
 * Both being empty means the platform's own host, which is the common case on a
 * single-machine install and is said in words rather than left as a dash.
 *
 * **No deploy webhook row**. It used to read `Deploy webhook · Set ·
 * Rotate`, over a secret (`application.refreshToken`) that no route checks:
 * there is no inbound deploy URL, so the row, its Rotate and the dialog behind
 * it advertised a trigger that does not exist. The column and
 * `POST /applications/:id/refresh-token` are still there; the console shows
 * them again when a route accepts the URL, and shows the URL with them.
 */
export function DeployTargetCard({
  application,
}: {
  application: ApplicationDetail;
}) {
  const { server, buildServer, cloudPlace } = application;

  // A cloud Service runs in its Cloud account and builds here.
  if (cloudPlace) {
    return (
      <Card>
        <Card.Header
          title="Where it runs"
          sub="The Cloud account serving it, and where it builds."
          headingLevel={2}
        />
        <Card.Body>
          <KVList>
            <KVRow
              label="Cloud account"
              title={cloudPlace.cloudAccountName}
              value={cloudPlace.cloudAccountName}
            />
            <KVRow label="Region" value={cloudPlace.region} mono />
            <KVRow label="Builds on" value="Cloudgate's own host" />
          </KVList>
          <p className="mt-3 text-meta text-tx-2">
            {onGoogleCloud(cloudPlace) ? (
              <>
                Each deploy pushes its image to this Service&rsquo;s own
                Artifact Registry repository and runs it on Cloud Run.
              </>
            ) : (
              <>
                Each deploy pushes its image to this Service&rsquo;s own ECR
                repository and runs it on ECS Fargate.
              </>
            )}
          </p>
        </Card.Body>
      </Card>
    );
  }

  return (
    <Card>
      <Card.Header
        title="Where it runs"
        sub="The Server serving it, and the one building it."
        headingLevel={2}
      />
      <Card.Body>
        <KVList>
          <KVRow
            label="Server"
            title={server?.name}
            value={
              server ? (
                <Link
                  href={`/servers/${server.serverId}`}
                  className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
                >
                  {server.name}
                </Link>
              ) : (
                "Cloudgate's own host"
              )
            }
          />
          {server ? (
            <>
              <KVRow label="Address" value={server.ipAddress} mono />
              <KVRow
                label="Server status"
                value={<StatusPill mark={serverMark(server)} />}
              />
            </>
          ) : null}
          <KVRow
            label="Builds on"
            title={buildServer?.name}
            value={
              buildServer ? (
                <Link
                  href={`/servers/${buildServer.serverId}`}
                  className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
                >
                  {buildServer.name}
                </Link>
              ) : server ? (
                server.name
              ) : (
                "Cloudgate's own host"
              )
            }
          />
        </KVList>
        <p className="mt-3 text-meta text-tx-2">
          Traefik on the Server above routes this Application&rsquo;s domains to
          it over the overlay network.
        </p>
      </Card.Body>
    </Card>
  );
}
