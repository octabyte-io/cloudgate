import { ConflictException } from '@nestjs/common';

import type { Environment } from '../db/schema';
import { CONFIG_PATH_AMBIGUOUS_CODE, unreadable } from './plan-errors';
import type { ConfigReadResult } from './reader/config-reader.port';
import type { RepositoryPlace } from './reader/repository-place';

/** The two names a move with no path looks for, in this order. */
export const DEFAULT_CONFIG_PATHS = [
  'cloudgate.yaml',
  'cloudgate.yml',
] as const;

type Copy = Extract<ConfigReadResult, { ok: true }>;

/**
 * The path a move into a repository takes when the operator names none
 * (#1344): `cloudgate.yaml` when every Environment's Config branch has only
 * that, `cloudgate.yml` when every one has only that. Answered with each
 * Environment's copy of it, so the plan and the confirm's stamp are made
 * from the very read that chose the path.
 *
 * Found **once, at the move**, and stored as the Project's one path: no read
 * after the move falls back from one name to the other. Rejected: a fallback
 * on every read, under which a second file committed later would silently
 * become the config and a plan could destroy Services nobody changed: the
 * "which record wins" problem ADR-0029 rules out.
 *
 * Refused (`CONFIG_PATH_AMBIGUOUS`) when a branch holds both names, or two
 * branches hold different ones; refused as a missing file
 * (`CONFIG_UNREADABLE`) naming both when a branch holds neither. Only
 * `file-missing` leads to the second name: an unreachable repository or a
 * missing branch is refused exactly as a read of a named path is.
 */
export async function findDefaultPath(
  environments: readonly Pick<
    Environment,
    'environmentId' | 'name' | 'configBranch'
  >[],
  at: Omit<RepositoryPlace, 'path'>,
  read: (
    place: RepositoryPlace,
    ref: string | null,
  ) => Promise<ConfigReadResult>,
): Promise<{ path: string; copies: ReadonlyMap<string, Copy> }> {
  const found: Array<{ name: string; path: string; copy: Copy }> = [];
  for (const env of environments) {
    const copies: Array<{ path: string; copy: Copy }> = [];
    let missing: Extract<ConfigReadResult, { ok: false }> | null = null;
    for (const path of DEFAULT_CONFIG_PATHS) {
      const place = { ...at, path };
      const result = await read(place, env.configBranch);
      if (result.ok) {
        copies.push({ path, copy: result });
        continue;
      }
      if (result.reason !== 'file-missing') {
        throw unreadable(env.name, place, result);
      }
      missing = result;
    }
    if (copies.length === 2) {
      throw new ConflictException({
        message: `Both ${DEFAULT_CONFIG_PATHS.join(' and ')} are in ${at.repository} on branch ${copies[0].copy.branch}; set Path to the one to use`,
        code: CONFIG_PATH_AMBIGUOUS_CODE,
      });
    }
    if (copies.length === 0 && missing !== null) {
      const branch = missing.branch ?? 'its default branch';
      throw unreadable(
        env.name,
        { ...at, path: DEFAULT_CONFIG_PATHS[0] },
        {
          ...missing,
          message: `There is no ${DEFAULT_CONFIG_PATHS.join(' or ')} in ${at.repository} on branch ${branch}`,
        },
      );
    }
    found.push({ name: env.name, ...copies[0] });
  }

  const paths = new Set(found.map(({ path }) => path));
  if (paths.size > 1) {
    const each = found
      .map(
        ({ name, path, copy }) =>
          `the ${name} Environment's branch ${copy.branch} has only ${path}`,
      )
      .join(', ');
    throw new ConflictException({
      message: `The Environments' Config branches in ${at.repository} hold different config files: ${each}; set Path to the one to use`,
      code: CONFIG_PATH_AMBIGUOUS_CODE,
    });
  }
  return {
    path: found[0]?.path ?? DEFAULT_CONFIG_PATHS[0],
    copies: new Map(
      environments.map((env, index) => [env.environmentId, found[index].copy]),
    ),
  };
}
