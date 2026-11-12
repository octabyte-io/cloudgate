"use client";

import { z } from "zod";

import { Banner, BannerRow } from "@/components/console/banner";
import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { PageHeader } from "@/components/console/page-header";
import { OpenShellButton } from "@/features/service-shell/open-shell-button";
import { SettingsCard } from "@/components/console/settings-card";
import { example, type FieldSpec } from "@/components/console/form-spec";
import type { Database, DatabaseKind } from "@/lib/api/endpoints/databases";
import { existingOf } from "@/lib/api/endpoints/existing-postgres";
import { existingCacheOf } from "@/lib/api/endpoints/existing-redis";
import { HealthFactRow } from "@/components/console/service-health-state";
import { usePermission } from "@/lib/auth/use-permission";
import {
  ConfigLockNote,
  lockRefusal,
  useConfigLock,
} from "@/components/console/config-lock";
import { serviceNameField } from "@/lib/forms/service-name";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { ContainerLog } from "../container-log";
import { DatabaseFactsCard } from "../database-facts-card";
import { DatabasePanel } from "../database-panel";
import { ExistingCacheCard } from "../existing/existing-cache-card";
import { ExistingDatabaseCard } from "../existing/existing-database-card";
import { DatabaseSwitchCard } from "../existing/switch-card";
import { DATABASE_KIND, imageField } from "../kinds";
import { DatabaseActions } from "../lifecycle/database-actions";
import { DatabaseCloudDeleteCard } from "../lifecycle/database-cloud-delete-card";
import { DATABASE_UPDATE_REFUSAL, useUpdateDatabase } from "../use-database";

/**
 * The database, its four lifecycle actions, and what the engine is saying.
 *
 * **The four actions are the point of this screen.** They are no longer
 * something the Application in the same Environment lacks — that screen got its
 * own lifecycle — but they still
 * lead here, because everything else the screen can say about whether the engine
 * is alive is the container output at the bottom.
 *
 * What is *absent* is a Deployment list, and it is absent from the whole scope
 * rather than empty here: a database's deploy converges the Swarm service inline
 * and writes no `deployment` row, so there is nothing to enumerate and F07 gave
 * this scope no Deployments tab. The container log below is what replaces it,
 * and it is a better answer for a database anyway — the interesting failure is
 * not "the deploy failed", it is "the deploy succeeded and the engine will not
 * start".
 */

const identitySchema = z.object({
  name: serviceNameField("A database needs a name."),
  description: z.string(),
  dockerImage: z.string().trim().min(1, "A database needs an image to run."),
});

type IdentityValues = z.infer<typeof identitySchema>;

export default function Panel(props: PanelProps) {
  return (
    <DatabasePanel
      panel={props}
      aside={(row, kind) => (
        <DatabaseFactsCard
          database={row}
          kind={kind}
          health={<HealthFactRow serviceType={kind} serviceId={props.id} />}
        />
      )}
      header={(row, kind) => (
        <PageHeader
          title={row.name}
          icon={props.icon}
          badges={
            /* No `StatusPill` — see the note in the Application's overview. The
               masthead and the facts card both carry this status already. */
            <>
              <Chip variant="brand">{DATABASE_KIND[kind].label}</Chip>
              <Chip variant="mono">{row.appName}</Chip>
            </>
          }
          lede={`${row.description || `A managed ${DATABASE_KIND[kind].label}`} — in ${row.environment.project.name} / ${row.environment.name}.`}
          actions={
            <>
              {/* To the Shell tab, wherever there is one. */}
              <OpenShellButton />
              <DatabaseActions database={row} kind={kind} />
            </>
          }
        />
      )}
    >
      {(row, kind) => {
        // An Existing database runs nothing of Cloudgate's.
        const existing = existingOf(row);
        const cache = existingCacheOf(row);
        return (
          <>
            {existing ? (
              <ExistingDatabaseCard row={row} existing={existing} />
            ) : cache ? (
              <ExistingCacheCard row={row} existing={cache} />
            ) : (
              <Body row={row} kind={kind} />
            )}
            {/* Switching to or from an existing database. */}
            <DatabaseSwitchCard row={row} />
          </>
        );
      }}
    </DatabasePanel>
  );
}

function Body({ row, kind }: { row: Database; kind: DatabaseKind }) {
  const update = useUpdateDatabase(kind, row.databaseId, row.environmentId);
  // A postgres's or redis's description and version are config-owned; the
  // name stays Cloudgate's, so the card stays open.
  const lock = useConfigLock(row.environmentId, kind, row.databaseId);
  // `PATCH /<engine>/:id` runs `findOwnedForUpdate`: `service: ['update']`.
  const canSave = usePermission({ service: ["update"] });
  const locked = lock ? lockRefusal(lock) : undefined;

  const fields: FieldSpec<IdentityValues>[] = [
    {
      kind: "text",
      name: "name",
      label: "Name",
      hint: "What this database is called in Cloudgate. The Swarm service keeps its own immutable name.",
    },
    {
      kind: "text",
      name: "description",
      label: "Description",
      optional: true,
      placeholder: example("Orders and inventory for the storefront"),
      hint: "What this database holds, for whoever finds it next.",
      locked,
    },
    {
      ...(imageField(kind) as unknown as FieldSpec<IdentityValues>),
      locked,
    },
  ];

  return (
    <>
      {row.cloudDelete ? (
        <DatabaseCloudDeleteCard database={row} kind={kind} />
      ) : null}
      {row.applicationStatus === "error" ? (
        <Banner
          icon="alert"
          title="The last deploy did not finish."
          className="animate-rise border-bad-line"
        >
          <BannerRow
            tone="bad"
            title="The Swarm service did not converge."
            description="The image may not have pulled, or the service could not be scheduled — a memory reservation larger than any node has free will do it. The container output below is where the reason is, if the container got far enough to write one."
          />
        </Banner>
      ) : null}

      <SettingsCard
        title="Identity"
        lede="What this database is called, and what it runs."
        gate={{ allowed: canSave.allowed, refusal: DATABASE_UPDATE_REFUSAL }}
        schema={identitySchema}
        fields={fields}
        savedMessage="Identity saved."
        defaultValues={{
          name: row.name,
          description: row.description ?? "",
          dockerImage: row.dockerImage,
        }}
        submit={(values) =>
          update.mutateAsync({
            name: values.name,
            // Nullable on the row, and clearing it has to be expressible —
            // F10's rule: `null` on an update, never `""`.
            description:
              values.description.trim() === ""
                ? null
                : values.description.trim(),
            dockerImage: values.dockerImage,
          })
        }
        footer="A new image reaches the container on the next deploy, not on save."
      >
        {lock ? (
          <ConfigLockNote
            lock={lock}
            what="The description and the image are"
            rest="The name is Cloudgate's."
          />
        ) : null}
      </SettingsCard>

      <Card>
        <Card.Header
          title="Container output"
          sub="What the engine itself is writing, live from the Swarm service."
          headingLevel={2}
        />
        <Card.Body>
          <ContainerLog database={row} />
        </Card.Body>
      </Card>
    </>
  );
}
