import path from 'node:path';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  VOLUME_NAME_MESSAGE,
  VOLUME_NAME_REGEX,
} from '../../volume-backups/dto/volume-backup.dto';

/**
 * Stand-in for whichever service's files directory the mount will land in.
 * The real one is `MountsService.baseFilesPath` — `<applications|compose>/
 * <appName>/files` — but which service it names cannot change the answer, so
 * the rule is decided against a sentinel and holds for all of them.
 */
const SENTINEL_FILES_DIRECTORY = '/files';

/** The two optional halves of `insideDirectorySchema`; see its docblock for each. */
interface InsideDirectoryOptions {
  /** The string rule the traversal check is layered onto. */
  subject?: z.ZodString;
  /** Admit `''` as "no value" before the sentinel is tested. */
  allowUnset?: boolean;
}

/**
 * A caller-supplied path that must stay inside the directory it is joined to.
 *
 * The rule: whatever the path normalises to must be *strictly inside* `base`.
 * An absolute path is refused rather than confined the way `path.join` confines
 * it — `patch-repo.service.ts`'s `resolveRepoFilePath` takes the other option
 * there, and it is the wrong one for a stored row: a mount whose `filePath`
 * reads `/etc/passwd` while its file sits at `…/files/etc/passwd` is a row that
 * lies about itself. `.` and the empty string go the same way: they name the
 * directory, not something in it — the one caller with its own meaning for the
 * empty string keeps it outside this rule rather than bending the rule, and
 * `application.dto.ts`'s `publishDirectory` says why.
 *
 * A trailing slash survives, because both callers that can carry one read it as
 * "this is a directory" — `getCreateFileCommand` for a file mount, and
 * `nixpacks.strategy.ts` to decide whether it copies out a directory's contents
 * or a single file — and the rule must not quietly change what was configured.
 *
 * `base` is a **sentinel** at all three call sites rather than the real
 * directory, and it can be: for any absolute base `B`, `resolve(B, value)`
 * either stays under `B` or leaves it, and a `..` that over-walks clamps at `/`
 * and still fails the prefix test — so `B`'s depth cannot change the verdict.
 * The message is the only base-specific part, which is why it is the one thing
 * a caller passes.
 *
 * It lives at the DTO rather than in the service because §2.4 puts validation
 * in one place, and because the refusal a caller wants for a bad path is the
 * 400 the global pipe already answers.
 *
 * Three callers, one rule rather than three copies of it: `filePathSchema`
 * below, and the two columns whose value is joined onto a
 * per-service directory on the build server and then *written* to —
 * `publishDirectory` on `updateApplicationSchema` (`path.join(buildAppDirectory,
 * …)` in `nixpacks.strategy.ts`, then a `docker cp` into it) and `composePath`
 * on `updateComposeSchema` (`getComposeFilePath`, three of whose six callers
 * write through it — it said two of four until they were re-counted).
 *
 * `subject` is the string rule the traversal check is layered onto, and it is a
 * parameter rather than always `z.string()` so that a column carrying a length
 * rule keeps it *in the published contract*: refining a `z.string().min(1)`
 * leaves `{ type: 'string', minLength: 1 }` in `openapi.json`, where the
 * `z.string().min(1).and(…)` intersection that would otherwise be needed renders
 * as a meaningless `allOf` of two strings (§2.11).
 *
 * `allowUnset` admits `''` before the sentinel is tested, for a column where the
 * empty string is an existing spelling of "no value" rather than a path — only
 * `publishDirectory`, whose builders all read a falsy value as unset. It is a
 * parameter for the same §2.11 reason as `subject`: expressing it as
 * `z.union([z.literal(''), …])` at the call site renders as an `anyOf` of an
 * empty-string enum and a plain string, and since a zod refinement never
 * reaches `openapi.json` at all, that `anyOf` documents precisely what a bare
 * `string` already did — contract churn for every generated consumer in exchange
 * for no information. `filePathSchema` and `composePath` keep refusing `''`.
 */
export const insideDirectorySchema = (
  base: string,
  message: string,
  { subject = z.string(), allowUnset = false }: InsideDirectoryOptions = {},
) =>
  subject.refine(
    (value) =>
      (allowUnset && value === '') ||
      path.posix.resolve(base, value).startsWith(`${base}/`),
    { message },
  );

