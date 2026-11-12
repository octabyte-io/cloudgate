import { useMutation } from "@tanstack/react-query";
import { z } from "zod";

import type { FieldSpec } from "@/components/console/form-spec";
import { SettingsCard } from "@/components/console/settings-card";
import type { Database } from "@/lib/api/endpoints/databases";
import {
  memorystoreRedisApi,
  type MemorystoreRedisSettings,
} from "@/lib/api/endpoints/memorystore-redis";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { usePermission } from "@/lib/auth/use-permission";

import { DATABASE_UPDATE_REFUSAL } from "../use-database";

const memorystoreSchema = z.object({ highAvailability: z.boolean() });

type MemorystoreValues = z.infer<typeof memorystoreSchema>;

const fields: FieldSpec<MemorystoreValues>[] = [
  {
    kind: "switch",
    name: "highAvailability",
    label: "High availability",
    hint: "One replica in another zone, so the cache keeps answering if a zone fails. It doubles the node cost: two nodes instead of one.",
  },
];

/**
 * A redis on Memorystore's own setting: high
 * availability, off by default. It is Cloudgate's, kept
 * per Service and never in the Project config, so a repository-kept config
 * does not lock it and no plan from the config moves it. A Save stores it;
 * the next plan shows the replica added or removed with the node count, and
 * its Apply changes the instance in place on Google Cloud.
 *
 * It takes the place of the Server's run command and resources cards:
 * Memorystore runs no container to configure.
 */
export function MemorystoreSettingsCard({
  row,
  settings,
}: {
  row: Database;
  settings: MemorystoreRedisSettings;
}) {
  // `PATCH /redis/:id/memorystore-settings` is `service: ['update']`.
  const canSave = usePermission({ service: ["update"] });
  const invalidate = useInvalidate();
  const save = useMutation({
    mutationFn: (input: MemorystoreRedisSettings) =>
      memorystoreRedisApi.saveSettings(row.databaseId, input),
    onSuccess: () =>
      invalidate.database({
        kind: "redis",
        databaseId: row.databaseId,
        environmentId: row.environmentId,
      }),
  });

  return (
    <SettingsCard
      title="Memorystore settings"
      gate={{ allowed: canSave.allowed, refusal: DATABASE_UPDATE_REFUSAL }}
      lede="How Memorystore runs this redis. Its size and version are in the Project config; this is Cloudgate's."
      schema={memorystoreSchema}
      fields={() => fields}
      savedMessage="Saved. Check for changes to see it in the plan; Apply makes it on Google Cloud."
      defaultValues={{ highAvailability: settings.highAvailability }}
      submit={(values) => save.mutateAsync(values)}
      footer="Nothing changes on Google Cloud until a plan with it is applied."
    />
  );
}
