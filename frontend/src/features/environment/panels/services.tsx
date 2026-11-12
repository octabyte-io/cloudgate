"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import { CreateAiModelModal } from "@/features/application/create/create-ai-model-modal";
import { CreateApplicationModal } from "@/features/application/create/create-application-modal";
import { CreateComposeModal } from "@/features/compose/create/create-compose-modal";
import { CreateDatabaseModal } from "@/features/database/create/create-database-modal";
import { DraftServiceModal } from "@/features/integrations/ai/draft-service-modal";
import { errorMessage } from "@/lib/api/error-message";
import { useEnvironmentHealth } from "@/lib/api/use-service-health";
import { useActiveMemberRole } from "@/lib/auth/client";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { EnvironmentDeleteCard } from "../environment-delete-card";
import { EnvironmentFactsCard } from "../environment-facts-card";
import { EnvironmentNetworkCard } from "../environment-network-card";
import { PendingSetupsCard } from "../pending-setups-card";
import {
  ENVIRONMENT_SERVICE_COLUMNS,
  ENVIRONMENT_SERVICE_COLUMNS_WITH_SPEND,
  toServiceRow,
} from "../environment-service-columns";

import { useEnvironment, useEnvironmentTokenSpend } from "../use-environments";

/**
 * Everything deployed in this Environment — Applications, databases and Compose
 * stacks (the reference's `envServicesTab`, e-console.html:3917-3948).
 *
 * **This screen now works.** `GET /environments/:id` carries a `services`
 * array — the eight service tables projected into one uniform row and ordered
 * server-side — so the Environment can finally name what it holds, and the
 * `ServiceTable` mapper F07 built this table for lives below.
 *
 * **Four of `serviceColumns()`' eight columns are dropped here, and that is the
 * one design decision on this screen.** The projection is deliberately uniform
 * across all eight kinds, so it carries no source, no domain, no replica count
 * and no last-deployment time — those live on each kind's own row. A column that
 * is permanently a dash reads as *this service has no domain*, which is a
 * confident claim made because a projection left a field out. So the table shows
 * what the read really answers (name, kind, status, when it was created) and each
 * row links to the screen that has the rest. The same call F07 made on the
 * Servers table and F08 on the Environment's tabs.
 *
 * **A restricted member sees a subset
 * ** The read
 * names only the services their member row grants — the scope the Deployments
 * and Domains tabs already applied — so the empty state below has a second
 * wording for them rather than claiming the Environment is empty.
 *
 * **The Health column is one request for the whole table**:
 * `GET /environments/:id/health` answers every row's open-Incident flag and
 * worst current state by the same scope as `services`, and each row looks its
 * Service up in that one answer — never a request per row.
 *
 * **The Token spend column is one request too**: the Environment's
 * 30-day spend names each AI model the reader can read with its total, and
 * each row looks itself up in it. The column is there only when that answer
 * names an AI model; in an Environment with none, a column of dashes would be
 * a statement about nothing.
 *
 * **The Live card is still absent.** Requests and p95 "across all services here"
 * need per-service request analytics, and `GET /monitoring/requests/*` is
 * instance-wide with no service dimension.
 *
 * ---
 *
 * **The create buttons predate the list**, and the argument that put them here
 * is worth keeping now that it no longer has to carry the screen: each of
 * `POST /applications`, `POST /:kind`, `POST /compose` and `POST /ai/deploy`
 * answers with the new row, so creating something ends on its own screen rather
 * than on a list that could not show it. That was the reason they were safe when
 * nothing listed; the list existing is why they are now ordinary.
 *
 * **There were four of them, and the first one was new
 * ** F09 shipped the
 * Application screens without a create flow, so for four phases this header
 * offered every kind except the one the empty state below names first — and an
 * operator's only way to make an Application was `POST /applications` by hand.
 * Adding it also moves which button is primary: Applications are what this
 * product deploys, so that is the one action here that gets the emphasis, and a
 * header with two primaries has none.
 *
 * **The fifth is "Add an AI model"**: an Application with the model
 * facet, on `POST /applications` like the first, landing on its Model tab.
 * Unlike the four it is **hidden**, not turned off, for a role without
 * `service: ['create']` — its dialog reads every host's GPU cards on a route
 * that statement guards, and a newcomer's control is not worth a refusal.
 *
 * **All four are off for a role without `service: ['create']`**
 * — the statement
 * `POST /applications`, `POST /:kind`, `POST /compose` and `POST /ai/deploy`
 * each check before anything else — with the reason on each, rather than a
 * dialog that ends in the 403. The base member holds `read` and `update` on a
 * service and not `create`.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const environment = useEnvironment(id);
  const health = useEnvironmentHealth(id);
  const spend = useEnvironmentTokenSpend(id).data;
  const withSpend = spend !== undefined && spend.aiModels.length > 0;
  const [adding, setAdding] = useState<
    "application" | "database" | "compose" | "ai" | "aiModel" | null
  >(null);
  const canCreate = usePermission({ service: ["create"] });
  // Off until the Environment is read (the dialogs need its name), and off for
  // a role that cannot create what they create — only the second has a reason
  // worth saying.
  const ready = environment.data !== undefined && canCreate.allowed;
  const refusal = canCreate.allowed ? undefined : CREATE_REFUSAL;
  // `services` names only what the caller's member row grants unless they are
  // an owner or an admin, so for anyone else an empty list is not "this
  // Environment is empty" and must not say so. Unknown role reads as the
  // unrestricted wording, which is what an owner — the common reader — sees.
  const role = useActiveMemberRole().data?.role;
  const restricted = role !== undefined && role !== "owner" && role !== "admin";

  return (
    <Page>
      <PageHeader
        title={label}
        icon={icon}
        lede="The Applications, databases and Compose stacks deployed in this Environment."
        actions={
          <>
            <Button
              variant="pri"
              aria-disabled={ready ? undefined : true}
              title={refusal}
              onClick={ready ? () => setAdding("application") : undefined}
            >
              <Icon name="plus" size={15} />
              Add an Application
            </Button>
            <Button
              aria-disabled={ready ? undefined : true}
              title={refusal}
              onClick={ready ? () => setAdding("database") : undefined}
            >
              <Icon name="plus" size={15} />
              Add a database
            </Button>
            <Button
              aria-disabled={ready ? undefined : true}
              title={refusal}
              onClick={ready ? () => setAdding("compose") : undefined}
            >
              <Icon name="plus" size={15} />
              Add a Compose stack
            </Button>
            {/* F15's one addition here, on F11's and F12's argument unchanged.
                `POST /ai/deploy` creates a Compose stack from a suggestion and
                returns it, so this ends on the new stack's own screen — the
                same reason the two buttons above defeat the dead end rather
                than reopening it. The modal renders its own "no provider is
                configured" state, so the button is not hidden on a hunch about
                what the Organization has set up. */}
            <Button
              aria-disabled={ready ? undefined : true}
              title={refusal}
              onClick={ready ? () => setAdding("ai") : undefined}
            >
              <Icon name="spark" size={15} />
              Draft one with AI
            </Button>
            {canCreate.allowed ? (
              <Button
                aria-disabled={ready ? undefined : true}
                onClick={ready ? () => setAdding("aiModel") : undefined}
              >
                <Icon name="cpu" size={15} />
                Add an AI model
              </Button>
            ) : null}
          </>
        }
      />

      <Cols
        aside={
          <>
            {environment.data ? (
              <EnvironmentDeleteCard environment={environment.data} />
            ) : null}
            <EnvironmentFactsCard environmentId={id} />
            <EnvironmentNetworkCard environmentId={id} />
          </>
        }
        asideLabel="About this Environment"
      >
        {/* No meta strip and no "How variables reach a service" card here.
           Both explained that variables are not inherited, which is
            the Variables tab's to say, and that tab keeps the card. A refusal
            lists nothing because an empty table would claim this Environment
            holds nothing. */}
        <Card>
          <Card.Body flush>
            {environment.error ? (
              <p className="px-4 py-6 text-body text-tx-2">
                {errorMessage(environment.error)}
              </p>
            ) : environment.isPending ? (
              <div className="grid gap-2.5 px-4 py-4" aria-busy="true">
                <Skeleton className="h-row" />
                <Skeleton className="h-row" />
                <Skeleton className="h-row" />
              </div>
            ) : (
              // Mounts once, when the skeleton gives way; never replays on a
              // refetch, which keeps it mounted.
              <div className="animate-rise">
                <DataTable
                  label={`Services in ${environment.data?.name ?? "this Environment"}`}
                  columns={
                    withSpend
                      ? ENVIRONMENT_SERVICE_COLUMNS_WITH_SPEND
                      : ENVIRONMENT_SERVICE_COLUMNS
                  }
                  rows={(environment.data?.services ?? []).map((service) =>
                    toServiceRow(service, health.data, health.isPending, spend),
                  )}
                  getRowId={(row) => `${row.kind}:${row.id}`}
                  defaultSort={{ id: "name", dir: "asc" }}
                  empty={
                    restricted ? (
                      <EmptyState
                        icon="box"
                        title="You have not been given access to any Service here"
                      >
                        Ask an owner or an admin to grant you one under Members
                        → Manage access.
                      </EmptyState>
                    ) : (
                      <EmptyState
                        icon="box"
                        title="Nothing is deployed here yet"
                      >
                        Add an Application, a database or a Compose stack above.
                      </EmptyState>
                    )
                  }
                />
              </div>
            )}
          </Card.Body>
        </Card>
        {/* Template setups waiting here for their plan (ADR-0065). */}
        <PendingSetupsCard
          environmentId={id}
          projectId={environment.data?.projectId}
        />
      </Cols>

      {environment.data ? (
        <>
          <CreateApplicationModal
            environmentId={id}
            environmentName={environment.data.name}
            deployTarget={environment.data.deployTarget}
            open={adding === "application"}
            onOpenChange={(next) => setAdding(next ? "application" : null)}
          />
          <CreateDatabaseModal
            environmentId={id}
            environmentName={environment.data.name}
            deployTarget={environment.data.deployTarget}
            open={adding === "database"}
            onOpenChange={(next) => setAdding(next ? "database" : null)}
          />
          <CreateComposeModal
            environmentId={id}
            environmentName={environment.data.name}
            deployTarget={environment.data.deployTarget}
            open={adding === "compose"}
            onOpenChange={(next) => setAdding(next ? "compose" : null)}
          />
          <CreateAiModelModal
            environmentId={id}
            environmentName={environment.data.name}
            deployTarget={environment.data.deployTarget}
            open={adding === "aiModel"}
            onOpenChange={(next) => setAdding(next ? "aiModel" : null)}
          />
          <DraftServiceModal
            environmentId={id}
            environmentName={environment.data.name}
            deployTarget={environment.data.deployTarget}
            open={adding === "ai"}
            onOpenChange={(next) => setAdding(next ? "ai" : null)}
          />
        </>
      ) : null}
    </Page>
  );
}

const CREATE_REFUSAL = roleRefusal("add a service to an Environment");
