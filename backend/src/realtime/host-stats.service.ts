import { Injectable } from '@nestjs/common';
import {
  parseServerStats,
  SERVER_STATS_COMMAND,
} from '../monitoring/collectors/server-stats.collector';
import { RemoteExecService } from '../remote/remote-exec.service';
import type { ContainerStat, HostDiskStats } from './live-stats';

/** gopsutil-style block IO totals: /proc/diskstats sectors × 512 bytes. */
export const HOST_DISKSTATS_COMMAND = 'cat /proc/diskstats';

/** Virtual devices excluded from block IO. */
const EXCLUDED_DEVICES = [/^loop/, /^ram/, /^sr\d+$/, /^fd\d+$/];

const BYTES_PER_SECTOR = 512;

/** docker-stats-style GiB/MiB/KiB/B labels. */
const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GiB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)}MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)}KiB`;
  }
  return `${bytes}B`;
};

/**
 * The host's own stats tile, built on Phase 41's stats collector: that
 * collector already reproduces gopsutil's math from /proc through the exec
 * seam, so the host tile reuses it and adds only a /proc/diskstats read for
 * block IO. Output keeps the docker-stats Container shape.
 */
@Injectable()
export class HostStatsService {
  constructor(private readonly remoteExec: RemoteExecService) {}

  async collect(): Promise<{ stat: ContainerStat; disk: HostDiskStats }> {
    const { stdout } = await this.remoteExec.execAsync(SERVER_STATS_COMMAND);
    const sample = parseServerStats(stdout);

    let blockReadBytes = 0;
    let blockWriteBytes = 0;
    try {
      const { stdout: diskstats } = await this.remoteExec.execAsync(
        HOST_DISKSTATS_COMMAND,
      );
      for (const line of diskstats.split('\n')) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 10) continue;
        const device = fields[2];
        if (EXCLUDED_DEVICES.some((pattern) => pattern.test(device))) continue;
        blockReadBytes += (Number(fields[5]) || 0) * BYTES_PER_SECTOR;
        blockWriteBytes += (Number(fields[9]) || 0) * BYTES_PER_SECTOR;
      }
    } catch {
      // No /proc/diskstats (non-Linux dev host): block IO stays 0.
    }

    const diskUsage = (sample.totalDisk * sample.diskUsed) / 100;

    return {
      stat: {
        CPUPerc: `${sample.cpu.toFixed(2)}%`,
        MemPerc: `${sample.memUsed.toFixed(2)}%`,
        MemUsage: `${sample.memUsedGB.toFixed(2)}GiB / ${sample.memTotal.toFixed(2)}GiB`,
        BlockIO: `${formatBytes(blockReadBytes)} / ${formatBytes(blockWriteBytes)}`,
        // MiB, which is what the collector divides by (1024²) — labelled MB
        // once, so the console read it as decimal megabytes.
        NetIO: `${sample.networkIn.toFixed(2)}MiB / ${sample.networkOut.toFixed(2)}MiB`,
        Container: 'cloudgate',
        ID: 'host-system',
        Name: 'cloudgate',
      },
      disk: {
        diskTotal: +sample.totalDisk.toFixed(2),
        diskUsedPercentage: +sample.diskUsed.toFixed(2),
        diskUsage: +diskUsage.toFixed(2),
        diskFree: +(sample.totalDisk - diskUsage).toFixed(2),
      },
    };
  }
}
