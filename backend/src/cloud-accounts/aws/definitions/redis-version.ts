import type { PlanRefusal } from '../../../project-config';

/**
 * The Valkey versions ElastiCache offers a node-based replication group,
 * newest last within each major, kept with the pinned AWS provider
 * and checked again by the moto lane. 7.2 is the oldest Valkey AWS
 * runs; a version outside this list refuses the plan before anything is
 * created.
 */
export const VALKEY_VERSIONS: readonly string[] = ['7.2', '8.0', '8.1'];

/**
 * A cloud's Valkey, as the one version rule reads a `redis` for it (the AWS
 * databases spec): its versions, newest last within each major, the first the
 * oldest, which every Redis of 7 or lower runs as; and its names in a
 * refusal. ElastiCache's is {@link ELASTICACHE_VALKEY}; Memorystore's is the
 * planner's own.
 */
export interface ValkeyOffer {
  readonly versions: readonly string[];
  /** `ElastiCache`: what "cannot run it". */
  readonly runner: string;
  /** `ElastiCache for Valkey`: what does not offer a version. */
  readonly product: string;
}

export const ELASTICACHE_VALKEY: ValkeyOffer = {
  versions: VALKEY_VERSIONS,
  runner: 'ElastiCache',
  product: 'ElastiCache for Valkey',
};

/** What a `redis` entry's version runs as on ElastiCache, or Memorystore. */
export interface ValkeyVersion {
  /** What the config wrote, kept as is (`8`, `8.1`, `6-alpine`). */
  readonly written: string;
  /** `engine_version`: always a major and minor ElastiCache offers. */
  readonly engineVersion: string;
  readonly major: number;
  /** The parameter group family the version takes: `valkey7`, `valkey8`. */
  readonly parameterFamily: string;
  /**
   * The written Redis version is 7 or lower, which runs as Valkey 7.2, the
   * oldest on AWS; the plan notes it. `false` for a Valkey AWS offers as
   * written.
   */
  readonly raisedToOldest: boolean;
  /** The image suffix dropped (`-alpine`), for the plan's note, or `null`. */
  readonly droppedSuffix: string | null;
}

export type ValkeyVersionReading =
  | { readonly ok: true; readonly version: ValkeyVersion }
  | { readonly ok: false; readonly refusal: PlanRefusal };

/**
 * The version rule for a `redis` on ElastiCache (the AWS databases spec "Version
 * rules"). The leading number is the major and a `.N` after it the minor;
 * an image suffix after that is dropped, and the plan says so.
 *
 * - A major alone gets AWS's newest Valkey minor of that major (`8` → 8.1).
 * - A major and minor pins it (`8.0`), when AWS offers it.
 * - `7` or lower — any Redis a Server config may run — becomes Valkey 7.2,
 *   the oldest on AWS, which the plan notes.
 * - Anything else (`9`, `8.5`) refuses, naming what AWS offers.
 *
 * What the config wrote is what is kept, so a minor AWS moves to by itself
 * is never a change. `image` is the saved form, `redis:<version>`. On
 * another cloud the rule is the same over that cloud's `offer`.
 */
export function valkeyVersion(
  entryName: string,
  image: string,
  offer: ValkeyOffer = ELASTICACHE_VALKEY,
): ValkeyVersionReading {
  const oldest = offer.versions[0];
  const written = image.startsWith('redis:')
    ? image.slice('redis:'.length)
    : image;
  const parts = /^(\d+)(?:\.(\d+))?(.*)$/.exec(written);
  if (!parts) {
    return refuse(
      entryName,
      `${entryName}.version: ${written} does not start with a Redis version number, so ${offer.runner} cannot run it; write one such as "8"`,
    );
  }
  const major = Number(parts[1]);
  const minor = parts[2] === undefined ? null : Number(parts[2]);
  const droppedSuffix = parts[3] === '' ? null : parts[3];
  const asked = minor === null ? null : `${major}.${minor}`;

  let engineVersion: string | undefined;
  let raisedToOldest = false;
  if (major <= 7) {
    engineVersion = oldest;
    raisedToOldest = asked !== oldest;
  } else if (asked === null) {
    engineVersion = offer.versions
      .filter((one) => one.startsWith(`${major}.`))
      .at(-1);
  } else if (offer.versions.includes(asked)) {
    engineVersion = asked;
  }
  if (!engineVersion) {
    return refuse(
      entryName,
      `${entryName}.version: ${asked ?? major} is not offered by ${offer.product}; it offers ${offer.versions.join(', ')}`,
    );
  }
  const runs = Number(engineVersion.split('.')[0]);
  return {
    ok: true,
    version: {
      written,
      engineVersion,
      major: runs,
      parameterFamily: `valkey${runs}`,
      raisedToOldest,
      droppedSuffix,
    },
  };
}

function refuse(entryName: string, message: string): ValkeyVersionReading {
  return { ok: false, refusal: { at: `${entryName}.version`, message } };
}
