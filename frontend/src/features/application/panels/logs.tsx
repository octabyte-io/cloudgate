"use client";

import { useEffect } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { DockedLogNote, LogDockButton } from "@/components/console/log-dock";
import { LogWell } from "@/components/console/log-well";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import { errorMessage } from "@/lib/api/error-message";
import type { ApplicationDetail } from "@/lib/api/endpoints/applications";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { toRuntimeLogLines } from "../runtime-log/runtime-log-lines";
import { ServerRuntimeLogCard } from "../runtime-log/server-runtime-log";
import { useRuntimeLog, type RuntimeLog } from "../runtime-log/use-runtime-log";
import { useApplication } from "../use-application";
import { onGoogleCloud } from "@/lib/api/endpoints/applications";

/** The label the spec asks for: the log is polled, not tailed. */
export const BEHIND_LABEL = "A few seconds behind";

/** What the tab says while Google's quota holds the reads back. */
export const DELAYED_LABEL = "Logs delayed";

/**
 * A cloud Service's **Runtime log**: what its ECS tasks write, read
 * from the log group Cloudgate made for it. The backend reads CloudWatch with
 * the Cloud account's deploy role, so the login never reaches the browser,
 * and this tab polls it every few seconds — there is no live tail, and the
 * label says so. Every task's lines are merged by time, each starting with its
 * task.
 *
 * On Google Cloud it is the project's own log store, filtered to the
 * Cloud Run service: each line also names its revision and is marked by what
 * wrote it (stdout, stderr, the app's own log, or Cloud Run). The project's
 * reads are shared, so the log can fall further behind, and it says so.
 *
 * On a Server or the platform host it is Docker's output for the
 * Application's Swarm service, followed live, every running copy merged by
 * time and each line naming its copy (`ServerRuntimeLogCard`, #1341). A Cron
 * service has no such tab: each run is its own job (`tabs/application.ts`).
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const application = useApplication(id);
  const row = application.data;
  const cloud = row?.cloudPlace ?? null;

  return (
    <Page>
      <PageHeader
        title={label}
        icon={icon}
        lede={
          cloud
            ? onGoogleCloud(cloud)
              ? `What ${row?.name ?? "this Service"} writes and what Cloud Run says about it, read from the log store of Google Cloud project ${cloud.cloudAccountName} (${cloud.region}). Every copy merged by time, each line starting with its copy and revision.`
              : `What ${row?.name ?? "this Service"}'s tasks write, read from CloudWatch in Cloud account ${cloud.cloudAccountName} (${cloud.region}). Every task merged by time, each line starting with its task.`
            : `What ${row?.name ?? "this Application"}'s running copies write, live from its Swarm service. Every copy merged by time, each line starting with its copy.`
        }
      />
      {application.error ? (
        // A refusal is not an empty log: it says why, as a failed read.
        <Card>
          <Card.Body>
            <p
              role="alert"
              className="rounded-lg border border-bad-line bg-bad-tint px-3 py-2.5 text-meta text-tx"
            >
              {errorMessage(application.error)}
            </p>
          </Card.Body>
        </Card>
      ) : application.isPending ? (
        <Card>
          <Card.Body>
            <Skeleton className="h-log" />
          </Card.Body>
        </Card>
      ) : row && cloud ? (
        <RuntimeLogCard application={row} />
      ) : row ? (
        <ServerRuntimeLogCard application={row} />
      ) : null}
    </Page>
  );
}

/**
 * The Runtime log's card. **It can be docked** (CONTEXT.md, **Docked log**):
 * the header's Dock button moves the Live log — its poll, cursor, held lines
 * and following flag — into the Dock, where it reads only while on screen, and
 * this card shows a note in its place.
 */
function RuntimeLogCard({ application }: { application: ApplicationDetail }) {
  const log = useRuntimeLog(application.applicationId, true);
  const live = log.stream.log;
  const google = onGoogleCloud(application.cloudPlace);
  const store = google ? "the Google project's log store" : "CloudWatch";
  const docked = live?.owner === "dock";

  const name = `${application.name} · Runtime log`;
  useEffect(() => {
    live?.describe({ name });
  }, [live, name]);

  return (
    <Card>
      <Card.Header
        title="Runtime log"
        sub={
          google
            ? "Read from the Google project's log store every few seconds, sharing the project's read allowance."
            : "Read from CloudWatch every few seconds."
        }
        headingLevel={2}
        actions={
          <>
            <Chip>{log.delayed ? DELAYED_LABEL : BEHIND_LABEL}</Chip>
            {docked ? null : <LogDockButton log={live} />}
          </>
        }
      />
      {live && docked ? (
        <Card.Body>
          <DockedLogNote
            log={live}
            stream={log.stream}
            onReadHere={log.readHereToo}
          />
        </Card.Body>
      ) : (
        <RuntimeLogBody application={application} log={log} store={store} />
      )}
    </Card>
  );
}

function RuntimeLogBody({
  application,
  log,
  store,
}: {
  application: ApplicationDetail;
  log: RuntimeLog;
  store: string;
}) {
  return (
    <Card.Body className="flex flex-col gap-2.5">
      {log.delayed && !log.error ? (
        <p
          role="status"
          className="rounded-lg border border-warn-line bg-warn-tint px-3 py-2.5 text-meta text-tx"
        >
          {DELAYED_LABEL}: Google Cloud refused a read over the project&apos;s
          quota, so reads are waiting a while before trying again. New lines
          show once they do.
        </p>
      ) : null}
      {log.error ? (
        <p
          role="alert"
          className="rounded-lg border border-bad-line bg-bad-tint px-3 py-2.5 text-meta text-tx"
        >
          {errorMessage(log.error)}
        </p>
      ) : null}
      {log.loaded && log.lines.length === 0 && !log.error ? (
        <p className="text-meta text-tx-2">
          {`Nothing written in the last few minutes. New lines show here as ${store} takes them in.`}
        </p>
      ) : null}
      <LogWell
        label={`Runtime log of ${application.name}`}
        lines={toRuntimeLogLines(log.lines)}
        live={!log.error}
        dropped={log.dropped}
        following={log.stream.following}
        onFollowingChange={log.stream.setFollowing}
      />
    </Card.Body>
  );
}
