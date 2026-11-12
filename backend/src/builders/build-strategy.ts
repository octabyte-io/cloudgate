import type { BuildType } from '../applications/application.schema';
import { dockerfileStrategy } from './strategies/dockerfile.strategy';
import { herokuStrategy } from './strategies/heroku.strategy';
import { nixpacksStrategy } from './strategies/nixpacks.strategy';
import { paketoStrategy } from './strategies/paketo.strategy';
import { railpackStrategy } from './strategies/railpack.strategy';
import { staticStrategy } from './strategies/static.strategy';

/**
 * The six builders, named by the column that selects one — and named *there*,
 * because this module used to name them too (item 3).
 *
 * **What broke.** This file declared its own `pgEnum('build_type', …)` with a
 * seventh member, `'drop'`, while `applications/application.schema.ts`
 * declared the same Postgres type name with six — and it is that one the
 * `application.build_type` column binds. `pgEnum` is a factory rather than a
 * registration, so two calls with one name are two unrelated objects and
 * nothing compares them: not drizzle, not the compiler, and not
 * `drizzle-kit generate`, which serializes what `db/schema.ts` re-exports and
 * has never been shown this file. The seventh member therefore reached no
 * migration, no DTO (`updateApplicationSchema`'s `buildType` has the six) and
 * no console (`frontend/…/source/builders.ts` documents "the six builders"),
 * and `dropStrategy` was a strategy in the map below that nothing could ever
 * select. Six of the seven arms were a subset of the six-member union, which is
 * why the mismatch also compiled.
 *
 * **So the enum is declared once, in the schema module that owns the column,
 * and this file imports the type.** The alternative — declaring it here and
 * having the table import it — reconciles the name just as well and was
 * rejected on blast radius: it moves a live Postgres type out of the closure
 * `drizzle-kit` diffs, to gain nothing, and the safe change is the one where
 * the database's own view of `build_type` does not move at all. The import is
 * `import type`, so `builders/` gains no runtime edge to `applications/`.
 * `test/coding-standards/pg-enum-names.spec.ts` is what fails if a third
 * declaration appears.
 *
 * **`'drop'` is gone rather than migrated, and `dropStrategy` with it.** An
 * uploaded archive is a *source*, which `sourceTypeEnum`'s own `'drop'` member
 * and `git-providers/strategies/drop.strategy.ts` already say; that
 * lane clones nothing and then builds the extracted tree with
 * whatever builder the row names — which `drop-deploy.e2e-spec.ts` pins as
 * `nixpacks` over the uploaded files, through the real upload route. A build
 * type has to answer *how the image is made*, and this one answered "it is
 * not": its program was a single `echo`, so the deploy would reach
 * `uploadImageCommands` with no `${appName}:latest` on the host — `docker tag`
 * failing the deployment where a Registry is linked, and where none is, the
 * converge asking the daemon for a bare reference it normalizes to
 * `docker.io/library/<appName>:latest` and pulls from the public registry.
 * Making it selectable would have been a migration adding a member
 * whose only behaviour is a broken deploy.
 */
export type { BuildType };

/**
 * Inputs a build strategy may need to produce its command. Pure data —
 * paths and decrypted env strings are resolved by the caller (deploy
 * engine); strategies never touch the database, network, or randomness.
 *
 * Mirrors the build-related columns of the `application` row.
 */
