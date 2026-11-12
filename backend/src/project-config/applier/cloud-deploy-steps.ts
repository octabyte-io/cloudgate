import { quote } from 'shell-quote';

import type { ImageHealthCheck } from '../../cloud-accounts/aws/definitions/container-health-check';
import type { ImageArchitecture } from '../../cloud-accounts/aws/definitions/web-definition';
import { readPlan } from '../../cloud-accounts/aws/plan-reader/read-plan';
import type { PlanReading } from '../../cloud-accounts/aws/plan-reader/read-plan';
import type { TofuFailure, TofuShow } from '../../cloud-accounts/cloud.port';
import type { Application } from '../../db/schema';
import { SIZES } from '../format/config-size';
import type { Size } from '../format/config-size';
import type { WebEntry } from '../project-config.types';
import {
  changesDiffer,
  unlisted,
  withoutAddresses,
  withoutImageLines,
} from './same-changes';

/**
 * The pure steps of a cloud Service's deploy, apart from the run that
 * strings them together (`cloud-service-deploys.service.ts`).
 */

/**
 * How many of a failed task's (or revision's) last log lines
 * the Deployment log quotes (the AWS spec).
 */
export const FAILED_TASK_LOG_LINES = 50;

/**
 * The environment variable the push password (ECR's, or Google's access token)
 * travels in to `docker login`: never a word of the
 * command, which `ExecError` would keep.
 */
export const PUSH_PASSWORD_HOLDER = 'CG_PUSH_PASSWORD';

/**
 * What a deploy no Apply queued ends with when its plan does more than its
 * new image (the AWS spec "Auto-apply rule"): its Deployment's whole
 * description, naming its cloud. What it met is in its log, and its plan is
 * the Environment's open plan.
 */
export function cloudDiffers(cloudName: string): string {
  return `${cloudName} differs from what Cloudgate made: review the plan`;
}

/** {@link cloudDiffers} on AWS. */
export const AWS_DIFFERS = cloudDiffers('AWS');

/**
 * What a deploy may apply, read off the plan it is about to apply (the AWS
 * spec, "Auto-apply rule"):
 *
 * - **queued by an Apply**: exactly what that Apply approved, less what the
 *   deploy itself already made of it (its ECR repository on a first deploy);
 * - **any other deploy** (a push's, a console Save's, a redeploy, an
 *   Agent's): an image-only plan — a new task definition revision, the
 *   service update to use it and the SSM changes of its own variables
 *   — nothing at all, or, while the Service's first deploy has
 *   not finished, the remainder of what its create's plan listed. Never
 *   drift: once the Service ran, a create its create plan listed is
 *   something deleted by hand, and a push stops on it as on any other.
 */
export interface Approval {
  /** The plan step this deploy's own Apply approved, or `null`. */
  readonly byApply: PlanReading | null;
  /**
   * The Service's last applied plan step, for a deploy no Apply queued
   * before any Cloud run of the Service finished; `null` once one has.
   */
  readonly listed: PlanReading | null;
  /**
   * The Apply approved a read made on the live image, and this
   * deploy builds a new one: the new image's own lines — its task
   * definition revision, its variables and the service update to use them
   * — are its to add. A put-back runs the live image, and adds nothing.
   */
  readonly newImage?: boolean;
}

/**
 * Why a deploy does not go on: AWS no longer matches what its Apply approved
 * (`stale`), or a deploy no Apply queued met more than its new image
 * (`differs`), which stops it and opens its plan for review.
 */
export type Refusal =
  | { readonly kind: 'stale'; readonly message: string }
  | { readonly kind: 'differs'; readonly detail: string };

/** The sentence a run stops with when its cloud no longer matches what its Apply approved. */
export function staleApproval(differs: string, cloudName = 'AWS'): string {
  return `${cloudName} no longer matches the plan that was applied: ${differs}. Nothing was applied; Check for changes, then apply the new plan`;
}

