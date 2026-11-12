import { z } from "zod";

import type { FieldSpec } from "@/components/console/form-spec";
import { SettingsCard } from "@/components/console/settings-card";
import type { Database } from "@/lib/api/endpoints/databases";
import { usePermission } from "@/lib/auth/use-permission";
import {
  ConfigLockNote,
  lockRefusal,
  statesField,
  useConfigLock,
} from "@/components/console/config-lock";
import {
  limitColumns,
  limitDefaults,
  limitFields,
  limitShape,
} from "@/components/console/engine-limit-fields";

import {
  DATABASE_UPDATE_REFUSAL,
  type useUpdateDatabase,
} from "../use-database";

const resourcesSchema = z.object({
  replicas: z.coerce
    .number()
    .int("Replicas has to be a whole number.")
    .min(0, "Replicas cannot be negative."),
  ...limitShape,
});

type ResourceValues = z.infer<typeof resourcesSchema>;

/**
 * What this database may use, and what is held for it.
 *
 * F10's `ResourcesCard` is the same card over the same columns and is not reused
 * directly for one reason: it takes an `ApplicationDetail`. Everything that makes
 * it work — `SettingsCard`, `FieldSpec`, the four limit fields in
 * `engine-limit-fields.tsx` — is shared, and F11 promoted all of it out
 * of F10's folder so it could be. What is here is one `defaultValues` and one
 * `submit`.
 */
export function ResourcesCard({
  row,
  update,
}: {
  row: Database;
  update: ReturnType<typeof useUpdateDatabase>;
}) {
  // `PATCH /<engine>/:id` runs `findOwnedForUpdate`: `service: ['update']`.
  const canSave = usePermission({ service: ["update"] });
  const lock = useConfigLock(row.environmentId, row.kind, row.databaseId);
  // Only the limits are the file's, through its `size`, and only when it
  // states one; replicas and reservations stay Cloudgate's.
  const limits =
    lock && statesField(lock, "size") ? lockRefusal(lock) : undefined;
  const resourceFields = (
    values: ResourceValues,
  ): FieldSpec<ResourceValues>[] => [
    {
      kind: "number",
      name: "replicas",
      label: "Replicas",
      min: 0,
      hint: "How many copies Swarm runs. Zero stops it without deleting anything — the same as Stop. More than one is almost always wrong here: these images are single-writer, and two tasks on one volume corrupt it.",
    },
    ...limitFields(values, {
      locked: limits,
      memoryLimitNote:
        "The container is killed if it goes past this, and a database killed mid-write is the worst version of that.",
      memoryReservationNote:
        "Memory Swarm holds free before scheduling this anywhere. Larger than any node has free and the service sits pending for ever with nothing in the log to say why.",
    }),
  ];

  return (
    <SettingsCard
      title="Resources"
      gate={{ allowed: canSave.allowed, refusal: DATABASE_UPDATE_REFUSAL }}
      lede="What this database may use, and what is held for it."
      schema={resourcesSchema}
      fields={resourceFields}
      savedMessage="Resources saved."
      defaultValues={{
        replicas: row.replicas,
        ...limitDefaults(row),
      }}
      submit={(values) =>
        update.mutateAsync({
          replicas: values.replicas,
          ...limitColumns(values),
        })
      }
      footer="None of this reaches the running container until the next deploy."
    >
      {lock && limits ? (
        <ConfigLockNote
          lock={lock}
          what="The CPU and memory limits are"
          rest="Replicas and reservations are Cloudgate's."
        />
      ) : null}
    </SettingsCard>
  );
}
