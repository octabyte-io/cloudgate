import { parse } from 'dotenv';
import { z } from 'zod';

/**
 * The prefix a managed database's own `env` may not assign, because the six
 * engines use it to hand their container a credential the container's command
 * then *references* rather than spells.
 *
 * **What broke first.** `BaseDatabaseService.deployInternal` builds the
 * container's environment as `this.defaultEnv(found)` and *then* the row's own
 * `env`, and hands the concatenation to `prepareEnvironmentVariables`, whose
 * `parse` is `dotenv`'s — where the **later** assignment of a duplicated key
 * wins. So an operator who wrote `CG_REDIS_REQUIREPASS=hunter2` into a Redis's
 * env changed the password `RedisService.containerCommand`'s
 * `--requirepass "$CG_REDIS_REQUIREPASS"` made the server enforce, while
 * `redis.databasePassword` — the column the console shows and the one every
 * connection string is built from — stayed the old value. Nothing failed and
 * nothing was logged: the database simply refused the platform's own
 * credential from its next deploy onwards. The hole was left open on purpose,
 * because the holder was one name in one engine's file and the answer is a
 * statement about all six.
 *
 * **The whole prefix rather than the holders that exist today**, so the next
 * engine's holder is protected before it is written. `CG_` is already the
 * tree's holder namespace — `builders/build-env.ts`' `CG_BUILD_ENV_<n>`,
 * `scheduling/schedules/schedule-commands.ts`' `CG_SCHEDULE_COMMAND`,
 * `git-providers/strategies/docker.strategy.ts`' `CG_SOURCE_REGISTRY_PASSWORD`
 * — and every one of them exists so a secret can reach a program without
 * being a word of it. A per-name list would have to be extended by whoever
 * adds the next holder, which is exactly the edit that gets forgotten.
 *
 * **Two alternatives were rejected, and the second is the interesting one.**
 *
 * *Documenting it as operator error* fails on the mechanism: the operator is
 * never told. The assignment is accepted, the deploy succeeds, and the symptom
 * arrives later as an authentication failure against a password the console
 * displays correctly.
 *
 * *Shadowing the collision at the deploy* — dropping the operator's key so
 * `defaultEnv` wins — reads like the smaller change and is the worse one,
 * because it has to be prefix-wide to be worth anything, and prefix-wide
 * shadowing silently **deletes** an operator variable that collides with
 * nothing: `CG_MY_FEATURE_FLAG` would vanish out of the container with no
 * refusal, no log line and no way to tell from the row that it had. Refusing
 * the write cannot destroy anything, because nothing is stored yet — and it is
 * the only one of the three that tells the operator at the moment they do it
 * rather than at the next deploy or never.
 *
 * The residual is deliberate and bounded: a row written *before* this rule that
 * already carries a `CG_`-prefixed key keeps today's behaviour until its env is
 * next saved, at which point it is refused. Nothing in `src/`, in
 * `backend/test/` or in any fixture assigns a `CG_`-prefixed key to a
 * database's `env` today (checked), so this is a rule about new
 * writes and not a migration.
 *
 * **The asymmetry with {@link ENGINE_ENV_OWNERS}, stated here because two
 * rules about one concatenation is how a rule drifts.** That rule
 * covers the *engine's own* documented names — `POSTGRES_PASSWORD` and its
 * siblings — and it is enforced twice where this one is enforced once: refused
 * at the write **and** overridden at the deploy. The difference is not a change
 * of mind about shadowing, it is that the two sets are shaped differently. This
 * one is an open prefix, so shadowing it would have to delete names that
 * collide with nothing. That one is a closed list of names the platform
 * demonstrably emits for the row in hand, so shadowing deletes only an
 * assignment that genuinely collides — which is what makes the deploy-side half
 * available there and not here, and what closes the pre-rule residual this
 * paragraph's rule still carries.
 */
export const RESERVED_ENV_PREFIX = 'CG_';

