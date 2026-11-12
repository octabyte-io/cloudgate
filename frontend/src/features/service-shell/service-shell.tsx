import { useState } from "react";

import { Card } from "@/components/console/card";
import { EmptyState } from "@/components/console/empty-state";
import { Field } from "@/components/console/field";
import { LinkButton } from "@/components/console/link-button";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { Picker } from "@/components/console/picker";
import { Skeleton } from "@/components/console/skeleton";
import { Terminal, type TerminalTarget } from "@/components/console/terminal";
import { isApiError, isUnreachableHost } from "@/lib/api/api-error";
import type {
  ServiceContainer,
  WorkloadServiceType,
} from "@/lib/api/endpoints/docker";
import { errorMessage } from "@/lib/api/error-message";
import type { IconName } from "@/lib/design/icons";
import { ServerUnreachable } from "@/features/server/server-unreachable";

import { useServiceContainers } from "./use-service-containers";

/**
 * What the Shell tab needs to know about its Service, from the scope's own
 * row. Each scope's panel builds this; the tab itself is one component for
 * all three.
 */
export type ShellService = {
  serviceType: WorkloadServiceType;
  serviceId: string;
  /** The Service's display name, `storefront`. */
  name: string;
  /** Its Environment's and Project's names, for the terminal's title. */
  environment: string;
  project: string;
  /** Its Server, or `null` for the platform host and a Stack VM. */
  serverId: string | null;
  serverName: string | null;
  /** A Compose stack on its own Stack VM (ADR-0070): reached by the stack. */
  composeId?: string;
  /** What the Service is called in a sentence: "Application", "database". */
  noun: string;
  /** The scope root, for "Go to Overview". */
  overviewHref: string;
  /** The Deployments tab, where the scope has one (a database does not). */
  deploymentsHref?: string;
};

/**
 * The container the picker shows: the one chosen, while it is still running,
 * else the first running one. `null` only for
 * an empty list.
 */
export function chosenContainer(
  rows: readonly ServiceContainer[],
  chosen: string | null,
): ServiceContainer | null {
  return rows.find((row) => row.containerId === chosen) ?? rows[0] ?? null;
}

type ContainerTarget = Extract<TerminalTarget, { kind: "container" }>;

/**
 * The terminal target for one of the Service's containers.
 *
 * `service` names the Service the shell is in, so the terminal's header and
 * the Dock's read `storefront · production · Demo Shop` rather than
 * Docker's generated name. It is optional on the container target and always
 * set here, which the return type says.
 */
export function shellTarget(
  service: ShellService,
  container: ServiceContainer,
): ContainerTarget & Required<Pick<ContainerTarget, "service">> {
  return {
    kind: "container",
    containerId: container.containerId,
    serverId: service.serverId,
    ...(service.composeId ? { composeId: service.composeId } : {}),
    name: container.name,
    host: service.composeId
      ? "its Stack VM"
      : (service.serverName ?? "this host"),
    shell: "sh",
    service: {
      name: service.name,
      environment: service.environment,
      project: service.project,
    },
  };
}

/**
 * **The Shell tab**: `sh` inside one of a Service's own running
 * containers, without a visit to Servers.
 *
 * The containers come from the Service-scoped listing, gated on the same
 * `service:update` the socket asks for, so whatever it offers opens. More than
 * one — replicas, or a Compose stack's services — gets a picker with the first
 * preselected; switching opens a fresh shell in the other, because the shared
 * `<Terminal>` keys its session on the container.
 *
 * The shell lives in the tab until it is docked: leaving closes the socket,
 * which ends the shell's processes, unless the Dock holds it;
 * coming back opens a fresh one either way — the lede says so, in the Server
 * Terminal tab's words. Every other end of a shell (the image has no `sh`, the shell exited, the
 * Server dropped) is the terminal's own wording.
 *
 * What is *not* a terminal, each in words: the row still loading or refused,
 * a Server nobody reached, a refusal of the listing, and no running container
 * at all — stopped, never deployed, or a failed deploy.
 */
