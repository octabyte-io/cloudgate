#!/usr/bin/env node
/**
 * Restore the executable bit on node-pty's `spawn-helper`.
 *
 * **On macOS**, node-pty execs a small prebuilt `spawn-helper` binary for every
 * local pty, so every websocket gateway that spawns a process
 * (`/docker-container-logs`, `/docker-container-terminal`, `/terminal`) goes
 * through it there. pnpm extracts that binary out of its content-addressable
 * store **without its executable bit**, and node-pty's own install scripts never
 * chmod it — so on a fresh clone every one of those gateways fails with a single
 * frame of `posix_spawnp failed.`, identically for every target including
 * `/bin/sh`, which makes it read like a PATH problem rather than a permissions
 * one.
 *
 * This is a Darwin-only failure. `spawn-helper` is declared in node-pty's
 * `binding.gyp` only under `['OS=="mac"', …]` and used in `src/unix/pty.cc` only
 * inside `#if defined(__APPLE__)`; Linux goes through `forkpty(3)` and execs no
 * helper, so the artefact to check on a Linux install is `build/Release/pty.node`
 * (which is why `deploy/install.sh` asserts on that and not on this). A
 * `spawn-helper` found on a Linux box is one of the darwin prebuilds sitting
 * unused in the tarball — do not treat finding it as proof of anything.
 *
 * Wired up as the root `postinstall` so a fresh clone + install just works. It
 * fixes every prebuild it finds rather than only this platform's, so a checkout
 * shared with a macOS machine is fixed from either side. Idempotent, silent
 * unless it changes something, and a clean no-op where there is no helper to fix
 * (Windows uses conpty and ships none). Never fails the install.
 *
 * The invariant this maintains is covered by
 * `backend/test/realtime/pty-spawn-helper.spec.ts`.
 */

import { createRequire } from 'node:module';
import {
  chmodSync,
  existsSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

/** The repo root plus every workspace package directory next to it. */
function resolutionBases() {
  const bases = [repoRoot];
  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    if (entry.name.startsWith('.')) continue;
    const dir = join(repoRoot, entry.name);
    if (existsSync(join(dir, 'package.json'))) bases.push(dir);
  }
  return bases;
}

/**
 * Every installed copy of node-pty: whatever each workspace package resolves
 * (npm/yarn/pnpm-hoisted layouts) plus every version in pnpm's virtual store,
 * which is where the real files — and the wrong modes — live.
 */
function nodePtyPackageRoots() {
  const roots = new Set();

  for (const base of resolutionBases()) {
    try {
      // node-pty's entry point is `lib/index.js`; two levels up is the package.
      roots.add(dirname(dirname(require.resolve('node-pty', { paths: [base] }))));
    } catch {
      // Not installed for this package — nothing to fix from here.
    }
  }

  const virtualStore = join(repoRoot, 'node_modules', '.pnpm');
  if (existsSync(virtualStore)) {
    for (const entry of readdirSync(virtualStore, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('node-pty@')) continue;
      const root = join(virtualStore, entry.name, 'node_modules', 'node-pty');
      if (existsSync(root)) roots.add(root);
    }
  }

  // Distinct packages, not distinct symlinks to the same one.
  return [...new Set([...roots].map((root) => realpathSync(root)))];
}

/**
 * The `spawn-helper` files inside one node-pty, in the order node-pty's own
 * loader looks for its native build (`lib/utils.js`): a local build first, then
 * the prebuild for this platform. Prebuild directories are read off disk rather
 * than assumed, so no architecture is hardcoded.
 */
function spawnHelpersIn(packageRoot) {
  const helpers = [
    join(packageRoot, 'build', 'Release', 'spawn-helper'),
    join(packageRoot, 'build', 'Debug', 'spawn-helper'),
  ];

  const prebuilds = join(packageRoot, 'prebuilds');
  if (existsSync(prebuilds)) {
    for (const entry of readdirSync(prebuilds, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        helpers.push(join(prebuilds, entry.name, 'spawn-helper'));
      }
    }
  }

  return helpers.filter((helper) => existsSync(helper));
}

try {
  for (const packageRoot of nodePtyPackageRoots()) {
    for (const helper of spawnHelpersIn(packageRoot)) {
      const { mode } = statSync(helper);
      if ((mode & 0o111) === 0o111) continue; // already executable

      try {
        chmodSync(helper, mode | 0o111);
        console.log(
          `restored +x on ${relative(repoRoot, helper) || helper} (node-pty spawn-helper)`,
        );
      } catch (err) {
        console.warn(
          `warning: could not restore +x on ${helper}: ${err.message}\n` +
            '  local ptys (terminals, container logs) will fail with "posix_spawnp failed."',
        );
      }
    }
  }
} catch (err) {
  // Never break an install over this.
  console.warn(`warning: could not check node-pty's spawn-helper: ${err.message}`);
}
