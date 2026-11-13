import { ConflictException, HttpException } from '@nestjs/common';

import { PLAN_REFUSED_CODE } from './applier/plan-applier';
import { cloudReadOf, cloudStepName } from './planner/cloud-steps';
import { CONFIG_UNREADABLE_CODE } from './console-saves/repository-kept';
import { canonical } from './planner/plan-environment';
import type { DeployTarget, PlanStep } from './planner/plan.types';
import type { ConfigReadResult } from './reader/config-reader.port';
import type { RepositoryPlace } from './reader/repository-place';

/** The refusal codes a client branches on (ADR-0005), never the message. */
export const PROJECT_CONFIG_MISSING_CODE = 'PROJECT_CONFIG_MISSING';
export const PLAN_NOT_OPEN_CODE = 'PLAN_NOT_OPEN';
/** The config or the compared settings moved on since the plan was made (US23). */
export const PLAN_STALE_CODE = 'PLAN_STALE';
/**
 * An Apply's `confirmDestroy` is not exactly the plan's destroys (US25): a
 * destroy is confirmed by naming it, and naming a Service the plan
 * does not destroy is refused too.
 */
export const PLAN_DESTROY_NOT_CONFIRMED_CODE = 'PLAN_DESTROY_NOT_CONFIRMED';
/**
 * An Apply's `confirmUpgrade` is not exactly the plan's major upgrades
 * confirmed by the Service's name like a destroy, since one is
 * offline while it runs and never undone.
 */
export const PLAN_UPGRADE_NOT_CONFIRMED_CODE = 'PLAN_UPGRADE_NOT_CONFIRMED';
/**
 * A whole-YAML edit that started from an older config version than
 * Cloudgate's (ADR-0080): someone changed the config since it was read.
 */
export const CONFIG_VERSION_STALE_CODE = 'CONFIG_VERSION_STALE';
/** A move's confirm whose preview's reads no longer hold. */
export const MOVE_STALE_CODE = 'MOVE_STALE';
/**
 * A move into a repository with no path, where the Config branches do not
 * settle one name: a branch holds both `cloudgate.yaml` and `cloudgate.yml`,
 * or two Environments' branches hold different ones (#1344).
 */
export const CONFIG_PATH_AMBIGUOUS_CODE = 'CONFIG_PATH_AMBIGUOUS';
/** A move out of a repository of a config no repository keeps. */
export const PROJECT_CONFIG_NOT_REPOSITORY_KEPT_CODE =
  'PROJECT_CONFIG_NOT_REPOSITORY_KEPT';

export function notOpen(status: string): ConflictException {
  return new ConflictException({
    message: `This plan is no longer open; it is ${status}`,
    code: PLAN_NOT_OPEN_CODE,
  });
}

export function stalePlan(why: string): ConflictException {
  return new ConflictException({
    message: `This plan no longer describes this Environment: ${why}. Check for changes, then apply the new plan`,
    code: PLAN_STALE_CODE,
  });
}

/**
 * Why a plan no longer fits its Environment's Deploy target, or `null` while
 * it does (ADR-0035): a plan made before a switch names the old place,
 * so its Apply is refused rather than creating there. `null` too for a plan
 * made before plans kept their target, which the settings fingerprint still
 * covers.
 */
export function deployTargetMoved(
  planned: DeployTarget | null,
  now: DeployTarget,
): string | null {
  if (planned === null || canonical(planned) === canonical(now)) return null;
  const describe = (target: DeployTarget) => {
    switch (target.kind) {
      case 'platform-host':
        return 'the platform host';
      case 'server':
        return 'a Server';
      case 'cloud':
        return `a Cloud account in ${target.region}`;
    }
  };
  const another =
    (planned.kind === 'server' && now.kind === 'server') ||
    (planned.kind === 'cloud' &&
      now.kind === 'cloud' &&
      planned.cloudAccountId !== now.cloudAccountId);
  const after = another
    ? describe(now).replace(/^a /, 'another ')
    : describe(now);
  return `the Environment's Deploy target changed since it was made, from ${describe(planned)} to ${after}`;
}

/**
 * A whole-YAML edit from `startedFrom` refused, saying when the config last
 * changed and who changed it (`null` for Cloudgate itself), so the person
 * reads it again rather than undoing that change. Both are in the message
 * only: the error body publishes `code`, and a client reads the version
 * again from `GET /projects/:projectId/config`.
 */
