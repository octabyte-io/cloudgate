import Link from "next/link";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { Dash } from "@/components/console/dash";
import { KVList, KVRow } from "@/components/console/kv-list";
import { StatusPill } from "@/components/console/status-pill";
import type { Database, DatabaseKind } from "@/lib/api/endpoints/databases";
import { timeExact } from "@/lib/format/time";

import { DATABASE_KIND } from "./kinds";

/**
 * What this database is, in the rail beside whichever tab is open.
 *
 * The same shape as F09's `ApplicationFactsCard`, and deliberately so — these
 * two sit in the same slot of the same shell, and a database that described
 * itself in a different order would read as a different product.
 *
 * **`appName` is the fact worth showing most.** It names the Swarm service *and*
 * its data volume (`<appName>-data`), it is immutable, and it is both the string
 * an operator types into `docker service ls` and the host every other service on
 * `cloudgate-network` connects to.
 */
export function DatabaseFactsCard({
  database,
  kind,
  health,
}: {
  database: Database;
  kind: DatabaseKind;
  /**
   * The Overview's health fact line, under Status. Only the Overview
   * passes it, so the other tabs' rail stays as it was.
   */
  health?: React.ReactNode;
}) {
  const descriptor = DATABASE_KIND[kind];
  const { environment } = database;

  return (
    <Card>
      <Card.Header title="Database" headingLevel={2} />
      <Card.Body>
        <KVList>
          <KVRow
            label="Status"
            value={
              // Keyed, so a change of status fades the new word in rather
              // than swapping it under the eye — the Application's recipe.
              <StatusPill
                key={database.applicationStatus}
                status={database.applicationStatus}
                className="animate-fade"
              />
            }
          />
          {/* A postgres on RDS that Cloudgate stopped: when AWS
              starts it again, and after that date that it has. */}
          {database.rdsStop ? (
            <KVRow
              label="On AWS"
              value={database.rdsStop.sentence}
              title={database.rdsStop.sentence}
            />
          ) : null}
          {/* A postgres on Cloud SQL that Cloudgate stopped: no
              date, since Google never starts it by itself. */}
          {database.cloudSqlStop ? (
            <KVRow
              label="On Google Cloud"
              value={database.cloudSqlStop.sentence}
              title={database.cloudSqlStop.sentence}
            />
          ) : null}
          {health}
          <KVRow
            label="Engine"
            value={<Chip variant="brand">{descriptor.label}</Chip>}
          />
          {/* **The configured image, and after a failed deploy it says so**.
             The column is what the next Deploy sends, not a reading
              of the service: a new image Swarm rolled back leaves the row on
              `redis:7` while `redis:8` keeps running, and a bare `redis:7`
              beside the `error` pill read as the image in use. */}
          {database.applicationStatus === "error" ? (
            <KVRow
              label="Image"
              value={
                <>
                  <span className="font-mono text-meta tracking-mono">
                    {database.dockerImage}
                  </span>{" "}
                  <span className="text-tx-2">· not confirmed running</span>
                </>
              }
              title={`${database.dockerImage} is configured, but the last deploy did not take, so Swarm may still be running the previous image. Deploy again once the cause is fixed.`}
            />
          ) : (
            <KVRow
              label="Image"
              value={database.dockerImage}
              title={database.dockerImage}
              mono
            />
          )}
          <KVRow
            label="Service name"
            value={database.appName}
            title={database.appName}
            mono
          />
          <KVRow
            label="Config name"
            value={database.configName}
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
          <KVRow
            label="Server"
            value={
              database.server ? (
                <Link
                  href={`/servers/${database.server.serverId}`}
                  className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
                >
                  {database.server.name}
                </Link>
              ) : (
                // Not a missing value: `serverId` null is how the platform's own
                // host is spelled, and it is the common case on a single-node
                // install. Saying "None" would read as unscheduled.
                <span className="text-tx-2">This Cloudgate host</span>
              )
            }
          />
          {/* **Qualified, always**. This column is the *configured*
              count — it becomes `Mode.Replicated.Replicas` in the service spec
              — and nothing on these screens reads the live one, because a
              database has no task list. A bare `1` beside a stopped database
              was read as "one replica is running", which it was not: Stop
              scales the service to 0 and leaves this column alone. The stopped
              row is the one case where the live count *is* known, so it is the
              one that states it. */}
          <KVRow
            label="Replicas"
            value={
              database.applicationStatus === "stopped" ? (
                <>
                  <span className="num">0</span> of{" "}
                  <span className="num">{database.replicas}</span> running
                </>
              ) : (
                <>
                  <span className="num">{database.replicas}</span> configured
                </>
              )
            }
          />
          <KVRow
            label="Created"
            value={timeExact(database.createdAt) ?? <Dash word="Unknown" />}
          />
        </KVList>
      </Card.Body>
    </Card>
  );
}