/**
 * The `CG_`-prefixed keys a database `env` body assigns, in the order
 * `dotenv` yields them.
 *
 * **`dotenv`'s own `parse` and not a regex**, because the refusal has to agree
 * with the deploy about what an assignment *is*: `prepareEnvironmentVariables`
 * (`docker/docker.utils.ts`) is what `deployInternal` resolves the env through,
 * and it parses with this same function. A hand-rolled line match would differ
 * on the shapes `dotenv` accepts and the platform would refuse names it then
 * ignored, or ignore names it then honoured — `export CG_X=1`, a quoted
 * multi-line value, `CG_X = 1`. Whatever `dotenv` calls a key here is what
 * `dotenv` will call a key at deploy.
 */
export function reservedEnvKeys(env: string | null | undefined): string[] {
  if (!env) return [];
  return Object.keys(parse(env)).filter((key) =>
    key.startsWith(RESERVED_ENV_PREFIX),
  );
}

/** The six managed database engines, as their `defaultEnv` rules are keyed. */
export type DatabaseEngine =
  'postgres' | 'mysql' | 'mariadb' | 'mongo' | 'redis' | 'libsql';

/**
 * Every environment variable an engine's `defaultEnv` derives from a column,
 * mapped to the column that owns the value.
 *
 * **What broke first, and it is the `CG_` mechanism outside `CG_`'s reach.**
 * `deployInternal` concatenated `defaultEnv(row)` and *then* the row's own
 * `env`, so an operator who saved `POSTGRES_PASSWORD=other` had a container
 * whose entrypoint created the superuser with `other` while
 * `postgres.databasePassword` — what `GET /postgres/:id` answers, what the
 * console shows, what `BackupsService` authenticates its `pg_dump` with — still
 * said `stored`. The backup was the loud end of it and it arrived days later:
 * `backups/commands/utils.ts` injects the *stored* password into the dump
 * container, so every scheduled run of a database whose env carried this failed
 * authentication against its own server.
 *
 * **The decision is harder than {@link RESERVED_ENV_PREFIX}'s and lands
 * differently, which is why it is split out rather than folded in.** A
 * `CG_` name is one nothing suggests, so refusing the prefix narrowed nothing
 * anybody had. These are the upstream images' own documented interface and an
 * operator has every reason to know them, so a flat refusal on its own is a
 * behaviour change for rows that may already exist. What settles it is that
 * this set is **closed and demonstrable** where the prefix is open: it is
 * exactly the keys `defaultEnv` emits, so an override is a collision by
 * construction and never a bystander. That makes both halves available, and
 * neither is sufficient alone:
 *
 * - **Overridden at the deploy**, because it is the only half that reaches a
 *   row that is already wrong. A refusal at the write cannot help a row whose
 *   env was saved before the rule, and those are the rows the ticket is about.
 * - **Refused at the write**, because the deploy half on its own is the thing
 *   that was rejected: it discards what an operator typed and says nothing. Here
 *   the write is the one moment the operator is present to be told, and the
 *   message names the column that owns the value, so the answer is *"change it
 *   there"* rather than *"you may not"*.
 *
 * **What was measured before choosing, because the ticket asks for it.**
 * Nothing in `src/`, `backend/test/`, `drizzle/`, the console or any fixture
 * assigns one of these names to a database's `env`. The one in-tree assignment
 * of *any* engine name is `test/databases/mongo.e2e-spec.ts`' `env:
 * 'MONGO_INITDB_DATABASE=analytics'`, and that name is not in this map — it is
 * not derived from a column and nothing in mongo emits it any more, so that
 * body is still accepted. And the refusal is deliberately confined
 * to derived names: `POSTGRES_HOST_AUTH_METHOD`, `POSTGRES_INITDB_ARGS`,
 * `PGDATA`, `MYSQL_ALLOW_EMPTY_PASSWORD` and every other documented image
 * variable the platform does not emit stay the operator's to set.
 *
 * **How much an override was ever worth is engine-specific, and it matters to
 * what the fix claims.** On postgres, mysql, mariadb and a non-replica-set
 * mongo these are read by the image's own entrypoint at *first boot only*, so
 * an operator who set one against an initialised volume has a container whose
 * environment disagrees with its own data directory and a server still wanting
 * the stored credential — the fix takes away a lever that was mostly not
 * working, and takes it away completely on the next `rebuild`. Two engines are
 * not like that. LibSQL's `SQLD_HTTP_AUTH` is read by `sqld` on **every**
 * start, so an override there was a live, permanent authentication change.
 * Redis's `REDIS_PASSWORD` is the mirror image and inert: what the server
 * enforces comes from `CG_REDIS_REQUIREPASS`, so overriding `REDIS_PASSWORD`
 * only ever misinformed the operator's own applications. Both are in the map
 * anyway — the value belongs to a column either way, and an engine's
 * entrypoint is not this file's to predict.
 *
 * Keyed by engine and declared here rather than in the six services, for the
 * reason `DATABASE_PASSWORD_REGEX` and `databaseImageSchema` live in
 * `database.constants.ts`: it is one rule the six engines hold, and six copies
 * of it drift (CODING_STANDARDS §2.4). `test/databases/reserved-env.spec.ts`
 * runs each engine's `defaultEnv` over both of its branches and fails if it
 * emits a derived name this map does not carry.
 */
