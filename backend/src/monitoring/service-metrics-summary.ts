import type { ServiceType } from '../applications/application.schema';
import type { ContainerStatsRecord } from './collectors/container-stats.collector';

/**
 * A Service's container metrics as an Agent reads them (ADR-0096): a summary
 * over a window, never the raw samples the console's charts draw.
 *
 * Every figure is read off the stored samples `getContainerMetrics` answers.
 * CPU is Docker's percentage; memory is in MiB, the unit Docker counts it in
 * (the collector relabels `MiB` as `MB`); network and disk are in MB, Docker's
 * decimal units, and are its counters since the container started, as of the
 * last sample. A sample whose unit is not one Docker prints counts as no
 * figure rather than as zero.
 *
 * **Summed across the Service's containers.** A Service runs as one or more
 * containers — an Application's replicas, a Compose's services — each its own
 * series of samples, and one collection run stamps every container it
 * samples with the same time. So the summary is over collection ticks: at
 * each, CPU %, memory and the memory limit are the sums over the containers
 * sampled then, and memory % is the summed memory against the summed limit.
 * Network and disk are each container's last counters, summed. `samples`
 * counts ticks.
 */

/** Why a Service has no container metrics to summarise: a closed vocabulary. */
export const SERVICE_METRICS_UNAVAILABLE = {
  cloud:
    'Runs in a Cloud account: Cloudgate collects no container metrics there',
  platformHostNotSetUp:
    'Monitoring is not set up on the platform host, where this Service runs',
  serverNotSetUp: 'Monitoring is not set up on the Server this Service runs on',
  noSamples:
    "No samples are stored for this Service's containers: the monitoring of the Server or platform host it runs on does not collect for it, or has not sampled it yet",
  emptyWindow: 'No samples in this window',
} as const;

export interface ServiceMetricsCpu {
  nowPercent: number;
  averagePercent: number;
  peakPercent: number;
}

export interface ServiceMetricsMemory {
  nowMiB: number | null;
  averageMiB: number | null;
  peakMiB: number | null;
  limitMiB: number | null;
  nowPercent: number | null;
  peakPercent: number | null;
}

export interface ServiceMetricsNetwork {
  receivedMB: number | null;
  sentMB: number | null;
}

export interface ServiceMetricsDisk {
  readMB: number | null;
  writtenMB: number | null;
}

export interface ServiceMetricsPoint {
  at: string;
  cpuPercent: number;
  memoryMiB: number | null;
}

export interface ServiceMetricsSummary {
  serviceType: ServiceType;
  serviceId: string;
  available: boolean;
  unavailableReason: string | null;
  windowHours: number;
  since: string;
  until: string;
  samples: number;
  lastSampledAt: string | null;
  cpu: ServiceMetricsCpu | null;
  memory: ServiceMetricsMemory | null;
  network: ServiceMetricsNetwork | null;
  disk: ServiceMetricsDisk | null;
  trend: ServiceMetricsPoint[];
}

/** One stored sample: the collector's record, stamped. */
export type StoredContainerSample = ContainerStatsRecord & {
  timestamp: string;
};

export interface MetricsWindowRead {
  serviceType: ServiceType;
  serviceId: string;
  windowHours: number;
  since: string;
  until: string;
}

/** An answer with no figures, saying why. */
export function unavailableMetrics(
  window: MetricsWindowRead,
  reason: string,
): ServiceMetricsSummary {
  return {
    ...window,
    available: false,
    unavailableReason: reason,
    samples: 0,
    lastSampledAt: null,
    cpu: null,
    memory: null,
    network: null,
    disk: null,
    trend: [],
  };
}

const MEMORY_TO_MIB: Readonly<Record<string, number>> = {
  B: 1 / 1024 / 1024,
  KiB: 1 / 1024,
  MB: 1,
  MiB: 1,
  GB: 1024,
  GiB: 1024,
};

const DECIMAL_TO_MB: Readonly<Record<string, number>> = {
  B: 1e-6,
  kB: 1e-3,
  KB: 1e-3,
  MB: 1,
  GB: 1e3,
  TB: 1e6,
};

function inUnit(
  value: number,
  unit: string,
  scale: Readonly<Record<string, number>>,
): number | null {
  const factor = Object.hasOwn(scale, unit) ? scale[unit] : undefined;
  return factor === undefined ? null : value * factor;
}

const round = (value: number): number => Math.round(value * 100) / 100;