/** Answers why not, or `null` to go on. */
export function refusalOf(
  approval: Approval,
  now: PlanReading,
  made: ReadonlySet<string>,
  cloudName = 'AWS',
): Refusal | null {
  if (approval.byApply) {
    const compared = approval.newImage
      ? withoutImageLines
      : (reading: PlanReading) => reading;
    const differs = changesDiffer(
      compared(withoutAddresses(approval.byApply, made)),
      compared(withoutAddresses(now, made)),
    );
    return differs
      ? { kind: 'stale', message: staleApproval(differs, cloudName) }
      : null;
  }
  if (now.imageOnly || now.raw.length === 0) return null;
  const extra =
    approval.listed && !now.raw.some((line) => line.drift)
      ? unlisted(approval.listed, now)
      : `it would ${now.raw.map((line) => `${line.action} ${line.address}`).join('; ')}`;
  return extra ? { kind: 'differs', detail: extra } : null;
}

/** A refusal as the plan check that met it words it. */
export function refusalMessage(refusal: Refusal, cloudName = 'AWS'): string {
  return refusal.kind === 'stale'
    ? refusal.message
    : `${cloudDiffers(cloudName)} (${refusal.detail})`;
}

/**
 * A plan check as `beforeApply` answers it: refused, or the apply begins.
 * `variableNames` are the deploy's own, whose SSM changes keep a
 * plan image-only. `read` is the cloud's plan reader, AWS's unless given.
 */
export function checkBeforeApply(
  show: TofuShow,
  refuse: (reading: PlanReading, show: TofuShow) => string | null,
  beginApply: () => boolean,
  variableNames: readonly string[] = [],
  read: (
    show: TofuShow,
    variableNames: readonly string[],
  ) => PlanReading = readNow,
): TofuFailure | null {
  const message = refuse(read(show, variableNames), show);
  if (message) return { ok: false, reason: 'failed', message };
  if (!beginApply()) {
    return {
      ok: false,
      reason: 'interrupted',
      message: 'The run was ended before it changed anything',
    };
  }
  return null;
}

export function readNow(
  show: TofuShow,
  variableNames: readonly string[] = [],
): PlanReading {
  return readPlan({ show, tagSearch: [], context: { variableNames } });
}

/**
 * The repository's own plan on a first deploy: it may only create (or
 * adopt) the repository and its lifecycle rule, and nothing else.
 * `repository` names it as its cloud does.
 */
export function repositoryOnly(
  addresses: readonly string[],
  repository = 'ECR repository',
): (reading: PlanReading) => string | null {
  return (reading) => {
    const other = reading.raw.filter(
      (line) =>
        !addresses.includes(line.address) ||
        (line.action !== 'create' && line.action !== 'adopt'),
    );
    return other.length === 0
      ? null
      : `Making the ${repository} would also ${other.map((line) => `${line.action} ${line.address}`).join('; ')}. Nothing was applied; Check for changes, then apply the plan it shows`;
  };
}

/**
 * The Service's settings as the `web` entry its definition is written from:
 * the same fields its plan read (`CloudPlanReads`), now from the row its
 * Apply wrote. Its variables' values are not an entry's: they go to the
 * definition apart.
 */
export function webEntryOf(
  row: Pick<
    Application,
    'port' | 'command' | 'args' | 'cpuLimit' | 'memoryLimit'
  >,
): WebEntry {
  const size = sizeOf(row.cpuLimit, row.memoryLimit);
  return {
    kind: 'web',
    managed: false,
    env: [],
    buildArgs: [],
    buildSecrets: [],
    port: row.port,
    ...(row.command ? { command: row.command } : {}),
    args: row.args ?? [],
    ...(size ? { size } : {}),
  };
}

/** A Size from the two cap columns (`sizeLimits`' inverse), named when it is one. */
function sizeOf(
  cpuLimit: string | null,
  memoryLimit: string | null,
): Size | null {
  const nano = Number(cpuLimit);
  const bytes = Number(memoryLimit);
  if (!cpuLimit || !memoryLimit || !(nano > 0) || !(bytes > 0)) return null;
  const cpu = nano / 1e9;
  const memoryMb = Math.round(bytes / (1024 * 1024));
  const name = (Object.keys(SIZES) as (keyof typeof SIZES)[]).find(
    (key) => SIZES[key].cpu === cpu && SIZES[key].memoryMb === memoryMb,
  );
  return name ? { name, cpu, memoryMb } : { cpu, memoryMb };
}

