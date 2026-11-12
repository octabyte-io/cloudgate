import { ApiSchema } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { composeFileSchema } from '../../compose/dto/compose.dto';
import { hostSchema } from '../../domains/dto/domain.dto';
import { filePathSchema } from '../../mounts/dto/mount.dto';

// Body of POST /ai.
export const createAiSchema = z.object({
  name: z.string().min(1, { message: 'Name is required' }),
  apiUrl: z.string().url({ message: 'Please enter a valid URL' }),
  apiKey: z.string(),
  model: z.string().min(1, { message: 'Model is required' }),
  isEnabled: z.boolean().optional(),
});

export class CreateAiDto extends createZodDto(createAiSchema) {}

// Body of PATCH /ai/:id (partial; the aiId travels in the URL).
export const updateAiSchema = createAiSchema.partial();

export class UpdateAiDto extends createZodDto(updateAiSchema) {}

// Body of POST /ai/suggest.
export const suggestAiSchema = z.object({
  aiId: z.string(),
  input: z.string(),
  // `.nullish()`, not `.optional()`: a row on the platform host carries
  // `serverId: null`, so `null` is the value a client reads off the resource
  // and sends back — ADR-0008's "no server row" contract. `.optional()`
  // answered 400 to the API's own output; widening keeps every payload that
  // was already accepted.
  serverId: z.string().nullish(),
});

export class SuggestAiDto extends createZodDto(suggestAiSchema) {}

// Body of POST /ai/analyze-logs.
export const analyzeLogsSchema = z.object({
  aiId: z.string().min(1),
  logs: z.string().min(1),
  context: z.enum(['build', 'runtime']),
});

export class AnalyzeLogsDto extends createZodDto(analyzeLogsSchema) {}

// Body of POST /ai/test-connection.
//
// `apiUrl` carries the same shape rule as `createAiSchema`'s, and for the same
// reason §2.4 gives: the rule lives in one place, and that place is the DTO.
// `AiService.assertDestinationAllowed` parses this URL to read its hostname for
// the private-destination check and refuses one it cannot parse — that
// is a precondition of the check rather than a second copy of this rule, since
// the service is also reachable without a DTO.
export const testConnectionSchema = z.object({
  apiUrl: z.string().url({ message: 'Please enter a valid URL' }),
  apiKey: z.string(),
  model: z.string().min(1),
});

// Named explicitly for the OpenAPI document. Destinations exports a
// `TestConnectionDto` too, and Swagger keys components by class name, so
// without distinct names the two silently collapse into one — which left
// POST /destinations/test-connection documented with this body.
@ApiSchema({ name: 'AiTestConnectionDto' })
export class TestConnectionDto extends createZodDto(testConnectionSchema) {}

// Body of POST /ai/models. `apiUrl` as above.
export const getModelsSchema = z.object({
  apiUrl: z.string().url({ message: 'Please enter a valid URL' }),
  apiKey: z.string(),
});

export class GetModelsDto extends createZodDto(getModelsSchema) {}

/**
 * Body of POST /ai/deploy: an accepted suggestion to instantiate.
 *
 * **`configFiles[].filePath` is the mounts rule itself, not a copy of it.**
 * `AiService.deploy` loops this array into `MountsService.create`,
 * which the global pipe never validates because the object is built in the
 * service — so the traversal refusal, which lives on `createMountSchema`,
 * did not apply here. The field read `z.string().min(1)`: the exact shape that refusal
 * replaced, straight off the request body, and `getCreateFileCommand` joins it
 * onto `…/<appName>/files` with a `path.join` that normalises `../` away.
 *
 * Fixed at this DTO rather than by a `createMountSchema.parse()` inside
 * `MountsService.create`, because a second validation site is what §2.4 exists
 * to prevent and it would double-validate `POST /mounts`. Importing
 * `filePathSchema` keeps one rule, one message and one layer.
 *
 * **`domains[].host` was the sibling of that finding, and the first pass missed it.**
 * The same sentence applies word for word: `AiService.deploy` loops
 * `domains` into `DomainsService.create` with an object it built, so the global
 * pipe never validated it and the host rule — which lives on `hostSchema` — did
 * not apply. The field read `z.string().min(1)`, the exact shape that rule replaced.
 * A compose domain's host travels as a Traefik router label,
 * ``rule=Host(`<host>`)`` (`compose/compose.utils.ts:80-82`), which the Docker
 * provider parses *as a rule*: a backtick closes that `Host(...)` and appends
 * alternations of its own, so the stack answers for hostnames with no Domain
 * row — and outranks the legitimate router, because Traefik prioritises by rule
 * length. Fixed by importing `hostSchema` for the same §2.4 reason
 * `filePathSchema` is imported: one rule, one message, one layer.
 *
 * `path` is **not** reachable here — this shape carries no `path` field, so
 * the path charset has no seam on this route. Recorded so the sweep is not
 * redone. The ownership check is not a DTO rule either, since it lives in
 * `DomainsService.create`; this note used to stop at *"it does apply already"*,
 * which was true and beside the point — it applied from inside the domains
 * loop, i.e. after `createByTemplate`, so a claimed hostname was refused with
 * the caller's stack already committed. That is the half-built-stack residual
 * that was closed for the `template.toml` deploy route (removed in #1364)
 * and not here. `AiService.deploy` now calls `assertHostsUnclaimed` at its
 * own pre-flight, as `PlanApplier.check` checks a Template's hosts before
 * any step writes — and `assertRoutesUntaken` before it, so the `(host, path)` pair check (every
 * domain here is at `/`) no longer refuses a taken host, or one named twice,
 * with the stack already built either.
 *
 * It covers the model's own output for free: a suggestion's `configFiles` and
 * its `domains` both come back through this same body before anything is
 * written, so a model that invents an unroutable hostname is refused here too.
 */
export const deployAiSchema = z.object({
  environmentId: z.string().min(1),
  id: z.string().min(1),
  // The shared rule, imported rather than restated — the third field on this
  // schema to make that move, after `host` and `filePath` (§2.4). This is
  // a **caller-supplied** compose file that reaches
  // `ComposeService.createByTemplate` and its
  // `assertComposeContentClaimable`, whose parse was unguarded: an alias bomb or
  // a `*base` with no anchor answered 500 here exactly as it did on
  // `POST /compose`. Sharing the schema means it answers 400 at
  // `details[].path` instead, the same shape and the same sentence as its
  // sibling.
  //
  // **`.min(1)` stays, and it is not redundant with the shared rule.**
  // `composeFileSchema` deliberately admits `''` — `composeFile` is optional on
  // create and a stack is routinely created before its file is written — but an
  // empty `dockerCompose` here is a *model* that answered nothing, which is a
  // different failure and one this route has always refused. zod 4 appends the
  // check rather than replacing it, so both fire.
  dockerCompose: composeFileSchema.min(1),
  envVariables: z.string(),
  serverId: z.string().nullish(),
  name: z.string().min(1),
  description: z.string(),
  domains: z
    .array(
      z.object({
        // The shared rule, imported rather than restated — the same move
        // `filePath` below makes, for the same reason.
        host: hostSchema,
        port: z.number().min(1),
        serviceName: z.string().min(1),
      }),
    )
    .optional(),
  configFiles: z
    .array(
      z.object({
        // The shared rule, imported rather than restated: `min(1)` is implied
        // by it, since the empty string names the files directory and not a
        // file in it.
        filePath: filePathSchema,
        content: z.string().min(1),
      }),
    )
    .optional(),
});

export class DeployAiDto extends createZodDto(deployAiSchema) {}