function rounded(value: number | null): number | null {
  return value === null ? null : round(value);
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** The mean and the peak of the figures that were read, or null for none. */
function spread(values: ReadonlyArray<number | null>): {
  average: number | null;
  peak: number | null;
} {
  const read = values.filter((value): value is number => value !== null);
  if (read.length === 0) return { average: null, peak: null };
  return { average: round(average(read)), peak: round(Math.max(...read)) };
}

const memoryOf = (sample: StoredContainerSample): number | null =>
  inUnit(sample.Memory.used, sample.Memory.usedUnit, MEMORY_TO_MIB);

const limitOf = (sample: StoredContainerSample): number | null =>
  inUnit(sample.Memory.total, sample.Memory.totalUnit, MEMORY_TO_MIB);

/** The sum of the figures, or null when any one of them could not be read. */
function sumOf(values: ReadonlyArray<number | null>): number | null {
  let sum = 0;
  for (const value of values) {
    if (value === null) return null;
    sum += value;
  }
  return sum;
}

/** One collection tick: every container sampled at it, summed. */
interface Tick {
  at: string;
  cpu: number;
  memory: number | null;
  limit: number | null;
  memoryPercent: number | null;
}

/** A container's stored name, as `docker stats` names it, less a leading `/`. */
const containerOf = (sample: StoredContainerSample): string =>
  sample.Name.replace(/^\//, '');

/** Each container's samples, by its name, oldest first as given. */
export function samplesByContainer(
  samples: readonly StoredContainerSample[],
): Map<string, StoredContainerSample[]> {
  const byContainer = new Map<string, StoredContainerSample[]>();
  for (const sample of samples) {
    const name = containerOf(sample);
    byContainer.set(name, [...(byContainer.get(name) ?? []), sample]);
  }
  return byContainer;
}

/** The samples as collection ticks, oldest first: each tick's containers summed. */
function ticksOf(samples: readonly StoredContainerSample[]): Tick[] {
  const byTime = new Map<string, StoredContainerSample[]>();
  for (const sample of samples) {
    byTime.set(sample.timestamp, [
      ...(byTime.get(sample.timestamp) ?? []),
      sample,
    ]);
  }
  return [...byTime.entries()]
    .sort(([a], [b]) => Date.parse(a) - Date.parse(b))
    .map(([at, sampled]) => {
      const memory = sumOf(sampled.map(memoryOf));
      const limit = sumOf(sampled.map(limitOf));
      return {
        at,
        cpu: sampled.reduce((sum, sample) => sum + sample.CPU, 0),
        memory,
        limit,
        memoryPercent:
          memory === null || limit === null || limit === 0
            ? null
            : (memory / limit) * 100,
      };
    });
}

/**
 * The samples of one or more containers, at least one, as their summary
 * (see the file's docblock): `maxPoints` trend points at most, each the mean
 * of a run of consecutive ticks, stamped with the last tick of its run.
 */
export function summarizeSamples(
  window: MetricsWindowRead,
  samples: readonly StoredContainerSample[],
  maxPoints: number,
): ServiceMetricsSummary {
  const ticks = ticksOf(samples);
  const last = ticks[ticks.length - 1];
  const cpu = ticks.map((tick) => tick.cpu);
  const memorySpread = spread(ticks.map((tick) => tick.memory));
  const percentSpread = spread(ticks.map((tick) => tick.memoryPercent));
  // Each container's counters as of its last sample in the window.
  const lastOfEach = [...samplesByContainer(samples).values()].map(
    (series) => series[series.length - 1],
  );
  const counter = (
    read: (sample: StoredContainerSample) => number | null,
  ): number | null => rounded(sumOf(lastOfEach.map(read)));

  const points = Math.min(maxPoints, ticks.length);
  const trend: ServiceMetricsPoint[] = [];
  for (let point = 0; point < points; point += 1) {
    const run = ticks.slice(
      Math.floor((point * ticks.length) / points),
      Math.floor(((point + 1) * ticks.length) / points),
    );
    trend.push({
      at: run[run.length - 1].at,
      cpuPercent: round(average(run.map((tick) => tick.cpu))),
      memoryMiB: spread(run.map((tick) => tick.memory)).average,
    });
  }

  return {
    ...window,
    available: true,
    unavailableReason: null,
    samples: ticks.length,
    lastSampledAt: last.at,
    cpu: {
      nowPercent: round(last.cpu),
      averagePercent: round(average(cpu)),
      peakPercent: round(Math.max(...cpu)),
    },
    memory: {
      nowMiB: rounded(last.memory),
      averageMiB: memorySpread.average,
      peakMiB: memorySpread.peak,
      limitMiB: rounded(last.limit),
      nowPercent: rounded(last.memoryPercent),
      peakPercent: percentSpread.peak,
    },
    network: {
      receivedMB: counter((sample) =>
        inUnit(sample.Network.input, sample.Network.inputUnit, DECIMAL_TO_MB),
      ),
      sentMB: counter((sample) =>
        inUnit(sample.Network.output, sample.Network.outputUnit, DECIMAL_TO_MB),
      ),
    },
    disk: {
      readMB: counter((sample) =>
        inUnit(sample.BlockIO.read, sample.BlockIO.readUnit, DECIMAL_TO_MB),
      ),
      writtenMB: counter((sample) =>
        inUnit(sample.BlockIO.write, sample.BlockIO.writeUnit, DECIMAL_TO_MB),
      ),
    },
    trend,
  };
}
