import type { ApplicationConfigKind, BuildType } from './application.schema';

/**
 * The `configKind` write a settings edit carries, if any.
 *
 * A `web` and a `static` are one Application built two ways, and the console
 * switches between them with the build type, so an edit to or from `static`
 * moves the recorded kind with it: a console Save records that as a `kind`
 * change, which it reads off the row this edit writes. No other recorded
 * kind follows the build type: a `worker`, `web-private` or `cron` builds as
 * a `web` does and is never made `static` by one.
 */
export function configKindAfter(
  current: ApplicationConfigKind,
  buildType: BuildType | undefined,
): { configKind: 'web' | 'static' } | Record<string, never> {
  if (buildType === undefined) return {};
  if (current !== 'web' && current !== 'static') return {};
  const configKind = buildType === 'static' ? 'static' : 'web';
  return configKind === current ? {} : { configKind };
}
