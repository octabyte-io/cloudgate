import type {
  RdsPostgresVersion,
  RdsPostgresVersionReading,
} from './postgres-version';

/**
 * The MySQL major RDS offers new instances in standard support (the AWS kinds
 * spec "`mysql` on RDS"): 8.4 alone. 8.0 is paid Extended Support
 * since 1 August 2026 and 9.x is RDS's preview environment only, so
 * both refuse the plan by name rather than bill or fail at Apply.
 */
export const RDS_MYSQL_MAJORS: readonly string[] = ['8.4'];

/** What a `mysql` entry with no `version` runs on RDS: RDS's default 8.4 minor. */
export const RDS_MYSQL_DEFAULT = '8.4';

/**
 * A cloud's MySQL, as the one version rule reads a `mysql` for it, as
 * `PostgresOffer` is a cloud's PostgreSQL: the majors it offers,
 * its name in a refusal, why it refuses 8.0 and a 9.x, and whether a third
 * number may pin a minor there. RDS's is {@link RDS_MYSQL}; Cloud SQL's is
 * `cloud-sql-engines.ts`'s.
 */
export interface MysqlOffer {
  readonly majors: readonly string[];
  /** `RDS`, `Cloud SQL`. */
  readonly runner: string;
  /** Why `8.0` refuses there, before "write ...". */
  readonly refuses80: string;
  /** Why a 9.x refuses there, given its `X.Y`, before "write ...". */
  readonly refuses9: (major: string) => string;
  /**
   * Whether `8.4.<n>` pins a minor there (RDS), or refuses since the cloud
   * has no pinned minor of the major (Cloud SQL).
   */
  readonly pinsMinor: boolean;
}

export const RDS_MYSQL: MysqlOffer = {
  majors: RDS_MYSQL_MAJORS,
  runner: 'RDS',
  refuses80:
    'MySQL 8.0 runs on RDS only under paid Extended Support, which Cloudgate never chooses for you',
  refuses9: (major) =>
    `MySQL ${major} is not offered by RDS, which runs 9.x only in its preview environment`,
  pinsMinor: true,
};

/**
 * The version rule for a `mysql` on RDS: `postgres` on RDS's rule
 * (`rdsPostgresVersion`) with MySQL's numbering, where `X.Y` is the major
 * and a third number pins the minor. A major alone takes RDS's
 * default minor with automatic minor upgrades on; a pinned minor turns
 * them off. An image suffix (`-oracle`) is dropped, and the plan says so.
 * What the config wrote is what is kept.
 *
 * `image` is the saved form, `mysql:<version>`. A version RDS does not
 * offer refuses, naming it: `8.0` (paid Extended Support), any 9.x (preview
 * only), and `8`, `lts` or `latest`, which name no RDS major. On another
 * cloud the rule is the same over that cloud's `offer`, where a pinned
 * minor may refuse too (Cloud SQL).
 */
export function rdsMysqlVersion(
  entryName: string,
  image: string,
  offer: MysqlOffer = RDS_MYSQL,
): RdsPostgresVersionReading {
  const written = image.startsWith('mysql:')
    ? image.slice('mysql:'.length)
    : image;
  const at = `${entryName}.version`;
  const refuse = (message: string): RdsPostgresVersionReading => ({
    ok: false,
    refusal: { at, message: `${at}: ${message}` },
  });
  const parts = /^(\d+)\.(\d+)(?:\.(\d+))?(.*)$/.exec(written);
  if (!parts) {
    return refuse(
      `${written} names no MySQL major ${offer.runner} runs, which is written as two numbers; write "${RDS_MYSQL_DEFAULT}"`,
    );
  }
  const majorText = `${parts[1]}.${parts[2]}`;
  if (!offer.majors.includes(majorText)) {
    if (majorText === '8.0') {
      return refuse(`${offer.refuses80}; write "${RDS_MYSQL_DEFAULT}"`);
    }
    if (parts[1] === '9') {
      return refuse(
        `${offer.refuses9(majorText)}; write "${RDS_MYSQL_DEFAULT}"`,
      );
    }
    return refuse(
      `MySQL ${majorText} is not offered by ${offer.runner}; it offers ${offer.majors.join(', ')}, so write "${RDS_MYSQL_DEFAULT}"`,
    );
  }
  if (parts[3] !== undefined && !offer.pinsMinor) {
    return refuse(
      `${written} pins a MySQL minor, which ${offer.runner} cannot: it offers MySQL ${majorText} with no pinned minor and moves its minors itself; write "${majorText}"`,
    );
  }
  const minor = parts[3] === undefined ? null : Number(parts[3]);
  const rest = parts[4];
  const version: RdsPostgresVersion = {
    written,
    major: Number(majorText),
    minor,
    engineVersion: minor === null ? majorText : `${majorText}.${minor}`,
    autoMinorUpgrade: minor === null,
    droppedSuffix: rest === '' ? null : rest,
  };
  return { ok: true, version };
}
