import { z } from "zod";

import type { ApplicationDetail } from "@/lib/api/endpoints/applications";
import type { GpuCounts } from "@/lib/api/endpoints/settings";
import { useGpuCounts } from "@/lib/api/use-gpu";
import { usePermission } from "@/lib/auth/use-permission";
import {
  ConfigLockNote,
  lockRefusal,
  statesField,
  useConfigLock,
} from "@/components/console/config-lock";

import { APPLICATION_SETTINGS_REFUSAL } from "../use-application";
import type { FieldSpec } from "./resource-spec";
import { SettingsCard } from "@/components/console/settings-card";
import {
  limitColumns,
  limitDefaults,
  limitFields,
  limitShape,
} from "@/components/console/engine-limit-fields";

/**
 * What this Application is allowed to use, and what is held for it.
 *
 * **A limit and a reservation are different promises** and the card says so
 * rather than presenting four boxes in a grid: a limit is a ceiling the
 * container is killed at, a reservation is capacity Swarm keeps free before it
 * will schedule the task anywhere. Setting a reservation larger than any node
 * has free is how a service sits in `pending` for ever with nothing in the log
 * to say why, so it is worth the sentence.
 *
 * The fields take cores and sizes, and `engine-limit-fields.tsx` turns them into
 * the nano-CPUs and bytes the API keeps.
 *
 * **GPUs are whole cards per running copy**, beside CPU and memory on
 * any Application. The field reads the run Server's cards and free count live
 * and the total held (copies × N). Asking for more than the Server has is
 * refused by the save, not warned about here.
 */

const schema = z.object({
  replicas: z.coerce
    .number()
    .int("Replicas has to be a whole number.")
    .min(0, "Replicas cannot be negative."),
  ...limitShape,
  gpus: z.coerce
    .number()
    .int("GPUs has to be a whole number.")
    .min(0, "GPUs cannot be negative."),
});

type Values = z.infer<typeof schema>;

export function ResourcesCard({
  application,
  save,
}: {
  application: ApplicationDetail;
  save: (input: Record<string, unknown>) => Promise<unknown>;
}) {
  // `PATCH /applications/:id` runs `findOwnedForUpdate`: `service: ['update']`.
  const canSave = usePermission({ service: ["update"] });
  const lock = useConfigLock(
    application.environmentId,
    "application",
    application.applicationId,
  );
  // Only the limits are the file's, through its `size`, and only when it
  // states one; replicas and reservations stay Cloudgate's.
  const limits =
    lock && statesField(lock, "size") ? lockRefusal(lock) : undefined;
  // The counts read is `service: ['create']` on the run Server; a
  // caller without it still edits the field, without the reading.
  const canReadCards = usePermission({ service: ["create"] });
  const cards = useGpuCounts(application.serverId, canReadCards.allowed);
  const host = application.server?.name ?? "The platform host";
  const fields = (values: Values): FieldSpec<Values>[] => [
    {
      kind: "number",
      name: "replicas",
      label: "Replicas",
      min: 0,
      hint: "How many copies of this Application Swarm runs. Zero stops it without deleting anything.",
    },
    ...limitFields(values, {
      locked: limits,
      memoryLimitNote: "The container is killed if it goes past this.",
      memoryReservationNote:
        "Memory Swarm holds free before scheduling this anywhere.",
    }),
    {
      kind: "number",
      name: "gpus",
      label: "GPUs",
      min: 0,
      hint: gpuReading(cards.data, host, values),
    },
  ];

  return (
    <SettingsCard
      title="Resources"
      gate={{ allowed: canSave.allowed, refusal: APPLICATION_SETTINGS_REFUSAL }}
      lede="What this Application may use, and what is held for it."
      schema={schema}
      fields={fields}
      savedMessage="Resources saved."
      defaultValues={{
        replicas: application.replicas,
        ...limitDefaults(application),
        gpus: application.gpus,
      }}
      submit={(values) =>
        save({
          replicas: values.replicas,
          ...limitColumns(values),
          gpus: values.gpus,
        })
      }
      footer="None of this reaches the running container until the next Deployment."
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

/**
 * The run Server's cards first, then what the reservation holds in all. A
 * reading that has not come back, or that the caller may not ask for, leaves
 * only the second half.
 */
function gpuReading(
  counts: GpuCounts | undefined,
  host: string,
  values: Pick<Values, "gpus" | "replicas">,
): React.ReactNode {
  const per = Number(values.gpus) || 0;
  const copies = Number(values.replicas) || 0;
  const held =
    per > 0
      ? `Holds ${copies * per} in all: ${copies} ${copies === 1 ? "copy" : "copies"} × ${per}.`
      : "Whole cards per running copy.";
  if (!counts) return held;
  const machine =
    counts.gpuSetup === "card-id"
      ? `${host} has ${counts.cards} ${counts.cards === 1 ? "GPU" : "GPUs"}, ${counts.free} free`
      : counts.gpuSetup === "count"
        ? `${host} was set up for GPUs the old way: run GPU setup again`
        : `${host} is not set up for GPUs`;
  return (
    <>
      <strong className="font-medium text-tx-2">{machine}</strong>
      {" · "}
      {held}
    </>
  );
}