export const ENGINE_ENV_OWNERS: Readonly<
  Record<DatabaseEngine, Readonly<Record<string, string>>>
> = {
  postgres: {
    POSTGRES_DB: 'databaseName',
    POSTGRES_USER: 'databaseUser',
    POSTGRES_PASSWORD: 'databasePassword',
  },
  mysql: {
    MYSQL_DATABASE: 'databaseName',
    MYSQL_USER: 'databaseUser',
    MYSQL_PASSWORD: 'databasePassword',
    MYSQL_ROOT_PASSWORD: 'databaseRootPassword',
  },
  mariadb: {
    MARIADB_DATABASE: 'databaseName',
    MARIADB_USER: 'databaseUser',
    MARIADB_PASSWORD: 'databasePassword',
    MARIADB_ROOT_PASSWORD: 'databaseRootPassword',
  },
  mongo: {
    MONGO_INITDB_ROOT_USERNAME: 'databaseUser',
    MONGO_INITDB_ROOT_PASSWORD: 'databasePassword',
  },
  redis: {
    REDIS_PASSWORD: 'databasePassword',
  },
  libsql: {
    SQLD_NODE: 'sqldNode',
    SQLD_HTTP_AUTH: 'databaseUser and databasePassword',
    SQLD_PRIMARY_URL: 'sqldPrimaryUrl',
  },
};

/**
 * The engine-owned keys a database `env` body assigns, paired with the column
 * that owns each.
 *
 * `dotenv`'s `parse` for {@link reservedEnvKeys}' reason, and it is the same
 * reason twice over here: the deploy resolves this body through the same
 * function, so whatever it calls a key is what the override will collide with.
 */
export function engineOwnedEnvKeys(
  env: string | null | undefined,
  engine: DatabaseEngine,
): { key: string; column: string }[] {
  if (!env) return [];
  const owners = ENGINE_ENV_OWNERS[engine];
  return Object.keys(parse(env))
    .filter((key) => key in owners)
    .map((key) => ({ key, column: owners[key] }));
}

/**
 * The `env` field of one engine's `save{Engine}Environment` body.
 *
 * A function of the engine rather than a shared constant, because
 * {@link ENGINE_ENV_OWNERS} is per-engine: `MYSQL_ROOT_PASSWORD` is a name
 * mysql and mariadb own and postgres has no opinion about, and refusing every
 * engine's names on every engine would take `MONGO_INITDB_ROOT_PASSWORD` away
 * from a postgres row that has no such variable. The `CG_` half is engine-wide
 * and stays so.
 *
 * `saveEnvironment` is the only writer of the column — `env` is absent from
 * every engine's create and update schema, and zod strips unknown keys — so
 * this one seam covers the surface.
 *
 * **Two issues rather than one**, so a paste that trips both rules is answered
 * once and each sentence says what to do about its own keys: the `CG_` names
 * want renaming, the engine's names want a different route.
 */
