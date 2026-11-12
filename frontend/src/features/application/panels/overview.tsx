"use client";

import { useState } from "react";

import { Banner, BannerRow } from "@/components/console/banner";
import { WiredChangedNotice } from "@/components/console/wired-changed-notice";
import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { EmptyState } from "@/components/console/empty-state";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { OpenShellButton } from "@/features/service-shell/open-shell-button";
import { Skeleton } from "@/components/console/skeleton";
import { Chip } from "@/components/console/chip";
import { Button } from "@/components/ui/button";
import { HealthFactRow } from "@/components/console/service-health-state";
import { errorMessage } from "@/lib/api/error-message";
import { newestLive, watchingOther } from "@/lib/format/deployment-facts";
import type { PanelProps } from "@/lib/shell/tab-registry";

import {
  ApplicationFactsCard,
  DeployTargetCard,
} from "../application-facts-card";
import { CloudResourcesCard } from "../cloud-resources-card";
import { cronAfterFailure } from "../cron/cron-failure";
import { CronTimetableCard } from "../cron/cron-timetable-card";
import { RunNowButton } from "../cron/run-now-button";
import { DeployButton, deployUnavailable } from "../deploy/deploy-button";
import { DeploymentLog } from "../deploy/deployment-log";
import { afterFailure, liveBuildSub } from "../deploy/deployment-facts";
import { DomainsAside } from "../domains/domains-aside";
import { ApplicationActions } from "../lifecycle/application-actions";
import { CloudDeleteCard } from "../lifecycle/cloud-delete-card";
import { CancelBuildButton } from "../lifecycle/cancel-build-button";
import { StopRunButton } from "../lifecycle/stop-run-button";
import { RedeployButton } from "../lifecycle/redeploy-button";
import { BuildCard } from "../source/build-card";
import { SourceCard } from "../source/source-card";
import {
  useApplication,
  useApplicationDeployments,
  useGpuWait,
  useRunningTasks,
  useUpdateApplication,
} from "../use-application";