export interface BuildCommandInput {
  appName: string;
  /**
   * Resolved directory the source was materialized into — always a directory,
   * for every build type. The Dockerfile *file* travels separately in
   * `dockerfilePath`; the two used to share this field, which is how `-f` ended
   * up pointing at a directory.
   */
  buildAppDirectory: string;
  /**
   * Resolved path to the Dockerfile itself — `buildAppDirectory` joined with
   * the application's `dockerfile` column (dockerfile build type). Its
   * directory is the default build context unless `dockerContextPath`
   * overrides it. Defaults to `Dockerfile` inside `buildAppDirectory`.
   */
  dockerfilePath?: string | null;
  /**
   * Caller-generated unique id (a `nanoid()`) so per-build container
   * and buildx-builder names don't collide across concurrent builds.
   */
  buildNonce: string;
  /** Dotenv-style env strings; project/environment feed `${{...}}` refs. */
  env?: string | null;
  projectEnv?: string | null;
  environmentEnv?: string | null;
  cleanCache?: boolean | null;
  /** Directory of built artifacts to serve statically (nixpacks, static). */
  publishDirectory?: string | null;
  /** Serve the publish directory with SPA fallback routing (static). */
  isStaticSpa?: boolean | null;
  /** heroku/builder image tag (heroku_buildpacks). */
  herokuVersion?: string | null;
  /** railpack-frontend BUILDKIT_SYNTAX tag (railpack). */
  railpackVersion?: string | null;
  /** Dotenv-style build args / secrets (dockerfile). */
  buildArgs?: string | null;
  buildSecrets?: string | null;
  /** Multi-stage build target (dockerfile). */
  dockerBuildStage?: string | null;
  /** Resolved build-context path overriding the Dockerfile's directory. */
  dockerContextPath?: string | null;
  /** Materialize a .env next to the code before building (dockerfile). */
  createEnvFile?: boolean | null;
}

/**
 * A build strategy is a pure command builder: it returns the shell command that
 * builds the app image `<appName>`, to be executed locally or over ssh via
 * RemoteExecService.
 *
 * **Every word carrying a value goes through `quote()` from `shell-quote`.**
 * This is the rule for every command builder in the tree — the git-provider
 * strategies, the schedule commands, the Traefik writer — and it is stated here
 * because the builders are where it broke first.
 *
 * What broke: `dockerContextPath`, `dockerfile`, `dockerBuildStage`,
 * `publishDirectory` and `railpackVersion` are plain `z.string().nullable()`
 * columns set through `PATCH /applications/:id`, and they were spliced
 * unquoted into `cd …`, `docker build …`, `mkdir -p …` and `docker cp …`. The
 * result goes to `RemoteExecService` — `execAsync` on the platform host,
 * `execAsyncRemote` over SSH to a Server — so a context path of `a$(id)` ran as
 * the account that drives Docker. A double-quoted interpolation is not a fix
 * either: `$` and a backtick still substitute inside `"…"`, which is why the
 * `echo` lines are quoted the same way as the commands.
 *
 * `appName` reaches nearly every site here as well, and it is separately held
 * to `APP_NAME_REGEX` at its mint (`db/columns.ts`'s `cleanAppName`, which the
 * templates and AI deploy paths use in place of a DTO). That takes it out of
 * the blast radius, but it stands *behind* this rule rather than in place of
 * it: no site is left relying on the shape of the value it was handed.
 *
 * **Three times now, and the third is why this paragraph is longer than it
 * was.** The first was a value nobody had constrained; the second was constrained by a
 * charset and reopened as H-12, because the charset was written for a
 * double-quoted word and the word was bare — `;` `&` `|` `(` `)` `>` `<` and
 * whitespace are not in it and need no quote of their own; H-19 then found the
 * same bare `mkdir -p ${…}; … >> ${…}` shape at three more sinks
 * (`deployments.service.ts`'s `initLogFile`, `backups/run-recorder.service.ts`,
 * `volume-backups/volume-backup-commands.ts`), two of them relying on this
 * paragraph and the third — a Docker volume name — on nothing at all, and
 * live. So state it without the hedge: **the quoting is the defence, and every
 * charset in the tree is belt-and-braces behind it.** A charset is only ever
 * correct for one shell context, it sits modules and tables away from the word
 * it is supposed to be protecting, and nothing links the two — so a site that
 * leans on one is one careless edit from being defended by nothing, and cannot
 * be reviewed by reading it. "This value is already safe" is never the reason
 * a word is bare; there is no reason a word is bare.
 *
 * Two alternatives were rejected for this pass. Refusing the value (the
 * `SHELL_UNSAFE` regex in `patch/patch-repo.service.ts`) is right for a path a
 * caller browses and wrong for a legitimate `git clone` URL, and would force a
 * per-column split; giving `RemoteExecService` an argv form is the real fix and
 * would touch every builder plus the SSH transport (scoped out before, and
 * here). `quote()` was already the house precedent twice over —
 * `applications/drop-archive.ts` and `docker.utils.ts`'s
 * `getCreateFileCommand`.
 *
 * How to apply it, because getting this wrong quietly un-fixes it:
 *
 * - **Per word, never over an assembled command.** `quote([oneValue])`, at the
 *   point the word is built. `quote()` on a joined string escapes the spaces
 *   that separate the arguments and produces one long argument.
 * - **Never twice.** A helper that returns a word already `quote()`d is
 *   re-quoted at its peril: the backslashes become literal.
 *   `docker.utils.ts`'s `prepareEnvironmentVariablesForShell` was that helper
 *   and is gone — its one job was to escape an operator's env *values* into
 *   `--env` / `--build-arg` words, which is a closed defect, so an
 *   export whose only purpose was the leak is not left lying next to
 *   `build-env.ts` for the next builder to find.
 * - **A `k=v` word quotes the value, not the whole word** — `type=env,id=` and
 *   `BUILDKIT_SYNTAX=` are literals with nothing shell-special in them, and a
 *   single-quoted run inside a word concatenates (`id='a b'` is one word).
 * - **An `echo` quotes its whole message**, since the interesting characters
 *   are live inside double quotes.
 * - **`build-env.ts`'s holder name is the one word here that is deliberately
 *   not quoted, and it is not an exception to the rule.** `envFlagWord` emits
 *   `${quote([key])}"=$CG_BUILD_ENV_0"`: the operator's key goes through
 *   `quote()` like every other value, and the `$…` after it is a *variable
 *   reference this tree wrote*, whose name is a literal prefix plus an array
 *   index. `quote()` on it would escape the `$` and turn the expansion into
 *   nine literal characters — the value would stop arriving and the flag would
 *   silently pass the holder's name to the build. Nothing operator-controlled
 *   is bare.
 */