/**
 * What a caller-supplied file-mount path may be.
 *
 * `getCreateFileCommand` does `path.join(outputPath, filePath)`, which
 * *normalises* — so `../../../etc/traefik/traefik.yml` walks straight out of
 * the service's files directory, and the write lands wherever it points. Three
 * routes reach it with the row's value: `create` and `update` write the file,
 * and `remove` builds `rm -rf "<joined path>"`. The mount row is also a bind
 * `Source` in the deploy spec (`generateFileMounts`), so an escaped path
 * mounts a host file into the container.
 *
 * **Exported because other seams need this rule, not a copy of it.**
 * `AiService` and `PlanApplier` (a Template's config files) call
 * `MountsService.createForNewService` with an object they built, so the global
 * pipe never sees theirs. One review named that bypass
 * and left it open; a later fix closed it the way §2.4 asks — `aiDeploySchema`'s
 * `configFiles` element derives its `filePath` from *this* schema, so `POST
 * /ai/deploy` is validated by the same rule at the same layer as `POST /mounts`,
 * and `MountsService.create` gains no second validation site.
 *
 * A Template's file paths could not be a DTO either: they arrive in the
 * catalogue, after any DTO ran. The Template check holds every listed path to
 * the one shared file-path rule (#222) before a template is offered, so a
 * path that reaches `MountsService` from an Apply was checked by it. (The
 * `template.toml` reader, removed in #1364, applied this schema to a path it
 * had substituted.)
 *
 * `mountPath` is bypassed by `AiService` too. That fix left it alone
 * as benign; a later one made it the documented shape instead — it is optional
 * exactly when `serviceType` is `compose`, which is what it writes. See
 * `createMountSchema` below.
 *
 * Not covered here, and deliberately: `getCreateFileCommand` interpolates the
 * directory into a `mkdir -p` word, so a path carrying shell metacharacters was
 * a separate hole with a separate answer. It is closed in
 * the command builder instead — `docker.utils.ts`'s `resolveShellSafePath`
 * refuses `SHELL_UNSAFE` over the whole *joined* path, which is the only
 * place that knows what the joined path is and covers `MountsService.remove`'s
 * `rm -rf` target as well. The two rules stay orthogonal on purpose: this one
 * decides where a mount may point, that one decides what may be interpolated
 * into a shell. The traversal check was asked for by the same review.
 */
export const filePathSchema = insideDirectorySchema(
  SENTINEL_FILES_DIRECTORY,
  'filePath must stay inside the service files directory',
);

/**
 * A volume mount's `volumeName`, held to the same Docker object-name rule its
 * sibling already carries (H-55).
 *
 * `volumeName` becomes the `Source` of a volume-type mount on the deploy spec
 * (`generateVolumeMounts` → `createService`), and it was a bare
 * `z.string()`/`z.string().optional()` here while `volume-backups`' copy of the
 * *same Docker object name* — the volume this application backs up and restores
 * — is held to `VOLUME_NAME_REGEX`. The asymmetry is what this closes:
 * `VOLUME_NAME_REGEX` is imported, not re-declared, so the two sites cannot
 * drift (§1.4), and a name Docker itself would refuse cannot name a volume this
 * application can mount.
 *
 * **Written down as consistency, not as a cross-tenant fix, so it is not cited
 * as one later.** The charset does not decide *which* volume a mount attaches
 * to — a valid name naming another tenant's volume on the shared platform daemon
 * is still valid — and that isolation question is a trust boundary, not a
 * grammar. This rule only brings `volumeName` up to the sibling it had fallen
 * behind; see the report's H-55 note for the boundary the charset leaves open.
 */
export const volumeNameSchema = z
  .string()
  .min(1)
  .regex(VOLUME_NAME_REGEX, VOLUME_NAME_MESSAGE);

