"use client";

import { Card } from "@/components/console/card";
import { PageHeader } from "@/components/console/page-header";
import { SettingsCard } from "@/components/console/settings-card";
import type { Database, DatabaseKind } from "@/lib/api/endpoints/databases";
import { existingPlaceOf } from "@/lib/api/endpoints/existing-redis";
import {
  ConfigLockNote,
  lockRefusal,
  statesField,
  useConfigLock,
} from "@/components/console/config-lock";
import { usePermission } from "@/lib/auth/use-permission";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { CloudConnectionCard } from "../credentials/cloud-connection-card";
import { ConnectionCard } from "../credentials/connection-card";
import { CredentialsNotice } from "../credentials/credentials-notice";
import { ExternalPortsCard } from "../credentials/external-ports-card";
import { DatabaseFactsCard } from "../database-facts-card";
import { DatabasePanel } from "../database-panel";
import {
  PASSWORD_COLUMNS,
  connectionFields,
  databaseSchema,
  toCredentialsInput,
  valuesFrom,
  type DatabaseFormValues,
} from "../kinds";
import {
  DATABASE_UPDATE_REFUSAL,
  useDatabaseActions,
  useUpdateDatabase,
} from "../use-database";

/**
 * How to connect, and the credentials that let you.
 *
 * **A new tab, added to `lib/shell/tabs/database.ts`.** F07 shipped the database
 * scope with Overview / Variables / Advanced, which is `SVC_NAV` minus what a
 * database cannot have — but a managed database has a whole concern an
 * Application does not: a connection identity that other services need, half of
 * it secret, and a switch that decides whether the whole internet can reach it.
 * Folding that into Overview would put a masked password and a
 * "this exposes your database" warning underneath a name field, and folding it
 * into Advanced would file the most-visited screen in this scope under the tab
 * marked "you probably do not need this". Contract rule 2 says a genuinely new
 * tab is one line there plus the panel — this is the second of the two lines
 * F11 added.
 *
 * Three cards, in the order the questions get asked: what do I paste, may
 * anything outside reach it, and what are the credentials actually set to.
 */
export default function Panel(props: PanelProps) {
  return (
    <DatabasePanel
      panel={props}
      aside={(row, kind) => <DatabaseFactsCard database={row} kind={kind} />}
      header={(row) => (
        <PageHeader
          title={props.label}
          icon={props.icon}
          lede={`How something reaches ${row.name}, and the credentials it needs.`}
        />
      )}
    >
      {(row, kind) =>
        existingPlaceOf(row) ? (
          // An Existing database's login is the apps' own, read back only as
          // set and edited on its Overview, as is an existing cache's
          // AUTH token; Cloudgate publishes no port.
          // In a card, as every other tab's body is, rather than loose text
          // on the page ground.
          <Card>
            <Card.Body>
              <p className="text-body text-tx-2">
                This is an existing database: its{" "}
                {kind === "redis" ? "AUTH token" : "login"} is the one your apps
                use, shown only as set and edited on its Overview. Services
                reach it through wired variables, at the address the last plan
                found.
              </p>
            </Card.Body>
          </Card>
        ) : (
          <Body row={row} kind={kind} />
        )
      }
    </DatabasePanel>
  );
}

function Body({ row, kind }: { row: Database; kind: DatabaseKind }) {
  const update = useUpdateDatabase(kind, row.databaseId, row.environmentId);
  const actions = useDatabaseActions(kind, row.databaseId, row.environmentId);
  // `PATCH /<engine>/:id` runs `findOwnedForUpdate`: `service: ['update']`.
  const canSave = usePermission({ service: ["update"] });
  // A postgres's database and user are the file's when it states them;
  // the password is always Cloudgate's.
  const lock = useConfigLock(row.environmentId, kind, row.databaseId);
  const lockedColumns = new Map<string, string>(
    (
      [
        ["databaseName", "database"],
        ["databaseUser", "user"],
      ] as const
    ).flatMap(([column, field]) =>
      lock && statesField(lock, field) ? [[column, lockRefusal(lock)]] : [],
    ),
  );
  const fields = connectionFields(kind, "update").map((spec) =>
    lockedColumns.has(spec.name)
      ? { ...spec, locked: lockedColumns.get(spec.name) }
      : spec,
  );

  // A database Cloudgate made on a cloud is reached at the address its
  // Cloud run saved and publishes no port; a redis there has no password of
  // its own to edit (Memorystore has none, ElastiCache's is its AUTH token).
  const onCloud = Boolean(row.cloudAccountId);
  if (onCloud && kind === "redis") {
    return <CloudConnectionCard database={row} kind={kind} />;
  }

  return (
    <>
      {onCloud ? (
        <CloudConnectionCard database={row} kind={kind} />
      ) : (
        <>
          <ConnectionCard database={row} kind={kind} />

          <ExternalPortsCard
            database={row}
            kind={kind}
            save={(input) => actions.saveExternalPorts.mutateAsync(input)}
          />
        </>
      )}

      {/*
        The engine's own connection columns, whichever ones it has. Redis's set
        is one field and MySQL's is four; the difference is `connectionFields`
        reading the descriptor, and this file never learns which engine it is.
      */}
      <SettingsCard
        title="Credentials"
        lede="The connection identity stored on this row."
        gate={{ allowed: canSave.allowed, refusal: DATABASE_UPDATE_REFUSAL }}
        schema={databaseSchema(kind, "update")}
        fields={fields}
        savedMessage="Credentials saved."
        defaultValues={valuesFrom(row)}
        clearAfterSave={PASSWORD_COLUMNS}
        submit={(values: DatabaseFormValues) =>
          update.mutateAsync(toCredentialsInput(kind, values))
        }
      >
        {lock && lockedColumns.size > 0 ? (
          <ConfigLockNote
            lock={lock}
            what="The database name and user are"
            rest="The password is Cloudgate's."
          />
        ) : null}
        <CredentialsNotice row={row} kind={kind} />
      </SettingsCard>
    </>
  );
}