export function ServiceShell({
  service,
  error,
  pending,
  label,
  icon,
}: {
  service: ShellService | null;
  /** The scope row's own read failed. */
  error: unknown;
  pending: boolean;
  label: string;
  icon: IconName;
}) {
  return (
    <Page>
      <PageHeader
        title={label}
        icon={icon}
        lede={
          service
            ? `A shell inside ${service.name}'s running container, as sh. Leaving this tab ends the shell, unless you Dock it first — the Dock keeps it running at the bottom of the console. Coming back opens a fresh one.`
            : "A shell inside this Service's running container, as sh."
        }
      />
      {error ? (
        <Card>
          <Card.Body>
            <p
              role="alert"
              className="rounded-lg border border-bad-line bg-bad-tint px-3 py-2.5 text-meta text-tx"
            >
              {errorMessage(error)}
            </p>
          </Card.Body>
        </Card>
      ) : pending || !service ? (
        <ShellSkeleton />
      ) : (
        <ShellBody service={service} />
      )}
    </Page>
  );
}

function ShellSkeleton() {
  return (
    <Card>
      <Card.Body>
        <Skeleton className="h-log" />
      </Card.Body>
    </Card>
  );
}

function ShellBody({ service }: { service: ShellService }) {
  const containers = useServiceContainers(
    service.serviceType,
    service.serviceId,
  );
  const [chosen, setChosen] = useState<string | null>(null);

  if (containers.isPending) return <ShellSkeleton />;

  if (isUnreachableHost(containers.error)) {
    return (
      <Card>
        <Card.Body>
          {service.serverId ? (
            <ServerUnreachable
              serverId={service.serverId}
              ran={<code className="font-mono">docker ps</code>}
            >
              Cloudgate cannot say which of {service.name}&rsquo;s containers
              are running, and has no shell to open.
            </ServerUnreachable>
          ) : (
            <p role="alert" className="text-body text-tx">
              {errorMessage(containers.error)}
            </p>
          )}
        </Card.Body>
      </Card>
    );
  }

  if (isApiError(containers.error) && containers.error.isForbidden) {
    return (
      <Card>
        <Card.Body>
          <p role="alert" className="text-body text-tx">
            Your role in this Organization cannot open a shell in this{" "}
            {service.noun}.
          </p>
          <p className="mt-1.5 text-meta text-tx-2">
            A shell writes inside the Service, which takes the update action on
            Services. Ask an owner or an admin to do it, or to change your role.
          </p>
        </Card.Body>
      </Card>
    );
  }

  if (containers.error) {
    return (
      <Card>
        <Card.Body>
          <p role="alert" className="text-body text-tx-2">
            {errorMessage(containers.error)}
          </p>
        </Card.Body>
      </Card>
    );
  }

  const rows = containers.data ?? [];
  const container = chosenContainer(rows, chosen);

  if (!container) {
    return (
      <Card>
        <Card.Body flush>
          <EmptyState
            icon="term"
            title={`No container of ${service.name} is running`}
            action={
              <div className="flex flex-wrap justify-center gap-2.5">
                <LinkButton href={service.overviewHref} variant="pri">
                  Go to Overview
                </LinkButton>
                {service.deploymentsHref ? (
                  <LinkButton href={service.deploymentsHref}>
                    See Deployments
                  </LinkButton>
                ) : null}
              </div>
            }
          >
            {/* A shell runs inside a running container, and the host runs
                none: stopped, never deployed, or its last deploy failed. */}
            {service.deploymentsHref
              ? "Start it from Overview to open a shell; Deployments says how the last one went."
              : "Start or deploy it from Overview to open a shell."}
          </EmptyState>
        </Card.Body>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3.5">
      {rows.length > 1 ? (
        <Field
          name="container"
          label="Container"
          hint={
            service.serviceType === "compose"
              ? "Each of the stack's running containers, by its compose service."
              : "Each running copy of this Service on its machine."
          }
          manual
        >
          <Picker
            mono
            value={container.containerId}
            onValueChange={setChosen}
            options={rows.map((row) => ({
              value: row.containerId,
              label: row.composeService ?? row.name,
              detail: `${row.state} · ${row.containerId.slice(0, 12)}`,
            }))}
          />
        </Field>
      ) : null}
      <Terminal target={shellTarget(service, container)} />
    </div>
  );
}
