"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { EmptyState } from "@/components/console/empty-state";
import { Field } from "@/components/console/field";
import { PageHeader } from "@/components/console/page-header";
import { Picker } from "@/components/console/picker";
import { Segmented } from "@/components/console/segmented";
import { Skeleton } from "@/components/console/skeleton";
import { errorMessage } from "@/lib/api/error-message";
import { runsOnStackVm, type ComposeDetail } from "@/lib/api/endpoints/compose";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { ComposeFactsCard } from "../compose-facts-card";
import { ComposePanel } from "../compose-panel";
import { useStackContainers } from "../containers/use-stack-containers";
import { ComposeActions } from "../lifecycle/compose-actions";
import { whyNothingRuns } from "../lifecycle/nothing-running";
import { ContainerOutput } from "../logs/container-output";

/**
 * What the containers in this stack are saying.
 *
 * **"The logs" is a choice here, which it is not for an Application**, and that is
 * the whole reason this is its own tab: a stack is several containers and
 * `/docker-container-logs` follows exactly one. So the screen is a picker and a
 * well, and the picker is built from the same join the Containers tab uses — a
 * service with nothing running is offered and disabled rather than missing, because
 * "there is no worker to read" is the answer somebody came here for.
 *
 * **A Swarm stack gets a second reading**, and it is not decoration:
 * `runType=swarm` runs `docker service logs`, which takes a *service* name and
 * aggregates **every task** of it — so on a replicated service it is the only way
 * to see the output of all of them, and it survives Swarm replacing a task
 * underneath you, which a container id does not. For a `docker-compose` stack there
 * is no such command, so the choice is absent rather than present and broken.
 */
export default function Panel(props: PanelProps) {
  return (
    <ComposePanel
      panel={props}
      live
      aside={(row) => <ComposeFactsCard compose={row} />}
      header={(row) => (
        <PageHeader
          title={props.label}
          icon={props.icon}
          lede={`Live output from one container in ${row.name}. Following the tail, until you scroll up.`}
          actions={<ComposeActions compose={row} size="sm" />}
        />
      )}
    >
      {(row) => <Body compose={row} />}
    </ComposePanel>
  );
}

type Source = "container" | "service";

function Body({ compose }: { compose: ComposeDetail }) {
  const containers = useStackContainers(compose);
  const swarm = compose.composeType === "stack";

  const [source, setSource] = useState<Source>("container");
  const [chosen, setChosen] = useState<string | null>(null);

  const running = containers.rows.filter((row) => row.containerId !== null);
  const services = [
    ...new Set(
      containers.rows
        .map((row) => row.service)
        .filter((name): name is string => name !== null),
    ),
  ];

  // The first container, until someone picks another. Derived rather than seeded
  // in an effect: the list arrives after the first render and a `setState` in an
  // effect is what this project's lint rules refuse (F10's note).
  const target =
    source === "service"
      ? (chosen ?? services[0] ?? null)
      : (chosen ?? running[0]?.containerId ?? null);

  const targetName =
    source === "service"
      ? target
        ? `${compose.appName}_${target}`
        : null
      : target;

  const chosenRow = running.find((row) => row.containerId === target);

  if (containers.isPending) {
    return (
      <Card>
        <Card.Body>
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-ctl" />
            <Skeleton className="h-log" />
          </div>
        </Card.Body>
      </Card>
    );
  }

  if (containers.error) {
    return (
      <Card>
        <Card.Header title="Output" headingLevel={2} />
        <Card.Body>
          <p className="text-body text-tx-2">
            {errorMessage(containers.error)} There is no container to choose
            until the deploy target answers.
          </p>
        </Card.Body>
      </Card>
    );
  }

  if (running.length === 0) {
    return (
      <Card>
        <Card.Body flush>
          <EmptyState
            icon="term"
            title="Nothing is running to read from"
            action={<ComposeActions compose={compose} size="sm" deployOnly />}
          >
            {whyNothingRuns(compose, "output")}
          </EmptyState>
        </Card.Body>
      </Card>
    );
  }

  return (
    <Card>
      <Card.Header
        title="Output"
        sub={
          source === "service"
            ? "Every task of one Swarm service, aggregated by Docker."
            : "One container, as it writes."
        }
        headingLevel={2}
      />
      <Card.Body className="flex flex-col gap-3.5">
        {swarm ? (
          <Field
            name="source"
            label="Read from"
            hint="A container is one process. A service aggregates every task of it, and survives Swarm replacing one."
            manual
          >
            <Segmented<Source>
              label="Read from"
              value={source}
              onChange={(next) => {
                setSource(next);
                // The two lists are keyed differently — a container id is not a
                // service name — so a choice made in one is not a choice in the
                // other.
                setChosen(null);
              }}
              options={[
                { value: "container", label: "One container" },
                { value: "service", label: "A whole service" },
              ]}
            />
          </Field>
        ) : null}

        <Field
          name="target"
          label={source === "service" ? "Service" : "Container"}
          hint={
            source === "service"
              ? "Named as Swarm has it — the stack name, an underscore, then the service."
              : "The containers Docker has under this stack's name."
          }
          manual
        >
          <Picker
            mono
            value={target ?? ""}
            onValueChange={setChosen}
            placeholder="Choose one"
            options={
              source === "service"
                ? services.map((name) => ({
                    value: name,
                    label: name,
                    detail: `${compose.appName}_${name}`,
                  }))
                : running.map((row) => ({
                    value: row.containerId!,
                    label: row.service ?? row.name,
                    detail: `${row.state} · ${row.containerId!.slice(0, 12)}`,
                  }))
            }
          />
        </Field>

        {chosenRow?.taskError ? (
          <p className="rounded-lg border border-bad-line bg-bad-tint px-3 py-2.5 text-meta text-tx">
            <strong className="font-medium">Swarm reported an error</strong> for
            this task: {chosenRow.taskError}
          </p>
        ) : null}

        <ContainerOutput
          // Keyed on the target so switching containers opens a **new** socket
          // rather than reusing the one that is following something else — the
          // buffer belongs to the container, and carrying it across would print
          // one container's lines under another's name.
          key={`${source}:${targetName ?? "none"}`}
          containerId={targetName}
          serverId={compose.serverId}
          // On its own Stack VM, reached by the stack (ADR-0070).
          composeId={runsOnStackVm(compose) ? compose.composeId : null}
          runType={source === "service" ? "swarm" : "native"}
          label={`Output of ${targetName ?? "the chosen container"}`}
          subject={compose.name}
          container={
            source === "service"
              ? (target ?? undefined)
              : (chosenRow?.service ?? chosenRow?.name ?? target ?? undefined)
          }
          describe={
            source === "service"
              ? `every task of ${targetName}`
              : `${chosenRow?.name ?? targetName}'s output`
          }
        />
      </Card.Body>
    </Card>
  );
}
