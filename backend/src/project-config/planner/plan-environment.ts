import {
  fargateSize,
  formatPair,
} from '../../cloud-accounts/aws/definitions/fargate-size';
import {
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_TIMEZONE,
  formatTimeout,
} from '../../cron-services/cron-fields';
import { posix } from 'node:path';

import {
  DEFAULT_COMPOSE_FILE,
  DEFAULT_COMPOSE_TYPE,
} from '../format/config-schema';
import { SIZES } from '../format/config-size';
import { cloudRdsChange, cloudRdsCreate, savedSize } from './cloud-postgres';
import {
  cloudStaticSite,
  ignoredOnCloud,
  isIgnoredOnS3,
  staticChangeOf,
  staticCreateNotes,
} from './cloud-static';
import { cloudRedisChange, cloudRedisCreate } from './cloud-redis';
import { cloudRunSizeOf } from './cloud-run';
import type { RunningSize } from './cloud-run';
import { cloudSqlChange, cloudSqlCreate, cloudSqlWanted } from './cloud-sql';
import { isCloudCreate } from './cloud-steps';
import {
  consoleStackVmCreate,
  consoleStackVmSize,
  stackVmChange,
  stackVmCreate,
  stackVmDestroy,
  stackVmGapRefusal,
  stackVmNativeOf,
  templateStackVmCreate,
} from './stack-vm';
import type { StackVmAsked } from './stack-vm';
import { privateHostRefusal } from '../../cloud-accounts/aws/definitions/private-dns';
import {
  nativeDockerDiffs,
  nativeDockerRefusals,
  takesNativeDocker,
} from '../../native/docker-native';
import { nativeAwsCheck } from '../../native/aws-native';
import type { NativeAwsBlock } from '../../native/aws-native';
import {
  fargateWording,
  nativeFargateOf,
  nativeFargateRefusal,
} from '../../native/aws-size';
import { nativeAwsFacts } from './native-aws-facts';
import { nativeGcpCheck } from '../../native/gcp-native';
import { nativeGcpFacts } from './native-gcp-facts';
import {
  comparesNativeAws,
  laidAwsBlock,
  laysNativeAwsOn,
  nativeAwsLines,
  stepNativeAws,
  withNativeAws,
} from './native-aws-lines';
import {
  comparesNativeGcp,
  laidGcpBlock,
  laysNativeGcpOn,
  nativeGcpLines,
  runAppNotes,
  withNativeGcp,
} from './native-gcp-lines';
import { cloudRunResourceOf } from '../../cloud-accounts/gcp/definitions/cloud-run-definition';
import { article } from '../messages.utils';
import {
  LISTED_NAMES,
  ONLY_WHEN_STATED,
  statedFields,
  VARIABLE_KEYS,
  VARIABLE_LISTS,
} from './fields';
import type { DescribedEntry } from './fields';
import {
  bucketChecksumNotes,
  linkChanges,
  linkCreates,
  linkRefusals,
  roleAccessNotes,
} from './plan-links';
import {
  memorystoreChange,
  memorystoreCreate,
  memorystoreWanted,
  memorystoreMinorNote,
} from './memorystore';
import { orderedSteps } from './plan-order';
import { holdBackSetups } from './setup-hold-back';
import { setupValuesUnused } from './setup-values-unused';
import type { CloudKind } from '../../cloud-accounts/cloud-account.schema';
import {
  byCloud,
  cloudOrLegacy,
  LEGACY_CLOUD,
} from '../../cloud-accounts/cloud-provider';
import type { PerCloud } from '../../cloud-accounts/cloud-provider';
import { missingLinks } from '../../cloud-accounts/definitions/network-links';
import type { NetworkLinkKind } from '../../cloud-accounts/definitions/network-links';
import { composeSourceTypeSchema } from '../../compose/dto/compose.dto';
import type { ComposeSourceType } from '../../compose/dto/compose.dto';
import type { SourceType } from '../../git-providers/git-provider.schema';
import type { Size } from '../format/config-size';
import type {
  ComposeSource,
  CronEntry,
  MysqlEntry,
  PostgresEntry,
  RedisEntry,
  Source,
  StaticEntry,
  WebEntry,
  WebLikeEntry,
  WorkerEntry,
} from '../project-config.types';
import type {
  BucketCorsChange,
  CloudWebCreate,
  ConfigKind,
  DeployTarget,
  FieldDiff,
  PlanInput,
  PlanNote,
  PlanOutcome,
  PlanRefusal,
  PlanStep,
  SavedApplicationSettings,
  SavedComposeSettings,
  SavedService,
  SavedStackVm,
  SavedVariableKeys,
  StackVmCreate,
  TemplateCreate,
} from './plan.types';
import { templateHostTaken } from './template-host-taken';

/** An entry the config describes, as opposed to one it lists as console-managed. */
type Described = DescribedEntry;

/**
 * The planner: what applying a Project config to one Environment
 * would create, change and destroy there, with notes, or why it cannot be
 * planned at all. A pure function — no database, no Docker, no clock — so
 * every rule below is stated once and tested without I/O.
 *
 * - **Matching is by Config name only.** A display name never matches, and a
 *   rename in the config is a destroy plus a create, as is a kind change
 *   (US26).
 * - **Saved settings, never containers** (US20): `saved` is what Cloudgate
 *   has stored for the fields the config owns. A crashed container is
 *   not a difference.
 * - **A field the config leaves out compares with what a console create
 *   leaves it at** (`port` 3000, `build.dockerfile` `Dockerfile`, no
 *   `command`), so the config describes the whole Service. Three exceptions,
 *   which have no such default: a missing `size` leaves the caps Cloudgate's
 * and a postgres's or mysql's missing `database` or `user` leaves
 *   the one it has.
 * - **`native.docker` is checked on every plan and compared on a Server**
 *   (ADR-0044): its refusals stop the plan whatever the Deploy
 *   target, and on a Service Swarm runs its seven Swarm settings are native
 *   lines of the ordinary `change` step, laid over the kind's defaults on
 *   both sides, so a stored value no file shows plans back to its default.
 * - **Variables are names.** A listed name with no value here is a note; a
 *   key this Environment holds that the config does not list is a change,
 *   whose Apply removes it. A wired variable (ADR-0031) is a link,
 *   never a held key, so a typed value for a name the config now links is
 *   removed too; a link the plan cannot honour refuses it (`plan-links.ts`).
 * - **Links order the Apply** (`plan-order.ts`): a source's step runs
 *   before what links to it, a changed Output redeploys what links to it,
 *   and a destroyed source goes after whatever stops linking to it.
 * - **Console-managed Services are never touched.** *Adding* a line for one
 *   that does not exist, or under the wrong kind, refuses the plan (a line
 *   `context.previous` already had is not checked again); not listing one, or
 *   dropping its line, is a note with the line to paste (US33, US34).
 * - **A Cloud account takes only the kinds {@link kindsOn} its cloud**
 * a `mysql` too, an RDS for
 *   MySQL instance on AWS or a Cloud SQL for MySQL one on Google
 *   Cloud, made by a `postgres`'s rules. A `bucket` it creates
 *   is an S3 bucket whose AWS lines are read like a `web`'s, and whose origins
 *   edited on its page plan as a CORS change. A `redis` it creates is a
 *   one-node ElastiCache for Valkey replication group whose node type and
 *   version are checked here (`cloud-redis.ts`); a change to one already there
 *   that moves it (node type, version, the console's replica and snapshot
 *   retention) reads its state like a postgres on RDS's, a major
 *   upgrade is marked for Apply's confirmation and a downgrade refuses. A
 *   `static` it creates is a private S3 bucket behind CloudFront
 *   (`cloud-static.ts`), where `size`, `command`, `args`, `env`,
 *   `build_args` and `build_secrets` are ignored, never refused, with one
 *   note naming those it sets, and only `spa` reaches AWS.
 *   With a cloud Deploy target, an entry of any other kind refuses the plan,
 *   naming it — never put on a Server instead. A `postgres` it creates is an
 *   RDS instance whose class, version and login are checked here
 *   (`cloud-postgres.ts`); a change to one already on RDS that moves its
 *   instance (class, version, the console's settings) reads its state like
 *   a create, a major upgrade is marked for Apply's confirmation and
 *   a downgrade or a new user or database refuses. A `web` the plan creates there is a step whose
 *   AWS lines are still `reading`: this function makes no call, so
 *   AWS is read after the plan is stored. Its size lands on a Fargate pair,
 *   and one above Fargate's largest refuses. Where the Environment has no
 *   **Environment network** in that Cloud account and region, the plan makes one first, as its own step. A
 *   Service that already exists keeps the place it was created in
 *   (ADR-0035), so a `web` on a Server is still changed there, and one in a
 *   Cloud account refuses a linked Registry; console-managed lines are
 *   untouched.
 * - **What AWS is read for Drift**. A cloud Service a step changes
 *   reads AWS with the config it will have. `cloudReads` adds a change of
 *   no field for each other cloud Service it names (every one on "Check
 *   for changes"), and on "Check for changes" a step for each made
 *   Environment network; their reads say whether AWS differs.
 * - **Only what the config described is destroyed.** A Service the config
 *   does not list is a destroy only when `context.previous` described it;
 *   any other — demoted, never listed, or with no previous at all — is a
 *   note, so editing the file can never delete what it did not describe.
 */