/** Docker's `Architecture` as the task's runtime platform takes it. */
export function imageArchitecture(said: string): ImageArchitecture | null {
  const word = said.trim();
  return word === 'amd64' || word === 'arm64' ? word : null;
}

/**
 * The `docker image inspect` format a deploy to ECS reads its image with
 * its CPU, then its `HEALTHCHECK` as JSON (`null` for none).
 */
export const IMAGE_INSPECT_FORMAT =
  '{{.Architecture}} {{json .Config.Healthcheck}}';

/**
 * The platform a deploy that pulled for the host's own CPU reads again when
 * its image names none: an amd64 image on an ARM host is the one a store
 * keeps without the host's own CPU.
 */
const PLATFORM_READ_AGAIN = 'linux/amd64';

/** The `docker image inspect` of {@link IMAGE_INSPECT_FORMAT}, of `platform`'s variant when one is named. */
export function imageInspectArgv(
  local: string,
  platform: string | null,
): string[] {
  return [
    'docker',
    'image',
    'inspect',
    ...(platform ? ['--platform', platform] : []),
    '--format',
    IMAGE_INSPECT_FORMAT,
    local,
  ];
}

/**
 * What {@link IMAGE_INSPECT_FORMAT} says of the image a deploy pulled or
 * built on Cloudgate's host, read so a containerd image store still names
 * its CPU. That store (Docker Engine 29's default on a fresh install) keeps
 * the image index a pull names, and a plain inspect of an index pulled for
 * another CPU than the host's says no `Architecture` at all: an amd64 image
 * on an ARM host read as "built for an unknown CPU" and every deploy of it
 * to Cloud Run or ECS was refused (found in a local walk by hand). So the
 * variant the pull asked for (`pulledFor`, Cloud Run's `linux/amd64`) is read
 * first, and a pull for the host's own CPU that names none is read again
 * as {@link PLATFORM_READ_AGAIN}.
 *
 * A `--platform` read is only ever a better answer, never a new failure:
 * Docker before 28.1 (API 1.49) refuses the flag ("unknown flag", or "requires
 * API version 1.49" from a newer CLI), a store that cannot select a variant
 * refuses one it does not hold, and each falls back to the plain read, whose
 * answer and whose failure are exactly what they were before. Rejected:
 * asking the engine's version first, a second round trip every deploy
 * makes to learn what the refusal already says.
 */
export async function readImage(
  inspect: (argv: string[]) => Promise<string>,
  local: string,
  pulledFor: string | null,
): Promise<string> {
  const variant = (platform: string): Promise<string | null> =>
    inspect(imageInspectArgv(local, platform)).then(
      (said) => (inspectedImage(said).architecture ? said : null),
      () => null,
    );
  if (pulledFor) {
    return (await variant(pulledFor)) ?? inspect(imageInspectArgv(local, null));
  }
  const said = await inspect(imageInspectArgv(local, null));
  if (inspectedImage(said).architecture) return said;
  return (await variant(PLATFORM_READ_AGAIN)) ?? said;
}

/**
 * What {@link IMAGE_INSPECT_FORMAT} said of an image: its CPU, or `null` for
 * one Fargate does not run, and its `HEALTHCHECK`. `HEALTHCHECK
 * NONE`, an empty test (inherit, from an image with nothing to inherit) and
 * no check at all are each `null`. Docker always prints the check, `null`
 * when there is none, so a reply with no second word has none either.
 */
export function inspectedImage(said: string): {
  architecture: ImageArchitecture | null;
  healthCheck: ImageHealthCheck | null;
} {
  const text = said.trim();
  const space = text.search(/\s/);
  const word = space < 0 ? text : text.slice(0, space);
  const rest = space < 0 ? '' : text.slice(space).trim();
  return {
    architecture: imageArchitecture(word),
    healthCheck: rest ? imageHealthCheck(JSON.parse(rest) as unknown) : null,
  };
}

