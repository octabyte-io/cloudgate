import { z } from "zod";

import { SettingsCard } from "@/components/console/settings-card";
import type {
  ApplicationDetail,
  CopyRangeInput,
} from "@/lib/api/endpoints/applications";
import { usePermission } from "@/lib/auth/use-permission";

import { APPLICATION_SETTINGS_REFUSAL } from "../use-application";
import type { FieldSpec } from "./resource-spec";

/** Cloud Run's own ceiling; a project's lower quota is Google's to refuse. */
const MOST_COPIES = 1000;

const schema = z
  .object({
    minCopies: z.coerce
      .number()
      .int("The fewest copies has to be a whole number.")
      .min(0, "The fewest copies cannot be negative.")
      .max(MOST_COPIES, `Cloud Run runs at most ${MOST_COPIES} copies.`),
    maxCopies: z.coerce
      .number()
      .int("The most copies has to be a whole number.")
      .min(1, "The most copies has to be at least 1.")
      .max(MOST_COPIES, `Cloud Run runs at most ${MOST_COPIES} copies.`),
  })
  .refine((values) => values.minCopies <= values.maxCopies, {
    path: ["minCopies"],
    message: "The fewest copies cannot be more than the most copies.",
  });

type Values = z.infer<typeof schema>;

/**
 * **How many copies a `web` on Cloud Run runs** (S10): the
 * fewest and the most, Cloudgate's per Service, 0 and 10
 * when its plan made it. Never in the Project config and never in a plan:
 * a save sets it on the Cloud Run service by a direct call, at once, and
 * keeps it only if Google took it. Start puts this range back.
 *
 * The fewest at 0 scales to zero when idle, which costs almost nothing and
 * makes the first request after a quiet spell wait for a start; the plan
 * line says the same.
 */
export function CopyRangeCard({
  application,
  save,
}: {
  application: ApplicationDetail;
  save: (input: CopyRangeInput) => Promise<unknown>;
}) {
  // `PUT /applications/:id/copy-range` is `service: ['update']`.
  const canSave = usePermission({ service: ["update"] });
  const fields: FieldSpec<Values>[] = [
    {
      kind: "number",
      name: "minCopies",
      label: "Fewest copies",
      min: 0,
      hint: "0 scales to zero when idle: almost nothing billed, and the first request after a quiet spell waits for a start.",
    },
    {
      kind: "number",
      name: "maxCopies",
      label: "Most copies",
      min: 1,
      hint: "Cloud Run adds copies up to this as requests come in.",
    },
  ];

  return (
    <SettingsCard
      title="Copies"
      gate={{ allowed: canSave.allowed, refusal: APPLICATION_SETTINGS_REFUSAL }}
      lede="How many copies Cloud Run runs of this Service."
      schema={schema}
      fields={fields}
      savedMessage="Copy range saved and set on Cloud Run."
      defaultValues={{
        minCopies: application.minCopies ?? 0,
        maxCopies: application.maxCopies ?? 10,
      }}
      submit={(values) =>
        save({ minCopies: values.minCopies, maxCopies: values.maxCopies })
      }
      footer="Set on Cloud Run as soon as it is saved, without a Deployment. It is Cloudgate's, never the Project config's, and no plan shows it."
    />
  );
}
