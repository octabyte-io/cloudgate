import { useMutation } from "@tanstack/react-query";
import { z } from "zod";

import { Card } from "@/components/console/card";
import type { FieldSpec } from "@/components/console/form-spec";
import { KVList, KVRow } from "@/components/console/kv-list";
import { SettingsCard } from "@/components/console/settings-card";
import type { Database } from "@/lib/api/endpoints/databases";
import {
  existingRdsApi,
  type ExistingDatabase,
  type UpdateExistingInput,
} from "@/lib/api/endpoints/existing-postgres";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { usePermission } from "@/lib/auth/use-permission";

import { DATABASE_UPDATE_REFUSAL } from "../use-database";
import { NotFoundNote } from "./not-found-note";

const schema = z.object({
  identifier: z
    .string()
    .trim()
    .regex(
      /^(?:[a-zA-Z][a-zA-Z0-9-]{0,62}|[a-z][a-z0-9.:-]*:[a-z]+-[a-z]+[0-9]+:[a-z][a-z0-9-]*)$/,
      "An RDS identifier (letters, digits and hyphens, starting with a letter) or a Cloud SQL connection name (project:region:instance).",
    ),
  databaseUser: z.string().trim().min(1, "The login the apps use."),
  /** Blank keeps the password that is set. */
  databasePassword: z.string(),
  databaseName: z.string().trim().min(1, "The database the apps use."),
  madeReachable: z.boolean(),
});
type Values = z.infer<typeof schema>;

const fields: FieldSpec<Values>[] = [
  {
    kind: "text",
    name: "identifier",
    label: "RDS identifier or connection name",
    mono: true,
    hint: "Another identifier is another database: the next plan looks it up.",
  },
  {
    kind: "text",
    name: "databaseUser",
    label: "Login",
    hint: "The login your apps use.",
  },
  {
    kind: "password",
    name: "databasePassword",
    label: "Password",
    optional: true,
    placeholder: "Set — leave blank to keep it",
    hint: "Never shown again. A new one reaches the Services linking it on their next deploy.",
  },
  { kind: "text", name: "databaseName", label: "Database" },
  {
    kind: "switch",
    name: "madeReachable",
    label: "I made it reachable from this Environment",
    hint: "Needed outside this Environment network's VPC. Cloudgate cannot check it.",
  },
];

/**
 * An Existing database's page (ADR-0033): where it is, where the last
 * plan found it, and the login the apps use, only ever read back as set.
 * Cloudgate runs nothing for it, so there is no image, container or
 * resources here: its Start, Stop and Rebuild are the database's own, in
 * AWS. Edits (`service: ['update']`) never reach the database; a new login
 * marks the Services linking it to deploy again.
 */
export function ExistingDatabaseCard({
  row,
  existing,
}: {
  row: Database;
  existing: ExistingDatabase;
}) {
  const canSave = usePermission({ service: ["update"] });
  const invalidate = useInvalidate();
  const save = useMutation({
    mutationFn: (input: UpdateExistingInput) =>
      existingRdsApi(row.kind === "mysql" ? "mysql" : "postgres").update(
        row.databaseId,
        input,
      ),
    onSuccess: () =>
      invalidate.database({
        kind: row.kind,
        databaseId: row.databaseId,
        environmentId: row.environmentId,
      }),
  });
  // A Cloud SQL instance on Google Cloud is named by its connection name.
  const onGoogle = existing.identifier.includes(":");
  const login = row as Database & {
    databaseUser?: string;
    databaseName?: string;
  };

  return (
    <>
      <Card>
        <Card.Header
          title="Existing database"
          sub="Cloudgate uses this database but doesn't manage it: it looks it up at every plan and never changes, stops or deletes it."
          headingLevel={2}
        />
        <Card.Body>
          <NotFoundNote notFound={existing.notFound} />
          {existing.endpoint?.sentence ? (
            <p
              role="status"
              className="mb-3 rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-body font-medium text-tx"
            >
              {existing.endpoint.sentence}.
            </p>
          ) : null}
          <KVList>
            <KVRow
              label={onGoogle ? "Connection name" : "RDS identifier"}
              value={existing.identifier}
              title={existing.identifier}
              mono
            />
            <KVRow label="Region" value={existing.region} mono />
            <KVRow
              label="Found at"
              value={
                existing.address
                  ? `${existing.address.host}:${existing.address.port}`
                  : "Not looked up yet — Check for changes"
              }
              title={existing.address
                  ? `${existing.address.host}:${existing.address.port}`
                  : "Not looked up yet — Check for changes"}
              mono={existing.address !== null}
            />
            <KVRow
              label="Password"
              value={existing.hasDatabasePassword ? "Set" : "Not set"}
            />
            <KVRow
              label="Reachable"
              value={
                onGoogle
                  ? existing.endpoint
                    ? `Through Cloudgate's endpoint: ${existing.endpoint.status}`
                    : "Through Cloudgate's endpoint, made by the next Apply"
                  : existing.madeReachable
                    ? "You made it reachable from this Environment"
                    : "Only from inside this Environment network"
              }
              title={onGoogle
                  ? existing.endpoint
                    ? `Through Cloudgate's endpoint: ${existing.endpoint.status}`
                    : "Through Cloudgate's endpoint, made by the next Apply"
                  : existing.madeReachable
                    ? "You made it reachable from this Environment"
                    : "Only from inside this Environment network"}
            />
          </KVList>
        </Card.Body>
      </Card>

      <SettingsCard
        title="Login and identifier"
        lede="What Cloudgate builds this database's Outputs from. Nothing here is written to the database."
        gate={{ allowed: canSave.allowed, refusal: DATABASE_UPDATE_REFUSAL }}
        schema={schema}
        fields={fields}
        savedMessage="Existing database saved."
        defaultValues={{
          identifier: existing.identifier,
          databaseUser: login.databaseUser ?? "",
          databasePassword: "",
          databaseName: login.databaseName ?? "",
          madeReachable: existing.madeReachable,
        }}
        submit={({ databasePassword, ...values }) =>
          save.mutateAsync({
            ...values,
            ...(databasePassword === "" ? {} : { databasePassword }),
          })
        }
        footer="A new identifier or tick is read by the next plan."
      />
    </>
  );
}
