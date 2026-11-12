import {
  isUnmeasuredSample,
  parseServerStats,
} from '../../src/monitoring/collectors/server-stats.collector';

/**
 * A question from the stats review. `SERVER_STATS_COMMAND` reads `/proc`, and it is a
 * `;`-joined list whose last member ends in `|| true` — so on a host with no
 * `/proc` every section comes back empty, the shell still exits 0, and
 * `parseServerStats` returns a **well-formed sample of zeros** rather than
 * failing. An earlier change made the web server a collection target, which means that
 * sample now gets stored: a row saying this machine has 0% CPU, no memory
 * fitted and no disk.
 *
 * The frontend already refuses to draw that (`live-card.tsx`'s `isUnmeasured`,
 * over the stats socket, which has the same parser underneath), and the rule it
 * uses is the one worth reproducing here rather than inventing a second shape
 * for: **test the totals, not the values.** A real host really can sit at 0%
 * CPU with nothing on the network — calling that unmeasured would hide a
 * genuinely idle machine. Nothing has zero bytes of memory fitted.
 */

const sections = (body: string) => body;

/** What this machine's own shell answers: markers, and nothing under them. */
const NO_PROC_OUTPUT = sections(`===CLOUDGATE_CPU===
===CLOUDGATE_CPUINFO===
===CLOUDGATE_MEMINFO===
===CLOUDGATE_DISK===
===CLOUDGATE_NET===
===CLOUDGATE_UPTIME===
===CLOUDGATE_HOST===
25.5.0
arm64
===CLOUDGATE_OS===
`);

describe('isUnmeasuredSample', () => {
  it('rejects the sample a host with no /proc produces', () => {
    const sample = parseServerStats(NO_PROC_OUTPUT);

    // The parser did not fail, which is the whole problem: it answered a
    // complete sample, with a kernel and an architecture on it.
    expect(sample.kernel).toBe('25.5.0');
    expect(sample.arch).toBe('arm64');
    expect(sample.memTotal).toBe(0);
    expect(sample.totalDisk).toBe(0);

    expect(isUnmeasuredSample(sample)).toBe(true);
  });

  it('accepts a host that is genuinely doing nothing', () => {
    // Two identical /proc/stat samples (0% busy), no traffic on any NIC, a
    // freshly booted host — and 8 GB of memory in 100 GB of disk. Every
    // *value* a busy host would move is zero here and this is still a
    // measurement, which is why the guard reads the totals.
    const sample = parseServerStats(`===CLOUDGATE_CPU===
cpu  1000 50 300 8000 200 0 50 0 0 0
cpu  1000 50 300 8000 200 0 50 0 0 0
===CLOUDGATE_MEMINFO===
MemTotal:        8388608 kB
MemAvailable:    8388608 kB
===CLOUDGATE_DISK===
Filesystem        1-blocks        Used   Available Capacity Mounted on
/dev/vda1     107374182400           0 107374182400       0% /
===CLOUDGATE_NET===
    lo: 0    0    0    0    0     0          0         0  0    0    0    0    0     0       0          0
===CLOUDGATE_UPTIME===
0.42 0.42
===CLOUDGATE_HOST===
5.15.0-91-generic
x86_64
2
===CLOUDGATE_OS===
PRETTY_NAME="Ubuntu 22.04.3 LTS"
`);

    expect(sample.cpu).toBe(0);
    expect(sample.memUsed).toBe(0);
    expect(sample.diskUsed).toBe(0);
    expect(sample.networkIn).toBe(0);
    expect(sample.uptime).toBe(0);

    expect(isUnmeasuredSample(sample)).toBe(false);
  });

  it('accepts a host whose memory was read but whose disk was not', () => {
    // A `df` that failed on its own — the composite command's other sections
    // still answered — is a partial reading, not an absent one. Requiring both
    // totals to be zero is what keeps this a measurement.
    const sample = parseServerStats(`===CLOUDGATE_MEMINFO===
MemTotal:        8388608 kB
MemAvailable:    2097152 kB
===CLOUDGATE_DISK===
df: unrecognized option: B
`);

    expect(sample.memTotal).toBe(8);
    expect(sample.totalDisk).toBe(0);

    expect(isUnmeasuredSample(sample)).toBe(false);
  });
});
