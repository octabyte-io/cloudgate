import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
} from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import {
  applicationStatusEnum,
  triggerTypeEnum,
} from '../applications/application.schema';
import {
  configNameColumn,
  configNameConstraints,
  encryptedText,
  generateAppName,
  isoTimestamp,
  nanoidPk,
} from '../db/columns';
import { environment } from '../environments/environment.schema';
import { sourceTypeEnum } from '../git-providers/git-provider.schema';
import type { ComposeSourceType } from './dto/compose.dto';
import { bitbucket } from '../git-providers/strategies/bitbucket/bitbucket.schema';
import { gitea } from '../git-providers/strategies/gitea/gitea.schema';
import { github } from '../git-providers/strategies/github/github.schema';
import { gitlab } from '../git-providers/strategies/gitlab/gitlab.schema';
import { cloudAccount } from '../cloud-accounts/cloud-account.schema';
import type { StackVmSettings } from '../cloud-accounts/definitions/stack-vm';
import type { StackVmCloudDeleteRecord } from './stack-vm-delete-record';
import { server } from '../servers/server.schema';
import { sshKey } from '../ssh-keys/ssh-key.schema';
import type { ComposePublishedPort } from './compose-file';

// Phase 29 scope: no randomize/suffix columns (isolatedDeployment is what keeps
// stacks collision-free), and no mounts/backups/schedules/patch relations
// (their tables arrive in later phases). sourceType reuses the shared
// source_type enum, which is already the union of the application and compose
// source types; DTOs restrict compose to its six valid sources.

export const composeTypeEnum = pgEnum('compose_type', [
  'docker-compose',
  'stack',
]);

export type ComposeType = (typeof composeTypeEnum.enumValues)[number];

