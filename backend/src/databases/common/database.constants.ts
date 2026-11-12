import { customAlphabet } from 'nanoid';
import { z } from 'zod';
import {
  refuseLockedSwarm,
  updateConfigSwarmSchema,
} from '../../applications/swarm.types';
import { imageReferenceSchema } from '../../registries/dto/registry.dto';

// Password helpers, shared by every managed database engine: passwords land in
// shell-interpolated commands and container env, so shell-dangerous characters
// are rejected outright.

/** Database password: blocks shell-dangerous characters like $ ! ' " \ / and spaces. */
export const DATABASE_PASSWORD_REGEX =
  /^[a-zA-Z0-9@#%^&*()_+\-=[\]{}|;:,.<>?~`]*$/;

export const DATABASE_PASSWORD_MESSAGE =
  'Password contains invalid characters. Please avoid: $ ! \' " \\ / and space characters for database compatibility';

/**
 * The database and user a managed Postgres, MySQL or MariaDB is created with
 * an unquoted identifier, the subset all three engines read the same
 * way, within each engine's own length limit. Before this only `min(1)` held,
 * so `bad name!` was accepted and every client had to quote it from then on.
 *
 * Create only. An existing row keeps whatever it was created with, and an
 * Existing database's names are the operator's server's, not Cloudgate's.
 * Mongo is not here: it has no database column, and its root user travels
 * percent-encoded in every URI Cloudgate writes.
 */
export const DATABASE_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Each engine's limit, in characters: NAMEDATALEN - 1, and MySQL's and MariaDB's own. */
export const DATABASE_IDENTIFIER_MAX = {
  postgres: { databaseName: 63, databaseUser: 63 },
  mysql: { databaseName: 64, databaseUser: 32 },
  mariadb: { databaseName: 64, databaseUser: 80 },
} as const;

const ENGINE_LABEL = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
} as const;

export function databaseIdentifierSchema(
  engine: keyof typeof DATABASE_IDENTIFIER_MAX,
  field: 'databaseName' | 'databaseUser',
) {
  const max = DATABASE_IDENTIFIER_MAX[engine][field];
  const base = z
    .string()
    .min(1, `${field} cannot be empty`)
    .max(
      max,
      `${field} is longer than ${ENGINE_LABEL[engine]}'s ${max} characters`,
    )
    .regex(
      DATABASE_IDENTIFIER_REGEX,
      `${field} must start with a letter or underscore and hold only letters, digits and underscores`,
    );
  // PostgreSQL reserves every role starting `pg_`, on a Server as on RDS and
  // Cloud SQL.
  return engine === 'postgres' && field === 'databaseUser'
    ? base.refine(
        (value) => !value.toLowerCase().startsWith('pg_'),
        'databaseUser cannot start with pg_, which PostgreSQL reserves for its own roles',
      )
    : base;
}

/**
 * What a managed database's `dockerImage` may be (H-53).
 *
 * **H-47's column, one module over and six times over.** d70bbfc gave
 * `application.dockerImage` `imageReferenceSchema`; the six engines' copies of
 * the same column kept the shape it started from — `z.string().optional()` on
 * create, `z.string().min(1)` on update — while `PATCH /{engine}/:id` is
 * reachable by a plain member (`service:['read']`) and the stored word is what
 * `deployInternal` pulls onto the database's Server.
 *
 * **The argv is the defence here and it holds; this is not a command
 * injection.** That sink is
 * `execOnServer(remoteExec, serverId, ['docker', 'pull', found.dockerImage])`
 * — one program and its arguments, joined once behind a test — and
 * `database-service.ts` argues its own case at the call site. What was missing
 * is the other half of the sentence `builders/build-strategy.ts` states for the
 * tree: *the quoting is the defence, and every charset in the tree is
 * belt-and-braces behind it*. Behind these six there was no charset at all, and
 * the arrangement of a quoted sink standing alone has now been the wrong bet
 * three times (H-12, H-19). So the column gets a meaning rather than the
 * sink getting a second one.
 *
 * **One schema for six engines, checked rather than assumed.** The six differ
 * in the image they default to — `postgres:18`, `mysql:8`, `mariadb:11`,
 * `mongo:8`, `redis:8` and libsql's registry-qualified
 * `ghcr.io/tursodatabase/libsql-server:v0.24.32` — and in nothing else this
 * rule can see: no engine pins a version through a second field, and the one
 * reader that parses the word, `getPostgresMountPath`'s `postgres:(\d+)`, reads
 * it and does not constrain it. A reference is a reference on all six, so
 * `test/databases/database-image.dto.spec.ts` runs the same table against every
 * one of them and reads each engine's column default off the drizzle column
 * rather than retyping it.
 *
 * **No `allowUnset`, unlike `application.dockerImage`.** There `''` is an
 * existing spelling of "no image" that `builtImageName` reads and the API has
 * taken since the column existed. Here it never meant anything: the column is
 * NOT NULL with a default, `docker pull ''` is the deploy that follows, update
 * already refused it through `.min(1)`, and the console omits the key rather
 * than sending an empty one (`kinds.ts`'s `toCreateInput`). Create took it only
 * because `z.string().optional()` does, and `createDatabase` spreads the body
 * into the insert — so an empty string overwrote a defaulted column. The two
 * halves of the surface agree now.
 *
 * Here rather than in each engine's DTO for the reason `DATABASE_PASSWORD_REGEX`
 * is here: it is one rule the six share, and six copies of it drift (§2.4).
 */
export const databaseImageSchema = imageReferenceSchema();

/**
 * A managed database's `updateConfigSwarm` and `rollbackConfigSwarm`:
 * an Application's block, with the Docker lock list's stop-first exception
 * (`DATABASE_ORDER_MESSAGE`, ADR-0044 rule 7) read from that list, which the
 * deploy reads too (`buildDatabaseServiceSpec`), so a stored `start-first`
 * fails the Deployment rather than being forced over. Here for the
 * reason `databaseImageSchema` is: one rule the six engines share.
 */
export const databaseUpdateConfigSwarmSchema =
  updateConfigSwarmSchema.superRefine(
    refuseLockedSwarm('UpdateConfig', 'database'),
  );

/** A generated database password: 16 lowercase alphanumerics. */
export const generateDatabasePassword = customAlphabet(
  'abcdefghijklmnopqrstuvwxyz0123456789',
  16,
);