export function planEnvironment(given: PlanInput): PlanOutcome {
  // A Template's parts, held back where it was not set up (#1377).
  const held = holdBackSetups(given);
  const { input } = held;
  const { config, saved, context } = input;
  const refusals: PlanRefusal[] = [...held.refusals];
  const creates: PlanStep[] = [];
  const changes: PlanStep[] = [];
  const destroys: PlanStep[] = [];
  const notes: PlanNote[] = [...held.notes];
  const savedByName = new Map(saved.map((found) => [found.configName, found]));
  const heldLinks = new Set(held.refusals.map((refusal) => refusal.at));
  refusals.push(
    ...linkRefusals(input).filter((refusal) => !heldLinks.has(refusal.at)),
  );
  notes.push(...roleAccessNotes(input));
  notes.push(...bucketChecksumNotes(input));

  for (const [name, entry] of Object.entries(config.services)) {
    const found = savedByName.get(name);

    if (entry.managed === 'console') {
      // A line the config already had is not an edit to check: it touches
      // nothing, and a generated config lists a Service that exists
      // in only some Environments, or under different kinds, this way.
      // Not on a cloud Deploy target that refuses describing it until that
      // cloud's spec lands: the note would point at a refusal. AWS
      // makes one on RDS, Google Cloud on Cloud SQL.
      if (
        entry.kind === 'mysql' &&
        (input.deployTarget.kind !== 'cloud' ||
          kindsOn(cloudOrLegacy(input.cloud)).has('mysql'))
      ) {
        notes.push(mysqlCanBeDescribed(name));
      }
      // A stack whose compose file is in a repository can be handed
      // over too; one whose file Cloudgate keeps cannot (ADR-0069).
      if (
        entry.kind === 'compose' &&
        found?.serviceType === 'compose' &&
        composeFromRepository(found.settings)
      ) {
        notes.push(composeCanBeDescribed(name));
      }
      // A stack the console created in a Cloud Environment runs on its
      // own Stack VM, which only a plan makes (#1372, ADR-0070): its row
      // is the console's, and the plan makes only the VM, sized by its
      // console setting. No plan creates the stack itself (ADR-0065).
      if (
        entry.kind === 'compose' &&
        found?.serviceType === 'compose' &&
        found.stackVm &&
        !found.stackVm.made
      ) {
        const made = consoleStackVmStep(
          name,
          { serviceId: found.serviceId, stackVm: found.stackVm },
          input.deployTarget,
          input.cloudAccount,
        );
        if (made.ok) creates.push(made.step);
        else refusals.push(...made.refusals);
        continue;
      }
      // Once made, its Stack VM moves by its console setting, the data
      // disk grown on its page and Cloudgate's pins (#1368), though the
      // config describes nothing.
      if (
        entry.kind === 'compose' &&
        found?.serviceType === 'compose' &&
        found.stackVm
      ) {
        const { stackVm } = found;
        const native = byCloud(stackVm.cloud, {
          aws: stackVm.native,
          gcp: stackVm.nativeGcp,
        });
        const stepped = stackVmStep(
          name,
          found,
          {
            // A size its native block set stays the block's.
            ...(native ? { native } : {}),
            ...(stackVm.sizeName !== null || stackVm.consoleSize
              ? { size: consoleStackVmSize(stackVm).size }
              : {}),
            ...(stackVm.consoleDataDiskGb
              ? { dataDiskGb: stackVm.consoleDataDiskGb }
              : {}),
          },
          [],
          input,
          false,
        );
        if (!stepped.ok) {
          refusals.push(...stepped.refusals);
          continue;
        }
        if (stepped.step) changes.push(stepped.step);
      }
      // A Template's compose part, which no Service holds yet: the one
      // console-managed Service a plan creates, from the Pending setup
      // holding it under this Config name and kind (ADR-0065). Before the
      // line-already-listed skip, which an Environment the config listed
      // it for already would otherwise take.
      if (!found && entry.kind === 'compose') {
        const stack = templateStackStep(name, input);
        if (stack) {
          if (stack.ok) creates.push(stack.step);
          else refusals.push(...stack.refusals);
          continue;
        }
      }
      const kept = context.previous?.services[name];
      if (kept?.managed === 'console' && kept.kind === entry.kind) continue;
      if (!found) {
        refusals.push({
          at: name,
          message: `${name} is listed with managed: console, but this Environment has no Service with that Config name; a console-managed Service is created in the console`,
        });
      } else if (kindOf(found) !== entry.kind) {
        refusals.push({
          at: `${name}.kind`,
          message: `${name}.kind: the Service is ${article(kindOf(found))}, not ${article(entry.kind)}; a console-managed entry keeps its kind`,
        });
      }
      continue;
    }

    // A stack's container settings are its compose file's, so no
    // `native.docker` describes them (ADR-0069). Its cloud block may set
    // its Stack VM's machine type, checked below as any other (ADR-0070).
    if (entry.kind === 'compose' && entry.native?.docker !== undefined) {
      refusals.push(composeNative(name));
      continue;
    }

    // Every native block is checked on every plan, whatever the Deploy
    // target (ADR-0044 rule 5): a mistake in `native.docker` shows on a
    // cloud Environment's plan too, not first on a Server's, and
    // one in `native.aws` or `native.gcp` on a Server's, not first on its
    // cloud's. Only on its own cloud, and only on a kind
    // whose definition lays it, is a `native.aws` or a `native.gcp`
    // planned as lines: elsewhere it is checked only.
    const awsChecked = nativeAwsCheck(
      name,
      entry.kind,
      entry.native?.aws,
      nativeAwsFacts(name, entry, found, input),
    );
    const gcpChecked = nativeGcpCheck(
      name,
      entry.kind,
      entry.native?.gcp,
      nativeGcpFacts(name, entry, found, input),
    );
    const nativeRefused = [
      ...nativeDockerRefusals(name, entry.kind, entry.native?.docker),
      ...awsChecked.refusals,
      ...gcpChecked.refusals,
    ];
    if (nativeRefused.length > 0) {
      refusals.push(...nativeRefused);
      continue;
    }
    notes.push(
      ...[...awsChecked.warnings, ...gcpChecked.warnings].map(
        (warning): PlanNote => ({
          kind: 'native-deprecated',
          configName: name,
          at: warning.at,
          message: warning.message,
        }),
      ),
    );
    // The config reader already read an old address as its new name
    // the plan says so, naming both.
    notes.push(
      ...(entry.nativeRenamed ?? []).map((renamed): PlanNote => ({
        kind: 'native-renamed',
        configName: name,
        ...renamed,
        message: `${renamed.at}: renamed - Cloudgate now calls it ${renamed.to}, and this plan reads it so; write ${JSON.stringify(renamed.to)} in the file when you choose`,
      })),
    );

    // A stack already on a Server keeps its place (ADR-0035), so only
    // its create is refused in a Cloud account (`createStep`).
    if (
      input.deployTarget.kind === 'cloud' &&
      entry.kind !== 'compose' &&
      !kindsOn(cloudOrLegacy(input.cloud)).has(entry.kind)
    ) {
      refusals.push(notOnCloud(name, entry.kind, cloudOrLegacy(input.cloud)));
      continue;
    }

    // The existing database a switch goes to, once the Cloudgate-made one
    // it replaces is gone: its create waited for that Delete. A
    // postgres's, a mysql's or a redis's, by the kind the switch
    // was asked on.
    const pending = input.existingCreates?.find(
      (one) => one.configName === name && one.kind === entry.kind,
    );
    if (
      !found &&
      pending &&
      (entry.kind === 'postgres' ||
        entry.kind === 'mysql' ||
        entry.kind === 'redis')
    ) {
      const created = existingCreate(name, entry, input, pending.identifier);
      if (!created.ok) {
        refusals.push(...created.refusals);
        continue;
      }
      creates.push(created.step);
      notes.push(...created.notes);
      continue;
    }

    if (!found) {
      const hostRefusal = templateHostRefusal(name, entry, input);
      if (hostRefusal) {
        refusals.push(hostRefusal);
        continue;
      }
      const created = createStep(name, entry, input);
      if (!created.ok) {
        refusals.push(...created.refusals);
        continue;
      }
      // A Template's part takes its values from its Pending setup, so its
      // create says how each is made and notes only what it leaves empty.
      const template = templateCreate(name, entry, input.pendingSetups);
      creates.push(
        template && created.step.action === 'create'
          ? { ...created.step, template }
          : created.step,
      );
      notes.push(...created.notes);
      // A static site on S3 reads no variables: its note says so.
      if (!onS3(input, entry)) {
        notes.push(
          ...variablesWithoutValue(name, entry, null).filter(
            (note) =>
              !(
                note.kind === 'variable-without-value' &&
                template?.values.some(
                  (value) =>
                    value.list === note.list &&
                    value.variable === note.variable,
                )
              ),
          ),
        );
      }
      // A worker takes no Domain, so it is not pointed at one.
      if (
        created.step.action === 'create' &&
        created.step.cloud &&
        entry.kind === 'web'
      ) {
        notes.push(cloudNoDomain(name));
      }
      notes.push(...createdRunAppNotes(name, entry, input));
      continue;
    }

    refusals.push(...linkedRegistries(name, found));

    const savedKind = configKindOf(found);
    if (savedKind === null || !('settings' in found)) {
      refusals.push({
        at: `${name}.kind`,
        message: `${name} is ${article(kindOf(found))} Service, which version 1 does not describe; list it as kind: ${kindOf(found)} with managed: console`,
      });
      continue;
    }

    // A stack whose compose file Cloudgate keeps (raw text, every
    // template's) has no source a config can name, so it stays
    // console-managed (ADR-0069).
    if (
      found.serviceType === 'compose' &&
      entry.kind === 'compose' &&
      !composeFromRepository(found.settings)
    ) {
      refusals.push(composeNotInRepository(name, found.settings.sourceType));
      continue;
    }

    // Name is identity, and so is how a stack is deployed: a `type`
    // change is a destroy plus a create, as a kind change is (ADR-0069).
    const retyped =
      found.serviceType === 'compose' &&
      entry.kind === 'compose' &&
      (entry.composeType ?? DEFAULT_COMPOSE_TYPE) !==
        found.settings.composeType;

    if (savedKind !== entry.kind || retyped) {
      const created = createStep(name, entry, input);
      if (!created.ok) {
        refusals.push(...created.refusals);
        continue;
      }
      destroys.push(destroyStep(found, savedKind));
      creates.push(created.step);
      notes.push(...created.notes);
      notes.push(...createdRunAppNotes(name, entry, input));
      if (!onS3(input, entry)) {
        notes.push(...variablesWithoutValue(name, entry, null));
      }
      continue;
    }

    const unrun = healthCheckNotRun(name, entry, found, input);
    if (unrun) notes.push(unrun);

    // A switch between a Cloudgate-made and an existing database,
    // a postgres's, a mysql's or a redis's: one Service
    // removed and the other added, like a kind change.
    const switched =
      (found.serviceType === 'postgres' && entry.kind === 'postgres') ||
      (found.serviceType === 'mysql' && entry.kind === 'mysql') ||
      (found.serviceType === 'redis' && entry.kind === 'redis')
        ? switchSteps(name, entry, found, input)
        : null;
    if (switched && !switched.ok) {
      refusals.push(...switched.refusals);
      continue;
    }
    if (switched) {
      destroys.push(destroyStep(found, savedKind));
      creates.push(switched.step);
      notes.push(...switched.notes);
      continue;
    }

    // A bucket on AWS takes no Domain, so its endpoint never follows
    // one; nor does an existing bucket.
    if (
      found.serviceType === 'bucket' &&
      !found.cloud &&
      !found.existing &&
      found.settings.hasDomain === false
    ) {
      notes.push(bucketNoDomain(name));
    }

    // A static site on S3: what only a container has is ignored,
    // with one note, and its `spa` is read into the definition.
    const site =
      found.cloud && entry.kind === 'static' ? cloudStaticSite(entry) : null;
    if (site && entry.kind === 'static') {
      const ignored = ignoredOnCloud(
        cloudOrLegacy(found.cloud?.cloud),
        name,
        entry,
      );
      if (ignored) notes.push(ignored);
    }

    // An Existing database is used as given (ADR-0033): what the config
    // says of the database itself is never applied to it, so never a change.
    const existing =
      found.serviceType === 'postgres' ||
      found.serviceType === 'mysql' ||
      found.serviceType === 'redis'
        ? found.existing
        : undefined;
    // Its `native.aws`, on a Service on ECS, a bucket on S3 or a
    // static site on S3 and CloudFront, or a database on RDS or
    // ElastiCache: against the block its last Apply laid.
    const awsLines = comparesNativeAws(found, entry.kind)
      ? nativeAwsLines(
          name,
          entry,
          found.nativeAws,
          nativeAwsFacts(name, entry, found, input),
          found.serviceType === 'bucket' ? found.cors?.origins : undefined,
          found,
        )
      : [];
    // A bucket's or a static site's read lays the entry's block once it
    // plans a line of it; otherwise the one its last Apply laid.
    const readsNative =
      awsLines.length > 0 &&
      (entry.kind === 'bucket' || entry.kind === 'static')
        ? stepNativeAws(entry)
        : null;
    const fields = [
      ...diffFields(entryView(entry), savedView(found), statedFields(entry)),
      ...variableChanges(entry, found.variables),
      ...linkChanges(entry, found.links, found.variables.env),
      // Its Swarm settings, on a Service Swarm runs, a bucket's
      // Garage too.
      ...(comparesNativeDocker(found, entry.kind)
        ? nativeDockerDiffs(entry.kind, entry.native?.docker, found.docker)
        : []),
      ...awsLines,
      // Its `native.gcp`, on a Service on Cloud Run: against the
      // block its last Apply laid.
      ...(comparesNativeGcp(found, entry.kind)
        ? nativeGcpLines(name, entry, found.nativeGcp, found)
        : []),
    ].filter(
      (diff) =>
        (!site || !isIgnoredOnS3(diff)) &&
        (!existing || !NOT_APPLIED_TO_EXISTING.has(diff.field)),
    );
    // A stack on its own Stack VM (ADR-0070): its size, its data disk
    // and Cloudgate's pins move the Stack VM, read from its cloud (#1368).
    if (
      found.serviceType === 'compose' &&
      entry.kind === 'compose' &&
      found.stackVm
    ) {
      const stepped = stackVmStep(
        name,
        found,
        {
          ...(entry.size ? { size: entry.size } : {}),
          ...(() => {
            const native = stackVmNativeOf(entry, found.stackVm.cloud);
            return native ? { native } : {};
          })(),
          ...(found.stackVm.consoleDataDiskGb
            ? { dataDiskGb: found.stackVm.consoleDataDiskGb }
            : {}),
        },
        fields,
        input,
      );
      if (!stepped.ok) {
        refusals.push(...stepped.refusals);
        continue;
      }
      if (stepped.step) changes.push(stepped.step);
      continue;
    }
    // Closing its `run.app` address, and with no Domain a warning.
    if (comparesNativeGcp(found, entry.kind)) {
      notes.push(
        ...runAppNotes(name, entry, found.nativeGcp, found.hasDomain ?? false),
      );
    }
    // Whether a made static site's change reads its cloud, and what it
    // notes: on Google Cloud a `spa` change is the network's run.
    const siteChange = site
      ? staticChangeOf(cloudOrLegacy(found.cloud?.cloud), name, fields)
      : null;
    if (siteChange) notes.push(...siteChange.notes);
    // An existing bucket: used as given too; its entry has only a
    // description, which is Cloudgate's and so still a change.
    const existingBucket =
      found.serviceType === 'bucket' ? found.existing : undefined;
    if (existingBucket && entry.kind === 'bucket') {
      changes.push({
        action: 'change',
        configName: name,
        kind: savedKind,
        serviceType: found.serviceType,
        serviceId: found.serviceId,
        name: found.name,
        fields,
        existing: { identifier: existingBucket.bucketName, version: null },
        cloudRead: { status: 'reading' },
      });
      continue;
    }
    if (
      existing &&
      (entry.kind === 'postgres' ||
        entry.kind === 'mysql' ||
        entry.kind === 'redis')
    ) {
      notes.push(existingNotApplied(name, entry.kind, existing.identifier));
      notes.push(...variablesWithoutValue(name, entry, found.variables));
      // Looked up at every plan, so it has a step even when the
      // config changes nothing; a lookup that finds it as given is quiet.
      changes.push({
        action: 'change',
        configName: name,
        kind: savedKind,
        serviceType: found.serviceType,
        serviceId: found.serviceId,
        name: found.name,
        fields,
        existing: {
          identifier: existing.identifier,
          version: entry.dockerImage ?? null,
        },
        cloudRead: { status: 'reading' },
      });
      continue;
    }
    // A cloud database's change is checked against its own cloud's rules
    // (ADR-0043): RDS's (a postgres's or a mysql's) or
    // ElastiCache's on AWS, Cloud SQL's or Memorystore's on Google Cloud,
    // never another's.
    const checked: DatabaseChanges = found.cloud
      ? byCloud<() => DatabaseChanges>(cloudOrLegacy(found.cloud.cloud), {
          aws: () => ({
            onRds:
              (found.serviceType === 'postgres' && entry.kind === 'postgres') ||
              (found.serviceType === 'mysql' && entry.kind === 'mysql')
                ? cloudRdsChange(name, entry, found, fields)
                : null,
            onElastiCache:
              found.serviceType === 'redis' && entry.kind === 'redis'
                ? cloudRedisChange(name, entry, found, fields)
                : null,
          }),
          gcp: () => ({
            onCloudSql:
              (found.serviceType === 'postgres' && entry.kind === 'postgres') ||
              (found.serviceType === 'mysql' && entry.kind === 'mysql')
                ? cloudSqlChange(
                    name,
                    entry,
                    found,
                    fields,
                    cloudSqlWanted(entry),
                  )
                : null,
            onMemorystore:
              found.serviceType === 'redis' && entry.kind === 'redis'
                ? memorystoreChange(name, entry, found, fields)
                : null,
          }),
        })()
      : {};
    // A native line moves a Cloud SQL or Memorystore instance too, and the
    // move carries the block its read lays.
    const onCloudSql = checked.onCloudSql
      ? {
          ...checked.onCloudSql,
          cloudSql: withNativeGcp(
            checked.onCloudSql.cloudSql,
            { tier: null, version: null, lines: [] },
            entry,
            found,
            fields,
          ),
        }
      : null;
    const onMemorystore = checked.onMemorystore
      ? {
          ...checked.onMemorystore,
          memorystore: withNativeGcp(
            checked.onMemorystore.memorystore,
            {
              nodeType: null,
              version: null,
              highAvailability: null,
              lines: [],
            },
            entry,
            found,
            fields,
          ),
        }
      : null;
    // A native line moves an RDS instance or a replication group too, and
    // the move carries the block its read lays.
    const onRds = checked.onRds
      ? {
          ...checked.onRds,
          database: withNativeAws(
            checked.onRds.database,
            { instanceClass: null, version: null, settings: [] },
            entry,
            found,
            fields,
          ),
        }
      : null;
    const onElastiCache = checked.onElastiCache
      ? {
          ...checked.onElastiCache,
          cache: withNativeAws(
            checked.onElastiCache.cache,
            { nodeType: null, version: null, settings: [] },
            entry,
            found,
            fields,
          ),
        }
      : null;
    const databaseChange =
      onRds ?? onElastiCache ?? onCloudSql ?? onMemorystore;
    if (databaseChange) {
      if (databaseChange.refusals.length > 0) {
        refusals.push(...databaseChange.refusals);
        continue;
      }
      notes.push(...databaseChange.notes);
    }
    const majorUpgrade =
      onRds?.majorUpgrade ??
      onElastiCache?.majorUpgrade ??
      onCloudSql?.majorUpgrade ??
      onMemorystore?.majorUpgrade;
    // A bucket on AWS whose origins were edited on its page.
    const cors = found.serviceType === 'bucket' ? corsChange(found) : null;
    if (
      fields.length > 0 ||
      onRds?.database ||
      onElastiCache?.cache ||
      onCloudSql?.cloudSql ||
      onMemorystore?.memorystore ||
      cors
    ) {
      const change: PlanStep = {
        action: 'change',
        configName: name,
        kind: savedKind,
        serviceType: found.serviceType,
        serviceId: found.serviceId,
        name: found.name,
        fields,
        // An instance this change moves is read from its state.
        ...(onRds?.database
          ? {
              database: onRds.database,
              cloudRead: { status: 'reading' as const },
            }
          : {}),
        // A replication group this change moves likewise.
        ...(onElastiCache?.cache
          ? {
              cache: onElastiCache.cache,
              cloudRead: { status: 'reading' as const },
            }
          : {}),
        // A Cloud SQL instance this change moves likewise.
        ...(onCloudSql?.cloudSql
          ? {
              cloudSql: onCloudSql.cloudSql,
              cloudRead: { status: 'reading' as const },
            }
          : {}),
        // A Memorystore instance this change moves likewise.
        ...(onMemorystore?.memorystore
          ? {
              memorystore: onMemorystore.memorystore,
              cloudRead: { status: 'reading' as const },
            }
          : {}),
        ...(majorUpgrade ? { majorUpgrade } : {}),
        // Its CORS is written by a Cloud run, read from its state first.
        ...(cors ? { cors, cloudRead: { status: 'reading' as const } } : {}),
        // Its `native.aws` likewise, laid by its read as by its run.
        ...(readsNative
          ? {
              ...readsNative,
              ...(entry.kind === 'bucket'
                ? { cloudRead: { status: 'reading' as const } }
                : {}),
            }
          : {}),
        // A static site on S3 reads AWS with the `spa` it will have;
        // one on Google Cloud reads nothing.
        ...(site
          ? {
              site,
              ...(siteChange?.reads
                ? { cloudRead: { status: 'reading' as const } }
                : {}),
            }
          : {}),
      };
      // A cloud web's change reads AWS with the config it will have,
      // as does a Worker's on ECS, and a Cron service's
      // unless all it changes is its timetable, which is Cloudgate's alone:
      // a setting with no AWS line, applied with no AWS call.
      const cloud =
        found.cloud &&
        (entry.kind === 'web' ||
          entry.kind === 'worker' ||
          entry.kind === 'web-private' ||
          (entry.kind === 'cron' &&
            !fields.every((diff) => TIMETABLE_FIELDS.has(diff.field)))) &&
        found.serviceType === 'application'
          ? cloudWebCreate(name, entry, input.cloud, {
              changed: fields.some((diff) => diff.field === 'size'),
              cpuLimit: found.settings.cpuLimit,
              memoryLimit: found.settings.memoryLimit,
            })
          : null;
      if (cloud === null) changes.push(change);
      else if (!cloud.ok) refusals.push(...cloud.refusals);
      else {
        changes.push({
          ...change,
          cloud: cloud.cloud,
          cloudRead: { status: 'reading' },
        });
      }
    }
    if (!site) {
      notes.push(...variablesWithoutValue(name, entry, found.variables));
    }
  }

  for (const found of saved) {
    if (Object.hasOwn(config.services, found.configName)) continue;
    const kind = kindOf(found);
    const line = consoleManagedLine(found.configName, kind);
    const previous = context.previous?.services[found.configName];
    const configKind = configKindOf(found);

    if (previous?.managed === 'console') {
      notes.push({
        kind: 'console-managed-dropped',
        configName: found.configName,
        line,
        message: `${found.configName} was dropped from the config; a console-managed Service is never deleted by a plan, so it stays. Paste the line back to keep the config complete`,
      });
    } else if (configKind !== null && previous !== undefined) {
      // Only a Service the config in effect described is the config's to
      // delete; one it never described is the console's (US34).
      destroys.push(destroyStep(found, configKind));
    } else {
      notes.push({
        kind: 'console-managed-unlisted',
        configName: found.configName,
        line,
        message: `${found.configName} is ${article(kind)} Service the config does not list; paste the line to keep the config complete`,
      });
    }
  }

  if (refusals.length > 0) return { ok: false, refusals };
  const firstMemorystore = creates.find(
    (step) => step.action === 'create' && step.memorystore,
  );
  if (firstMemorystore?.action === 'create') {
    notes.push(memorystoreMinorNote(firstMemorystore.configName));
  }
  notes.push(...filesNotCopied(creates, destroys));
  notes.push(...dataNotCopied(creates, destroys));
  // A repository-kept file's renamed part takes nothing (#1378).
  notes.push(...setupValuesUnused(input, creates));
  const network = networkSteps(input, creates, changes);
  const removals = networkRemovals(input);
  const natOff = natRemovals(input, [...network, ...creates], removals);
  return {
    ok: true,
    steps: [
      ...network,
      ...natOff,
      ...networkReads(input, [...network, ...natOff]),
      ...orderedSteps(input, {
        creates: creates.filter(isAction('create')),
        changes: changes.filter(isAction('change')),
        destroys: destroys.filter(isAction('destroy')),
      }),
      ...driftReads(input, [...changes, ...destroys]),
      ...removals,
    ],
    notes,
  };
}

