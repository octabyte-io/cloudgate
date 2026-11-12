import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { deployTargetSchema } from '../../environments/deploy-target';

/**
 * "New Project from a template" (#1376): the Project's name, and the Deploy
 * target of the one `production` Environment setup makes in it. The target
 * follows `POST /environments`' rules: left out, it is the platform host when
 * the organization has no deploy Server, and refused when it has one.
 */
export const newProjectSchema = z.strictObject({
  name: z.string().trim().min(1, 'name cannot be empty'),
  deployTarget: deployTargetSchema.optional(),
});

/**
 * Which Project's Environments `GET /templates/:templateId/setup` answers
 * for; none for a new Project, whose form answers by Deploy target instead.
 * A setup names its existing Project by the same rule.
 */
export const setupEnvironmentsQuerySchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty').optional(),
});

export class SetupEnvironmentsQueryDto extends createZodDto(
  setupEnvironmentsQuerySchema,
) {}

/**
 * A Template setup (spec #1356, "What a setup takes"): into an existing
 * Project and one of its Environments, or into a new Project, never both.
 * The asked values are by input name; the Domain hosts by `{{domains.<name>}}`
 * name.
 */
export const templateSetupSchema = setupEnvironmentsQuerySchema
  .extend({
    templateId: z.string().min(1, 'templateId cannot be empty'),
    environmentId: z
      .string()
      .min(1, 'environmentId cannot be empty')
      .optional(),
    newProject: newProjectSchema.optional(),
    /** The name in front of every part's Config name; the template's id by default. */
    setupName: z.string().min(1, 'setupName cannot be empty'),
    values: z.record(z.string(), z.string()).default({}),
    hosts: z.record(z.string(), z.string()).default({}),
    /**
     * The get-started wizard's setup (ADR-0073): Cloudgate applies its plan
     * itself, as the caller, once the target Server is Ready and set up.
     * Left out, the plan waits for Apply as any other (ADR-0065).
     */
    autoApply: z.boolean().optional(),
  })
  .superRefine((body, issues) => {
    const existing =
      body.projectId !== undefined || body.environmentId !== undefined;
    if (body.newProject !== undefined) {
      if (existing) {
        issues.addIssue({
          code: 'custom',
          path: ['newProject'],
          message:
            'newProject cannot be given with projectId or environmentId: name one place, not both',
        });
      }
      return;
    }
    for (const key of ['projectId', 'environmentId'] as const) {
      if (body[key] === undefined) {
        issues.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required unless newProject is given`,
        });
      }
    }
  });

export class TemplateSetupDto extends createZodDto(templateSetupSchema) {}
