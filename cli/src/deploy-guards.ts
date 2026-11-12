import { STUCK_DEPLOYMENT_MINUTES } from 'api-schemas';
import type { ApplicationBuildList } from 'api-schemas';

import { CliError, usageError } from './errors.js';
import { EXIT } from './exit-codes.js';
import { describeSource } from './service-status.js';
import type { ServiceSource } from './service-status.js';

/**
 * What `cloudgate deploy` checks before it uploads (deploy steps 5 and
 * 10; step 4, Applications only, is `kindRefusal` in `service-status.ts`),
 * as rules with no network: `deploy` reads the facts and acts on the verdicts. Each refuses or asks wherever going ahead would surprise
 * someone, and none ever uploads while a build reads the tree.
 */

export interface SourceFacts {
  configName: string;
  /** The Service's source now, as `status` reads it. */
  source: ServiceSource | null;
  /**
   * The repository the Project config names as its source, if any, and
   * where that config is kept; or a repository-kept config that could not be
   * read, so whether it names one is not known.
   */
  configRepository:
    | {
        keptIn: 'cloudgate' | 'repository';
        provider: string;
        repository: string;
      }
    | { keptIn: 'repository'; readable: false }
    | null;
  /** `--switch-source`: the only yes besides the terminal's. */
  switchSource: boolean;
  canAsk: boolean;
}

export type SourceVerdict =
  | { kind: 'go' }
  | { kind: 'ask'; question: string }
  | { kind: 'refuse'; error: CliError };

/**
 * Step 5. An upload switches the source to uploaded files for good, so:
 *
 * - a repository named by a Project config kept in a repository is the
 *   file's: refused every time, `--switch-source` or not, until the entry is
 *   `managed: console`, because the file is the record and its next plan
 *   would put the repository back. A repository-kept config that could not
 *   be read is refused the same way, since it may name one. A Cloudgate-kept
 *   config is kept in step
 *   with the Service: the upload, a console Save, rewrites its entry
 *   as `managed: console` itself, so that Service is asked about as the git
 *   source it is;
 * - a git or image source is asked about once in a terminal, and without one
 *   refused (exit 2) unless `--switch-source` says yes;
 * - uploaded files, or a new Service with no source set yet (a GitHub source
 *   naming no repository, an image source naming no image), ask nothing.
 */
export function sourceVerdict(facts: SourceFacts): SourceVerdict {
  const { configName, source, configRepository } = facts;
  if (configRepository && 'readable' in configRepository) {
    return {
      kind: 'refuse',
      error: new CliError(
        `the Project config is kept in a repository and could not be read, so whether it names ${configName}'s source is not known`,
        EXIT.failed,
        "Fix the Project config, or the Instance's access to its repository, then deploy again.",
      ),
    };
  }
  if (configRepository?.keptIn === 'repository') {
    return {
      kind: 'refuse',
      error: new CliError(
        `the Project config names ${configRepository.provider} ${configRepository.repository} as ${configName}'s source, and it is kept in a repository, so its next plan would undo an upload`,
        EXIT.failed,
        `List ${configName} as managed: console in the Project config first, then deploy again.`,
      ),
    };
  }
  const current = switchedFrom(source);
  if (!current || facts.switchSource) return { kind: 'go' };
  const what = `${configName} ${current}`;
  if (facts.canAsk) {
    return {
      kind: 'ask',
      question: `${what}. Deploying this folder switches it to uploaded files. Continue?`,
    };
  }
  return {
    kind: 'refuse',
    error: usageError(
      `${what}, and deploying this folder switches it to uploaded files`,
      'Pass --switch-source to switch it.',
    ),
  };
}

/** What an upload would switch away from, in words; none for nothing to switch. */
function switchedFrom(source: ServiceSource | null): string | undefined {
  if (!source) return undefined;
  switch (source.type) {
    case 'uploaded':
      return undefined;
    case 'raw':
      return undefined;
    case 'image':
      return source.image ? `runs ${describeSource(source)}` : undefined;
    case 'git':
      if (source.provider === 'git') return 'builds from a git repository';
      return source.repository
        ? `builds from ${describeSource(source)}`
        : undefined;
  }
}

export type BuildRow = ApplicationBuildList[number];

export type BuildVerdict =
  { kind: 'wait'; deploymentId: string } | { kind: 'go'; warnings: string[] };

/**
 * Step 10: wait while the Service has a build pending or running, the
 * running one first; go ahead, with a warning naming it, past one that is
 * held by a plan or has been pending or running for more than
 * {@link STUCK_DEPLOYMENT_MINUTES} (CLI spec, "very old"). The server
 * draws the same line for its 409, so going ahead past a stuck build is not
 * refused. A preview's builds, a Cron service's runs and rows for another
 * Service in the list read no uploaded tree and are not waited for.
 */
export function runningBuildVerdict(
  applicationId: string,
  rows: readonly BuildRow[],
  now: Date,
): BuildVerdict {
  const builds = rows.filter(
    (row) =>
      row.applicationId === applicationId &&
      !row.previewDeploymentId &&
      (row.cronRun === null || row.cronRun === undefined),
  );
  const minutesOf = (row: BuildRow) =>
    (now.getTime() - Date.parse(row.createdAt)) / 60_000;
  const inProgress = builds.filter(
    (row) => row.status === 'pending' || row.status === 'running',
  );
  const fresh = inProgress.filter(
    (row) => !(minutesOf(row) > STUCK_DEPLOYMENT_MINUTES),
  );
  const waitedFor = fresh.find((row) => row.status === 'running') ?? fresh[0];
  if (waitedFor) return { kind: 'wait', deploymentId: waitedFor.deploymentId };

  const warnings = builds.flatMap((row) => {
    if (row.status === 'held') {
      return [
        `Warning: Deployment ${row.deploymentId} is held by a plan; deploying without waiting for it.`,
      ];
    }
    if (inProgress.includes(row)) {
      return [
        `Warning: Deployment ${row.deploymentId} has been ${row.status} for ${hoursAndMinutes(minutesOf(row))}; deploying without waiting for it.`,
      ];
    }
    return [];
  });
  return { kind: 'go', warnings };
}

/** `1h 15m`, `45m`. */
function hoursAndMinutes(minutes: number): string {
  const whole = Math.floor(minutes);
  const hours = Math.floor(whole / 60);
  return hours > 0 ? `${hours}h ${whole % 60}m` : `${whole}m`;
}
