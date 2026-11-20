import Link from "next/link";

import { Card } from "@/components/console/card";
import { CopyButton } from "@/components/console/copy-button";
import { LinkButton } from "@/components/console/link-button";
import { Skeleton } from "@/components/console/skeleton";
import { serviceTabHref } from "@/components/shell/service-href";
import { buttonVariants } from "@/components/ui/button";
import type {
  EnvironmentDetail,
  EnvironmentDomain,
} from "@/lib/api/endpoints/environments";
import type { TemplateSummary } from "@/lib/api/endpoints/templates";
import { errorMessage } from "@/lib/api/error-message";
import {
  useServedCertificate,
  type ServedCertificateState,
} from "@/lib/api/use-served-certificate";
import { Icon } from "@/lib/design/icons";

import { addressInSslipName } from "../application/domains/dns-helper";
import { LaunchDetail } from "./launch-progress";
import { SignInBlock } from "./sign-in-block";
import { useLaunch, useWizardServers } from "./use-get-started";
import { StageList } from "./wizard-parts";
import {
  appAddress,
  launchParts,
  type LaunchPhase,
  type StageState,
} from "./wizard-model";

/**
 * Step three: the deploy, followed until the app runs, then its address
 * and what to do next. Cloudgate applies the setup's plan by itself (the
 * setup asked for `autoApply`), so this view only watches; leaving it
 * changes nothing.
 */
export function LaunchView({
  template,
  environmentId,
  serverId = null,
}: {
  template: TemplateSummary;
  environmentId: string;
  /** The Server the app goes on, from the wizard's address. */
  serverId?: string | null;
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
      <Launched
        template={template}
        domains={launch.domains.data}
        pending={launch.domains.isPending}
        environment={launch.environment?.data}
        environmentHref={environmentHref}
        serverId={serverId}
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
          // An https address shows its certificate stage from the start.
          stages={launchStages(
            phase,
            template.name,
            launch.domains.data?.[0]?.https ? "reading" : null,
          )}
          detail={
            <LaunchDetail
              phase={phase}
              parts={launchParts(
                launch.plan.data?.plan,
                launch.deployments.data,
              )}
              serverId={serverId}
            />
          }
        />
      </Card.Body>
    </Card>
  );
}

/** The stage a launch waits on its HTTPS certificate in (#130). */
export const CERTIFICATE_STAGE = "Getting its HTTPS certificate";

/**
 * The stages of a launch, from where it stands: three, and a fourth for an
 * `https://` address, between starting and running, while Let's Encrypt
 * issues its certificate (#130). Until then Traefik serves its own
 * self-signed one, so "running" with an Open button would be a first click
 * onto a browser's security warning.
 *
 * `certificate` is that wait's state; null for an `http://` address, which
 * has no certificate and skips the stage.
 */
export function launchStages(
  phase: LaunchPhase,
  appName: string,
  certificate: ServedCertificateState["state"] | null = null,
): { label: string; state: StageState }[] {
  const waits = certificate === "reading" || certificate === "issuing";
  const at =
    phase.phase === "preparing"
      ? 0
      : phase.phase === "starting"
        ? 1
        : certificate !== null && waits
          ? 2
          : 3;
  const state = (index: number): StageState =>
    index < at ? "done" : index === at ? "now" : "todo";
  return [
    { label: `Preparing ${appName}`, state: state(0) },
    { label: `Starting ${appName}`, state: state(1) },
    ...(certificate === null
      ? []
      : [{ label: CERTIFICATE_STAGE, state: state(2) }]),
    { label: `${appName} is running`, state: at === 3 ? "done" : "todo" },
  ];
}

/**
 * The app is running. With an `https://` address, its certificate is waited
 * for first (`useServedCertificate`, polling the address's served
 * certificate from the platform host): the stages stay up, on their
 * certificate stage, until it is issued, and Open appears only then. Past
 * the wait, it finishes anyway with a note, never a dead end.
 */
