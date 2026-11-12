import { BadRequestException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  jsonb,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { customAlphabet, nanoid } from 'nanoid';
import { decryptValue, encryptValue } from '../common/encryption/encryption';
import type { ConfigLinks } from '../project-config/project-config.types';

/** Text primary key populated with a nanoid. */
export const nanoidPk = (name: string) =>
  text(name)
    .primaryKey()
    .$defaultFn(() => nanoid());

/** ISO-8601 timestamp stored as text, defaulting to now. */
export const isoTimestamp = (name: string) =>
  text(name)
    .notNull()
    .$defaultFn(() => new Date().toISOString());

// appName helpers. appNames become container/router names, so they must stay
// shell/Docker safe.
const appNameSuffix = customAlphabet('abcdefghijklmnopqrstuvwxyz123456789', 6);

/**
 * App name: letters, numbers, dots, underscores, hyphens only (no spaces), and
 * not starting with a dot or a hyphen.
 *
 * Every path builder joins an appName onto a root (the applications, compose
 * and volume-backup directories among others), so `.` and `..` named the root
 * itself or the directory above it — `ownerOnlyDirectoryCommand` would `chmod
 * 700` the Cloudgate root and an `rm -rf` of "the Service's directory" would
 * target its parent. A leading dot is refused rather than just those two so
 * `...` and hidden directories go with them; a leading hyphen reads as an
 * option to `docker`, `rm` and `chmod`. `_` may still lead: it is neither.
 * No row is migrated — a Service already holding such a name keeps it.
 */
export const APP_NAME_REGEX = /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/;

export const APP_NAME_MESSAGE =
  'App name can only contain letters, numbers, dots, underscores and hyphens, and cannot start with a dot or a hyphen';

/** Random default appName for a service type, e.g. `app-x4k2m9`. */
export const generateAppName = (type: string): string =>
  `${type}-${appNameSuffix()}`;

/**
 * Normalizes a caller-supplied appName — trimmed, lowercased, spaces to
 * hyphens — and then holds the result to `APP_NAME_REGEX`, the same constraint
 * the create DTOs put in front of the column.
 *
 * The normalization *was* the whole guard, and it only ever removed spaces:
 * every create DTO validates `appName` with `APP_NAME_REGEX`, but the template
 * and AI deploy paths insert through `ComposeService.createByTemplate`, which
 * has no DTO in front of it, so a minted name carrying `$(…)`, a backtick or a
 * `/` reached every command builder that interpolates an appName — and an
 * appName reaches a great many of them, as a container name, a Swarm service
 * name, a Traefik router name and a path segment under
 * `{applications,compose,schedules,patch-repos}/{appName}`.
 * `patch/patch-repo.service.ts`'s `resolveRepoPath` documents exactly this gap
 * and was the only site that defended against it; this closes it at the mint
 * instead, which takes `appName` out of the blast radius of all of them.
 *
 * Rejecting rather than sanitizing further: a name that has to be rewritten to
 * be safe is not the name the caller asked for, and silently mangling it is how
 * a row and the container it claims come to disagree. `BadRequestException`
 * from a `db/` helper on `patch-repo.service.ts`'s and `docker.utils.ts`'s
 * precedent — §2.5's built-ins, thrown where the value is, so the four callers
 * answer 400 without four copies of the check. Defence in depth only —
 * every interpolation site quotes its own words (see
 * `builders/build-strategy.ts` for the rule), so this is not what stands
 * between a column and the build server.
 */
export const cleanAppName = (appName: string): string => {
  const cleaned = appName.trim().replace(/ /g, '-').toLowerCase();
  if (!APP_NAME_REGEX.test(cleaned)) {
    throw new BadRequestException(APP_NAME_MESSAGE);
  }
  return cleaned;
};

/** Text column encrypted at rest (AES-256-GCM keyed from APP_ENCRYPTION_SECRET). */
export const encryptedText = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'text';
  },
  toDriver(value) {
    return encryptValue(value);
  },
  fromDriver(value) {
    return decryptValue(value);
  },
});

/**
 * JSON value encrypted at rest: the same `encryptedText` wire format, over the
 * value's JSON serialization.
 *
 * A credential is not always a single string — a custom webhook authenticates
 * with a free-form header map, and `jsonb` cannot be encrypted
 * without ceasing to be `jsonb`. Serializing to JSON first makes the whole blob
 * one opaque text value, so the column keeps its typed shape for callers while
 * the driver only ever sees `enc:v1:…`. A legacy row holding plain JSON is
 * passed through by `decryptValue` and parses as before (ADR 0006).
 */
export const encryptedJson = <TData>(name: string) =>
  customType<{ data: TData; driverData: string }>({
    dataType() {
      return 'text';
    },
    toDriver(value) {
      return encryptValue(JSON.stringify(value));
    },
    fromDriver(value) {
      return JSON.parse(decryptValue(value)) as TData;
    },
  })(name);

/**
 * A Service's Config name: non-null, and minted by
 * `environments/config-name.ts`' `mintServiceConfigName` at create, never
 * taken from a request.
 */
export const configNameColumn = () => text('config_name').notNull();

/**
 * The wired variables a Service's config entry last applied (ADR-0031):
 * variable name → source Config name and Output, beside
 * `config_plan_id`. Names only, never a value: the value is built at each
 * deploy, and a linked name has no key in the Service's env blob.
 */
export const configLinksColumn = () =>
  jsonb('config_links').$type<ConfigLinks>().notNull().default({});

/**
 * When an Output one of a Service's wired variables links to last changed
 * outside a plan (ADR-0031): a login edited in the console. While
 * set, the Service reads "deploy to pick up the new value"; nothing deploys
 * it by itself, and a deploy that built its variables after this time
 * clears it. A time, never a value or a digest of one.
 */
export const wiredChangedAtColumn = () => text('wired_changed_at');

/**
 * The two constraints every Service table carries on its Config name: unique
 * within the Environment, and in the Config name's own format. Uniqueness
 * *across* the eight tables is the minting path's, under its per-Environment
 * lock; this index is the per-table backstop. The pattern is
 * the Project config's `CONFIG_NAME_REGEX`, restated in SQL.
 */
export const configNameConstraints = (
  table: string,
  t: { environmentId: AnyPgColumn; configName: AnyPgColumn },
) => [
  uniqueIndex(`${table}_environment_config_name_unique`).on(
    t.environmentId,
    t.configName,
  ),
  check(
    `${table}_config_name_format`,
    sql`${t.configName} ~ '^[a-z][a-z0-9-]{0,62}$'`,
  ),
];
