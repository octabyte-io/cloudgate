import type { ParseArgsOptionDescriptor } from 'node:util';

import { CliError, usageError } from './errors.js';
import { EXIT } from './exit-codes.js';
import type { FolderLink } from './folder-link.js';
import { requireInputs } from './terminal.js';

/**
 * The shared target lookup (CLI spec, "Folder link and target lookup"): which
 * Organization, Project, Environment and Service a `link`, `deploy`, `status`,
 * `logs` or `vars` run acts on.
 *
 * Two halves, so each can be tested alone:
 *
 * - {@link targetInputs} decides **where each value comes from**: `--org
 *   --project --env --service`, then `CLOUDGATE_ORG/PROJECT/ENV/SERVICE`, then
 *   the nearest Folder link. No network.
 * - {@link resolveTarget} turns those values into the rows they name, through a
 *   {@link TargetCatalog}: each value tried as an id, then as a name ignoring
 *   case — a Service by its **Config name**. A missing level is asked about
 *   when a `choose` is given, and refused (exit 2, naming the first missing
 *   flag) when not.
 *
 * Commands do not call these directly; they call `lookUpTarget`
 * (`target-session.ts`), which also picks the Instance and the key.
 */

export type TargetLevel =
  'organization' | 'project' | 'environment' | 'service';

const LEVELS: readonly TargetLevel[] = [
  'organization',
  'project',
  'environment',
  'service',
];

/** The flags that pick a target, accepted only by the commands that act on one. */
export const TARGET_OPTIONS: Record<string, ParseArgsOptionDescriptor> = {
  org: { type: 'string' },
  project: { type: 'string' },
  env: { type: 'string' },
  service: { type: 'string' },
};

/** Each level's flag, variable and words, in one table. */
const LEVEL: Record<
  TargetLevel,
  { flag: string; option: string; env: string; noun: string; plural: string }
> = {
  organization: {
    flag: '--org',
    option: 'org',
    env: 'CLOUDGATE_ORG',
    noun: 'Organization',
    plural: 'Organizations',
  },
  project: {
    flag: '--project',
    option: 'project',
    env: 'CLOUDGATE_PROJECT',
    noun: 'Project',
    plural: 'Projects',
  },
  environment: {
    flag: '--env',
    option: 'env',
    env: 'CLOUDGATE_ENV',
    noun: 'Environment',
    plural: 'Environments',
  },
  service: {
    flag: '--service',
    option: 'service',
    env: 'CLOUDGATE_SERVICE',
    noun: 'Service',
    plural: 'Services',
  },
};

export interface TargetValue {
  value: string;
  from: 'flag' | 'env' | 'link';
}

/** The value found for each level; a level with none is absent. */
export type TargetInputs = Partial<Record<TargetLevel, TargetValue>>;