/**
 * A Cron service's timetable (ADR-0034): Cloudgate's own settings,
 * read by its timetable on every tick. Nothing of them is in a cloud
 * so changing them reads, plans and changes nothing there.
 */
const TIMETABLE_FIELDS: ReadonlySet<string> = new Set([
  'schedule',
  'timezone',
  'timeout',
]);

function isAction<A extends PlanStep['action']>(action: A) {
  return (step: PlanStep): step is Extract<PlanStep, { action: A }> =>
    step.action === action;
}

/** What an Apply's confirmation names for a network's removal. */
export function networkConfirmName(region: string): string {
  return `network-${region}`;
}

/**
 * Each Environment network nothing uses any more: the
 * Deploy target is elsewhere, and no Service of the Environment — of any
 * kind or source, described or not — runs in its Cloud account and region.
 * A Service this plan destroys still counts until it is gone, so its
 * network is removed by the plan after: a network is never destroyed under
 * a Service's security group.
 */
function networkRemovals(input: PlanInput): PlanStep[] {
  const target = input.deployTarget;
  return (input.removableNetworks ?? []).flatMap((network) => {
    const here = (place: { cloudAccountId: string; region: string }) =>
      place.cloudAccountId === network.cloudAccountId &&
      place.region === network.region;
    if (target.kind === 'cloud' && here(target)) return [];
    // A bucket on S3 or a static site on CloudFront is not in
    // the network, so it holds none.
    if (
      input.saved.some(
        (found) =>
          (found.cloud &&
            found.serviceType !== 'bucket' &&
            configKindOf(found) !== 'static' &&
            here(found.cloud)) ||
          // A Stack VM sits in the network's private subnet.
          (found.serviceType === 'compose' &&
            found.stackVm &&
            here(found.stackVm)),
      )
    ) {
      return [];
    }
    return [
      {
        action: 'network-remove' as const,
        environmentNetworkId: network.environmentNetworkId,
        cloudAccountId: network.cloudAccountId,
        region: network.region,
        confirmName: networkConfirmName(network.region),
        dnsRecordsLeft: network.dnsRecordsLeft,
      },
    ];
  });
}

/**
 * The cloud Services no step touches that this plan still reads for Drift
 * (the AWS spec "When AWS is read"): every one on "Check for changes",
 * else those an open plan it replaces found drift on, so found drift stays
 * in view. Each is a change of no field, whose AWS lines say whether AWS
 * differs; a Service the plan destroys is not read, nor one on a Server.
 */
function driftReads(
  input: PlanInput,
  touched: readonly PlanStep[],
): PlanStep[] {
  const reads = input.cloudReads;
  if (!reads) return [];
  const stepped = new Set(
    touched.flatMap((step) =>
      step.action === 'change' || step.action === 'destroy'
        ? [step.serviceId]
        : [],
    ),
  );
  return input.saved.flatMap((found): PlanStep[] => {
    // A `web`, or a bucket on S3; a postgres on RDS is read only
    // when a change moves its instance.
    if (
      !found.cloud ||
      (found.serviceType !== 'application' && found.serviceType !== 'bucket')
    ) {
      return [];
    }
    if (stepped.has(found.serviceId)) return [];
    if (!reads.everything && !reads.services.includes(found.serviceId)) {
      return [];
    }
    return [
      {
        action: 'change',
        configName: found.configName,
        kind: configKindOf(found) ?? 'web',
        serviceType: found.serviceType,
        serviceId: found.serviceId,
        name: found.name,
        fields: [],
        cloudRead: { status: 'reading' },
      },
    ];
  });
}

/**
 * A stack's change on its Stack VM (#1368): its config fields, and what
 * moves its Stack VM (`stackVmChange`), read from its cloud. A Stack VM
 * nothing moves is still read when "Check for changes" asks for it; one
 * whose stack's fields alone change is the stack's ordinary change.
 */
function stackVmStep(
  name: string,
  found: Extract<SavedService, { serviceType: 'compose' }>,
  asked: StackVmAsked,
  fields: readonly FieldDiff[],
  input: PlanInput,
  /** Whether its size is a config field: not on a console-managed stack. */
  describesSize = true,
):
  | { readonly ok: true; readonly step: PlanStep | null }
  | { readonly ok: false; readonly refusals: PlanRefusal[] } {
  const base = {
    action: 'change' as const,
    configName: name,
    kind: 'compose' as const,
    serviceType: 'compose' as const,
    serviceId: found.serviceId,
    name: found.name,
  };
  // One not made yet has nothing to move: the plan that makes it does.
  if (!found.stackVm?.made) {
    return {
      ok: true,
      step: fields.length > 0 ? { ...base, fields } : null,
    };
  }
  const reads = input.cloudReads;
  const drift =
    !!found.stackVm.pins &&
    !!reads &&
    (reads.everything || reads.services.includes(found.serviceId));
  const moved = stackVmChange(
    name,
    { cloud: found.stackVm.cloud, region: found.stackVm.region },
    found.stackVm,
    asked,
    drift,
  );
  if (!moved.ok) return moved;
  const all = [...fields, ...(describesSize ? moved.fields : [])];
  if (!moved.change) {
    return { ok: true, step: all.length > 0 ? { ...base, fields: all } : null };
  }
  return {
    ok: true,
    step: {
      ...base,
      fields: all,
      stackVm: moved.change,
      cloudRead: { status: 'reading' },
    },
  };
}

/**
 * Each made Environment network, read for Drift by "Check for changes"
 * but one a network step of this plan already reads.
 */
function networkReads(
  input: PlanInput,
  stepped: readonly PlanStep[],
): PlanStep[] {
  if (!input.cloudReads?.everything) return [];
  return (input.networks ?? []).flatMap((network): PlanStep[] =>
    network.environmentNetworkId &&
    !stepped.some(
      (step) =>
        step.action === 'network-change' &&
        step.environmentNetworkId === network.environmentNetworkId,
    )
      ? [
          {
            action: 'network-change',
            environmentNetworkId: network.environmentNetworkId,
            cloudAccountId: network.cloudAccountId,
            region: network.region,
            cloudRead: { status: 'reading' },
          },
        ]
      : [],
  );
}

