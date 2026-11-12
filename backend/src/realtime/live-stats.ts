/** One `docker stats` sample in the wss handler's JSON format. */
export interface ContainerStat {
  BlockIO: string;
  CPUPerc: string;
  Container: string;
  ID: string;
  MemPerc: string;
  MemUsage: string;
  Name: string;
  NetIO: string;
}

/** The host-only disk reading. */
export interface HostDiskStats {
  diskTotal: number;
  diskUsedPercentage: number;
  diskUsage: number;
  diskFree: number;
}

/** One reading and when it was taken — the wire shape the console parses. */
interface Reading<T> {
  value: T;
  time: Date;
}

/**
 * What `/listen-docker-stats-monitoring` pushes on every tick: the reading the
 * tick just took, per stat. `disk` is the host's only; a container has none.
 */
export interface LiveStatsFrame {
  cpu: Reading<string>;
  memory: Reading<{ used: string; total: string }>;
  disk: Reading<HostDiskStats> | null;
  network: Reading<{ inputMb: string; outputMb: string }>;
  block: Reading<{ readMb: string; writeMb: string }>;
}

/**
 * The frame for one sample, built in memory from the sample itself.
 *
 * This used to be a file store: every 1300 ms tick read, appended to, capped at
 * 288 entries and rewrote five whole JSON series under `monitoring/{appName}/`
 * (~127 KB a tick), then read the newest entry back to send it. Nothing else
 * ever read those series — the card is live-only by design, and the stored
 * history is the `server_metric` / `container_metric` rows — so the store is
 * gone rather than moved into memory: a frame needs nothing but the sample it
 * reports, which keeps no per-container state to leak either. Its cap was also
 * documented as "24h of 5-minute samples"; at this tick it was ~6 minutes.
 *
 * A future chart of the live stream should keep its own bounded window, keyed
 * by socket, rather than resurrect a store keyed by a name that changes with
 * every Swarm task.
 */
export function liveStatsFrame(
  stats: ContainerStat,
  disk?: HostDiskStats,
): LiveStatsFrame {
  const time = new Date();
  // `docker stats` prints each pair as "<a> / <b>".
  const pair = (text: string) => {
    const words = text.split(' ');
    return [words[0], words[2]] as const;
  };
  const [used, total] = pair(stats.MemUsage);
  const [readMb, writeMb] = pair(stats.BlockIO);
  const [inputMb, outputMb] = pair(stats.NetIO);
  return {
    cpu: { value: stats.CPUPerc, time },
    memory: { value: { used, total }, time },
    disk: disk ? { value: disk, time } : null,
    network: { value: { inputMb, outputMb }, time },
    block: { value: { readMb, writeMb }, time },
  };
}