/**
 * What a strategy produces: the shell program that builds the image, and the
 * values that program reads out of its own environment rather than off a
 * command line.
 *
 * **The second field is the env leak.** Every builder used to splice the
 * *resolved values* of `application.env`, `project.env`, `environment.env`,
 * `buildArgs` and `buildSecrets` into the command — three `encryptedText`
 * columns and two more that a column literally named `buildSecrets` says are
 * secrets — and `ExecError` captures the whole command, which pino then writes
 * six times over. So a strategy now *declares* the environment its command
 * needs and never carries a value in the string; `builders/build-env.ts` holds
 * the shape and the argument, and `DeploymentEngineService.exec` hands the
 * declaration to `RemoteExecOptions.env`, where it travels as a script on the
 * SSH channel and reaches no argv, no process table and no journal.
 *
 * A strategy that needs no environment returns `{}` — that is not a formality:
 * an empty environment is what keeps a build with nothing to protect on the
 * transport it has always used, since `execAsyncRemote` only substitutes
 * `sh -s` for the login shell when there is an environment to send. Every
 * builder here reaches it through `build-env.ts`'s carrier rather than by
 * writing the literal, which is what makes it the answer for an Application
 * with no env set rather than for one strategy: the `drop` builder was the
 * hard-coded `{}` and it is gone.
 */
export interface BuildProgram {
  readonly command: string;
  readonly env: Record<string, string>;
}

export interface BuildStrategy {
  readonly buildType: BuildType;
  getProgram(input: BuildCommandInput): BuildProgram;
}

const strategies = new Map<BuildType, BuildStrategy>(
  [
    nixpacksStrategy,
    herokuStrategy,
    paketoStrategy,
    dockerfileStrategy,
    staticStrategy,
    railpackStrategy,
  ].map((s) => [s.buildType, s]),
);

export function getBuildStrategy(buildType: BuildType): BuildStrategy {
  const strategy = strategies.get(buildType);
  if (!strategy) {
    throw new Error(
      `No build strategy registered for build type "${buildType}"`,
    );
  }
  return strategy;
}

/** Dispatches to the strategy for `buildType`. The registry-upload suffix is
 * not part of the program; the deploy engine appends it (Phase 21). */
export function getBuildProgram(
  input: BuildCommandInput & { buildType: BuildType },
): BuildProgram {
  const { buildType, ...rest } = input;
  return getBuildStrategy(buildType).getProgram(rest);
}