/** Docker's `.Config.Healthcheck` as the container's check takes it. */
function imageHealthCheck(config: unknown): ImageHealthCheck | null {
  if (!config || typeof config !== 'object') return null;
  const docker = config as {
    Test?: unknown;
    Interval?: unknown;
    Timeout?: unknown;
    StartPeriod?: unknown;
    Retries?: unknown;
  };
  const test = Array.isArray(docker.Test)
    ? docker.Test.filter((part): part is string => typeof part === 'string')
    : [];
  if (test[0] !== 'CMD' && test[0] !== 'CMD-SHELL') return null;
  if (test.length < 2) return null;
  const number = (value: unknown) =>
    typeof value === 'number' && value > 0 ? value : undefined;
  const check: {
    test: string[];
    interval?: number;
    timeout?: number;
    startPeriod?: number;
    retries?: number;
  } = { test };
  const interval = number(docker.Interval);
  if (interval) check.interval = interval;
  const timeout = number(docker.Timeout);
  if (timeout) check.timeout = timeout;
  const startPeriod = number(docker.StartPeriod);
  if (startPeriod) check.startPeriod = startPeriod;
  const retries = number(docker.Retries);
  if (retries) check.retries = retries;
  return check;
}

/** The fields of an Application that say which image its deploy left on the platform host. */
export type LocalImageSource = Pick<
  Application,
  'sourceType' | 'dockerImage' | 'appName'
>;

/**
 * Whether the local image is this Application's own build output, rather
 * than a docker source's image the operator named. The one place the two are
 * told apart, for {@link localImageOf} and {@link pushProgram} alike.
 */
export function isOwnBuild(app: LocalImageSource): boolean {
  return app.sourceType !== 'docker';
}

/**
 * The image a build left on the platform host: `<appName>:latest` for this
 * Application's own build (as the deploy engine names it), the pulled image
 * of a docker source otherwise.
 */
export function localImageOf(app: LocalImageSource): string {
  return isOwnBuild(app) ? `${app.appName}:latest` : (app.dockerImage ?? '');
}

/**
 * The push, as one shell program on the platform host: one `docker login`
 * against a throwaway `DOCKER_CONFIG` (`registry-login.ts`' shape), the
 * password read from {@link PUSH_PASSWORD_HOLDER}, then tag, push and
 * remove what this deploy owns: the `remote` tag always, and the local image
 * only when {@link isOwnBuild} says it is this Application's own build output.
 * The build cache is not an image and stays.
 *
 * The trade-off: an image the operator named stays on the platform host
 * after a push, as it does after a Server deploy, because another Service
 * may share it, and another Service of the same Apply may have pulled it and
 * still be about to inspect it. That holds for an AWS and a Google
 * Cloud deploy alike, since both push through here.
 * Every word is `quote()`d; the password is no word of it.
 */
export function pushProgram(input: {
  registry: string;
  username: string;
  app: LocalImageSource;
  remote: string;
  logPath: string;
}): string {
  const { registry, username, app, remote, logPath } = input;
  const local = localImageOf(app);
  const owned = isOwnBuild(app) ? [remote, local] : [remote];
  const steps = [
    'set -e',
    'CG_DOCKER_CONFIG="$(mktemp -d)"',
    `trap 'rm -rf "$CG_DOCKER_CONFIG"' EXIT`,
    'export DOCKER_CONFIG="$CG_DOCKER_CONFIG"',
    `printf %s "$${PUSH_PASSWORD_HOLDER}" | docker login ${quote([registry])} -u ${quote([username])} --password-stdin >/dev/null`,
    `docker tag ${quote([local])} ${quote([remote])}`,
    `docker push ${quote([remote])}`,
    `docker image rm ${quote(owned)} >/dev/null || true`,
  ];
  return `(${steps.join('\n')}) >> ${quote([logPath])} 2>&1 < /dev/null`;
}
