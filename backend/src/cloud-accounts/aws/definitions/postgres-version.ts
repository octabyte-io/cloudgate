import type { PlanRefusal } from '../../../project-config';

/**
 * The PostgreSQL major versions RDS offers new instances, kept with the
 * pinned AWS provider and checked again by the moto lane. A
 * version outside it refuses the plan before anything is created.
 */
export const RDS_POSTGRES_MAJORS: readonly number[] = [13, 14, 15, 16, 17, 18];

/**
 * A cloud's PostgreSQL, as the one version rule reads a `postgres` for it
 * (the AWS databases spec): the majors it offers new instances and its name in a
 * refusal. RDS's is {@link RDS_POSTGRES}; Cloud SQL's is the planner's own.
 */
export interface PostgresOffer {
  readonly majors: readonly number[];
  /** `RDS`. */
  readonly runner: string;
}

export const RDS_POSTGRES: PostgresOffer = {
  majors: RDS_POSTGRES_MAJORS,
  runner: 'RDS',
};

/** What a `postgres` entry's version runs as on RDS, or Cloud SQL. */
export interface RdsPostgresVersion {
  /** What the config wrote, kept as is (`17`, `17.2`, `17-alpine`). */
  readonly written: string;
  readonly major: number;
  /** The pinned minor, or `null` for RDS's default minor of the major. */
  readonly minor: number | null;
  /** `engine_version`: the major alone, or major and minor. */
  readonly engineVersion: string;
  /** On for a major alone, off for a pinned minor. */
  readonly autoMinorUpgrade: boolean;
  /** The image suffix dropped (`-alpine`), for the plan's note, or `null`. */
  readonly droppedSuffix: string | null;
}

export type RdsPostgresVersionReading =
  | { readonly ok: true; readonly version: RdsPostgresVersion }
  | { readonly ok: false; readonly refusal: PlanRefusal };

/**
 * The version rule for a `postgres` on RDS (the AWS databases spec "Version
 * rules"). The leading number of the version is its major; a `.N` after it
 * pins the minor, which turns automatic minor upgrades off, while a major
 * alone takes RDS's default minor with them on. Anything after that — an
 * image suffix such as `-alpine` or `-bookworm` — is dropped, and the plan
 * says so. What the config wrote is what is kept, so a minor AWS moves to by
 * itself is never a change.
 *
 * `image` is the saved form, `postgres:<version>`; a version RDS does not
 * offer refuses, naming it. On another cloud the rule is the same over
 * that cloud's `offer`.
 */
export function rdsPostgresVersion(
  entryName: string,
  image: string,
  offer: PostgresOffer = RDS_POSTGRES,
): RdsPostgresVersionReading {
  const written = image.startsWith('postgres:')
    ? image.slice('postgres:'.length)
    : image;
  const parts = /^(\d+)(?:\.(\d+))?(.*)$/.exec(written);
  if (!parts) {
    return refuse(
      entryName,
      `${entryName}.version: ${written} does not start with a PostgreSQL version number, so ${offer.runner} cannot run it; write one such as "17"`,
    );
  }
  const major = Number(parts[1]);
  const minor = parts[2] === undefined ? null : Number(parts[2]);
  const rest = parts[3];
  if (!offer.majors.includes(major)) {
    return refuse(
      entryName,
      `${entryName}.version: PostgreSQL ${major} is not offered by ${offer.runner}; it offers ${offer.majors.join(', ')}`,
    );
  }
  return {
    ok: true,
    version: {
      written,
      major,
      minor,
      engineVersion: minor === null ? String(major) : `${major}.${minor}`,
      autoMinorUpgrade: minor === null,
      droppedSuffix: rest === '' ? null : rest,
    },
  };
}

function refuse(entryName: string, message: string): RdsPostgresVersionReading {
  return { ok: false, refusal: { at: `${entryName}.version`, message } };
}