export function staleVersion(
  startedFrom: number,
  now: {
    readonly changedAt: string;
    readonly changedBy: string | null;
  },
): ConflictException {
  const by = now.changedBy === null ? '' : ` by ${now.changedBy}`;
  return new ConflictException({
    message: `The Project config changed at ${now.changedAt}${by}, after the version ${startedFrom} this edit started from. Read it again, then make the edit on what it is now`,
    code: CONFIG_VERSION_STALE_CODE,
  });
}

export function configMissing(): ConflictException {
  return new ConflictException({
    message:
      'This Project has no Project config yet, so there is nothing to plan',
    code: PROJECT_CONFIG_MISSING_CODE,
  });
}

const branchName = (branch: string | null) =>
  branch === null ? 'its default branch' : `branch ${branch}`;

/** ` for the X Environment`, or nothing for a copy no Environment names. */
const forEnvironment = (name: string | null) =>
  name === null ? '' : ` for the ${name} Environment`;

/** A copy that could not be read, naming the Environment, repository and branch (US54). */
export function unreadable(
  environmentName: string | null,
  place: RepositoryPlace,
  read: Extract<ConfigReadResult, { ok: false }>,
): ConflictException {
  return new ConflictException({
    message: `The Project config cannot be read${forEnvironment(environmentName)} from ${place.repository} on ${branchName(read.branch)}: ${read.message}`,
    code: CONFIG_UNREADABLE_CODE,
  });
}

/** A plan refusal (`PLAN_REFUSED`) with `where` added to its message; any other error as it is. */
function refusalAt(error: unknown, where: string): unknown {
  if (!(error instanceof HttpException)) return error;
  const response = error.getResponse() as { message?: string; code?: string };
  if (response.code !== PLAN_REFUSED_CODE) return error;
  return new ConflictException({
    message: `${response.message} (${where})`,
    code: PLAN_REFUSED_CODE,
  });
}

/** A plan refusal of a repository copy, saying which Environment and branch read it. */
export function inCopy(
  error: unknown,
  environmentName: string | null,
  place: RepositoryPlace,
  branch: string,
): unknown {
  return refusalAt(
    error,
    `${environmentName === null ? '' : `in the ${environmentName} Environment, `}read from ${place.repository} at ${place.path} on branch ${branch}`,
  );
}

/** A plan refusal, saying which Environment refused the text. */
export function inEnvironment(error: unknown, name: string): unknown {
  return refusalAt(error, `in the ${name} Environment`);
}

/**
 * The steps an Apply confirms by typing the Service's Config name: every
 * destroy — a kind change or a rename is a destroy plus a
 * create, so its old name is among them — and an Environment network's
 * removal, by its `confirmName`; and every major upgrade, which any
 * kind's change may carry (`majorUpgrade`), so a redis on ElastiCache is
 * confirmed by the same rule.
 */
export function namesToConfirm(steps: readonly PlanStep[]): {
  readonly destroy: readonly string[];
  readonly upgrade: readonly string[];
} {
  return {
    destroy: steps.flatMap((step) =>
      step.action === 'destroy'
        ? [step.configName]
        : step.action === 'network-remove'
          ? [step.confirmName]
          : [],
    ),
    upgrade: steps
      .filter((step) => step.action === 'change' && step.majorUpgrade)
      .map((step) => (step as { configName: string }).configName),
  };
}

/**
 * Refuses an Apply whose confirmations are not exactly the plan's: every
 * destroyed and every major-upgraded Service named by its
 * Config name in its own list, and nothing else. Destroys are checked
 * first, with their own code, as before.
 */
export function refuseUnconfirmed(
  steps: readonly PlanStep[],
  confirmed: {
    readonly destroy: readonly string[];
    readonly upgrade: readonly string[];
  },
) {
  const needed = namesToConfirm(steps);
  const destroys = mismatch(needed.destroy, confirmed.destroy, 'destroys');
  if (destroys) {
    throw new ConflictException({
      message: `Confirm every Service this plan destroys by its Config name, and only those: ${destroys}`,
      code: PLAN_DESTROY_NOT_CONFIRMED_CODE,
    });
  }
  const upgrades = mismatch(
    needed.upgrade,
    confirmed.upgrade,
    'upgrades to a new major version',
  );
  if (upgrades) {
    throw new ConflictException({
      message: `Confirm every Service this plan upgrades to a new major version by its Config name, and only those, since it is offline during the upgrade and the upgrade cannot be undone: ${upgrades}`,
      code: PLAN_UPGRADE_NOT_CONFIRMED_CODE,
    });
  }
}

