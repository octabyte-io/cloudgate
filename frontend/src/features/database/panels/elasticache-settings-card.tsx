import { useMutation } from "@tanstack/react-query";
import { z } from "zod";

import type { FieldSpec } from "@/components/console/form-spec";
import { SettingsCard } from "@/components/console/settings-card";
import type { Database } from "@/lib/api/endpoints/databases";
import {
  ELASTICACHE_NODE_TYPE_OPTIONS,
  elastiCacheRedisApi,
  type ElastiCacheRedisSettings,
  type SaveElastiCacheRedisSettings,
} from "@/lib/api/endpoints/elasticache-redis";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { usePermission } from "@/lib/auth/use-permission";

import { DATABASE_UPDATE_REFUSAL } from "../use-database";

const cacheSchema = z.object({
  nodeType: z.string(),
  replica: z.boolean(),
  snapshotRetentionDays: z.coerce
    .number()
    .int("Retention has to be a whole number of days.")
    .min(0, "0 at least: 0 turns daily snapshots off.")
    .max(35, "ElastiCache keeps daily snapshots 35 days at most."),
});

type CacheValues = z.infer<typeof cacheSchema>;

/**
 * A redis on ElastiCache's own settings: its
 * node type when the config gives it no size, a replica in another zone,
 * and how long daily snapshots are kept. They are Cloudgate's, kept per
 * Service and never in the Project config, so a repository-kept config
 * locks none of them. A Save stores them; the next plan shows each one
 * moving and its Apply makes it on AWS — a new node type may drop
 * connections briefly while it resizes, the rest do not.
 *
 * It takes the place of the Server's run command and resources cards:
 * ElastiCache runs no container to configure.
 */
export function ElastiCacheSettingsCard({
  row,
  settings,
}: {
  row: Database;
  settings: ElastiCacheRedisSettings;
}) {
  // `PATCH /redis/:id/elasticache-settings` is `service: ['update']`.
  const canSave = usePermission({ service: ["update"] });
  const invalidate = useInvalidate();
  const save = useMutation({
    mutationFn: (input: SaveElastiCacheRedisSettings) =>
      elastiCacheRedisApi.saveSettings(row.databaseId, input),
    onSuccess: () =>
      invalidate.database({
        kind: "redis",
        databaseId: row.databaseId,
        environmentId: row.environmentId,
      }),
  });
  const ownType = settings.nodeType !== null;

  const fields = (): FieldSpec<CacheValues>[] => [
    ...(ownType
      ? [
          {
            kind: "select" as const,
            name: "nodeType" as const,
            label: "Machine type",
            options: ELASTICACHE_NODE_TYPE_OPTIONS,
            hint: "The config gives this redis no size, so its node type is Cloudgate's. A new one may drop connections briefly while it resizes.",
          },
        ]
      : []),
    {
      kind: "switch",
      name: "replica",
      label: "Replica",
      hint: "One replica in another zone, with automatic failover: it takes over if the first fails, and a resize no longer drops connections. About double the node's cost.",
    },
    {
      kind: "number",
      name: "snapshotRetentionDays",
      label: "Snapshot retention (days)",
      min: 0,
      max: 35,
      hint: "How long ElastiCache keeps its daily snapshots: 0 to 35 days, 0 for none.",
    },
  ];

  return (
    <SettingsCard
      title="ElastiCache settings"
      gate={{ allowed: canSave.allowed, refusal: DATABASE_UPDATE_REFUSAL }}
      lede={
        ownType
          ? "How ElastiCache runs this redis. Its size and version are in the Project config; these are Cloudgate's."
          : "How ElastiCache runs this redis. Its node type comes from size in the Project config; these are Cloudgate's."
      }
      schema={cacheSchema}
      fields={fields}
      savedMessage="Saved. Check for changes to see it in the plan; Apply makes it on AWS."
      defaultValues={{
        nodeType: settings.nodeType ?? "",
        replica: settings.replica,
        snapshotRetentionDays: settings.snapshotRetentionDays,
      }}
      submit={({ nodeType, ...values }) =>
        save.mutateAsync(ownType ? { ...values, nodeType } : values)
      }
      footer="Nothing changes on AWS until a plan with it is applied."
    />
  );
}
