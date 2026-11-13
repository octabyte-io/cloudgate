import { z } from "zod";

/**
 * A **Plan** as `cloudgate config plan` reads it (ADR-0080): enough to
 * print each step on one line and to know which names an Apply must
 * confirm. Only those fields: zod drops the rest, so a cloud read's lines or
 * a field's values never reach anything the CLI prints.
 *
 * A step is one object rather than a union of actions, so an action this
 * CLI does not know yet is still printed, by its name, instead of failing
 * the read.
 */
const planStepSchema = z.object({
  /** `create`, `change`, `redeploy`, `destroy`, `network-create`, … */
  action: z.string(),
  /** A Service's step's Config name; absent on an Environment network's. */
  configName: z.string().optional(),
  kind: z.string().optional(),
  /**
   * Each changed field, named as the config writes it, and whether the
   * change removes it (its new value is none). Only that fact is kept of the
   * value, so no value reaches what the CLI prints.
   */
  fields: z
    .array(
      z
        .object({ field: z.string(), to: z.unknown().optional() })
        .transform(({ field, to }) => ({
          field,
          removed: to === null,
        })),
    )
    .optional(),
  /** A major version upgrade, which an Apply confirms by Config name. */
  majorUpgrade: z.object({ from: z.string(), to: z.string() }).optional(),
  /** A `redeploy`'s (or a change's) changed links, as `<source>.<output>`. */
  because: z.array(z.string()).optional(),
  /** Why its Apply will not run it. */
  blocked: z.string().optional(),
  /** An Environment network's region. */
  region: z.string().optional(),
  /** What an Apply confirms a network removal by. */
  confirmName: z.string().optional(),
});

/** One step's result after an Apply. */
const planStepResultSchema = z.object({
  configName: z.string(),
  action: z.string(),
  status: z.string(),
  message: z.string().nullable(),
});

/** One Environment's Plan, as the API answers it. */
export const planViewSchema = z.object({
  planId: z.string(),
  environmentId: z.string(),
  /** `open`, `applied`, `partly-applied`, `unchanged`, … */
  status: z.string(),
  steps: z.array(planStepSchema),
  notes: z.array(z.object({ message: z.string().optional() })),
  results: z.array(planStepResultSchema).nullable(),
});

/**
 * `POST /projects/:projectId/config/plans`, the whole-YAML edit: a plan per
 * Environment, and whether the text was stored at once, which it is only
 * when no Environment has anything to change.
 */
export const savedConfigPlansSchema = z.object({
  stored: z.boolean(),
  plans: z.array(planViewSchema),
});

export type PlanView = z.infer<typeof planViewSchema>;
export type PlanStepView = PlanView["steps"][number];
export type SavedConfigPlans = z.infer<typeof savedConfigPlansSchema>;