/**
 * A MySQL listed as console-managed: version 1 lists every MySQL that
 * way, and no upgrade rewrites a config, so every plan for an Environment on
 * a Server says it can now be handed over by removing `managed: console`.
 */
function mysqlCanBeDescribed(configName: string): PlanNote {
  return {
    kind: 'mysql-can-be-described',
    configName,
    message: `${configName}: mysql can now be described; remove managed: console to hand it to the config`,
  };
}

/**
 * A Compose stack listed as console-managed whose compose file is in a
 * repository (ADR-0069): every stack was listed that way, and no upgrade
 * rewrites a config, so every plan says it can now be handed over.
 */
function composeCanBeDescribed(configName: string): PlanNote {
  return {
    kind: 'compose-can-be-described',
    configName,
    message: `${configName}: its compose file is in a repository, so it can now be described as kind: compose; remove managed: console and name its source, file and type to hand it to the config`,
  };
}

/**
 * A `native.docker` block on a `compose` entry, refused whole (ADR-0069);
 * a cloud block sets its Stack VM (ADR-0070).
 */
function composeNative(configName: string): PlanRefusal {
  return {
    at: `${configName}.native.docker`,
    message: `${configName}.native.docker: refused - a Compose stack's container settings are its compose file's, so kind compose takes no native.docker block; set them in the compose file`,
  };
}

/**
 * A `type: stack` create in a Cloud account: a Stack VM runs
 * `docker compose`, never Swarm (ADR-0070 "Only `docker-compose`").
 */
function swarmNotInCloud(configName: string): PlanRefusal {
  return {
    at: `${configName}.type`,
    message: `${configName}.type: stack (Swarm) cannot run in a Cloud account; a Stack VM runs docker-compose only. Remove type, or set it to docker-compose`,
  };
}

/**
 * The create of a console-made stack's Stack VM (#1372): in its own place,
 * fixed when the console created it (ADR-0035), so a Deploy target that has
 * moved since refuses rather than make it elsewhere.
 */
function consoleStackVmStep(
  name: string,
  found: { readonly serviceId: string; readonly stackVm: SavedStackVm },
  target: DeployTarget,
  account: PlanInput['cloudAccount'],
):
  | { readonly ok: true; readonly step: PlanStep }
  | { readonly ok: false; readonly refusals: PlanRefusal[] } {
  const { stackVm } = found;
  if (
    target.kind !== 'cloud' ||
    target.cloudAccountId !== stackVm.cloudAccountId ||
    target.region !== stackVm.region
  ) {
    return {
      ok: false,
      refusals: [
        {
          at: name,
          message: `${name}: its Stack VM is still to be made in ${stackVm.region}, the place the console created the stack in, but this Environment's Deploy target has moved; point it back there to make it, or delete the stack`,
        },
      ],
    };
  }
  // A Cloud account whose role predates Stack VMs (#1366).
  const gap = stackVmGapRefusal(name, stackVm, account);
  if (gap) return { ok: false, refusals: [gap] };
  const made = consoleStackVmCreate(name, found);
  if (!made.ok) return made;
  return {
    ok: true,
    step: {
      action: 'create',
      configName: name,
      kind: 'compose',
      placement: target,
      // Nothing of the config's: the stack is the console's.
      fields: [],
      stackVm: made.stackVm,
      cloudRead: { status: 'reading' },
    },
  };
}

/**
 * A `compose` entry for a stack whose compose file is not in a
 * repository: no config field could name its source without becoming a
 * second copy of it, so it stays console-managed (ADR-0069).
 */
function composeNotInRepository(
  configName: string,
  sourceType: ComposeSourceType,
): PlanRefusal {
  const kept =
    sourceType === 'raw'
      ? 'its compose file is kept in Cloudgate, as every template stack’s is'
      : `its source is ${sourceType}`;
  return {
    at: `${configName}.source`,
    message: `${configName}: ${kept}, not in a repository, so the config cannot describe it; list it as kind: compose with managed: console, or move its compose file into a repository and choose that source in the console first`,
  };
}

/**
 * The sources a `compose` entry can name: a repository, which is every
 * source a stack takes but `raw`. A stack has no uploaded-archive source, so
 * `raw` is the only one kept in Cloudgate.
 */
const COMPOSE_REPOSITORY_SOURCES: ReadonlySet<ComposeSourceType> = new Set(
  composeSourceTypeSchema.exclude(['raw']).options,
);

/** Whether a stack's compose file is in a repository a config can name. */
export function composeFromRepository(
  settings: Pick<SavedComposeSettings, 'sourceType'>,
): boolean {
  return COMPOSE_REPOSITORY_SOURCES.has(settings.sourceType);
}

/**
 * A compose file's path as the config writes it: from the repository's
 * root, with no leading `./`, which a stored `composePath` has.
 */
export function composeFileValue(composePath: string): string {
  return posix.normalize(composePath).replace(/^(\.\/)+/, '');
}

/**
 * A bucket a destroy plus a create replaces: renamed in the config,
 * or changed to or from another kind. Nothing moves its files to what
 * replaces it, so the plan says so on each one it destroys, and on a kind
 * change into a bucket, which starts empty.
 */
function filesNotCopied(
  creates: readonly PlanStep[],
  destroys: readonly PlanStep[],
): PlanNote[] {
  const notes: PlanNote[] = [];
  for (const destroy of destroys) {
    if (destroy.action !== 'destroy') continue;
    const replacement = creates.find(
      (create) =>
        create.action === 'create' && create.configName === destroy.configName,
    );
    const createsBucket =
      replacement?.action === 'create' && replacement.kind === 'bucket';
    if (destroy.kind !== 'bucket' && !createsBucket) continue;
    notes.push({
      kind: 'files-not-copied',
      configName: destroy.configName,
      message:
        destroy.kind === 'bucket' && destroy.existing
          ? // An existing bucket is left as it was, never destroyed.
            `${destroy.configName}: the existing bucket ${destroy.existing.identifier} is left as it was, and its files are not copied; a bucket renamed or given another kind is a new, empty one`
          : destroy.kind === 'bucket'
            ? `${destroy.configName}: the bucket is destroyed and its files are not copied; a bucket renamed or given another kind is a new, empty one`
            : `${destroy.configName}: the ${destroy.kind} is replaced by a new, empty bucket; nothing is copied into it`,
    });
  }
  return notes;
}

/** The kinds whose Service holds data a destroy plus a create would not carry over. */
const DATA_KINDS: ReadonlySet<ConfigKind> = new Set([
  'postgres',
  'mysql',
  'redis',
]);

/**
 * A database replaced by a destroy plus a create (the AWS databases spec "Plan
 * lines"): a kind change (one Config name, destroyed and created again) or
 * a rename (a database destroyed and one of the same kind created under
 * another name in the same plan, paired in order). The new one starts empty
 * and nothing of the old one's data is copied into it, whatever the old
 * one's Delete keeps.
 */
function dataNotCopied(
  creates: readonly PlanStep[],
  destroys: readonly PlanStep[],
): PlanNote[] {
  const notes: PlanNote[] = [];
  const created = creates.filter(isAction('create'));
  const destroyed = destroys
    .filter(isAction('destroy'))
    .filter((one) => DATA_KINDS.has(one.kind));
  const paired = new Set<string>();
  const say = (from: string, to: string): PlanNote => ({
    kind: 'data-not-copied',
    configName: to,
    message: `${to}: the new ${to} starts empty; ${from}'s data is not copied`,
  });
  // A kind change first: its create has the destroy's own Config name.
  for (const destroy of destroyed) {
    const replacement = created.find(
      (one) => one.configName === destroy.configName,
    );
    if (!replacement) continue;
    paired.add(destroy.configName);
    // Into a bucket, `files-not-copied` already says it starts empty.
    if (replacement.kind === 'bucket') continue;
    // A switch to or from an existing database (ADR-0033).
    const switchLine = switchNotCopied(destroy, replacement);
    if (switchLine) {
      notes.push({
        kind: 'data-not-copied',
        configName: destroy.configName,
        message: switchLine,
      });
      continue;
    }
    notes.push(say(destroy.configName, replacement.configName));
  }
  // Then a rename: a create of the same kind no destroy names.
  const renamed = new Set(destroyed.map((one) => one.configName));
  const unclaimed = created.filter((one) => !renamed.has(one.configName));
  for (const destroy of destroyed) {
    if (paired.has(destroy.configName)) continue;
    const index = unclaimed.findIndex((one) => one.kind === destroy.kind);
    if (index < 0) continue;
    const [replacement] = unclaimed.splice(index, 1);
    notes.push(say(destroy.configName, replacement.configName));
  }
  return notes;
}

/**
 * A bucket on a Server whose last Domain was removed (ADR-0037): its
 * `endpoint` falls back to the internal URL, which no browser reaches, so
 * every plan that keeps it says so until it has a Domain again.
 */
function bucketNoDomain(configName: string): PlanNote {
  return {
    kind: 'bucket-no-domain',
    configName,
    message: `${configName}: the bucket has no Domain, so its endpoint is the internal URL and presigned URLs and browser uploads stop working; add a Domain on its page`,
  };
}

/** The fields of a `postgres` entry an Existing database never takes (ADR-0033). */
const NOT_APPLIED_TO_EXISTING: ReadonlySet<string> = new Set([
  'database',
  'user',
  'size',
  'version',
]);

/**
 * An entry an Existing database stands for (ADR-0033): it is used as
 * given, so the config's `database`, `user`, `size` and `version` are not
 * applied to it, and every plan says so. A redis has only a `size` and a
 * `version` to say it of.
 */
function existingNotApplied(
  configName: string,
  kind: 'postgres' | 'mysql' | 'redis',
  identifier: string,
): PlanNote {
  return {
    kind: 'existing-not-applied',
    configName,
    message:
      kind === 'redis'
        ? `${configName} uses the existing cache ${identifier}: the config's size and version are not applied to it`
        : `${configName} uses the existing database ${identifier}: the config's database, user, size and version are not applied to it`,
  };
}

/**
 * A `web` created on Cloud Run whose `native.gcp` closes its `run.app`
 * address: the line, and the warning, since a create has no Domain.
 */
function createdRunAppNotes(
  name: string,
  entry: Described,
  input: PlanInput,
): PlanNote[] {
  return input.deployTarget.kind === 'cloud' &&
    laysNativeGcpOn(input.cloud, entry.kind)
    ? runAppNotes(name, entry, undefined, false)
    : [];
}

/**
 * A `web` created in a Cloud account gets no generated Domain (the AWS spec,
 * "Domains"): there is no sslip.io name on AWS, so the plan says how
 * it will be reached instead.
 */
function cloudNoDomain(configName: string): PlanNote {
  return {
    kind: 'cloud-no-domain',
    configName,
    message: `${configName}: no Domain yet, add one in the console once its first deploy is done`,
  };
}

/**
 * What each cloud does with an always-running Service's image `HEALTHCHECK`
 * (ADR-0043): on AWS the task runs it, so nothing is said; on
 * Google Cloud a Cloud Run probe is HTTP, TCP or gRPC only and cannot run a
 * command, so it is not run, no probe is written from it, and the plan says
 * so (the Google Cloud kinds spec) of each Cloud Run resource with a
 * container that runs until stopped: a service or a worker pool, never a
 * job, whose run is judged only by how it ends (ADR-0034).
 */
const HEALTHCHECK_NOT_RUN: PerCloud<
  ((configName: string, kind: ConfigKind) => PlanNote | null) | null
> = {
  aws: null,
  gcp: (configName, kind) =>
    cloudRunResourceOf(kind) === 'job'
      ? null
      : {
          kind: 'healthcheck-not-run',
          configName,
          message: `${configName}: its image's HEALTHCHECK is not run on Google Cloud, whose health checks are HTTP, TCP or gRPC only and cannot run a command`,
        },
};

/**
 * The one note a Service already in a Cloud account gets when its live
 * image has a `HEALTHCHECK` its cloud cannot run, or `null`. Keyed
 * on what its cloud runs it as (`HEALTHCHECK_NOT_RUN`), never on a kind
 * name, so a Worker or a Private web service gets it by the same rule as
 * each joins a cloud, and a Cron service's job never does.
 */
function healthCheckNotRun(
  configName: string,
  entry: Described,
  found: SavedService,
  input: PlanInput,
): PlanNote | null {
  if (!found.cloud) return null;
  if (!input.imageHealthChecks?.includes(found.serviceId)) return null;
  return (
    byCloud(cloudOrLegacy(found.cloud.cloud), HEALTHCHECK_NOT_RUN)?.(
      configName,
      entry.kind,
    ) ?? null
  );
}

/**
 * The private links each cloud's Environment network holds, one per kind a
 * plan creates there (ADR-0043): on AWS the private DNS
 * namespace, for the first `web-private`, the NAT gateway for the first
 * Stack VM, and none for a database,
 * which sits in the network's own subnets; on Google Cloud the private
 * `run.app` zone, for the first `web-private`, one for Cloud
 * SQL and one for Memorystore, and Cloud NAT for the first Stack VM.
 */
const PRIVATE_LINKS: PerCloud<
  readonly {
    readonly kind: NetworkLinkKind;
    readonly made: (step: PlanStep) => boolean;
  }[]