/**
 * The Application, and everything about it that is not a list.
 *
 * The reference puts a requests chart at the top of this page
 * (`e-console.html:4150-4152`). It is **absent**: per-service request metrics need
 * F14's monitoring gateway, and a chart drawn from nothing is the one thing on an
 * infrastructure console that must never be decorative. What leads instead is the
 * thing that is real and live — the current build's output when there is one, and
 * the last one's when there is not.
 *
 * The status banner is only drawn for `error`, and its wording is the point: **a
 * failed Deployment does not take the Application down.** The previous release is
 * still serving, and an operator who reads red as "we are offline" makes the wrong
 * decision next.
 *
 * **Unless there is no previous release serving** — and the banner once said
 * so regardless: to an Application whose first Deployment had just failed, and
 * to one Swarm had rolled back onto a spec no node could run. Reading red as
 * "offline" is the wrong decision; so is reading "still serving" when the
 * domain answers 502. `afterFailure` decides which of the four it is.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const deployments = useApplicationDeployments(id);
  const rows = deployments.data ?? [];
  const live = newestLive(rows);

  const application = useApplication(id, { live: live !== null });
  const update = useUpdateApplication(id, application.data?.environmentId);
  // The **id**, not the row: a Deployment captured at deploy time keeps the
  // `pending` status it had then, and the log's header would report it for ever
  // while the table beside it moved on. Same fix as the Deployments panel.
  const [watchingId, setWatchingId] = useState<string | null>(null);

  const row = application.data;
  // **Not while a Deployment is in flight**. The row's `error` is the
  // last *finished* attempt's, and until the worker picks the new build up the
  // row still wears it: the banner said "The last Deployment failed" over a
  // log card streaming the new one. The live Deployment is the newer fact, so
  // the card and the banner both follow the Deployment list.
  const failed = row?.applicationStatus === "error" && live === null;
  // A Cron service has no Swarm service to read tasks of, and serves nothing
  // at all: its banner and facts speak of runs instead.
  const cron = row?.cronService ?? null;
  const running = useRunningTasks(row, failed && cron === null);
  const gpuWait = useGpuWait(row);
  // Until the history has arrived, "nothing was ever done" is not known, so the
  // banner does not say it on the strength of an empty list still loading.
  const failure = deployments.data
    ? afterFailure(rows, running)
    : "previous-serving";

  // A bad id 404s into `Outcome` before this panel (F07). What lands here is a
  // 403 or a backend not answering: the shell stays, only the reading goes.
  if (application.error) {
    return (
      <Page>
        <PageHeader title={label} icon={icon} />
        <Cols>
          <Card>
            <Card.Body>
              <p className="text-body text-tx-2">
                {errorMessage(application.error)}
              </p>
            </Card.Body>
          </Card>
        </Cols>
      </Page>
    );
  }

  if (!row) {
    return (
      <Page>
        <PageHeader title={label} icon={icon} />
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

  // Newest first: `createdAt` is the only field every Deployment has.
  const latest = [...rows].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )[0];
  const watching =
    rows.find((deployment) => deployment.deploymentId === watchingId) ?? null;
  // What "Show the newest" would switch to, and so what it is compared against:
  // offered against `live` alone, it grew on every finished deploy, because
  // `live` is `null` by then while `watching` is already the newest.
  const newest = live ?? latest ?? null;
  const streaming = watching ?? newest;
  // What the output card and its empty state say depends on the source
  // an image is pulled, never built, and with no source at all the
  // next step is choosing one, not deploying.
  const noSource = deployUnavailable(row) !== null;
  const image = row.sourceType === "docker" && !noSource;
  const empty = EMPTY_OUTPUT[noSource ? "none" : image ? "image" : "build"];

  return (
    <Page>
      <PageHeader
        title={row.name}
        icon={icon}
        badges={
          /* No `StatusPill` here — F19's one removal. The masthead states this
             Application's status a few pixels above, on every tab and while you
             scroll, and `ApplicationFactsCard` states it again under a label. A
             third copy of one four-value enum on one screen is the extra badge
             audit 8 asks for, and the title line is where it earns least: it is
             the one place the word has neither a label nor a scope beside it. */
          <Chip variant="mono">{row.appName}</Chip>
        }
        lede={`${row.description || "An Application"} — in ${row.environment.project.name} / ${row.environment.name}.`}
        actions={
          /* Deploy, Restart and Stop-or-Start, as a database's slot has. */
          <>
            {/* To the Shell tab, wherever there is one. */}
            <OpenShellButton />
            <ApplicationActions
              application={row}
              hasBuilt={rows.some((deployment) => deployment.status === "done")}
              onDeployed={(deployment) =>
                setWatchingId(deployment.deploymentId)
              }
            />
          </>
        }
      />

      <Cols
        aside={
          <>
            <ApplicationFactsCard
              application={row}
              health={
                cron ? null : (
                  <HealthFactRow serviceType="application" serviceId={id} />
                )
              }
            />
            <DeployTargetCard application={row} />
            <DomainsAside applicationId={id} />
          </>
        }
        asideLabel="About this Application"
      >
        {/* A cloud Delete running or incomplete: first, since it is
            what this Service is doing, and its Retry and Forget live here. */}
        {row.cloudDelete ? <CloudDeleteCard application={row} /> : null}

        {/* A linked Output changed outside a plan. */}
        <WiredChangedNotice
          wiredChangedAt={row.wiredChangedAt}
          deploymentsHref={`/applications/${id}/deployments`}
        />

        {gpuWait ? (
          /* Why it is not running when no Deployment failed: Swarm left
             its task pending, after a reboot or a lost card, until enough
             cards are free. Read live from the Server; nothing is written. */
          <Banner
            icon="alert"
            title="This Application is not running."
            className="animate-rise"
          >
            <BannerRow
              tone="warn"
              title={`Waiting for a GPU: this Server has ${gpuWait.free} free of ${gpuWait.cards}`}
              description="Swarm starts it as soon as enough cards are free on its Server."
            />
          </Banner>
        ) : null}

        {failed ? (
          <Banner
            icon="alert"
            title="The last Deployment failed."
            className="animate-rise border-bad-line"
          >
            <BannerRow
              tone="bad"
              {...(cron
                ? cronAfterFailure(cron.waitingForFirstBuild)
                : AFTER_FAILURE[failure])}
              action={
                /* **Redeploy, not Deploy** — the reference put a Redeploy here
                   (`e-console.html:4148`) and at first there was nothing for it
                   to call. It builds the same source again and records the
                   attempt as a rebuild, so a retry is legible in the history as
                   a retry. */
                <RedeployButton
                  applicationId={id}
                  environmentId={row.environmentId}
                  onDeployed={(deployment) =>
                    setWatchingId(deployment.deploymentId)
                  }
                />
              }
            />
          </Banner>
        ) : null}

        {/* A Cron service's timetable, and whether it waits for a first
            build. */}
        {row.cronService ? (
          <CronTimetableCard
            cron={row.cronService}
            actions={
              <RunNowButton
                applicationId={id}
                waitingForFirstBuild={row.cronService.waitingForFirstBuild}
                onStarted={(run) => setWatchingId(run.deploymentId)}
              />
            }
          />
        ) : null}

        <Card>
          <Card.Header
            title={
              OUTPUT_TITLE[image ? "image" : "build"][live ? "live" : "last"]
            }
            sub={
              live
                ? liveBuildSub(live)
                : streaming
                  ? "The most recent Deployment of this Application."
                  : undefined
            }
            headingLevel={2}
            actions={
              <>
                {/* Only a `pending` or `running` build renders one — see the
                    note in `cancel-build-button.tsx`. A queued build once had
                    no answer here, and a hung one none either. */}
                {streaming ? (
                  <>
                    <CancelBuildButton
                      deployment={streaming}
                      applicationId={id}
                    />
                    {/* A running Cloud run only. */}
                    <StopRunButton deployment={streaming} applicationId={id} />
                  </>
                ) : null}
                {watchingOther(watching, newest) ? (
                  <Button size="xs" onClick={() => setWatchingId(null)}>
                    Show the newest
                  </Button>
                ) : null}
              </>
            }
          />
          <Card.Body>
            {deployments.isPending ? (
              <Skeleton className="h-log" />
            ) : streaming ? (
              <DeploymentLog deployment={streaming} subject={row.name} />
            ) : (
              <EmptyState
                icon="rocket"
                title={empty.title}
                action={
                  noSource ? undefined : (
                    <DeployButton
                      applicationId={id}
                      environmentId={row.environmentId}
                      onDeployed={(deployment) =>
                        setWatchingId(deployment.deploymentId)
                      }
                      size="sm"
                    />
                  )
                }
              >
                {empty.body}
              </EmptyState>
            )}
          </Card.Body>
        </Card>

        {/* What Cloudgate made in AWS, and an unreadable state's Rebuild
            from the cloud. Nothing for a Service on a Server. */}
        <CloudResourcesCard application={row} />

        <SourceCard
          application={row}
          save={(input) => update.mutateAsync(input)}
        />

        <BuildCard
          application={row}
          save={(input) => update.mutateAsync(input)}
        />
      </Cols>
    </Page>
  );
}