function Launched({
  template,
  domains,
  pending,
  environment,
  environmentHref,
  serverId,
}: {
  template: TemplateSummary;
  domains: EnvironmentDomain[] | undefined;
  pending: boolean;
  environment: EnvironmentDetail | undefined;
  environmentHref: string;
  serverId: string | null;
}) {
  const domain = domains?.[0];
  const https = domain?.https === true;
  // Mounted when the app was seen running, so the wait starts from there.
  const certificate = useServedCertificate(domain?.domainId ?? null, {
    enabled: https,
  });
  if (
    https &&
    (certificate.state === "reading" || certificate.state === "issuing")
  ) {
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
            stages={launchStages(
              { phase: "running" },
              template.name,
              certificate.state,
            )}
            detail={
              <p className="text-meta text-tx-3">Usually under a minute.</p>
            }
          />
        </Card.Body>
      </Card>
    );
  }
  return (
    <Running
      template={template}
      domains={domains}
      pending={pending}
      environment={environment}
      environmentHref={environmentHref}
      certificateLate={https && certificate.state === "not-issued"}
      serverId={serverId}
    />
  );
}

/** The app is running: its address, and the next things people do. */
function Running({
  template,
  domains,
  pending,
  environment,
  environmentHref,
  certificateLate,
  serverId,
}: {
  template: TemplateSummary;
  domains: EnvironmentDomain[] | undefined;
  pending: boolean;
  /** The Environment's read, for the template's stack when no Domain names it. */
  environment: EnvironmentDetail | undefined;
  environmentHref: string;
  /** Its HTTPS certificate was waited for, and is still not issued. */
  certificateLate: boolean;
  serverId: string | null;
}) {
  const address = appAddress(domains);
  // The template's stack: its Domain's Service, or else the Environment's
  // one stack (Get started's Environment is the template's own).
  const service =
    domains?.[0]?.service ??
    environment?.services.find((one) => one.serviceType === "compose");
  const composeId =
    service?.serviceType === "compose" ? service.serviceId : null;
  const servers = useWizardServers();
  const host = domains?.[0]?.host ?? "";
  // Where an A record has to point: the sslip.io name carries it; an own
  // domain points at the Server's address.
  const pointsAt =
    addressInSslipName(host) ??
    servers.data?.find((server) => server.serverId === serverId)?.ipAddress ??
    null;

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
            {certificateLate ? (
              <p className="text-meta wrap-anywhere text-tx-2">
                {template.name}{" "}
                is running, but its HTTPS certificate
                isn&rsquo;t issued yet. Your browser will warn until it is,
                usually within a few minutes.
                {pointsAt ? (
                  <>
                    {" "}
                    If you used your own domain, check its A record points at{" "}
                    <span className="font-mono">{pointsAt}</span>.
                  </>
                ) : null}
              </p>
            ) : (
              <p className="text-meta text-tx-3">
                The first visit can take a minute while it finishes starting.
              </p>
            )}
          </div>
        ) : (
          <p className="text-body wrap-anywhere text-tx-2">
            {template.name} has no web address of its own. Its page in your
            Project shows how to reach it.
          </p>
        )}

        {template.signIn ? (
          <SignInBlock
            appName={template.name}
            signIn={template.signIn}
            address={pending ? null : address}
            composeId={composeId}
          />
        ) : null}

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
            {service ? (
              <li>
                All of {template.name}&rsquo;s settings and passwords are on its{" "}
                <Link
                  href={serviceTabHref(service, "variables")}
                  className="text-brand-tx underline underline-offset-2"
                >
                  Variables
                </Link>{" "}
                tab.
              </li>
            ) : null}
            <li>
              <Link
                href={environmentHref}
                className="text-brand-tx underline underline-offset-2"
              >
                See {template.name} in your Project
              </Link>
              {service
                ? ": its logs and settings."
                : ": its logs, settings and passwords."}
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