export const compose = pgTable(
  'compose',
  {
    composeId: nanoidPk('compose_id'),
    name: text('name').notNull(),
    /** Fixed key in a Project config; never follows a rename. */
    configName: configNameColumn(),
    appName: text('app_name')
      .notNull()
      .unique()
      .$defaultFn(() => generateAppName('compose')),
    description: text('description'),
    env: encryptedText('env'),
    /**
     * The docker-compose file a `raw` stack is deployed from, and the file every
     * other source's clone is overwritten with once its domains are injected.
     *
     * Encrypted at rest (ADR 0006) on ADR 0015's rule, which this column is the
     * fourth instance of and was written for: **a file body is where an operator
     * puts a credential**, and Cloudgate has no way to know which lines of one
     * are the secret, so the whole body is treated as one. It is the strongest of
     * the four on the merits rather than the weakest — it routinely carries
     * literal `environment:` values even though the `encryptedText` `env` sits
     * beside it on this very table for exactly those, and one file's blast radius
     * is every service in a stack.
     *
     * **An earlier review looked at this column, left it, and its recorded reason does not
     * survive contact with the code** — the sentence was that the file is
     * *edited in a code editor, diffed and templated*, and none of the three is a
     * reason. `encryptedText` converts at the driver boundary, so every reader
     * that goes through drizzle sees exactly what it saw before: the DTO's
     * `composeFileSchema` refinement, `ComposeService.update`'s
     * `data.composeFile ?? row.composeFile` merge, `readComposeFile`,
     * `findDeployable`, the label injector, `DomainsService.findComposeDefinition`'s
     * projection, `DeploymentEngineService.readComposeContent`, the template
     * writer and the AI writer — while the console's editor and its converted-file
     * diff work on JSON the API has already decrypted. **Verified rather than
     * assumed**: the nine reader sites needed no edit at all, in any of
     * the four modules, and neither did the relational-query readers
     * (`ComposeService.findOne`, `TraefikSetupService`) which already read the
     * `encryptedText` `env` and `refreshToken` through the same path.
     *
     * **Nothing queries it**, which is the gate rather than a detail: AES-256-GCM
     * under a random IV encrypts the same plaintext to different bytes every
     * time, so `where compose_file = $1` matches nothing and a column something
     * searches cannot be given this type at all (ADR 0006, as extended).
     * There is no index on it in the 0066 snapshot, no `where`, `like`, `orderBy`,
     * `groupBy` or `distinct` over it anywhere in `src/`, no `sql` template and
     * no `db.execute` touching `compose_file`, and no view or `.mapWith` that
     * would read it around the custom type.
     *
     * **No migration, and none is possible to need.** `encryptedText`
     * `dataType()`s to `'text'` — read off the custom type in `db/columns.ts`
     * rather than by running `drizzle-kit`, which prompts on a TTY — so this
     * makes no DDL diff and `meta/0066_snapshot.json`'s `compose_file` entry
     * stays byte-identical. The `notNull` `default('')` stays **plaintext in the
     * DDL and must**: a ciphertext baked into a migration is tied to whichever
     * `APP_ENCRYPTION_SECRET` generated it and is undecryptable everywhere else
     * (ADR 0006). It reads back as `''` through ADR 0006's pass-through, which is
     * the same mechanism that carries every row an install already holds until
     * its next write of this column. All three halves are pinned in
     * `compose.e2e-spec.ts`' *the compose file at rest*.
     */
    composeFile: encryptedText('compose_file').notNull().default(''),
    /**
     * The deploy-webhook secret, the same column as `application.refreshToken`
     * and encrypted for the same reason — see that column for the argument and
     * for why there is neither a backfill nor a migration.
     *
     * Named here rather than left to the reader: that review was filed against the
     * Application's copy alone and never mentions Compose, and the webhook this
     * one would authorize deploys *every* service in the file, so covering one
     * and not the other would have left the larger blast radius in cleartext.
     *
     * This copy is further from a consumer than the Application's: there is no
     * inbound route that checks it and no rotate route either, so it is minted,
     * carried on the row and never used. That is a reason to encrypt it and not
     * to clear it — an operator has no way to replace a value this column loses.
     */
    refreshToken: encryptedText('refresh_token').$defaultFn(() => nanoid()),
    // The shared enum, of which a stack takes only the API's values.
    sourceType: sourceTypeEnum('source_type')
      .$type<ComposeSourceType>()
      .notNull()
      .default('github'),
    composeType: composeTypeEnum('compose_type')
      .notNull()
      .default('docker-compose'),
    // GitHub
    repository: text('repository'),
    owner: text('owner'),
    branch: text('branch'),
    triggerType: triggerTypeEnum('trigger_type').default('push'),
    autoDeploy: boolean('auto_deploy').$defaultFn(() => true),
    // GitLab
    gitlabProjectId: integer('gitlab_project_id'),
    gitlabRepository: text('gitlab_repository'),
    gitlabOwner: text('gitlab_owner'),
    gitlabBranch: text('gitlab_branch'),
    gitlabPathNamespace: text('gitlab_path_namespace'),
    // Gitea
    giteaRepository: text('gitea_repository'),
    giteaOwner: text('gitea_owner'),
    giteaBranch: text('gitea_branch'),
    // Bitbucket
    bitbucketRepository: text('bitbucket_repository'),
    bitbucketRepositorySlug: text('bitbucket_repository_slug'),
    bitbucketOwner: text('bitbucket_owner'),
    bitbucketBranch: text('bitbucket_branch'),
    // Custom git
    customGitUrl: text('custom_git_url'),
    customGitBranch: text('custom_git_branch'),
    customGitSSHKeyId: text('custom_git_ssh_key_id').references(
      () => sshKey.sshKeyId,
      { onDelete: 'set null' },
    ),
    /** Replaces the generated deploy command entirely when set. */
    command: text('command').notNull().default(''),
    enableSubmodules: boolean('enable_submodules').notNull().default(false),
    composePath: text('compose_path').notNull().default('./docker-compose.yml'),
    /** Deploy onto an app-named attachable network instead of cloudgate's shared one. */
    isolatedDeployment: boolean('isolated_deployment').notNull().default(false),
    watchPaths: text('watch_paths').array(),
    composeStatus: applicationStatusEnum('compose_status')
      .notNull()
      .default('idle'),
    /**
     * The fixed TCP ports the file of this stack's **last successful deploy
     * from a repository** published — `listComposePublishedPorts` of the
     * bytes that deploy's `assertComposeContentClaimable` admitted, never a
     * second read of the Server. A repository's file is on the Server and
     * nowhere here, so without this a TCP Uptime check had no port to aim at.
     *
     * - **null** until such a deploy has succeeded: its ports are not known,
     *   and `publishedPortsOf` says to deploy it first;
     * - **written on every successful deploy**, and cleared by a successful
     *   `raw` one, whose ports are read from `compose_file` instead — so a
     *   stack switched back to a repository source never shows ports from a
     *   deploy that is no longer what runs;
     * - **left alone by a failed deploy**, which ran nothing new.
     *
     * Plaintext, unlike `compose_file`: port numbers and compose service names,
     * which `domain.service_name` and the published-ports picker already carry
     * in the clear, and nothing an operator puts a credential in.
     */
    deployedPublishedPorts: jsonb('deployed_published_ports').$type<
      ComposePublishedPort[]
    >(),
    /**
     * The volumes this stack's Delete removes (`listComposeVolumes`), from
     * the file of its **last successful deploy**, written beside
     * `deployedPublishedPorts` from the same admitted bytes. A plan's
     * destroy of a `compose` entry names them (ADR-0069) without the plan
     * reading a compose file. **null** until such a deploy has recorded
     * them; empty for a `stack`, whose Delete removes none.
     */
    deployedVolumes: jsonb('deployed_volumes').$type<string[]>(),
    createdAt: isoTimestamp('created_at'),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environment.environmentId, { onDelete: 'cascade' }),
    githubId: text('github_id').references(() => github.githubId, {
      onDelete: 'set null',
    }),
    gitlabId: text('gitlab_id').references(() => gitlab.gitlabId, {
      onDelete: 'set null',
    }),
    giteaId: text('gitea_id').references(() => gitea.giteaId, {
      onDelete: 'set null',
    }),
    bitbucketId: text('bitbucket_id').references(() => bitbucket.bitbucketId, {
      onDelete: 'set null',
    }),
    serverId: text('server_id').references(() => server.serverId, {
      onDelete: 'cascade',
    }),
    /**
     * A stack whose place is a Cloud account and region (ADR-0070): it
     * runs on its own Stack VM there, never on a Server, set together by
     * the Apply that creates it and never changed after (ADR-0035). `null`
     * on a Server or the platform host. A Cloud account is never deleted
     * from under it.
     */
    cloudAccountId: text('cloud_account_id').references(
      () => cloudAccount.cloudAccountId,
      { onDelete: 'no action' },
    ),
    region: text('region'),
    /**
     * Its Stack VM's settings (`StackVmSettings`): the machine type it
     * runs, its data disk, and — once its Apply made it — the image it was
     * made from and the Docker pins it installed, which only an approved
     * "replace VM" line moves. `null` on a Server.
     */
    stackVm: jsonb('stack_vm').$type<StackVmSettings>(),
    /**
     * A Stack VM stack's Delete under way or incomplete (ADR-0038, #1367);
     * see {@link StackVmCloudDeleteRecord}. `null` otherwise.
     */
    cloudDelete: jsonb('cloud_delete').$type<StackVmCloudDeleteRecord>(),
  },
  (t) => [
    ...configNameConstraints('compose', t),
    // A Server (or the platform host) or a Cloud account + region, as a
    // cloud database's: the two cloud columns set together, never beside a
    // Server.
    check(
      'compose_place',
      sql`(${t.cloudAccountId} IS NULL) = (${t.region} IS NULL) AND (${t.cloudAccountId} IS NULL OR ${t.serverId} IS NULL)`,
    ),
  ],
);

