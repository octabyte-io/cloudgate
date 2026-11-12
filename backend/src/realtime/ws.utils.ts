import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  localCloudgateDirectory,
  REMOTE_CLOUDGATE_DIRECTORY,
} from '../common/config/cloudgate-directory';

/**
 * Socket parameter validators: every query parameter that ends up in a shell
 * command is validated against a strict format first.
 */

/**
 * Docker container IDs are 64-character hex strings (or 12-char short form);
 * container names are alphanumeric with underscores, hyphens and dots.
 */
export const isValidContainerId = (id: string): boolean => {
  const hexPattern = /^[a-f0-9]{12,64}$/i;
  const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
  return hexPattern.test(id) || (namePattern.test(id) && id.length <= 128);
};

/** `tail` for docker logs: digits only, 0..10000. */
/**
 * A Compose stack's id as a socket names it, for a stack on its own Stack VM
 * (ADR-0070): a nanoid's alphabet, and nothing a shell or a path could read.
 */
export const isValidStackId = (id: string): boolean =>
  /^[A-Za-z0-9_-]{1,64}$/.test(id);

export const isValidTail = (tail: string): boolean => {
  return (
    /^\d+$/.test(tail) &&
    Number.parseInt(tail, 10) <= 10000 &&
    Number.parseInt(tail, 10) >= 0
  );
};

/** `since` for docker logs: "all" or a duration like 5s, 10m, 1h, 2d. */
export const isValidSince = (since: string): boolean => {
  return since === 'all' || /^\d+[smhd]$/.test(since);
};

/**
 * `search` is concatenated into a shell command, double-quoted — only
 * alphanumerics, space, dot, underscore and hyphen survive. Space only (not \s) to reject control characters.
 */
export const isValidSearch = (search: string): boolean => {
  return /^[a-zA-Z0-9 ._-]{0,500}$/.test(search);
};

/** The shell a container terminal may exec. */
export const isValidShell = (shell: string): boolean => {
  const allowedShells = [
    'sh',
    'bash',
    'zsh',
    'ash',
    '/bin/sh',
    '/bin/bash',
    '/bin/zsh',
    '/bin/ash',
  ];
  return allowedShells.includes(shell);
};

/** The host shell local log ptys run under. */
export const getShell = (): string => {
  switch (os.platform()) {
    case 'win32':
      return 'powershell.exe';
    case 'darwin':
      return 'zsh';
    default:
      return 'bash';
  }
};

/**
 * The path with every symlink on it resolved, so that containment cannot be
 * escaped by a link inside the tree. `fs.realpathSync` needs the path to exist
 * and a log file often does not yet, so the deepest existing ancestor is
 * resolved and the rest appended to it.
 */
const resolveThroughSymlinks = (target: string): string => {
  const resolved = path.resolve(target);
  let existing = resolved;
  const remainder: string[] = [];

  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return resolved;
    remainder.unshift(path.basename(existing));
    existing = parent;
  }

  try {
    return path.join(fs.realpathSync(existing), ...remainder);
  } catch {
    return resolved;
  }
};

/**
 * A log path is only streamed when it resolves inside the platform directory,
 * which is CLOUDGATE_DIRECTORY. Both sides are resolved through their symlinks
 * on the local branch, so neither `..` nor a link planted in the tree gets out
 * of it.
 *
 * **Defense in depth, not the security boundary (ADR-0007).** What confines a
 * caller is that `/listen-deployment` is addressed by deployment id: the path
 * reaching this function came off a deployment row the caller was already
 * checked to be entitled to, and that check is what decides who reads what.
 * This stays because a stored path can still be tainted — a row minted before
 * the tightened `APP_NAME_REGEX` can hold `..`, so a composed log path can
 * climb a segment — and because it
 * catches a path written by an earlier bug before it is followed. What it no
 * longer does is decide who may read a log.
 *
 * `serverId` picks the tree the file actually lives in. A remote build writes
 * under `REMOTE_CLOUDGATE_DIRECTORY` — the literal `/etc/cloudgate` that
 * `serverSetupCommand` creates on every Server — while a local one follows this
 * instance's own root, and the two are deliberately not the same value.
 * The remote branch compares lexically: the symlinks on that path are the
 * Server's, and resolving them against this host's filesystem would answer
 * about the wrong machine's tree.
 */
export const readValidDirectory = (
  directory: string,
  serverId?: string | null,
): boolean => {
  if (!/^[\w/. :[\]-]{1,500}$/.test(directory)) {
    return false;
  }

  const [resolvedBase, resolvedDir] = serverId
    ? [REMOTE_CLOUDGATE_DIRECTORY, path.resolve(directory)]
    : [
        resolveThroughSymlinks(localCloudgateDirectory()),
        resolveThroughSymlinks(directory),
      ];

  return (
    resolvedDir === resolvedBase ||
    resolvedDir.startsWith(resolvedBase + path.sep)
  );
};

/**
 * The docker logs invocation `/docker-container-logs` follows, one program
 * wherever the container runs (a Server or the platform host: the run target
 * carries it). It was worded twice once, the platform host's single-quoting the
 * search and a Server's double-quoting it with `'` escaped and adding
 * `--line-buffered`; `isValidSearch` admits no character either quoting treats
 * specially, and both run on a terminal, where grep line-buffers anyway, so the
 * one wording kept is the one that stays correct if that pattern ever widens.
 * The empty conditionals leave double spaces behind.
 *
 * `follow: false` (the Cloudgate CLI's `logs` without `-f`) leaves
 * `--follow` out, so the follower exits after the tail and the socket ends
 * with `outputEnded`; the console always follows.
 *
 * `taskPrefix: true` keeps Docker's per-copy prefix on a Swarm service's
 * lines (`<stamp> web.1@node    | <line>`: the stamp first, then the copy
 * padded to the widest slot number), which `--raw` strips: an
 * Application's Logs tab merges every running copy by time and names each
 * line's copy (#1341). `--no-task-ids` leaves the copy as `name.N` rather
 * than `name.N.<task id>`. An opt-in rather than the new default because the
 * database and Compose views read the stripped form and are left exactly as
 * they were. Meaningless for a single container, which has no copies.
 */
export const buildContainerLogsCommand = (params: {
  containerId: string;
  tail: string;
  since: string;
  search: string;
  runType: string | null;
  follow?: boolean;
  taskPrefix?: boolean;
}): string => {
  const { containerId, tail, since, search, runType } = params;
  const follow = params.follow ?? true;
  const swarmFlag = params.taskPrefix ? '--no-task-ids' : '--raw';
  const baseCommand = `docker ${runType === 'swarm' ? 'service' : 'container'} logs --timestamps ${
    runType === 'swarm' ? swarmFlag : ''
  } --tail ${tail} ${
    since === 'all' ? '' : `--since ${since}`
  } ${follow ? '--follow' : ''} ${containerId}`;
  if (!search) return baseCommand;
  const escapedSearch = search.replace(/'/g, "'\\''");
  return `${baseCommand} 2>&1 | grep --line-buffered -iF "${escapedSearch}"`;
};