> = {
  // The private DNS namespace a Private web service is listed in.
  aws: [
    {
      kind: 'private-dns',
      made: (step) =>
        step.action === 'create' && !!step.cloud && step.kind === 'web-private',
    },
    // A Stack VM's way out: no public address, so a NAT gateway
    // (`nat-gateway.ts`), made with the first and kept by the network.
    {
      kind: 'nat-gateway',
      made: (step) => step.action === 'create' && !!step.stackVm,
    },
  ],
  gcp: [
    // The private `run.app` zone a Private web service is reached through
    // (ADR-0045).
    {
      kind: 'run-app-zone',
      made: (step) =>
        step.action === 'create' && !!step.cloud && step.kind === 'web-private',
    },
    {
      kind: 'cloud-sql',
      // An Existing database on Cloud SQL, a postgres's or a
      // mysql's, takes its endpoint's address from the link's
      // subnet, so it needs the link too.
      made: (step) =>
        (step.action === 'create' && !!step.cloudSql) ||
        (step.action === 'change' &&
          (step.serviceType === 'postgres' || step.serviceType === 'mysql') &&
          !!step.existing),
    },
    {
      kind: 'memorystore',
      // An existing Valkey takes its two endpoints' addresses from
      // the link's subnet, and its clients Redis's ports, which the link
      // opens.
      made: (step) =>
        (step.action === 'create' && !!step.memorystore) ||
        (step.action === 'change' &&
          step.serviceType === 'redis' &&
          !!step.existing),
    },
    // A Stack VM's way out: no external IP, so Cloud NAT on a Cloud
    // Router (`cloud-nat.ts`), made with the first and kept by the network.
    {
      kind: 'cloud-nat',
      made: (step) => step.action === 'create' && !!step.stackVm,
    },
  ],
};

/**
 * The Environment network a cloud `web` this plan creates needs, when the
 * Environment has none in that Cloud account and region: made first,
 * in its own step, by the first plan that creates a cloud Service there.
 *
 * On Google Cloud a database needs the network's private link too (the Google Cloud databases
 * spec), per kind: the first plan that creates a Cloud SQL instance,
 * or a Memorystore one, makes the network with that kind's link, or,
 * when the network is made already, adds it with a `network-change` of its
 * own, applied first as a network's create is. A network that has it is not
 * touched again, nor a web-only one. On AWS the first `web-private` does
 * the same with the private DNS namespace, and on Google Cloud
 * with the private `run.app` zone. An Existing database on
 * Cloud SQL is no create, but its endpoint's address is on the
 * link's subnet, so its lookup asks for Cloud SQL's link alike.
 */
function networkSteps(
  input: PlanInput,
  creates: readonly PlanStep[],
  changes: readonly PlanStep[],
): PlanStep[] {
  const target = input.deployTarget;
  if (target.kind !== 'cloud') return [];
  const wanted: NetworkLinkKind[] = byCloud(
    cloudOrLegacy(input.cloud),
    PRIVATE_LINKS,
  )
    .filter(({ made }) => [...creates, ...changes].some(made))
    .map(({ kind }) => kind);
  // A change needs a network only for the link a kind of it holds there:
  // an Existing database on Cloud SQL's endpoint.
  if (!creates.some(isCloudCreate) && wanted.length === 0) return [];
  const network = (input.networks ?? []).find(
    (one) =>
      one.cloudAccountId === target.cloudAccountId &&
      one.region === target.region,
  );
  if (!network) {
    return [
      {
        action: 'network-create',
        cloudAccountId: target.cloudAccountId,
        region: target.region,
        ...(wanted.length > 0 ? { privateLinks: wanted } : {}),
        cloudRead: { status: 'reading' },
      },
    ];
  }
  const adds = missingLinks(network.privateLinks ?? [], wanted);
  // One being made by another Apply gets its link from the next plan.
  if (adds.length === 0 || !network.environmentNetworkId) return [];
  return [
    {
      action: 'network-change',
      environmentNetworkId: network.environmentNetworkId,
      cloudAccountId: network.cloudAccountId,
      region: network.region,
      privateLinks: adds,
      cloudRead: { status: 'reading' },
    },
  ];
}

/** A Stack VM's way out on each cloud: AWS's NAT gateway, Google's Cloud NAT. */
const NAT_LINKS: readonly NetworkLinkKind[] = ['nat-gateway', 'cloud-nat'];

/**
 * The NAT the first Stack VM added to an Environment network, taken off
 * again once the Environment has no Stack VM there (the owner's decision
 * amending ADR-0070, #1367), so the network goes back to its idle cost.
 *
 * As with a network's own removal, a Stack VM this plan destroys still
 * holds it until it is gone — its Delete may keep it a while, or end
 * incomplete — so the plan after takes the NAT off. A plan that makes a
 * Stack VM there keeps it, and a network this plan removes goes whole.
 */
function natRemovals(
  input: PlanInput,
  making: readonly PlanStep[],
  removals: readonly PlanStep[],
): PlanStep[] {
  const target = input.deployTarget;
  return (input.networks ?? []).flatMap((network): PlanStep[] => {
    const { environmentNetworkId } = network;
    if (!environmentNetworkId) return [];
    const nat = NAT_LINKS.filter((kind) =>
      (network.privateLinks ?? []).includes(kind),
    );
    if (nat.length === 0) return [];
    const here = (place: { cloudAccountId: string; region: string }) =>
      place.cloudAccountId === network.cloudAccountId &&
      place.region === network.region;
    const held = input.saved.some(
      (found) =>
        found.serviceType === 'compose' && found.stackVm && here(found.stackVm),
    );
    const made =
      target.kind === 'cloud' &&
      here(target) &&
      making.some(
        (step) =>
          (step.action === 'create' && !!step.stackVm) ||
          ((step.action === 'network-create' ||
            step.action === 'network-change') &&
            (step.privateLinks ?? []).some((kind) => NAT_LINKS.includes(kind))),
      );
    const removed = removals.some(
      (step) =>
        step.action === 'network-remove' &&
        step.environmentNetworkId === environmentNetworkId,
    );
    if (held || made || removed) return [];
    return [
      {
        action: 'network-change',
        environmentNetworkId,
        cloudAccountId: network.cloudAccountId,
        region: network.region,
        removedLinks: nat,
        cloudRead: { status: 'reading' },
      },
    ];
  });
}

/**
 * A Registry linked to a cloud Service the config describes (the AWS spec
 * "Image and ECR"): its image always goes to its own ECR repository,
 * so each link refuses the plan, naming the Registry.
 */
function linkedRegistries(name: string, found: SavedService): PlanRefusal[] {
  return (found.cloud?.linkedRegistries ?? []).map((linked) => ({
    at: name,
    message: `${name} runs in a Cloud account, where its image always goes to the Service's own ECR repository, so the ${linked.as} ${linked.name} linked to it is refused. Unlink it in the console`,
  }));
}

/**
 * The kinds a Cloud account makes, by its cloud (the Google Cloud spec S17). On AWS: a
 * `web`, as an RDS instance a `postgres`, as an ElastiCache
 * for Valkey replication group a `redis`, as an S3 bucket a `bucket`
 * on S3 + CloudFront a `static` site, on ECS with no
 * routing a `worker`, on ECS with private DNS a `web-private`
 * as a task definition Cloudgate's timetable runs one-off tasks
 * of a `cron`, and as an RDS for MySQL instance a `mysql`.
 * On Google Cloud a
 * `web` on Cloud Run (the Google Cloud spec), a `postgres` on Cloud SQL, a
 * `redis` on Memorystore for Valkey, as a Cloud Storage bucket
 * with its own HMAC key a `bucket`, and as a private Cloud Storage
 * bucket behind a Cloud CDN backend bucket a `static` site, as
 * a Cloud Run worker pool a `worker`, as an internal-only
 * Cloud Run service a `web-private`, as a Cloud Run job
 * Cloudgate's timetable runs executions of a `cron`, and, last of
 * the four, as a Cloud SQL for MySQL instance a `mysql`. A
 * cloud with no set makes nothing yet, so every kind is refused there.
 * On both a `compose` too, on its own Stack VM (ADR-0070): an EC2
 * instance on AWS, a Compute Engine one on Google Cloud.
 */
const CLOUD_KINDS: { readonly [cloud in CloudKind]?: ReadonlySet<ConfigKind> } =
  {
    aws: new Set([
      'web',
      'postgres',
      'redis',
      'bucket',
      'static',
      'worker',
      'web-private',
      'cron',
      'mysql',
      'compose',
    ]),
    gcp: new Set([
      'web',
      'postgres',
      'redis',
      'bucket',
      'static',
      'worker',
      'web-private',
      'cron',
      'mysql',
      'compose',
    ]),
  };

/** The kinds a Cloud account on `cloud` makes (the Google Cloud spec S17). */
export function kindsOn(cloud: CloudKind): ReadonlySet<ConfigKind> {
  return CLOUD_KINDS[cloud] ?? new Set();
}

/** A `static` entry this plan creates on S3 + CloudFront. */
function onS3(input: PlanInput, entry: Described): boolean {
  return input.deployTarget.kind === 'cloud' && entry.kind === 'static';
}

/**
 * A bucket on AWS's CORS change: the origins its page holds now
 * against those its last Cloud run wrote, in any order; `null` when they are
 * the same, or on a bucket not on AWS.
 */
function corsChange(
  found: Extract<SavedService, { serviceType: 'bucket' }>,
): BucketCorsChange | null {
  if (!found.cloud || !found.cors) return null;
  const from = found.cors.applied ?? [];
  const to = found.cors.origins;
  const same =
    from.length === to.length && from.every((origin) => to.includes(origin));
  return same ? null : { from: [...from], to: [...to] };
}

/**
 * A described entry of a kind a Cloud account cannot make yet:
 * every kind but those {@link kindsOn} its cloud, the Server kinds spec's four among
 * them. The one refusal for all of them, so a cloud spec that makes a kind
 * stops refusing it here. On Google Cloud it names Google Cloud (the Google Cloud spec,
 * copied from the AWS refusal); on AWS it reads as it did before Google could be one.
 */
function notOnCloud(
  name: string,
  kind: ConfigKind,
  cloud: CloudKind,
): PlanRefusal {
  const where = byCloud(cloud, {
    aws: "in this Environment's Cloud account",
    gcp: 'on Google Cloud',
  });
  return {
    at: `${name}.kind`,
    message: `${name}: kind ${kind} is not available ${where} yet; it is never put on a Server instead. Choose a Server or the platform host as the Deploy target, or list it with managed: console`,
  };
}

/** The line that lists a Service as console-managed, to paste under `services:`. */
export function consoleManagedLine(configName: string, kind: string): string {
  return `${configName}:\n  kind: ${kind}\n  managed: console`;
}

/**
 * A saved Service as the planner compares it, for the generator, which
 * writes the config this view would compare equal to: its config kind, the
 * fields compared for that kind, its own value of each (named as the config
 * writes them) and what a console create leaves each at. `null` for a kind
 * version 1 cannot describe.
 */
export function comparedView(found: SavedService): {
  readonly kind: ConfigKind;
  readonly fields: readonly string[];
  readonly view: View;
  readonly defaults: View;
} | null {
  const kind = configKindOf(found);
  if (kind === null) return null;
  return {
    kind,
    fields: FIELDS[kind],
    view: savedView(found),
    defaults: CREATE_DEFAULTS[kind],
  };
}

/**
 * Whether a saved Service's Swarm settings are compared with its entry's
 * `native.docker`: on a Service Swarm runs, a Server bucket's Garage
 * included, so neither in a Cloud account nor an Existing database
 * or bucket, whose `native.docker` is checked and never used. Only the keys
 * the kind takes are compared ({@link nativeDockerDiffs}). The generator
 * asks the same, so it writes the block only from the Environments
 * whose plans compare it.
 */
export function comparesNativeDocker(
  found: SavedService,
  kind: string,
): boolean {
  if (found.cloud) return false;
  if (
    (found.serviceType === 'postgres' ||
      found.serviceType === 'mysql' ||
      found.serviceType === 'redis' ||
      found.serviceType === 'bucket') &&
    found.existing
  ) {
    return false;
  }
  return takesNativeDocker(kind);
}

/** The kind a saved Service has in config terms, or `null` if unexpressible. */
export function configKindOf(found: SavedService): ConfigKind | null {
  switch (found.serviceType) {
    case 'application': {
      // The recorded kind. With `cron`, every kind an
      // Application records has a version 1 entry.
      return found.settings.configKind;
    }
    case 'postgres':
    case 'mysql':
    case 'redis':
      return found.serviceType;
    case 'bucket':
      return 'bucket';
    case 'compose':
      return 'compose';
    default:
      return null;
  }
}

/**
 * The kind a config line names this Service by, expressible or not: an
 * Application's recorded kind, any other Service's type.
 */
export function kindOf(found: SavedService): string {
  if (found.serviceType === 'application') return found.settings.configKind;
  return configKindOf(found) ?? found.serviceType;
}

/** What a step's create answers: the step and its notes, or its refusals. */
type CreateAnswer =
  | {
      readonly ok: true;
      readonly step: PlanStep;
      readonly notes: readonly PlanNote[];
    }
  | { readonly ok: false; readonly refusals: PlanRefusal[] };

/** A cloud's managed postgres, mysql and redis creates. */
interface DatabaseCreates {
  readonly postgres: (entry: PostgresEntry) => CreateAnswer;
  readonly mysql: (entry: MysqlEntry) => CreateAnswer;
  readonly redis: (entry: RedisEntry) => CreateAnswer;
}

