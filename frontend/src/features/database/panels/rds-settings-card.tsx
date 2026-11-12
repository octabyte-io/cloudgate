import { useMutation } from "@tanstack/react-query";
import { z } from "zod";

import type { FieldSpec } from "@/components/console/form-spec";
import { SettingsCard } from "@/components/console/settings-card";
import type { Database } from "@/lib/api/endpoints/databases";
import {
  RDS_CLASS_OPTIONS,
  rdsPostgresApi,
  type RdsPostgresSettings,
  type SaveRdsPostgresSettings,
} from "@/lib/api/endpoints/rds-postgres";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { usePermission } from "@/lib/auth/use-permission";

import { DATABASE_UPDATE_REFUSAL } from "../use-database";

const rdsSchema = z
  .object({
    instanceClass: z.string(),
    storageGb: z.coerce
      .number()
      .int("Storage has to be a whole number of GB.")
      .min(20, "RDS gp3 storage starts at 20 GB.")
      .max(65536, "RDS grows gp3 storage to 64 TiB at most."),
    maxStorageGb: z.coerce
      .number()
      .int("The ceiling has to be a whole number of GB.")
      .max(65536, "RDS grows gp3 storage to 64 TiB at most."),
    multiAz: z.boolean(),
    backupRetentionDays: z.coerce
      .number()
      .int("Retention has to be a whole number of days.")
      .min(
        1,
        "At least 1 day: 0 turns off RDS automated backups and point-in-time restore.",
      )
      .max(35, "RDS keeps automated backups 35 days at most."),
  })
  .refine((values) => values.maxStorageGb >= values.storageGb, {
    message: "The ceiling cannot be below the storage it grows from.",
    path: ["maxStorageGb"],
  });

type RdsValues = z.infer<typeof rdsSchema>;

/**
 * A postgres on RDS's own settings: its machine
 * type when the config gives it no size, storage and the ceiling it grows
 * to, Multi-AZ and backup retention. They are Cloudgate's, kept per Service
 * and never in the Project config, so a repository-kept config locks none
 * of them. A Save stores them; the next plan shows each one moving and its
 * Apply makes it on AWS — a new class restarts the instance, the rest do
 * not.
 *
 * It takes the place of the Server's run command and resources cards: RDS
 * runs no container to configure.
 */
export function RdsSettingsCard({
  row,
  settings,
}: {
  row: Database;
  settings: RdsPostgresSettings;
}) {
  // `PATCH /postgres/:id/rds-settings` is `service: ['update']`.
  const canSave = usePermission({ service: ["update"] });
  const invalidate = useInvalidate();
  const save = useMutation({
    mutationFn: (input: SaveRdsPostgresSettings) =>
      rdsPostgresApi.saveSettings(kind, row.databaseId, input),
    onSuccess: () =>
      invalidate.database({
        kind,
        databaseId: row.databaseId,
        environmentId: row.environmentId,
      }),
  });
  const ownClass = settings.instanceClass !== null;
  // A postgres's or a mysql's: the same card, the route by its kind.
  const kind = row.kind === "mysql" ? "mysql" : "postgres";

  const fields = (): FieldSpec<RdsValues>[] => [
    ...(ownClass
      ? [
          {
            kind: "select" as const,
            name: "instanceClass" as const,
            label: "Machine type",
            options: RDS_CLASS_OPTIONS,
            hint: `The config gives this ${kind} no size, so its class is Cloudgate's. A new one restarts it: a few minutes offline.`,
          },
        ]
      : []),
    {
      kind: "number",
      name: "storageGb",
      label: "Storage (GB)",
      min: 20,
      hint: "gp3 storage it starts from. It only grows: RDS cannot shrink it.",
    },
    {
      kind: "number",
      name: "maxStorageGb",
      label: "Grows to (GB)",
      min: 20,
      hint: "RDS adds storage by itself as it fills, up to this ceiling.",
    },
    {
      kind: "switch",
      name: "multiAz",
      label: "Multi-AZ",
      hint: "A standby in a second zone that takes over if the first fails. About double the instance's cost.",
    },
    {
      kind: "number",
      name: "backupRetentionDays",
      label: "Backup retention (days)",
      min: 1,
      max: 35,
      hint: "How long RDS keeps automated backups for point-in-time restore: 1 to 35 days.",
    },
  ];

  return (
    <SettingsCard
      title="RDS settings"
      gate={{ allowed: canSave.allowed, refusal: DATABASE_UPDATE_REFUSAL }}
      lede={
        ownClass
          ? `How RDS runs this ${kind}. Its size and version are in the Project config; these are Cloudgate's.`
          : `How RDS runs this ${kind}. Its class comes from size in the Project config; these are Cloudgate's.`
      }
      schema={rdsSchema}
      fields={fields}
      savedMessage="Saved. Check for changes to see it in the plan; Apply makes it on AWS."
      defaultValues={{
        instanceClass: settings.instanceClass ?? "",
        storageGb: settings.storageGb,
        maxStorageGb: settings.maxStorageGb,
        multiAz: settings.multiAz,
        backupRetentionDays: settings.backupRetentionDays,
      }}
      submit={({ instanceClass, ...values }) =>
        save.mutateAsync(ownClass ? { ...values, instanceClass } : values)
      }
      footer="Nothing changes on AWS until a plan with it is applied."
    />
  );
}
