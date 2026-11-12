import Link from "next/link";

import { Card } from "@/components/console/card";
import { CopyButton } from "@/components/console/copy-button";
import { LinkButton } from "@/components/console/link-button";
import { Skeleton } from "@/components/console/skeleton";
import { serviceTabHref } from "@/components/shell/service-href";
import { buttonVariants } from "@/components/ui/button";
import type { EnvironmentDomain } from "@/lib/api/endpoints/environments";
import type { TemplateSummary } from "@/lib/api/endpoints/templates";
import { errorMessage } from "@/lib/api/error-message";
import { Icon } from "@/lib/design/icons";

import { useLaunch } from "./use-get-started";
import { StageList } from "./wizard-parts";
import { appAddress, type LaunchPhase, type StageState } from "./wizard-model";

/**
 * Step three: the deploy, followed until the app runs, then its address
 * and what to do next. Cloudgate applies the setup's plan by itself (the
 * setup asked for `autoApply`), so this view only watches; leaving it
 * changes nothing.
 */
export function LaunchView({
  template,
  environmentId,
}: {
  template: TemplateSummary;
  environmentId: string;
}) {
  const launch = useLaunch(environmentId, template.id);
  const environmentHref = `/environments/${encodeURIComponent(environmentId)}`;

  if (launch.plan.error) {
    return (
      <Card>
        <Card.Body className="grid justify-items-start gap-3">
          <p className="text-body text-tx-2">
            {errorMessage(launch.plan.error)}
          </p>
          <LinkButton href={environmentHref}>Open the Project</LinkButton>
        </Card.Body>
      </Card>
    );
  }

  const { phase } = launch;

  // Each phase replaces the last in place, so each card fades in rather than
  // rising: the step already made its entrance, and a launch that moves on
  // is the same block reading differently.
  if (phase.phase === "failed") {
    return (
      <Card className="animate-fade">
        <Card.Body className="grid justify-items-start gap-3">
          <p className="flex min-w-0 items-center gap-2 text-body font-medium wrap-anywhere text-tx">
            <Icon name="alert" size={15} className="flex-none text-bad" />
            <span>{template.name} didn&rsquo;t start.</span>
          </p>
          <p className="text-body text-tx-2">{phase.reason}</p>
          <LinkButton href={environmentHref} variant="pri">
            See what happened
          </LinkButton>
        </Card.Body>
      </Card>
    );
  }

  if (phase.phase === "running") {
    return (
      <Running
        template={template}
        domains={launch.domains.data}
        pending={launch.domains.isPending}
        environmentHref={environmentHref}
      />
    );
  }

  return (
    <Card>
      <Card.Header
        title={`Launching ${template.name}`}
        sub="It starts once your server is ready, usually within a few minutes. You can leave this page; it carries on."
        headingLevel={2}
      />
      <Card.Body className="grid gap-4">
        <StageList
          label={`Launching ${template.name}`}
          stages={launchStages(phase, template.name)}
        />
        {phase.phase === "preparing" && phase.waitingFor ? (
          <p role="status" className="text-ui text-tx-2">
            {phase.waitingFor}
          </p>
        ) : null}
      </Card.Body>
    </Card>
  );
}

/** The three stages of a launch, from where it stands. */
export function launchStages(
  phase: LaunchPhase,
  appName: string,
): { label: string; state: StageState }[] {
  const at =
    phase.phase === "preparing" ? 0 : phase.phase === "starting" ? 1 : 2;
  const state = (index: number): StageState =>
    index < at ? "done" : index === at ? "now" : "todo";
  return [
    { label: `Preparing ${appName}`, state: state(0) },
    { label: `Starting ${appName}`, state: state(1) },
    { label: `${appName} is running`, state: at === 2 ? "done" : "todo" },
  ];
}

/** The app is running: its address, and the next things people do. */
function Running({
  template,
  domains,
  pending,
  environmentHref,
}: {
  template: TemplateSummary;
  domains: EnvironmentDomain[] | undefined;
  pending: boolean;
  environmentHref: string;
}) {
  const address = appAddress(domains);
  const service = domains?.[0]?.service;

  return (
    <Card className="animate-fade">
      <Card.Body className="grid justify-items-start gap-4 p-5">
        <p
          role="status"
          className="flex min-w-0 items-center gap-2.5 text-sect wrap-anywhere text-tx"
        >
          <span
            aria-hidden="true"
            className="grid size-8 flex-none place-items-center rounded-pill border border-ok-line bg-ok-tint text-ok"
          >
            <Icon name="check" size={16} />
          </span>
          <span>{template.name} is running</span>
        </p>

        {pending ? (
          <Skeleton className="h-ctl w-full max-w-64" />
        ) : address ? (
          <div className="grid w-full animate-fade gap-2">
            <div className="flex min-w-0 items-center gap-2 rounded-md border border-line bg-panel-2 px-3 py-2">
              <span className="min-w-0 flex-1 font-mono text-ui wrap-anywhere text-tx">
                {address}
              </span>
              <CopyButton value={address} label="address" />
            </div>
            <div className="flex flex-wrap gap-2">
              <a
                href={address}
                target="_blank"
                rel="noreferrer noopener"
                className={buttonVariants({
                  variant: "pri",
                  className: "max-w-full",
                })}
              >
                <span className="truncate">{`Open ${template.name}`}</span>
                <Icon name="ext" size={14} className="flex-none" />
              </a>
            </div>
            <p className="text-meta text-tx-3">
              The first visit can take a minute while it finishes starting.
            </p>
          </div>
        ) : (
          <p className="text-body wrap-anywhere text-tx-2">
            {template.name} has no web address of its own. Its page in your
            Project shows how to reach it.
          </p>
        )}

        <div className="grid w-full gap-2 border-t border-line pt-4">
          <h2 className="text-body font-medium text-tx">What next</h2>
          <ul className="grid gap-1.5 text-body text-tx-2">
            {service && address?.startsWith("http://") ? (
              <li>
                <Link
                  href={serviceTabHref(service, "domains")}
                  className="text-brand-tx underline underline-offset-2"
                >
                  Use your own domain
                </Link>{" "}
                so {template.name} is served over https.
              </li>
            ) : null}
            <li>
              <Link
                href={environmentHref}
                className="text-brand-tx underline underline-offset-2"
              >
                See {template.name} in your Project
              </Link>
              : its logs, settings and passwords.
            </li>
            <li>
              <Link
                href="/templates"
                className="text-brand-tx underline underline-offset-2"
              >
                Deploy another app
              </Link>
            </li>
          </ul>
        </div>
      </Card.Body>
    </Card>
  );
}