/** A cloud database's change, checked by its own cloud's rules (one is set). */
interface DatabaseChanges {
  readonly onRds?: ReturnType<typeof cloudRdsChange> | null;
  readonly onElastiCache?: ReturnType<typeof cloudRedisChange> | null;
  readonly onCloudSql?: ReturnType<typeof cloudSqlChange> | null;
  readonly onMemorystore?: ReturnType<typeof memorystoreChange> | null;
}

function createStep(
  name: string,
  entry: Described,
  input: PlanInput,
):
  | {
      readonly ok: true;
      readonly step: PlanStep;
      readonly notes: readonly PlanNote[];
    }
  | { readonly ok: false; readonly refusals: PlanRefusal[] } {
  // A Compose stack in a Cloud account runs on its own Stack VM
  // (ADR-0070), docker-compose only, and never on a fallback Server
  // (ADR-0035): every cloud makes one, so none is refused for its cloud.
  if (entry.kind === 'compose' && input.deployTarget.kind === 'cloud') {
    const cloud = cloudOrLegacy(input.cloud);
    if ((entry.composeType ?? DEFAULT_COMPOSE_TYPE) === 'stack') {
      return { ok: false, refusals: [swarmNotInCloud(name)] };
    }
    // A Cloud account whose role predates Stack VMs (#1366).
    const gap = stackVmGapRefusal(
      name,
      { cloud, cloudAccountId: input.deployTarget.cloudAccountId },
      input.cloudAccount,
    );
    if (gap) return { ok: false, refusals: [gap] };
    const made = stackVmCreate(
      name,
      entry,
      { cloud, region: input.deployTarget.region },
      input.stackVmStartingSizes?.[name],
    );
    if (!made.ok) return made;
    return {
      ok: true,
      notes: [],
      step: {
        action: 'create',
        configName: name,
        kind: entry.kind,
        placement: input.deployTarget,
        fields: diffFields(
          entryView(entry),
          CREATE_DEFAULTS[entry.kind],
          statedFields(entry),
        ).map((diff) => ({ ...diff, from: null })),
        stackVm: made.stackVm,
        cloudRead: { status: 'reading' },
      },
    };
  }
  const step = {
    action: 'create' as const,
    configName: name,
    kind: entry.kind,
    placement: input.deployTarget,
    fields: [
      ...diffFields(
        entryView(entry),
        CREATE_DEFAULTS[entry.kind],
        statedFields(entry),
      ).map((diff) => ({ ...diff, from: null })),
      ...linkCreates(entry),
      // Its Swarm settings beyond the kind's defaults, on a Server.
      ...(input.deployTarget.kind !== 'cloud' && takesNativeDocker(entry.kind)
        ? nativeDockerDiffs(entry.kind, entry.native?.docker, undefined).map(
            (diff) => ({ ...diff, from: null }),
          )
        : []),
      // Its `native.aws`, on ECS: each value it lays over
      // Cloudgate's.
      ...(input.deployTarget.kind === 'cloud' &&
      laysNativeAwsOn(input.cloud, entry.kind)
        ? nativeAwsLines(
            name,
            entry,
            undefined,
            nativeAwsFacts(name, entry, undefined, input),
          ).map((diff) => ({ ...diff, from: null }))
        : []),
      // Its `native.gcp`, on Cloud Run: each value it lays over
      // Cloudgate's.
      ...(input.deployTarget.kind === 'cloud' &&
      laysNativeGcpOn(input.cloud, entry.kind)
        ? nativeGcpLines(name, entry, undefined).map((diff) => ({
            ...diff,
            from: null,
          }))
        : []),
    ],
  };
  // Only a kind its cloud makes reaches here on a cloud target (`notOnCloud`).
  if (input.deployTarget.kind !== 'cloud') return { ok: true, step, notes: [] };
  // A cloud's managed postgres and redis (ADR-0043): RDS and ElastiCache on
  // AWS; Cloud SQL and Memorystore on
  // Google Cloud, each read and made as on AWS. A mysql on RDS or
  // on Cloud SQL is a postgres's create with MySQL's parameters.
  if (
    entry.kind === 'postgres' ||
    entry.kind === 'mysql' ||
    entry.kind === 'redis'
  ) {
    const reading = { status: 'reading' } as const;
    // Its `native.aws` on RDS or ElastiCache, which its read lays.
    // A class or node type it sets wins over its size.
    const laid = laysNativeAwsOn(input.cloud, entry.kind)
      ? laidAwsBlock(entry)
      : undefined;
    const native = laid ? { native: laid } : {};
    // And its `native.gcp` on Cloud SQL or Memorystore.
    const nativeGcp =
      laysNativeGcpOn(input.cloud, entry.kind) && laidGcpBlock(entry)
        ? { native: laidGcpBlock(entry) }
        : {};
    const onRds = (database: PostgresEntry | MysqlEntry): CreateAnswer => {
      const created = cloudRdsCreate(name, database, laid);
      if (!created.ok) return created;
      return {
        ok: true,
        notes: created.notes,
        step: {
          ...step,
          database: { ...created.database, ...native },
          cloudRead: reading,
        },
      };
    };
    // A postgres's or a mysql's on Cloud SQL, by one rule.
    const onCloudSql = (database: PostgresEntry | MysqlEntry): CreateAnswer => {
      const created = cloudSqlCreate(name, database, cloudSqlWanted(database));
      if (!created.ok) return created;
      return {
        ok: true,
        notes: created.notes,
        step: {
          ...step,
          cloudSql: { ...created.cloudSql, ...nativeGcp },
          cloudRead: reading,
        },
      };
    };
    const made = byCloud<DatabaseCreates>(cloudOrLegacy(input.cloud), {
      aws: {
        postgres: onRds,
        mysql: onRds,
        redis: (cache) => {
          const created = cloudRedisCreate(name, cache, laid);
          if (!created.ok) return created;
          return {
            ok: true,
            notes: created.notes,
            step: {
              ...step,
              cache: { ...created.cache, ...native },
              cloudRead: reading,
            },
          };
        },
      },
      gcp: {
        // Its `native.gcp` on Cloud SQL or Memorystore, which its
        // read lays, and which says what it is made with of what it sets.
        postgres: onCloudSql,
        mysql: onCloudSql,
        redis: (cache) => {
          const created = memorystoreCreate(
            name,
            cache,
            memorystoreWanted(cache),
          );
          if (!created.ok) return created;
          return {
            ok: true,
            notes: created.notes,
            step: {
              ...step,
              memorystore: { ...created.memorystore, ...nativeGcp },
              cloudRead: reading,
            },
          };
        },
      },
    });
    switch (entry.kind) {
      case 'postgres':
        return made.postgres(entry);
      case 'mysql':
        return made.mysql(entry);
      case 'redis':
        return made.redis(entry);
    }
  }
  // An S3 bucket: its real name is minted as the plan is stored,
  // then its read writes its definition with it. It needs no network.
  // Its `native.aws` on AWS is laid by its read as by its run.
  const native =
    laysNativeAwsOn(input.cloud, entry.kind) && laidAwsBlock(entry)
      ? stepNativeAws(entry)
      : {};
  if (entry.kind === 'bucket') {
    return {
      ok: true,
      notes: [],
      step: { ...step, ...native, cloudRead: { status: 'reading' } },
    };
  }
  // A static site on S3 + CloudFront, or on Cloud Storage + Cloud
  // CDN: its own bucket's name is minted as the plan is stored, as
  // a bucket's is, and it needs no network. What only a container has is
  // ignored, named in one note; on Google Cloud its cost and that it
  // answers nowhere until a Domain is added are noted too.
  if (entry.kind === 'static') {
    const cloud = cloudOrLegacy(input.cloud);
    const ignored = ignoredOnCloud(cloud, name, entry);
    return {
      ok: true,
      notes: [...(ignored ? [ignored] : []), ...staticCreateNotes(cloud, name)],
      step: {
        ...step,
        fields: step.fields.filter((diff) => !isIgnoredOnS3(diff)),
        site: cloudStaticSite(entry),
        ...native,
        cloudRead: { status: 'reading' },
      },
    };
  }
  if (
    entry.kind !== 'web' &&
    entry.kind !== 'worker' &&
    entry.kind !== 'web-private' &&
    entry.kind !== 'cron'
  ) {
    return { ok: true, step, notes: [] };
  }
  const cloud = cloudWebCreate(name, entry, input.cloud);
  if (!cloud.ok) return cloud;
  return {
    ok: true,
    notes: [],
    step: { ...step, cloud: cloud.cloud, cloudRead: { status: 'reading' } },
  };
}

/**
 * What a `web` created in a Cloud account is written from: its size
 * on its cloud's pair, refused above the largest — on AWS a Fargate pair,
 * on Google Cloud a Cloud Run one (the Google Cloud spec, `cloud-run.ts`). On AWS its
 * variables reach the task as SSM parameters, written by its deploys.
 * `running` is a change's: the caps the Service has, and whether the config
 * changed its size.
 *
 * A Worker on ECS is written from the same, with no port: its
 * routing is none, which its kind picks (`ecsRoutingOf`). A Private web
 * service too, on its port: its routing is private DNS. A Cron
 * service too, with no port: its task definition and no ECS
 * service (`ecsDefinitionOf`).
 */
function cloudWebCreate(
  name: string,
  entry: WebLikeEntry | WorkerEntry | CronEntry,
  cloud: CloudKind = LEGACY_CLOUD,
  running?: RunningSize,
):
  | { readonly ok: true; readonly cloud: CloudWebCreate }
  | { readonly ok: false; readonly refusals: PlanRefusal[] } {
  const sized = byCloud(cloud, {
    aws: () =>
      fargateSizeOf(
        name,
        entry,
        laysNativeAwsOn(cloud, entry.kind) ? laidAwsBlock(entry) : undefined,
        running,
      ),
    gcp: () =>
      cloudRunSizeOf(
        name,
        entry,
        running,
        cloudRunResourceOf(entry.kind),
        // Its container's limits its `native.gcp` sets win over the size.
        laysNativeGcpOn(cloud, entry.kind) ? laidGcpBlock(entry) : undefined,
      ),
  })();
  if (!sized.ok) return { ok: false, refusals: [sized.refusal] };
  // A Private web service's Config name is its DNS label on AWS.
  // On Google Cloud its address is its Cloud Run service's own `run.app`
  // one, named by Cloudgate, so a Config name is never in it.
  const named = byCloud(cloud, {
    aws: () => (entry.kind === 'web-private' ? privateHostRefusal(name) : null),
    gcp: () => null,
  })();
  if (named) return { ok: false, refusals: [named] };
  return {
    ok: true,
    cloud: {
      size: sized.size,
      service: {
        port:
          entry.kind === 'worker' || entry.kind === 'cron' ? null : entry.port,
        command: entry.command ?? null,
        args: [...(entry.args ?? [])],
        size: entry.size ?? null,
      },
      ...(entry.links && Object.keys(entry.links).length > 0
        ? { links: entry.links }
        : {}),
      // Laid by its read as by its deploy, on AWS only.
      ...(laysNativeAwsOn(cloud, entry.kind) && laidAwsBlock(entry)
        ? { native: laidAwsBlock(entry) }
        : {}),
      // And on Google Cloud.
      ...(laysNativeGcpOn(cloud, entry.kind) && laidGcpBlock(entry)
        ? { nativeGcp: laidGcpBlock(entry) }
        : {}),
    },
  };
}

/** A `web`'s size on its Fargate pair, refused above the largest. */
function fargateSizeOf(
  name: string,
  entry: Pick<WebEntry, 'size'>,
  native?: NativeAwsBlock,
  running?: RunningSize,
):
  | { readonly ok: true; readonly size: CloudWebCreate['size'] }
  | { readonly ok: false; readonly refusal: PlanRefusal } {
  const sizing = fargateSize(name, entry.size);
  // A pair native lays that Fargate does not run is refused here, by its
  // native path, rather than by AWS at deploy. With no size, the
  // half native leaves is the caps the task has, as its Apply lays it.
  const base =
    !entry.size && running
      ? fargateSize(name, savedSize(running.cpuLimit, running.memoryLimit))
      : sizing;
  if (base.ok) {
    const refused = nativeFargateRefusal(name, base.pair, native);
    if (refused) return { ok: false, refusal: refused };
  }
  // The task's `cpu` or `memory` its `native.aws` sets wins over that half
  // of the size's pair; with both set, the size is not what runs,
  // so one above Fargate's largest is not refused.
  const laid = nativeFargateOf(native);
  if (!sizing.ok) {
    if (laid.cpuUnits === undefined || laid.memoryMb === undefined) {
      return sizing;
    }
    return {
      ok: true,
      size: {
        name: entry.size?.name ?? null,
        pair: {
          runsOn: 'Fargate',
          wording: fargateWording(
            { cpuUnits: laid.cpuUnits, memoryMb: laid.memoryMb },
            native,
          ),
        },
      },
    };
  }
  return {
    ok: true,
    size: {
      name: sizing.sizeName,
      pair: {
        runsOn: 'Fargate',
        wording:
          laid.cpuUnits === undefined && laid.memoryMb === undefined
            ? formatPair(sizing.pair)
            : fargateWording(sizing.pair, native),
      },
    },
  };
}

/**
 * A switch the operator asked for on a postgres's or a redis's page (ADR-0033):
 * the create that adds the other Service, beside the destroy the caller
 * plans of this one. To an existing database, the existing Service its
 * lookup will find, which needs a Cloud account to look it up in; to a
 * Cloudgate-made one, the create the entry would have on the Deploy target.
 * `null` when there is no switch, or one that no longer fits (to existing
 * on an Existing database, or to made on a made one): the plan is as if
 * none were asked for.
 */
