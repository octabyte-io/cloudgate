import { BadRequestException } from '@nestjs/common';
import {
  APP_NAME_MESSAGE,
  APP_NAME_REGEX,
  cleanAppName,
  generateAppName,
} from '../../src/db/columns';

/**
 * `cleanAppName` is the mint the paths without a DTO in front of them use —
 * `ComposeService.createByTemplate` (templates and AI deploys) above all — and
 * until the fix it only trimmed, lowercased and turned spaces into hyphens, so it
 * admitted names no create DTO would: `$(id)`, a `/`, a quote. An appName is a
 * container name, a Swarm service name, a Traefik router name and a path
 * segment under `applications/`, `compose/`, `schedules/` and `patch-repos/`,
 * and every command builder that interpolates one now quotes it — this holds
 * the value itself to the same `APP_NAME_REGEX` the DTOs use, which takes
 * `appName` out of the blast radius rather than relying on each site.
 */
describe('cleanAppName', () => {
  it('still normalizes the names it always accepted', () => {
    expect(cleanAppName('  My App  ')).toBe('my-app');
    expect(cleanAppName('api.v2_beta-1')).toBe('api.v2_beta-1');
    expect(cleanAppName('MIXEDcase')).toBe('mixedcase');
  });

  it('holds its own output to APP_NAME_REGEX', () => {
    expect(APP_NAME_REGEX.test(cleanAppName('My App'))).toBe(true);
  });

  // The behavioural narrowing the app-name rule introduces, named case by case so a later
  // reader can see exactly which names stopped being accepted.
  it.each([
    ['a shell substitution', 'a$(id)'],
    ['a backtick', 'a`whoami`'],
    ['a path separator', 'apps/../etc'],
    ['a double quote', 'a"b'],
    ['a single quote', "a'b"],
    ['a semicolon', 'a;rm -rf /'],
    ['a newline', 'a\nb'],
    ['a non-ASCII letter', 'café'],
    ['nothing at all', '   '],
  ])('refuses a name carrying %s', (_case, name) => {
    expect(() => cleanAppName(name)).toThrow(BadRequestException);
  });

  // Not a tautology: the mint and the guard are two expressions, and a
  // generated default that the guard refused would refuse every create that
  // omits an appName.
  it('accepts every name generateAppName mints', () => {
    for (const type of ['app', 'compose', 'postgres', 'redis']) {
      const generated = generateAppName(type);
      expect(cleanAppName(generated)).toBe(generated);
    }
  });
});

/**
 * Every path builder joins an appName onto a root — `applications/`,
 * `compose/`, the volume-backup directory — so `..` named the directory one
 * level above the Service's own: `ownerOnlyDirectoryCommand` would `chmod 700`
 * the Cloudgate root, and `rm -rf` of "the Service's directory" would target
 * its parent. A leading `-` reads as an option to `docker`, `rm` and `chmod`,
 * and a leading `.` hides the directory and admits `.` and `..`.
 */
describe('APP_NAME_REGEX', () => {
  it.each([
    ['the current directory', '.'],
    ['the parent directory', '..'],
    ['a leading dot', '.x'],
    ['a leading hyphen', '-x'],
    ['three dots', '...'],
    ['a lone hyphen', '-'],
  ])('refuses %s', (_case, name) => {
    expect(APP_NAME_REGEX.test(name)).toBe(false);
  });

  it.each([
    ['a plain name', 'app'],
    ['a single character', 'a'],
    ['a digit first', '1app'],
    ['an underscore first', '_app'],
    ['dots, hyphens and underscores inside', 'api.v2_beta-1'],
    ['a trailing dot', 'x.'],
    ['two dots inside', 'a..b'],
  ])('accepts %s', (_case, name) => {
    expect(APP_NAME_REGEX.test(name)).toBe(true);
  });

  it('names the field and the leading-character rule in its message', () => {
    expect(APP_NAME_MESSAGE).toMatch(/^App name /);
    expect(APP_NAME_MESSAGE).toMatch(/cannot start with a dot or a hyphen/);
  });

  it.each(['.', '..', '.x', '-x', '  ..  '])(
    'cleanAppName refuses %j with that message',
    (name) => {
      expect(() => cleanAppName(name)).toThrow(APP_NAME_MESSAGE);
    },
  );
});
