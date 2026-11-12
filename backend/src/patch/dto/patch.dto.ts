import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { patchFilePathProblem } from '../patch-file-path';

/**
 * The path a Patch is written to, refused with a 400 naming `filePath` when it
 * leaves the checkout or carries a character that escapes a quoted shell word
 *. Every schema that writes a Patch row uses it: create and update,
 * and the editor's save and delete-mark, which upsert the same row. The rule
 * and why it holds are `patch-file-path.ts`'s.
 */
const patchFilePath = z
  .string()
  .min(1)
  .describe(
    'A path relative to the repository root, with no ".." segment and none ' +
      'of ", `, $, a backslash, NUL or a line break.',
  )
  .superRefine((value, ctx) => {
    const problem = patchFilePathProblem(value);
    if (problem !== null) {
      ctx.addIssue({ code: 'custom', message: `filePath ${problem}` });
    }
  });

/**
 * **Exactly one** of applicationId or composeId owns the patch, and the
 * `superRefine` below is what enforces it.
 *
 * This comment used to concede the rule and hand it off — *"enforced in
 * PatchService, not the schema"* — and `PatchService` did not enforce it.
 * `create` resolved `data.applicationId ?? data.composeId`, derived the
 * entity type from whichever was present, access-checked **that one id**
 * correctly, and then inserted `...data`, which writes *both* foreign keys.
 * `??` short-circuits, so a body carrying the caller's own `applicationId`
 * beside another organization's `composeId` passed the gate on the first and
 * landed a `patch` row on the victim's Compose stack — and
 * `PatchService.generateApplyPatchesCommand` renders a patch as a `base64 -d >`
 * into the owning service's code directory, so that row is an arbitrary file
 * write into another organization's build, applied at their next deploy.
 *
 * §2.4 puts the shape rule here rather than as a third throw in the service:
 * "exactly one of these" is a property of the payload, the global pipe already
 * runs on it, and putting it here is what makes the sentence above true instead
 * of aspirational. It is not the only half of the fix — `PatchService.create`
 * independently writes the *resolved* parent's id explicitly instead of
 * spreading the body, because a refinement only guards the fields it was
 * written for and the next foreign key added to this schema would otherwise be
 * inserted unvalidated. `saveFileAsPatch` and `markFileForDeletion` were never
 * exposed: their DTOs carry one `id` plus a `type` discriminator, so there is
 * no second id to smuggle. Neither is `updatePatchSchema`, which omits both
 * fields and, as a plain `z.object`, *strips* them off a body that sends them
 * anyway — a patch cannot be re-pointed at another service.
 */
export const createPatchSchema = z
  .object({
    filePath: patchFilePath,
    content: z.string(),
    type: z.enum(['create', 'update', 'delete']).optional(),
    enabled: z.boolean().optional(),
    // Both fields are optional in the object and mutually exclusive by the
    // refinement, so the condition has no place in a flat `required` array and
    // is published as prose on each of them instead — `createMountSchema`'s
    // H-70 shape. Without it the document says "optional" twice and stops,
    // which is exactly the reading that produced the both-ids bug.
    applicationId: z
      .string()
      .describe(
        'The owning Application. Exactly one of applicationId or composeId ' +
          'must be sent; a body carrying both is refused.',
      )
      .optional(),
    composeId: z
      .string()
      .describe(
        'The owning Compose stack. Exactly one of applicationId or composeId ' +
          'must be sent; a body carrying both is refused.',
      )
      .optional(),
  })
  .superRefine((data, ctx) => {
    if ((data.applicationId === undefined) === (data.composeId === undefined)) {
      ctx.addIssue({
        code: 'custom',
        // A field path rather than the object's root: an empty `path` names
        // nothing a caller can fix, which is the complaint
        // `triggerDeploymentSchema`'s docblock records.
        path: ['applicationId'],
        message: 'Exactly one of applicationId or composeId must be provided',
      });
    }
  });

export class CreatePatchDto extends createZodDto(createPatchSchema) {}

// Update input (patchId travels in the URL); the patch cannot be re-pointed at
// another service, so applicationId/composeId stay out — and stripping, not
// passthrough, is what makes that hold for a body that sends them anyway
// (verified; see `createPatchSchema`).
export const updatePatchSchema = z
  .object({
    filePath: patchFilePath,
    content: z.string(),
    type: z.enum(['create', 'update', 'delete']),
    enabled: z.boolean(),
  })
  .partial();

export class UpdatePatchDto extends createZodDto(updatePatchSchema) {}

// Mirrors the patch router's byEntityId input.
export const listPatchesSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['application', 'compose']),
});

export class ListPatchesDto extends createZodDto(listPatchesSchema) {}

// Toggle input (patchId travels in the URL).
export const togglePatchSchema = z.object({
  enabled: z.boolean(),
});

export class TogglePatchDto extends createZodDto(togglePatchSchema) {}

// Mirrors the patch router's ensureRepo input.
export const ensureRepoSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['application', 'compose']),
});

export class EnsureRepoDto extends createZodDto(ensureRepoSchema) {}

// Mirrors the patch router's readRepoDirectories input, minus its `repoPath`:
// the directory to list is derived from the entity, not supplied. zod strips
// unknown keys, so a caller that still sends one keeps working.
export const readRepoDirectoriesSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['application', 'compose']),
});

export class ReadRepoDirectoriesDto extends createZodDto(
  readRepoDirectoriesSchema,
) {}

// Mirrors the patch router's readRepoFile input, plus a `source` selector the
// source has no equivalent for: `patch` is the historical resolution (a patch
// standing in front of the path answers for it), `repo` is the repository's own
// copy of the path — the "before" side an `update` patch would otherwise hide.
export const readRepoFileSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['application', 'compose']),
  filePath: z.string(),
  source: z.enum(['patch', 'repo']).default('patch'),
});

export class ReadRepoFileDto extends createZodDto(readRepoFileSchema) {}

// Mirrors the patch router's saveFileAsPatch input.
export const saveFileAsPatchSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['application', 'compose']),
  filePath: patchFilePath,
  content: z.string(),
  patchType: z.enum(['create', 'update']).default('update'),
});

export class SaveFileAsPatchDto extends createZodDto(saveFileAsPatchSchema) {}

// Mirrors the patch router's markFileForDeletion input.
export const markFileForDeletionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['application', 'compose']),
  filePath: patchFilePath,
});

export class MarkFileForDeletionDto extends createZodDto(
  markFileForDeletionSchema,
) {}

// Mirrors the patch router's cleanPatchRepos input.
export const cleanPatchReposSchema = z.object({
  // `.nullish()`, not `.optional()`: a row on the platform host carries
  // `serverId: null`, so `null` is the value a client reads off the resource
  // and sends back — ADR-0008's "no server row" contract. `.optional()`
  // answered 400 to the API's own output; widening keeps every payload that
  // was already accepted.
  serverId: z.string().nullish(),
});

export class CleanPatchReposDto extends createZodDto(cleanPatchReposSchema) {}