function switchSteps(
  name: string,
  entry: PostgresEntry | MysqlEntry | RedisEntry,
  found: Extract<SavedService, { serviceType: 'postgres' | 'mysql' | 'redis' }>,
  input: PlanInput,
): ReturnType<typeof createStep> | null {
  const switching = found.switching;
  if (switching?.to === 'existing' && switching.identifier && !found.existing) {
    return existingCreate(name, entry, input, switching.identifier);
  }
  if (switching?.to === 'made' && found.existing) {
    const created = createStep(name, entry, input);
    if (!created.ok) return created;
    return {
      ok: true,
      step: created.step,
      notes: [...created.notes, ...variablesWithoutValue(name, entry, null)],
    };
  }
  return null;
}

/**
 * The line a switch between a Cloudgate-made and an existing database
 * carries (ADR-0033): no data is copied either way, the existing one
 * keeps its own, and the Cloudgate-made one goes by its Delete, whose
 * final snapshot the destroy's own line names. `null` on any other
 * destroy plus create.
 */
function switchNotCopied(
  destroy: Extract<PlanStep, { action: 'destroy' }>,
  create: Extract<PlanStep, { action: 'create' }>,
): string | null {
  const name = destroy.configName;
  if (create.existing && !destroy.existing) {
    return `${name}: switches to the existing database ${create.existing.identifier}, which keeps its own data; no data is copied from the database Cloudgate made`;
  }
  if (destroy.existing && !create.existing) {
    return `${name}: the database Cloudgate makes starts empty; no data is copied from the existing database ${destroy.existing.identifier}, which is left as it was`;
  }
  return null;
}

/**
 * A `postgres` or `redis` entry created as an existing database: nothing is
 * made, and what the config says of the database itself is not applied to
 * it, which the plan says, as every plan of one does. Refused off a Cloud
 * account, where nothing could look it up.
 */
function existingCreate(
  name: string,
  entry: PostgresEntry | MysqlEntry | RedisEntry,
  input: PlanInput,
  identifier: string,
): ReturnType<typeof createStep> {
  if (input.deployTarget.kind !== 'cloud') {
    return {
      ok: false,
      refusals: [
        {
          at: name,
          message: `${name} is to switch to the existing database ${identifier}, which is looked up in the Environment's Cloud account, and this Environment's Deploy target is not a Cloud account; choose one, or cancel the switch on ${name}'s page`,
        },
      ],
    };
  }
  return {
    ok: true,
    step: {
      action: 'create',
      configName: name,
      kind: entry.kind,
      placement: input.deployTarget,
      fields: [
        ...diffFields(
          entryView(entry),
          CREATE_DEFAULTS[entry.kind],
          statedFields(entry),
        ).map((diff) => ({ ...diff, from: null })),
        ...linkCreates(entry),
      ].filter((diff) => !NOT_APPLIED_TO_EXISTING.has(diff.field)),
      existing: { identifier },
    },
    notes: [
      existingNotApplied(name, entry.kind, identifier),
      ...variablesWithoutValue(name, entry, null),
    ],
  };
}

function destroyStep(found: SavedService, kind: ConfigKind): PlanStep {
  return {
    action: 'destroy',
    configName: found.configName,
    kind,
    serviceType: found.serviceType,
    serviceId: found.serviceId,
    name: found.name,
    // What its Delete leaves as it was (ADR-0033).
    ...(found.serviceType === 'bucket' && found.existing
      ? { existing: { identifier: found.existing.bucketName } }
      : (found.serviceType === 'postgres' ||
            found.serviceType === 'mysql' ||
            found.serviceType === 'redis') &&
          found.existing
        ? { existing: { identifier: found.existing.identifier } }
        : found.serviceType === 'compose' && found.stackVm
          ? // What its Delete removes, and the final snapshot it keeps.
            { stackVm: stackVmDestroy(found.configName, found.stackVm) }
          : {}),
  };
}

// ── Views: one Service as a flat map of wire-named fields to JSON values ──

export type View = Readonly<Record<string, unknown>>;

/** The fields compared for each kind, in the order a diff lists them. */
const WEB_FIELDS = [
  'description',
  'size',
  'command',
  'args',
  'port',
  'source',
  'build.type',
  'build.railpack_version',
  'build.heroku_version',
  'build.dockerfile',
  'build.context',
  'build.stage',
  'build.publish',
  'build.create_env_file',
  'build.submodules',
  'build.watch_paths',
];

/**
 * The fields a change compares, per kind. A cloud database's change planner
 * states what it does with each of its kind's (`cloud-change-fields.ts`).
 */
export const FIELDS: Record<ConfigKind, readonly string[]> = {
  web: WEB_FIELDS,
  // A `web-private` is configured as a `web` is; only where it is reached
  // differs.
  'web-private': WEB_FIELDS,
  // A `web` with no `port`.
  worker: WEB_FIELDS.filter((field) => field !== 'port'),
  static: [
    'description',
    'size',
    'command',
    'args',
    'source',
    'build.publish',
    'build.spa',
    'build.create_env_file',
    'build.submodules',
    'build.watch_paths',
  ],
  // A `web`'s fields without `port`, and the timetable.
  cron: [
    'description',
    'size',
    'command',
    'args',
    'schedule',
    'timezone',
    'timeout',
    'source',
    'build.type',
    'build.railpack_version',
    'build.heroku_version',
    'build.dockerfile',
    'build.context',
    'build.stage',
    'build.publish',
    'build.create_env_file',
    'build.submodules',
    'build.watch_paths',
  ],
  postgres: ['description', 'size', 'version', 'database', 'user'],
  mysql: ['description', 'size', 'version', 'database', 'user'],
  redis: ['description', 'size', 'version'],
  // Its real name is Cloudgate's, never the config's.
  bucket: ['description'],
  // The file it names, never what is in it (ADR-0069). A `type`
  // change is a destroy plus a create, so only a create shows one.
  compose: ['source', 'file', 'type'],
};

function diffFields(
  wanted: View & { readonly kind?: ConfigKind },
  have: View,
  stated: ReadonlySet<string>,
): FieldDiff[] {
  const kind = wanted.kind as ConfigKind;
  const diffs: FieldDiff[] = [];
  for (const field of FIELDS[kind]) {
    if (ONLY_WHEN_STATED.has(field) && !stated.has(field)) continue;
    const to = wanted[field] ?? null;
    const from = have[field] ?? null;
    if (canonical(to) !== canonical(from)) diffs.push({ field, from, to });
  }
  return diffs;
}

/** A JSON value with its object keys sorted, so equal values compare equal. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : inner,
  );
}

const APPLICATION_DEFAULTS = {
  port: 3000,
  buildType: 'nixpacks',
  railpackVersion: '0.15.4',
  herokuVersion: '24',
  dockerfile: 'Dockerfile',
  createEnvFile: true,
  enableSubmodules: false,
} as const;

/** What a console create leaves a `web` (and a `web-private`) at, as a view. */
const WEB_DEFAULTS: View = {
  description: null,
  size: null,
  command: null,
  args: [],
  port: APPLICATION_DEFAULTS.port,
  source: null,
  'build.type': APPLICATION_DEFAULTS.buildType,
  'build.railpack_version': APPLICATION_DEFAULTS.railpackVersion,
  'build.heroku_version': APPLICATION_DEFAULTS.herokuVersion,
  'build.dockerfile': APPLICATION_DEFAULTS.dockerfile,
  'build.context': null,
  'build.stage': null,
  'build.publish': null,
  'build.create_env_file': APPLICATION_DEFAULTS.createEnvFile,
  'build.submodules': APPLICATION_DEFAULTS.enableSubmodules,
  'build.watch_paths': [],
};

/** What a console create leaves a Service of each kind at, as a view. */
const CREATE_DEFAULTS: Record<ConfigKind, View> = {
  web: WEB_DEFAULTS,
  'web-private': WEB_DEFAULTS,
  worker: withoutPort(WEB_DEFAULTS),
  static: {
    description: null,
    size: null,
    command: null,
    args: [],
    source: null,
    'build.publish': null,
    'build.spa': false,
    'build.create_env_file': APPLICATION_DEFAULTS.createEnvFile,
    'build.submodules': APPLICATION_DEFAULTS.enableSubmodules,
    'build.watch_paths': [],
  },
  // `command` and `schedule` are required, so they have no default: a
  // create always shows them.
  cron: {
    description: null,
    size: null,
    command: null,
    args: [],
    schedule: null,
    timezone: DEFAULT_TIMEZONE,
    timeout: formatTimeout(DEFAULT_TIMEOUT_SECONDS),
    source: null,
    'build.type': APPLICATION_DEFAULTS.buildType,
    'build.railpack_version': APPLICATION_DEFAULTS.railpackVersion,
    'build.heroku_version': APPLICATION_DEFAULTS.herokuVersion,
    'build.dockerfile': APPLICATION_DEFAULTS.dockerfile,
    'build.context': null,
    'build.stage': null,
    'build.publish': null,
    'build.create_env_file': APPLICATION_DEFAULTS.createEnvFile,
    'build.submodules': APPLICATION_DEFAULTS.enableSubmodules,
    'build.watch_paths': [],
  },
  postgres: {
    description: null,
    size: null,
    version: 'postgres:18',
    database: null,
    user: null,
  },
  mysql: {
    description: null,
    size: null,
    version: 'mysql:8.4',
    database: null,
    user: null,
  },
  redis: { description: null, size: null, version: 'redis:8' },
  bucket: { description: null },
  // `source` is required, so a create always shows it.
  compose: {
    source: null,
    file: DEFAULT_COMPOSE_FILE,
    type: DEFAULT_COMPOSE_TYPE,
  },
};

function withoutPort(view: View): View {
  return Object.fromEntries(
    Object.entries(view).filter(([field]) => field !== 'port'),
  );
}

/** A config entry as a view; a field it leaves out takes its create default. */
function entryView(entry: Described): View & { kind: ConfigKind } {
  const defaults = CREATE_DEFAULTS[entry.kind];
  const shared = {
    description: emptyToNull(entry.description),
    size: entry.size ? sizeValue(entry.size) : null,
  };
  switch (entry.kind) {
    case 'web':
    case 'web-private':
    case 'worker':
    case 'static':
    case 'cron':
      return {
        ...defaults,
        ...shared,
        ...buildableView(entry),
        kind: entry.kind,
      };
    case 'postgres':
    case 'mysql':
      return {
        ...defaults,
        ...shared,
        ...sqlDatabaseView(entry),
        kind: entry.kind,
      };
    case 'redis':
      return { ...defaults, ...shared, ...redisView(entry), kind: 'redis' };
    case 'bucket':
      return {
        ...defaults,
        description: shared.description,
        kind: 'bucket',
      };
    case 'compose':
      return {
        ...defaults,
        source: composeSourceValue(entry.source),
        ...(entry.composePath === undefined
          ? {}
          : { file: composeFileValue(entry.composePath) }),
        ...(entry.composeType === undefined ? {} : { type: entry.composeType }),
        kind: 'compose',
      };
  }
}

function buildableView(
  entry: WebLikeEntry | WorkerEntry | StaticEntry | CronEntry,
): View {
  const view: Record<string, unknown> = {
    command: entry.command ?? null,
    args: entry.args ?? [],
    source: entry.source ? sourceValue(entry.source) : null,
  };
  const build = entry.build ?? {};
  const set = (field: string, value: unknown) => {
    if (value !== undefined) view[field] = value;
  };
  set('build.publish', build.publishDirectory);
  set('build.create_env_file', build.createEnvFile);
  set('build.submodules', build.enableSubmodules);
  set('build.watch_paths', build.watchPaths);
  if (entry.kind === 'cron') {
    view.schedule = entry.schedule;
    set('timezone', entry.timezone);
    if (entry.timeoutSeconds !== undefined) {
      view.timeout = formatTimeout(entry.timeoutSeconds);
    }
  }
  if (entry.kind !== 'static') {
    const web = entry.build ?? {};
    if (entry.kind !== 'worker' && entry.kind !== 'cron') {
      view.port = entry.port;
    }
    set('build.type', web.buildType);
    set('build.railpack_version', web.railpackVersion);
    set('build.heroku_version', web.herokuVersion);
    set('build.dockerfile', web.dockerfile);
    set('build.context', web.dockerContextPath);
    set('build.stage', web.dockerBuildStage);
  } else {
    set('build.spa', entry.build?.isStaticSpa);
  }
  return view;
}

function sqlDatabaseView(entry: PostgresEntry | MysqlEntry): View {
  const view: Record<string, unknown> = {};
  if (entry.dockerImage !== undefined) view.version = entry.dockerImage;
  if (entry.databaseName !== undefined) view.database = entry.databaseName;
  if (entry.databaseUser !== undefined) view.user = entry.databaseUser;
  return view;
}

function redisView(entry: RedisEntry): View {
  return entry.dockerImage === undefined ? {} : { version: entry.dockerImage };
}