export const composeRelations = relations(compose, ({ one }) => ({
  environment: one(environment, {
    fields: [compose.environmentId],
    references: [environment.environmentId],
  }),
  customGitSSHKey: one(sshKey, {
    fields: [compose.customGitSSHKeyId],
    references: [sshKey.sshKeyId],
  }),
  github: one(github, {
    fields: [compose.githubId],
    references: [github.githubId],
  }),
  gitlab: one(gitlab, {
    fields: [compose.gitlabId],
    references: [gitlab.gitlabId],
  }),
  gitea: one(gitea, {
    fields: [compose.giteaId],
    references: [gitea.giteaId],
  }),
  bitbucket: one(bitbucket, {
    fields: [compose.bitbucketId],
    references: [bitbucket.bitbucketId],
  }),
  server: one(server, {
    fields: [compose.serverId],
    references: [server.serverId],
  }),
}));

export type Compose = typeof compose.$inferSelect;

/**
 * **The SSH key Cloudgate reaches a stack's Stack VM with**, inside its
 * cloud's tunnel (ADR-0070): one per stack, made with the stack's row by the
 * Apply that creates it, its public half installed by the Stack VM's first
 * boot. Its private half is encrypted at rest (ADR-0006, ADR-0015) and
 * decrypted only to open that SSH connection.
 *
 * A table of its own rather than a column on `compose`, because the stack's
 * row is read whole and answered whole (`ComposeService.findOne`, Project
 * trees): a key beside it would be one forgotten projection from the wire.
 * Nothing reads this table but the Stack VM's connector. It goes with its
 * stack.
 */
export const stackVmKey = pgTable('stack_vm_key', {
  composeId: text('compose_id')
    .primaryKey()
    .references(() => compose.composeId, { onDelete: 'cascade' }),
  privateKey: encryptedText('private_key').notNull(),
});