// Which optional field matters depends on type (volume → volumeName, bind →
// hostPath, file → filePath + content), and the schema requires none of them.
// `mountPath` is the one exception, and what makes it required is
// `serviceType` rather than `type` — see the superRefine below.
export const createMountSchema = z
  .object({
    // The `.describe()` is the second conditional's only trace in
    // `openapi.json`, on `mountPath`'s H-70 terms below: a `superRefine`
    // cannot render into the schema, and a document that says a stack takes
    // any of the three would be wrong.
    type: z
      .enum(['bind', 'volume', 'file'])
      .describe(
        "Must be 'file' when serviceType is 'compose'. Nothing assembles a " +
          "Compose stack's mount rows into a deploy spec, so a bind or a " +
          'volume attached to one would never be read; declare those in the ' +
          "stack's own compose file.",
      ),
    // `hostPath` stays a bare string on purpose (H-55): a bind mount's Source
    // *is* an arbitrary host path — `/etc`, a data directory — and a charset
    // cannot tell `/var/run/docker.sock` from a path an operator legitimately
    // binds. What guards it is the trust boundary around who may create a bind
    // mount and on which daemon, not a grammar; see the report's H-55 note.
    hostPath: z.string().optional(),
    volumeName: volumeNameSchema.optional(),
    filePath: filePathSchema.optional(),
    content: z.string().optional(),
    // Optional in the object, required by the refinement: a compose stack's
    // mount rows are never assembled into a deploy spec, so a compose file
    // mount has no container target to name.
    //
    // The `.describe()` is the conditional's only trace in `openapi.json`
    // (H-70). A `superRefine` cannot render into a flat `required` array, and
    // listing `mountPath` there anyway would make the document *wrong* — a
    // compose mount legitimately omits it — so the condition is published as
    // this property's prose `description`, which is what someone reading a
    // generated client has in front of them. Without it the document says
    // "optional" and stops, which is the half of that change that never shipped.
    // `.describe()` is also the cheap shape in §2.11's terms, and that was
    // checked on the regenerated document rather than assumed: it adds one
    // `description` key beside the `type`/`minLength` this field already
    // publishes, where spelling the condition as a `z.union` or an
    // intersection would add the meaningless `anyOf`/`allOf` churn
    // `insideDirectorySchema`'s docblock is about.
    mountPath: z
      .string()
      .min(1)
      .describe(
        "Required unless serviceType is 'compose'. A compose stack's mount " +
          'rows are never assembled into a deploy spec, so a compose mount has ' +
          'no container target to name; every other serviceType is refused ' +
          'without one.',
      )
      .optional(),
    serviceType: z
      .enum([
        'application',
        'postgres',
        'mysql',
        'mariadb',
        'mongo',
        'redis',
        'compose',
        'libsql',
      ])
      .default('application'),
    serviceId: z.string().min(1),
  })
  .superRefine((data, ctx) => {
    // Not conditional on `type === 'file'`, which is what was first proposed:
    // `generateFileMounts` sets `Target: mount.mountPath` for every file mount
    // it sees (`docker/docker.utils.ts`), so an application or database file
    // mount without one stores fine and then fails the deploy with a Docker
    // error naming nothing. `compose` is the exemption because nothing ever
    // assembles a stack's mount rows — `compose/compose.schema.ts` declares no
    // mount relation, and both queries that reach `mount` for a deploy are
    // keyed to an application or a database. `TemplatesService` and `AiService`
    // materialize a compose file mount on disk and the stack's own YAML mounts
    // it, so there is no container target they could name.
    if (data.mountPath === undefined && data.serviceType !== 'compose') {
      ctx.addIssue({
        code: 'custom',
        path: ['mountPath'],
        message: "mountPath is required unless serviceType is 'compose'",
      });
    }
    // The other half of the same discriminant. `mountPath` above is
    // exempt for a stack *because* nothing assembles a stack's mount rows into
    // a deploy spec — so the two kinds of row that exist only to be assembled
    // are rows nothing will ever read. That was measured rather than assumed:
    // `composeRelations` declares no `mounts` relation at all, so
    // `ComposeService.findDeployable` could not load one if it tried;
    // `DeployableCompose` has no field for them; the only two reads of the
    // `mount` table outside this module key on `mount.applicationId` and on a
    // database's own FK; and `mechanize`'s three generators are what turns
    // those into a swarm service's `Mounts`. A `file` mount is different in kind and
    // is the one a stack does consume: `MountsService.insertMount` writes it
    // under `{composeDirectoryOn(serverId)}/{appName}/files` on the stack's
    // Server — the local `composeDirectory` spelling this named was deleted —
    // and the operator's own `volumes:` key mounts it, which is how
    // a Template's compose part (`PlanApplier.writeTemplateFiles`) and
    // `AiService.deploy` give a stack its config files.
    //
    // **A refusal rather than honouring them, and the choice is about which
    // mechanism owns a stack's volumes.** Honouring them would mean
    // `ComposeService.findDeployable` loading mounts and the generators
    // merging them into the operator's file — two mechanisms declaring one
    // stack's `volumes:`, which is the interaction the map-vs-list label
    // work is the precedent for: a merge has to decide silently what a
    // conflicting declaration means, and the operator's own file is the one
    // artefact they can read. Refusing says it once, at the field, in a 400
    // naming the file they already have.
    //
    // **It costs nothing that exists.** Every in-product creator of a compose
    // mount asks for `type: 'file'` — `TemplatesService`, `AiService`, and the
    // console, whose mounts panel is the Application's alone and hard-codes
    // `serviceType: 'application'`. A bind or volume row on a stack could only
    // have been made by calling this route directly, and any that exist go on
    // being listed and deletable: they are inert, which is the whole finding,
    // so nothing has to be migrated on their behalf.
    if (data.serviceType === 'compose' && data.type !== 'file') {
      ctx.addIssue({
        code: 'custom',
        path: ['type'],
        message:
          "A Compose stack only takes a 'file' mount; declare a bind or a " +
          "volume in the stack's own compose file",
      });
    }
  });