/** A saved Service as a view, its nulls read as a console create would. */
function savedView(found: SavedService): View {
  if (!('settings' in found)) return {};
  if (found.serviceType === 'bucket') {
    return { description: emptyToNull(found.settings.description) };
  }
  if (found.serviceType === 'compose') {
    return {
      source: savedSourceValue(found.settings, { buildPath: false }),
      file: composeFileValue(found.settings.composePath),
      type: found.settings.composeType,
    };
  }
  const shared = {
    description: emptyToNull(found.settings.description),
    size: savedSizeValue(found.settings.cpuLimit, found.settings.memoryLimit),
  };
  switch (found.serviceType) {
    case 'application':
      return { ...shared, ...savedApplicationView(found.settings) };
    case 'postgres':
    case 'mysql':
      return {
        ...shared,
        version: found.settings.dockerImage,
        database: found.settings.databaseName,
        user: found.settings.databaseUser,
      };
    case 'redis':
      return { ...shared, version: found.settings.dockerImage };
  }
}

function savedApplicationView(settings: SavedApplicationSettings): View {
  return {
    command: emptyToNull(settings.command),
    args: settings.args ?? [],
    port: settings.port,
    schedule: settings.cronSchedule,
    timezone: settings.cronTimezone,
    timeout:
      settings.cronTimeoutSeconds === null
        ? null
        : formatTimeout(settings.cronTimeoutSeconds),
    source: savedSourceValue(settings),
    'build.type': settings.buildType,
    'build.railpack_version':
      settings.railpackVersion ?? APPLICATION_DEFAULTS.railpackVersion,
    'build.heroku_version':
      settings.herokuVersion ?? APPLICATION_DEFAULTS.herokuVersion,
    'build.dockerfile': settings.dockerfile ?? APPLICATION_DEFAULTS.dockerfile,
    'build.context': emptyToNull(settings.dockerContextPath),
    'build.stage': emptyToNull(settings.dockerBuildStage),
    'build.publish': emptyToNull(settings.publishDirectory),
    'build.spa': settings.isStaticSpa ?? false,
    'build.create_env_file': settings.createEnvFile,
    'build.submodules': settings.enableSubmodules,
    'build.watch_paths': settings.watchPaths ?? [],
  };
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

// ── Sources ──

/** A source as the config writes it; a missing build path is the root. */
function sourceValue(source: Source): Record<string, string> {
  switch (source.sourceType) {
    case 'docker':
      return { image: source.dockerImage };
    case 'drop':
      return { folder: source.buildPath };
    case 'git':
      return { git: source.customGitUrl, path: source.buildPath ?? '/' };
    default:
      return {
        [source.sourceType]: source.repository,
        path: source.buildPath ?? '/',
      };
  }
}

/**
 * The repository columns an Application and a Compose stack share, and an
 * Application's build paths and image, which a stack has none of.
 */
type SavedSourceColumns = Omit<
  SavedComposeSettings,
  'sourceType' | 'composePath' | 'composeType'
> & {
  readonly sourceType: SourceType;
} & Partial<
    Pick<
      SavedApplicationSettings,
      | 'buildPath'
      | 'gitlabBuildPath'
      | 'giteaBuildPath'
      | 'bitbucketBuildPath'
      | 'customGitBuildPath'
      | 'dockerImage'
      | 'dropBuildPath'
    >
  >;

/**
 * A Service's saved source, as {@link sourceValue} writes an Application's
 * and {@link composeSourceValue} a stack's, which has no `path`
 * (`buildPath: false`).
 */
function savedSourceValue(
  settings: SavedSourceColumns,
  { buildPath }: { buildPath: boolean } = { buildPath: true },
): Record<string, unknown> | null {
  const repo = (owner: string | null, repository: string | null) =>
    owner && repository ? `${owner}/${repository}` : null;
  const at = (path: string | null | undefined) =>
    buildPath ? { path: path || '/' } : {};
  const provider = (
    key: string,
    repository: string | null,
    path: string | null | undefined,
  ) => (repository ? { [key]: repository, ...at(path) } : null);

  switch (settings.sourceType) {
    case 'github':
      return provider(
        'github',
        repo(settings.owner, settings.repository),
        settings.buildPath,
      );
    case 'gitlab':
      return provider(
        'gitlab',
        settings.gitlabPathNamespace ||
          repo(settings.gitlabOwner, settings.gitlabRepository),
        settings.gitlabBuildPath,
      );
    case 'gitea':
      return provider(
        'gitea',
        repo(settings.giteaOwner, settings.giteaRepository),
        settings.giteaBuildPath,
      );
    case 'bitbucket':
      return provider(
        'bitbucket',
        repo(settings.bitbucketOwner, settings.bitbucketRepository),
        settings.bitbucketBuildPath,
      );
    case 'git':
      return settings.customGitUrl
        ? { git: settings.customGitUrl, ...at(settings.customGitBuildPath) }
        : null;
    case 'docker':
      return settings.dockerImage ? { image: settings.dockerImage } : null;
    case 'drop': {
      // Uploaded files built from a subfolder are a folder source
      // (ADR-0080), however the upload spelled it (`/apps/web/`). Built
      // from the upload's root, no config source names them.
      const folder = folderOfBuildPath(settings.dropBuildPath);
      return folder !== null ? { folder } : { drop: 'set in the console' };
    }
    default:
      // An uploaded archive or raw Compose text: no config source names it,
      // so any source the config states is a difference.
      return { [settings.sourceType]: 'set in the console' };
  }
}

/**
 * An upload's build path as a folder source's subfolder: relative to the
 * uploaded folder, with no leading or trailing `/`. `null` for its root,
 * which a folder source does not name.
 */
export function folderOfBuildPath(
  buildPath: string | null | undefined,
): string | null {
  const folder = (buildPath ?? '').replace(/^\/+|\/+$/g, '');
  return folder === '' ? null : folder;
}

/** A `compose` entry's source as the config writes it: no path. */
function composeSourceValue(source: ComposeSource): Record<string, string> {
  return source.sourceType === 'git'
    ? { git: source.customGitUrl }
    : { [source.sourceType]: source.repository };
}

// ── Sizes ──

const NANO = 1e9;
const MB = 1024 * 1024;

/** A size as the config writes it: its name when one matches, else the pair. */
function describeSize(
  cpu: number | null,
  memoryMb: number | null,
): string | { cpu: number | null; memory: string | null } | null {
  if (cpu === null && memoryMb === null) return null;
  const named = Object.entries(SIZES).find(
    ([, size]) => size.cpu === cpu && size.memoryMb === memoryMb,
  );
  if (named) return named[0];
  return {
    cpu,
    memory:
      memoryMb === null
        ? null
        : memoryMb % 1024 === 0
          ? `${memoryMb / 1024} GB`
          : `${memoryMb} MB`,
  };
}

function sizeValue(size: Size) {
  return describeSize(size.cpu, size.memoryMb);
}

/** The caps a Service has, from the strings its columns hold. */
function savedSizeValue(cpuLimit: string | null, memoryLimit: string | null) {
  const number = (value: string | null) => {
    if (value === null || value.trim() === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  const nano = number(cpuLimit);
  const bytes = number(memoryLimit);
  return describeSize(
    nano === null ? null : nano / NANO,
    bytes === null ? null : bytes / MB,
  );
}

// ── Variables ──

const LISTS = VARIABLE_LISTS.map((list) => ({
  list,
  names: LISTED_NAMES[list],
  keys: VARIABLE_KEYS[list],
}));

/**
 * The Template a create is a part of: the Pending setup holding a part
 * under exactly this Config name and kind (ADR-0065 "Matching"), and how
 * each value it gives is made, in each list of the entry that lists it.
 * `undefined` when none does, or when it gives none of the entry's
 * variables a value it lists.
 */
function templateCreate(
  name: string,
  entry: Described,
  pendingSetups: PlanInput['pendingSetups'],
): TemplateCreate | undefined {
  // The compose part is taken only by its console-managed line
  // (`templateStackStep`), never by a described stack of its name (#1378).
  if (entry.kind === 'compose') return undefined;
  for (const setup of pendingSetups ?? []) {
    const part = setup.parts.find(
      (one) => one.configName === name && one.kind === entry.kind,
    );
    if (!part) continue;
    return {
      pendingSetupId: setup.pendingSetupId,
      templateId: setup.templateId,
      templateName: setup.templateName,
      setupName: setup.setupName,
      values: LISTS.flatMap(({ list, names }) =>
        names(entry).flatMap((variable) =>
          variable in part.made
            ? [{ list, variable, made: part.made[variable] }]
            : [],
        ),
      ),
      ...(part.host === undefined ? {} : { host: part.host }),
      ...(part.files && part.files.length > 0 ? { files: part.files } : {}),
    };
  }
  return undefined;
}

/**
 * The create of a Template's compose part (#1373, ADR-0065): its
 * console-managed line has no Service, and a Pending setup holds a part
 * under exactly this Config name with kind `compose`. Its values are the
 * stack's own `.env`, every one its compose file uses, so each is listed
 * under `env`; its Domains are on the hosts the setup picked, and a host
 * taken since refuses the plan. `undefined` when no setup holds it: the
 * line is refused as any console-managed line with no Service is.
 *
 * In a Cloud Environment the stack runs on its own Stack VM (#1379,
 * ADR-0070): the create is a Stack VM create read from its cloud and priced
 * like any cloud step, starting at the template's minimum size
 * (`stackVmStartingSizes`) or `medium`. Its Domains are on the hosts the
 * operator typed; they are the cloud's, added once the Stack VM is made.
 * A part whose stack an Apply already made, its Domains still waiting for
 * the Stack VM, is no create.
 */
function templateStackStep(
  name: string,
  input: PlanInput,
):
  | { readonly ok: true; readonly step: PlanStep }
  | { readonly ok: false; readonly refusals: PlanRefusal[] }
  | undefined {
  for (const setup of input.pendingSetups ?? []) {
    const part = setup.parts.find(
      (one) =>
        one.configName === name &&
        one.kind === 'compose' &&
        one.stackId === undefined,
    );
    if (!part) continue;
    const domains = part.domains ?? [];
    const taken = domains.flatMap(({ host }) => {
      const why = input.takenHosts?.get(host);
      return why === undefined ? [] : [templateHostTaken(name, host, why)];
    });
    if (taken.length > 0) return { ok: false, refusals: taken };
    const onStackVm = templateStackVm(name, input);
    if (onStackVm && !onStackVm.ok) return onStackVm;
    return {
      ok: true,
      step: {
        action: 'create',
        configName: name,
        kind: 'compose',
        placement: input.deployTarget,
        // Console-managed: the config describes nothing of it.
        fields: [],
        ...(onStackVm
          ? {
              stackVm: onStackVm.stackVm,
              cloudRead: { status: 'reading' as const },
            }
          : {}),
        template: {
          pendingSetupId: setup.pendingSetupId,
          templateId: setup.templateId,
          templateName: setup.templateName,
          setupName: setup.setupName,
          values: Object.entries(part.made).map(([variable, made]) => ({
            list: 'env' as const,
            variable,
            made,
          })),
          domains,
          files: part.files ?? [],
        },
      },
    };
  }
  return undefined;
}

/**
 * A Template stack's Stack VM in a Cloud Environment (#1379), or
 * `undefined` on a Server or the platform host: refused, as a described
 * stack's is, in a Cloud account whose role predates Stack VMs (#1366).
 */
function templateStackVm(
  name: string,
  input: PlanInput,
):
  | { readonly ok: true; readonly stackVm: StackVmCreate }
  | { readonly ok: false; readonly refusals: PlanRefusal[] }
  | undefined {
  if (input.deployTarget.kind !== 'cloud') return undefined;
  const cloud = cloudOrLegacy(input.cloud);
  const gap = stackVmGapRefusal(
    name,
    { cloud, cloudAccountId: input.deployTarget.cloudAccountId },
    input.cloudAccount,
  );
  if (gap) return { ok: false, refusals: [gap] };
  return templateStackVmCreate(
    name,
    { cloud, region: input.deployTarget.region },
    input.stackVmStartingSizes?.[name],
  );
}

/**
 * A Template `web` whose values name a generated host its setup made, in a
 * Cloud Environment, where a `web` gets none (ADR-0064): its URL would point
 * nowhere. Setup offers no such Environment; this holds if the Deploy target
 * changed after.
 */
function templateHostRefusal(
  name: string,
  entry: Described,
  input: PlanInput,
): PlanRefusal | null {
  if (input.deployTarget.kind !== 'cloud') return null;
  const host = templateCreate(name, entry, input.pendingSetups)?.host;
  if (host === undefined) return null;
  return {
    at: name,
    message: `${name}'s values name its URL on ${host}, a generated host its Template setup made, and a web in a Cloud Environment gets no generated host`,
  };
}

/** A listed name this Environment holds no value for (or will not, on a create). */
function variablesWithoutValue(
  name: string,
  entry: Described,
  variables: SavedVariableKeys | null,
): PlanNote[] {
  const notes: PlanNote[] = [];
  for (const { list, names, keys } of LISTS) {
    const held = new Set(variables ? keys(variables) : []);
    for (const variable of names(entry)) {
      if (held.has(variable)) continue;
      notes.push({
        kind: 'variable-without-value',
        configName: name,
        list,
        variable,
        message: `${name}.${list} lists ${variable}, which has no value in this Environment`,
      });
    }
  }
  return notes;
}

/** A key held here that the config does not list: Apply removes it. */
function variableChanges(
  entry: Described,
  variables: SavedVariableKeys,
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const { list, names, keys } of LISTS) {
    const held = keys(variables);
    const listed = new Set(names(entry));
    const kept = held.filter((key) => listed.has(key));
    if (kept.length !== held.length) {
      diffs.push({ field: list, from: [...held], to: kept });
    }
  }
  return diffs;
}
