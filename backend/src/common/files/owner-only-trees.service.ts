import * as fs from 'node:fs';
import * as path from 'node:path';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import {
  applicationsDirectoryOn,
  composeDirectoryOn,
  logsDirectoryOn,
  schedulesDirectoryOn,
} from '../../deployment-engine/deployment-engine.paths';
import { certificatesDirectory } from '../../traefik/traefik-writer.service';
import { OWNER_ONLY_DIRECTORY_MODE, OWNER_ONLY_FILE_MODE } from './owner-only';

/**
 * The directories on this host whose every child a writer makes owner-only,
 * and what inside each child is tightened with it.
 *
 * - A **Service directory**, `applications/{appName}` or `compose/{appName}`:
 *   its `code` holds the `.env` a deploy writes and its `files` the file
 *   mounts, so `0700` on it is what shuts a local reader out of both without
 *   changing the mode a container or an image sees.
 * - A **log directory**, `logs/{appName}`: a build log is whatever the build
 *   printed.
 * - A **schedule directory**, `schedules/{appName}`: the operator's script.
 * - A **certificate directory**: a private key, which Traefik reads as root, so
 *   its files are `0600` as well.
 */
export const OWNER_ONLY_TREES: readonly {
  readonly parent: () => string;
  readonly files: boolean;
}[] = [
  { parent: () => applicationsDirectoryOn(null), files: false },
  { parent: () => composeDirectoryOn(null), files: false },
  { parent: () => logsDirectoryOn(null), files: false },
  { parent: () => schedulesDirectoryOn(null), files: false },
  { parent: () => certificatesDirectory(null), files: true },
];

/**
 * **Corrects an install an earlier version of Cloudgate wrote, at boot.**
 *
 * The writers make what they write owner-only from now on, and on a Server
 * that is also how an old directory is corrected: the next deploy, file-mount
 * write or certificate write `chmod`s it. That is not enough on its own,
 * because some of what an earlier version left is never written again — a file
 * mount is written when it is saved, not when the Service deploys, and a
 * certificate only when it is edited — so waiting for the next write would
 * leave a key readable for as long as nobody touches it. This host's tree is
 * the one the backend can reach without SSH, so it is swept here, once per
 * start. Not swept: every other Server, which would be an SSH round trip to
 * each at every boot. That is a known gap, not a corrected one — on a Server,
 * a file mount or certificate an earlier version wrote stays under an open
 * directory until that mount or certificate is next saved (a deploy corrects
 * the Service directory on the Server that builds it, not on a separate run
 * Server).
 *
 * Idempotent and cheap — one `chmod` per child — and it never throws: a tree
 * that does not exist yet (a fresh install, the test lanes' root) is skipped,
 * and a child it cannot change is logged and left, because a boot that fails
 * over a mode would take the whole product down to protect one directory.
 */
@Injectable()
export class OwnerOnlyTreesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OwnerOnlyTreesService.name);

  onApplicationBootstrap(): void {
    for (const tree of OWNER_ONLY_TREES) {
      this.tighten(tree.parent(), tree.files);
    }
  }

  private tighten(parent: string, files: boolean): void {
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const directory = path.join(parent, child.name);
      try {
        fs.chmodSync(directory, OWNER_ONLY_DIRECTORY_MODE);
        if (!files) continue;
        for (const entry of fs.readdirSync(directory, {
          withFileTypes: true,
        })) {
          if (entry.isFile()) {
            fs.chmodSync(
              path.join(directory, entry.name),
              OWNER_ONLY_FILE_MODE,
            );
          }
        }
      } catch (error) {
        this.logger.warn(
          `Could not make ${directory} owner-only: ${(error as Error).message}`,
        );
      }
    }
  }
}