export function databaseEnvSchema(engine: DatabaseEngine) {
  return z
    .string()
    .nullable()
    .superRefine((env, ctx) => {
      const reserved = reservedEnvKeys(env);
      if (reserved.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message:
            `${reserved.join(', ')} ${reserved.length === 1 ? 'is' : 'are'} reserved: ` +
            `Cloudgate hands a managed database's own credentials to its container under ` +
            `${RESERVED_ENV_PREFIX}-prefixed names, and an assignment here wins over them at ` +
            `deploy — so the server would enforce a credential this platform does not know, ` +
            `while the stored one stayed unchanged. Rename the variable.`,
        });
      }

      const owned = engineOwnedEnvKeys(env, engine);
      if (owned.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message:
            `${owned.map(({ key, column }) => `${key} is ${column}'s`).join(', ')}: ` +
            `Cloudgate derives ${owned.length === 1 ? 'it' : 'them'} from the row and gives the ` +
            `container the stored value, so an assignment here is overridden at deploy rather ` +
            `than honoured. Change the ` +
            `${owned.length === 1 ? 'column' : 'columns'} instead and the container follows.`,
        });
      }
    });
}

/**
 * The container's environment: the operator's resolved variables with the
 * engine's own, derived ones laid over the top.
 *
 * **Pairs and not text, which is the whole of item 2 as well as item 1.**
 * `defaultEnv` used to return a dotenv *body* — `POSTGRES_DB="${row.databaseName}"`
 * — because `deployInternal` concatenated it with the operator's `env` and
 * parsed the pair together. `databaseName` and `databaseUser` are
 * `z.string().min(1)` with no charset, so that interpolation was an injection
 * into `ContainerSpec.Env`: measured on dotenv 17.4.2, a `databaseName` of
 * `shop"\nPOSTGRES_HOST_AUTH_METHOD=trust\n"x` closed the quoted value at the
 * first `"` and the remainder of the column became further dotenv lines, so the
 * deployed service carried `POSTGRES_HOST_AUTH_METHOD=trust` — a postgres that
 * accepts any password on a fresh volume — from a `POST /postgres` body. It also
 * broke `prepareEnvironmentVariables`' own stated invariant, that "the output
 * keys are the *service's* keys … which is why the reach is a substitution
 * rather than an injection", which is a property ADR-0014 rests an
 * authorization decision on.
 *
 * A Docker `Env` entry is a `KEY=value` string in an array and has no quoting
 * layer at all, so an engine's derived values never needed to be text. Once
 * they are pairs the value reaches the container byte-exact and there is
 * nothing to escape.
 *
 * **Escaping the emitter was the alternative and it cannot be made correct.**
 * Measured against dotenv 17.4.2: a double-quoted value turns a literal `\n`
 * into a newline and leaves `\"` as a backslash and a quote, a single-quoted
 * one has no escape for `'`, a backtick-quoted one none for a backtick, and the
 * unquoted fallback truncates at `#`. There is no quoting form that round-trips
 * an arbitrary string, so an escaper would have been a charset in disguise.
 *
 * **And a charset on the columns was the other**, rejected because
 * `DATABASE_NAME_REGEX` (`backups/dto/backup.dto.ts`) already weighed exactly
 * this column and declined it — *"that value is the container's
 * `POSTGRES_DB`-style environment, not a word in this module's pipeline"* — and
 * because narrowing a column that already holds values is a behaviour change on
 * the update path for every existing row. Pairs keep every row that works today
 * working, which is what the fix had to do.
 *
 * **The override is a filter and not an ordering.** Putting the engine's pairs
 * last and letting dotenv's later-wins do the work would have been one line,
 * and it hands the operator's body the ability to swallow the platform's
 * credentials with an unterminated quote. Dropping the colliding operator entry
 * outright is the same outcome and cannot be arranged around; `overridden` names
 * what was dropped so {@link BaseDatabaseService.deployInternal} can log it,
 * which is the answer to the one real objection to shadowing.
 */
export function withEngineEnv(
  operatorEnv: string[],
  engineEnv: Record<string, string>,
): { env: string[]; overridden: string[] } {
  const overridden: string[] = [];
  const kept = operatorEnv.filter((pair) => {
    const key = pair.slice(0, pair.indexOf('='));
    if (!(key in engineEnv)) return true;
    overridden.push(key);
    return false;
  });
  return {
    env: [
      ...Object.entries(engineEnv).map(([key, value]) => `${key}=${value}`),
      ...kept,
    ],
    overridden,
  };
}