export class CreateMountDto extends createZodDto(createMountSchema) {}

// Update input (mountId travels in the URL); the mount cannot be re-pointed at
// another service, so serviceId/serviceType stay out.
export const updateMountSchema = z
  .object({
    // This one *does* carry create's sentence, on the same H-70 terms that
    // keep it off `mountPath` below: `PATCH /mounts/:id` enforces the
    // compose rule, from `MountsService.update` rather than from here, because
    // `serviceType` is not in this schema and the stored row is the only thing
    // that knows what kind of parent the mount hangs off. A document silent
    // about it would describe a route that 400s on a body it published as
    // valid.
    type: z
      .enum(['bind', 'volume', 'file'])
      .describe(
        "Must be 'file' when the mount belongs to a Compose stack. Nothing " +
          "assembles a Compose stack's mount rows into a deploy spec, so a " +
          'bind or a volume attached to one would never be read; declare ' +
          "those in the stack's own compose file.",
      ),
    hostPath: z.string(),
    volumeName: volumeNameSchema,
    // The same rule as create: `update` rewrites the file at the new path and
    // `remove` rm -rf's it, so a create-then-patch would otherwise walk out.
    filePath: filePathSchema,
    content: z.string(),
    // Deliberately *not* carrying create's conditional or its description
    // (H-70). There is no condition here to document: the `.partial()` below
    // makes every field "leave it as it is", and `min(1)` refuses `''`, so a
    // patch can only replace `mountPath` with another non-empty path — it can
    // never remove the one an application or database mount was created with,
    // and it never has to supply one for a compose mount that was created
    // without one. `serviceType` is not even in this schema, because a mount
    // cannot be re-pointed at another service, so the discriminant the
    // condition reads cannot change under a patch either. Copying create's
    // sentence onto this field would document a rule `PATCH /mounts/:id` does
    // not enforce, which is the same way of being wrong as listing `mountPath`
    // in create's `required` array.
    mountPath: z.string().min(1),
  })
  .partial();

export class UpdateMountDto extends createZodDto(updateMountSchema) {}

// The list route's input: one service's mounts, by id and type.
export const listMountsSchema = z.object({
  serviceId: z.string().min(1),
  serviceType: z.enum([
    'application',
    'postgres',
    'mysql',
    'mariadb',
    'mongo',
    'redis',
    'compose',
    'libsql',
  ]),
});

export class ListMountsDto extends createZodDto(listMountsSchema) {}