/** What the failure banner says, for each answer `afterFailure` gives. */
const AFTER_FAILURE = {
  "previous-serving": {
    title: "The previous Deployment is still serving traffic.",
    description:
      "A failed Deployment does not take the Application down — nothing was swapped in. Read the output below, fix the cause, and build it again.",
  },
  "nothing-running": {
    title: "Nothing is serving traffic.",
    description:
      "An earlier Deployment succeeded, but Swarm has no task of this Application running now, so its domains have nothing behind them. Read the output below, fix the cause, and build it again.",
  },
  "running-unproven": {
    title: "No Deployment of this Application has succeeded yet.",
    description:
      "Swarm reports a task of it running, but it belongs to a Deployment that failed, not to one that finished — it can stop at any moment. Read the output below, fix the cause, and deploy again.",
  },
  "never-ran": {
    title: "This Application has never run.",
    description:
      "No Deployment of it has succeeded yet, so nothing is serving traffic. Read the output below, fix the cause, and deploy again.",
  },
} as const;

/** The output card's title: an image is deployed, never built. */
const OUTPUT_TITLE = {
  build: { live: "Build output", last: "Last build output" },
  image: { live: "Deployment output", last: "Last Deployment output" },
} as const;

/** What the output card says before the first Deployment, by source. */
const EMPTY_OUTPUT = {
  none: {
    title: "No source is chosen yet",
    body: "Choose where this Application comes from under Source below, then deploy it.",
  },
  image: {
    title: "Nothing has been deployed yet",
    body: "Deploy to pull the image and start it. Its output streams here.",
  },
  build: {
    title: "Nothing has been built yet",
    body: "Deploy to build the source and release it. Its output streams here.",
  },
} as const;