function given(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Where each level's value comes from: its flag, else its variable, else the
 * Folder link.
 *
 * **The link fills a level only while every level above it is the link's
 * too.** Its Project and Environment are ids inside its own Organization and
 * Project, so once `--org` or `--project` names another one they would point
 * at nothing, and the level is left for the run to ask about or refuse. The
 * Service's Config name is the exception, and the reason a link holds a
 * Config name rather than an id: it means the same Service wherever it is
 * looked up, which is what lets `--env production` deploy the linked Service
 * to production.
 */
export function targetInputs(input: {
  /** The command's parsed flags. */
  values: Record<string, unknown>;
  env: Record<string, string | undefined>;
  link?: FolderLink;
}): TargetInputs {
  const fromLink: Record<TargetLevel, string | undefined> = {
    organization: input.link?.organizationId,
    project: input.link?.projectId,
    environment: input.link?.environmentId,
    service: input.link?.serviceConfigName,
  };
  const inputs: TargetInputs = {};
  let linkStillApplies = true;
  for (const level of LEVELS) {
    const flag = given(input.values[LEVEL[level].option]);
    const env = given(input.env[LEVEL[level].env]);
    const linked = fromLink[level];
    if (flag) inputs[level] = { value: flag, from: 'flag' };
    else if (env) inputs[level] = { value: env, from: 'env' };
    else if (linked && (linkStillApplies || level === 'service')) {
      inputs[level] = { value: linked, from: 'link' };
    }
    if (inputs[level]?.from !== 'link') linkStillApplies = false;
  }
  return inputs;
}

/** One row a level may resolve to, as the lookup offers and matches it. */
export interface Candidate {
  id: string;
  /** What a value is matched against: a Service's Config name. */
  name: string;
  /** A word printed beside it when asking, e.g. why it is listed first. */
  note?: string;
}

export interface ServiceCandidate extends Candidate {
  /** The Service's own display name, printed only. */
  displayName: string;
  /** `application`, `compose`, `postgres`, … */
  kind: string;
}

/**
 * What the lookup reads of an Instance, in the Organization it names. The real
 * one is `instanceCatalog` (`target-session.ts`), over the API client; the
 * unit lane passes a fake.
 */
export interface TargetCatalog {
  organizations(): Promise<Candidate[]>;
  projects(organizationId: string): Promise<Candidate[]>;
  environments(organizationId: string, projectId: string): Promise<Candidate[]>;
  services(
    organizationId: string,
    environmentId: string,
  ): Promise<ServiceCandidate[]>;
}

/** What a run acts on, every level resolved. */
export interface Target {
  organization: { id: string; name: string };
  project: { id: string; name: string };
  environment: { id: string; name: string };
  service: { id: string; configName: string; name: string; kind: string };
}

export interface ResolveOptions {
  /**
   * Asks the person to pick one of `candidates` for a level nothing named.
   * Absent when the run may not ask (no terminal, `CI`, `--no-input`, `--yes`):
   * the lookup then refuses, naming the level's flag and variable.
   */
  choose?: <C extends Candidate>(
    level: TargetLevel,
    candidates: C[],
  ) => Promise<C>;
}

/**
 * Resolves every level, top down, each inside the one above it. A level with
 * a value is matched ({@link matchCandidate}); a level without one is skipped
 * when it has a single candidate and is the Organization (most people are in
 * one), asked about when `choose` is given, and refused otherwise.
 */
export async function resolveTarget(
  inputs: TargetInputs,
  catalog: TargetCatalog,
  options: ResolveOptions = {},
): Promise<Target> {
  const organization = await pick(
    'organization',
    inputs,
    await catalog.organizations(),
    'you are a member of',
    options,
  );
  const project = await pick(
    'project',
    inputs,
    await catalog.projects(organization.id),
    `in Organization ${organization.name}`,
    options,
  );
  const environment = await pick(
    'environment',
    inputs,
    await catalog.environments(organization.id, project.id),
    `in Project ${project.name}`,
    options,
  );
  const service = await pick(
    'service',
    inputs,
    await catalog.services(organization.id, environment.id),
    `in Environment ${environment.name} of Project ${project.name}`,
    options,
  );
  return {
    organization: { id: organization.id, name: organization.name },
    project: { id: project.id, name: project.name },
    environment: { id: environment.id, name: environment.name },
    service: {
      id: service.id,
      configName: service.name,
      name: service.displayName,
      kind: service.kind,
    },
  };
}

async function pick<C extends Candidate>(
  level: TargetLevel,
  inputs: TargetInputs,
  candidates: C[],
  /** Finishes "no Project "x" …": where it was looked for. */
  where: string,
  options: ResolveOptions,
): Promise<C> {
  const input = inputs[level];
  const words = LEVEL[level];
  if (input) return matchCandidate(level, input, candidates, where);

  if (level === 'organization' && candidates.length === 1) {
    return candidates[0];
  }
  // Refuses with exit 2, naming the flag, when there is no one to ask.
  requireInputs([{ name: words.noun, flag: words.flag, env: words.env }], {
    canAsk: options.choose !== undefined,
  });
  if (candidates.length === 0) throw emptyLevel(level, where);
  return options.choose!(level, candidates);
}

/**
 * The candidate a value names: the one whose id it is, else the one whose name
 * it is ignoring case. Two sharing that name is refused as wrong use, naming
 * their ids, rather than guessed between.
 */
function matchCandidate<C extends Candidate>(
  level: TargetLevel,
  input: TargetValue,
  candidates: C[],
  where: string,
): C {
  const words = LEVEL[level];
  const byId = candidates.find((candidate) => candidate.id === input.value);
  if (byId) return byId;
  const wanted = input.value.toLowerCase();
  const byName = candidates.filter(
    (candidate) => candidate.name.toLowerCase() === wanted,
  );
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw usageError(
      `${byName.length} ${words.plural} are named "${input.value}": ${byName.map((c) => c.id).join(', ')}`,
      `Pass ${words.flag} with the id of the one you mean.`,
    );
  }

  const named =
    level === 'service'
      ? `no Service with Config name "${input.value}"`
      : `no ${words.noun} "${input.value}"`;
  const hint =
    input.from === 'link' && level !== 'service'
      ? "This folder's link names it. Run cloudgate link to link the folder again."
      : candidates.length > 0
        ? `Its ${words.plural}: ${candidates.map((c) => c.name).join(', ')}.`
        : undefined;
  return failWith(`${named} ${where}`, hint);
}

function failWith(message: string, hint?: string): never {
  throw new CliError(message, EXIT.failed, hint);
}

function emptyLevel(level: TargetLevel, where: string): CliError {
  if (level === 'organization') {
    return new CliError(
      'you are not a member of any Organization',
      EXIT.failed,
    );
  }
  const holder = where.replace(/^in /, '');
  return new CliError(
    `${holder} has no ${LEVEL[level].plural}`,
    EXIT.failed,
    level === 'service'
      ? 'Make one in the console; the CLI never creates a Service.'
      : 'Make one in the console.',
  );
}