/** What differs between the names a plan needs and those confirmed, or `null`. */
function mismatch(
  needed: readonly string[],
  confirmed: readonly string[],
  verb: string,
): string | null {
  const wanted = new Set(needed);
  const given = new Set(confirmed);
  const missing = [...wanted].filter((name) => !given.has(name));
  const extra = [...given].filter((name) => !wanted.has(name));
  if (missing.length === 0 && extra.length === 0) return null;
  return [
    missing.length > 0
      ? `it ${verb} ${missing.join(', ')}, which the Apply does not confirm`
      : null,
    extra.length > 0
      ? `it does not ${verb.replace(/^(\w+)s\b/, '$1')} ${extra.join(', ')}, which the Apply confirms`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join('; ');
}

/**
 * Refuses an Apply that ticks "also delete its files" on anything but a
 * bucket this plan destroys, naming each: a tick is one
 * bucket's, so a name it cannot mean is a mistake, not a no-op.
 */
export function refuseFilesOfNoBucketDestroy(
  steps: readonly PlanStep[],
  deleteFilesOf: readonly string[],
) {
  const buckets = new Set(
    steps
      .filter(
        (step): step is Extract<PlanStep, { action: 'destroy' }> =>
          step.action === 'destroy' &&
          step.kind === 'bucket' &&
          // An existing bucket's files are never Cloudgate's to delete.
          !step.existing,
      )
      .map((step) => step.configName),
  );
  const extra = [...new Set(deleteFilesOf)].filter(
    (name) => !buckets.has(name),
  );
  if (extra.length === 0) return;
  throw new ConflictException({
    message: `Only a bucket this plan destroys can have its files deleted: it destroys no bucket ${extra.join(', ')}`,
    code: PLAN_DESTROY_NOT_CONFIRMED_CODE,
  });
}

/**
 * Refuses an Apply that ticks "also delete its data" on anything but a
 * cloud database or a Compose stack on a Stack VM (#1367) this plan
 * destroys, naming each: a destroy row that names its final snapshot.
 */
export function refuseDataOfNoCloudDatabaseDestroy(
  steps: readonly PlanStep[],
  deleteDataOf: readonly string[],
) {
  const databases = new Set(
    steps
      .filter(
        (step): step is Extract<PlanStep, { action: 'destroy' }> =>
          step.action === 'destroy' && step.finalSnapshot !== undefined,
      )
      .map((step) => step.configName),
  );
  const extra = [...new Set(deleteDataOf)].filter(
    (name) => !databases.has(name),
  );
  if (extra.length === 0) return;
  throw new ConflictException({
    message: `Only a database in a Cloud account or a stack on a Stack VM this plan destroys can have its data deleted: it destroys no such Service ${extra.join(', ')}`,
    code: PLAN_DESTROY_NOT_CONFIRMED_CODE,
  });
}

/** An Apply of a plan whose AWS reads have not all succeeded. */
export const PLAN_AWS_NOT_READ_CODE = 'PLAN_AWS_NOT_READ';
/**
 * Refuses an Apply until every cloud step's AWS read has succeeded (the AWS
 * spec "A failed read"), naming the steps still reading and each failed
 * one with its reason. There is no partial Apply.
 */
export function refuseUnreadAws(
  steps: readonly PlanStep[],
  /** The cloud the plan reads, as the message names it (the Google Cloud spec). */
  cloud = 'AWS',
) {
  const reading: string[] = [];
  const failed: string[] = [];
  for (const step of steps) {
    const aws = cloudReadOf(step);
    if (aws?.status === 'reading') reading.push(cloudStepName(step));
    if (aws?.status === 'failed') {
      failed.push(`${cloudStepName(step)} (${aws.reason})`);
    }
  }
  if (reading.length === 0 && failed.length === 0) return;
  const parts = [
    reading.length > 0
      ? `still reading ${cloud} for ${reading.join(', ')}`
      : null,
    failed.length > 0
      ? `the read failed for ${failed.join('; ')}, so Check for changes to read it again`
      : null,
  ].filter((part): part is string => part !== null);
  throw new ConflictException({
    message: `Apply waits until ${cloud} is read for every step of this plan: ${parts.join('; ')}`,
    code: PLAN_AWS_NOT_READ_CODE,
  });
}

/** An Apply making an Environment network another Apply is making. */
export const PLAN_NETWORK_BUSY_CODE = 'PLAN_NETWORK_BUSY';

export function networkBusy(region: string): ConflictException {
  return new ConflictException({
    message: `The Environment network (${region}) is being made by another Apply. Wait until its Deployment ends, then Check for changes`,
    code: PLAN_NETWORK_BUSY_CODE,
  });
}
