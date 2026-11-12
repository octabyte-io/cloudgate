import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { localCloudgateDirectory } from '../common/config/cloudgate-directory';

/**
 * Where older versions kept the live stream's JSON series, on this host
 * (under CLOUDGATE_DIRECTORY): one directory per watched `appName`, which
 * for a Swarm container is its task name, so every redeploy anyone watched left
 * another. Nothing writes here any more.
 */
export const monitoringDirectory = () =>
  `${localCloudgateDirectory()}/monitoring`;

/** The only files the old store ever wrote into an `appName` directory. */
const SERIES_FILES = new Set([
  'cpu.json',
  'memory.json',
  'disk.json',
  'network.json',
  'block.json',
]);

/**
 * Remove what the pre-#528 series store left under `dir`, and nothing else.
 *
 * A child is removed only if it is a real directory (not a symlink) holding
 * nothing but series files, and then file by file before an `rmdir` that
 * refuses a directory something else has written into since. `dir` itself goes
 * only if that leaves it empty. So an operator's own file, a directory with
 * anything unexpected in it, or a link pointing elsewhere is left exactly as it
 * was — the purge can only undo what the store did. Answers how many
 * directories it removed.
 */
export async function purgeLegacyStatsSeries(dir: string): Promise<number> {
  let children: Dirent[];
  try {
    children = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const series = path.join(dir, child.name);
    const entries = await fs.readdir(series, { withFileTypes: true });
    const ours = entries.every(
      (entry) => entry.isFile() && SERIES_FILES.has(entry.name),
    );
    if (!ours) continue;
    for (const entry of entries) {
      await fs.unlink(path.join(series, entry.name));
    }
    await fs.rmdir(series);
    removed += 1;
  }
  if ((await fs.readdir(dir)).length === 0) await fs.rmdir(dir);
  return removed;
}

/**
 * Clears the pre-#528 series once, at boot. Never throws: leftover scratch
 * files are not worth a boot that fails, so a purge that cannot finish is
 * logged and the rest is left for the next start.
 */
@Injectable()
export class LegacyStatsSeriesPurge implements OnApplicationBootstrap {
  private readonly logger = new Logger(LegacyStatsSeriesPurge.name);

  async onApplicationBootstrap(): Promise<void> {
    const dir = monitoringDirectory();
    try {
      const removed = await purgeLegacyStatsSeries(dir);
      if (removed > 0) {
        this.logger.log(
          `Removed ${removed} unused live-stats series director${removed === 1 ? 'y' : 'ies'} under ${dir}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Could not remove the unused live-stats series under ${dir}: ${(error as Error).message}`,
      );
    }
  }
}
