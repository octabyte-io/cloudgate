/**
 * The lowest Instance version this CLI works with (CLI spec, Version
 * compatibility). Raised by the CLI release that first needs a server change,
 * to the server release that ships it; never lowered. An Instance older than
 * this is refused by every command except `logout`, which must still be able
 * to forget a login to it. A newer Instance is always allowed: the server
 * keeps its routes working for older CLIs, not the other way round.
 *
 * `0.1.0` is the server version (`backend/package.json`) that first answers
 * `GET /settings/about`, the check every command makes before sending a key,
 * and the routes the commands call: device login, a key deleting itself,
 * `GET /deployments/:id`, the container-log socket's `follow=false`, the
 * Project config's repository sources and an Application's variables by name.
 * The `0.0.1` before it has none of them.
 */
export const MINIMUM_SERVER_VERSION = '0.1.0';

export type ServerVersionVerdict = 'supported' | 'older' | 'unreadable';

interface Parsed {
  core: [number, number, number];
  prerelease: string[];
}

/** `MAJOR.MINOR.PATCH[-pre][+build]`, with an optional leading `v`. */
const VERSION =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(version: string): Parsed | undefined {
  const match = VERSION.exec(version.trim());
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/** Semver precedence: numbers by value, a pre-release before its release. */
function compare(a: Parsed, b: Parsed): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = a.core[index] - b.core[index];
    if (difference !== 0) return difference;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumber = /^\d+$/.test(left);
    const rightNumber = /^\d+$/.test(right);
    if (leftNumber && rightNumber) return Number(left) - Number(right);
    if (leftNumber) return -1;
    if (rightNumber) return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Whether an Instance reporting `version` is one this CLI works with, given
 * the `minimum` it supports. `unreadable` is a version that is not semver at
 * all; the caller refuses it rather than guess.
 */
export function serverVersionAgainst(
  version: string,
  minimum: string,
): ServerVersionVerdict {
  const reported = parse(version);
  const floor = parse(minimum);
  if (!reported || !floor) return 'unreadable';
  return compare(reported, floor) < 0 ? 'older' : 'supported';
}
