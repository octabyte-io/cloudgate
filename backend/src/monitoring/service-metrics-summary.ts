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
 */

/** Why a Service has no container metrics to summarise: a closed vocabulary. */
export const SERVICE_METRICS_UNAVAILABLE = {
  cloud:
    'Runs in a Cloud account: Cloudgate collects no container metrics there',
  platformHostNotSetUp:
    'Monitoring is not set up on the platform host, where this Service runs',
  serverNotSetUp: 'Monitoring is not set up on the Server this Service runs on',
  noSamples:
    "No samples are stored for this Service's containers: its host's monitoring does not collect for it, or has not sampled it yet",
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
  nowPercent: number;
  peakPercent: number;
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

/**
 * The samples, oldest first and at least one, as their summary: `maxPoints`
 * trend points at most, each the mean of a run of consecutive samples,
 * stamped with the last sample of its run.
 */
export function summarizeSamples(
  window: MetricsWindowRead,
  samples: readonly StoredContainerSample[],
  maxPoints: number,
): ServiceMetricsSummary {
  const last = samples[samples.length - 1];
  const cpu = samples.map((sample) => sample.CPU);
  const memory = samples.map(memoryOf);
  const memorySpread = spread(memory);

  const points = Math.min(maxPoints, samples.length);
  const trend: ServiceMetricsPoint[] = [];
  for (let point = 0; point < points; point += 1) {
    const run = samples.slice(
      Math.floor((point * samples.length) / points),
      Math.floor(((point + 1) * samples.length) / points),
    );
    trend.push({
      at: run[run.length - 1].timestamp,
      cpuPercent: round(average(run.map((sample) => sample.CPU))),
      memoryMiB: spread(run.map(memoryOf)).average,
    });
  }

  return {
    ...window,
    available: true,
    unavailableReason: null,
    samples: samples.length,
    lastSampledAt: last.timestamp,
    cpu: {
      nowPercent: round(last.CPU),
      averagePercent: round(average(cpu)),
      peakPercent: round(Math.max(...cpu)),
    },
    memory: {
      nowMiB: rounded(memoryOf(last)),
      averageMiB: memorySpread.average,
      peakMiB: memorySpread.peak,
      limitMiB: rounded(
        inUnit(last.Memory.total, last.Memory.totalUnit, MEMORY_TO_MIB),
      ),
      nowPercent: round(last.Memory.percentage),
      peakPercent: round(
        Math.max(...samples.map((sample) => sample.Memory.percentage)),
      ),
    },
    network: {
      receivedMB: rounded(
        inUnit(last.Network.input, last.Network.inputUnit, DECIMAL_TO_MB),
      ),
      sentMB: rounded(
        inUnit(last.Network.output, last.Network.outputUnit, DECIMAL_TO_MB),
      ),
    },
    disk: {
      readMB: rounded(
        inUnit(last.BlockIO.read, last.BlockIO.readUnit, DECIMAL_TO_MB),
      ),
      writtenMB: rounded(
        inUnit(last.BlockIO.write, last.BlockIO.writeUnit, DECIMAL_TO_MB),
      ),
    },
    trend,
  };
}
