/**
 * Server-level stats collection. Cloudgate collects centrally, so one
 * composite shell command gathers the raw sources over the remote-execution
 * layer and a pure parser applies gopsutil's math:
 *  - cpu.Percent(time.Second): two /proc/stat samples a second apart,
 *    busy = total - idle - iowait over the delta.
 *  - mem.VirtualMemory: MemTotal/MemAvailable from /proc/meminfo.
 *  - disk.Usage("/"): df bytes, UsedPercent = used / (used + available).
 *  - net.IOCounters(false): /proc/net/dev bytes summed across all NICs.
 *  - host.Info: /proc/uptime, uname -r / -m; cpu.Info: /proc/cpuinfo.
 *  - getRealOS: /etc/os-release PRETTY_NAME → NAME+VERSION → NAME → ID,
 *    then the /etc/system-release red hat/centos/fedora sniffing. The Go
 *    uname -a / runtime.GOOS tail collapses to "linux" — targets are Linux.
 */

/** One server sample with the Go ServerMetric fields (timestamp added by the caller). */
export interface ServerStatsSample {
  cpu: number;
  cpuModel: string;
  cpuCores: number;
  cpuPhysicalCores: number;
  cpuSpeed: number;
  os: string;
  distro: string;
  kernel: string;
  arch: string;
  memUsed: number;
  memUsedGB: number;
  memTotal: number;
  uptime: number;
  diskUsed: number;
  totalDisk: number;
  networkIn: number;
  networkOut: number;
}

const SECTION = (name: string) => `===CLOUDGATE_${name}===`;

export const SERVER_STATS_COMMAND = [
  `echo '${SECTION('CPU')}'`,
  "grep '^cpu ' /proc/stat",
  'sleep 1',
  "grep '^cpu ' /proc/stat",
  `echo '${SECTION('CPUINFO')}'`,
  'cat /proc/cpuinfo 2>/dev/null',
  `echo '${SECTION('MEMINFO')}'`,
  'cat /proc/meminfo',
  `echo '${SECTION('DISK')}'`,
  'df -P -B1 /',
  `echo '${SECTION('NET')}'`,
  'cat /proc/net/dev',
  `echo '${SECTION('UPTIME')}'`,
  'cat /proc/uptime',
  `echo '${SECTION('HOST')}'`,
  'uname -r',
  'uname -m',
  'nproc',
  `echo '${SECTION('OS')}'`,
  'cat /etc/os-release 2>/dev/null || cat /etc/system-release 2>/dev/null || true',
].join('; ');

/** Splits the composite output into its marker-delimited sections. */
function splitSections(raw: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of raw.split('\n')) {
    const marker = /^===CLOUDGATE_([A-Z]+)===\s*$/.exec(line.trim());
    if (marker) {
      current = [];
      sections.set(marker[1], current);
      continue;
    }
    current?.push(line);
  }
  return sections;
}

/** gopsutil TimesStat totals for one `cpu ...` /proc/stat line. */
function cpuTimes(line: string): { total: number; busy: number } {
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  const [
    userRaw = 0,
    niceRaw = 0,
    system = 0,
    idle = 0,
    iowait = 0,
    irq = 0,
    softirq = 0,
    steal = 0,
    guest = 0,
    guestNice = 0,
  ] = fields;
  // Linux folds guest time into user/nice; gopsutil subtracts it back out.
  const user = userRaw - guest;
  const nice = niceRaw - guestNice;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { total, busy: total - idle - iowait };
}

function parseCpuPercent(lines: string[]): number {
  const samples = lines.filter((l) => l.startsWith('cpu '));
  if (samples.length < 2) return 0;
  const t1 = cpuTimes(samples[0]);
  const t2 = cpuTimes(samples[samples.length - 1]);
  const dTotal = t2.total - t1.total;
  const dBusy = t2.busy - t1.busy;
  if (dTotal <= 0 || dBusy < 0) return 0;
  return Math.min(100, (dBusy / dTotal) * 100);
}

interface CpuInfo {
  model: string;
  speedMhz: number;
  physicalCores: number;
}

function parseCpuInfo(lines: string[]): CpuInfo {
  let vendorId = '';
  let modelName = '';
  let speedMhz = 0;
  let processors = 0;
  let physicalId = '';
  const cores = new Set<string>();

  for (const line of lines) {
    const [key, ...rest] = line.split(':');
    const field = key?.trim();
    const value = rest.join(':').trim();
    if (field === 'processor') processors += 1;
    else if (field === 'vendor_id' && !vendorId) vendorId = value;
    else if (field === 'model name' && !modelName) modelName = value;
    else if (field === 'cpu MHz' && !speedMhz) speedMhz = Number(value) || 0;
    else if (field === 'physical id') physicalId = value;
    else if (field === 'core id') cores.add(`${physicalId}:${value}`);
  }

  return {
    model: [vendorId, modelName].filter(Boolean).join(' '),
    speedMhz,
    physicalCores: cores.size > 0 ? cores.size : processors,
  };
}

function memInfoKb(lines: string[], field: string): number {
  const line = lines.find((l) => l.startsWith(`${field}:`));
  if (!line) return 0;
  return Number(line.split(/\s+/)[1]) || 0;
}

/** The Go getRealOS chain over os-release / system-release content. */
function parseDistro(lines: string[]): string {
  let id = '';
  let name = '';
  let version = '';
  const unquote = (value: string) => value.replace(/^"|"$/g, '');
  for (const line of lines) {
    if (line.startsWith('PRETTY_NAME=')) {
      return unquote(line.slice('PRETTY_NAME='.length));
    }
    if (line.startsWith('NAME=')) name = unquote(line.slice('NAME='.length));
    else if (line.startsWith('VERSION=')) {
      version = unquote(line.slice('VERSION='.length));
    } else if (line.startsWith('ID=')) id = unquote(line.slice('ID='.length));
  }
  if (name && version) return `${name} ${version}`;
  if (name) return name;
  if (id) return id;

  const text = lines.join('\n').toLowerCase();
  if (text.includes('red hat')) return 'rhel';
  if (text.includes('centos')) return 'centos';
  if (text.includes('fedora')) return 'fedora';
  return 'linux';
}

/**
 * Whether a sample is a reading at all, or the zeros this parser answers when
 * there was nothing to read.
 *
 * SERVER_STATS_COMMAND is a `;`-joined list ending in `|| true`, so a host with
 * no `/proc` — a macOS or Windows platform host — leaves every section empty,
 * exits 0, and gets a **well-formed sample of zeros** back rather than an
 * error. Since the web server became a collection target, that sample
 * would be stored: a row claiming this machine has 0% CPU, no memory fitted and
 * no disk. That is not an idle host, it is an unmeasured one.
 *
 * **The test is on the totals, not on the values**, and it is deliberately the
 * same shape as the console's own `isUnmeasured` guard over the stats socket
 * (`live-card.tsx`), which reads the same quirk from the other end. A real host
 * can sit at 0% CPU with nothing on the network, and calling that unmeasured
 * would hide a genuinely idle machine; nothing has zero bytes of memory fitted
 * and zero bytes of disk.
 */
export function isUnmeasuredSample(sample: ServerStatsSample): boolean {
  return sample.memTotal === 0 && sample.totalDisk === 0;
}

const BYTES_PER_GB = 1024 * 1024 * 1024;
const BYTES_PER_MB = 1024 * 1024;

export function parseServerStats(raw: string): ServerStatsSample {
  const sections = splitSections(raw);
  const get = (name: string) => sections.get(name) ?? [];

  const cpuInfo = parseCpuInfo(get('CPUINFO'));

  const memTotalKb = memInfoKb(get('MEMINFO'), 'MemTotal');
  const memAvailableKb = memInfoKb(get('MEMINFO'), 'MemAvailable');
  const memTotalGB = memTotalKb / BYTES_PER_MB;
  const memUsedGB = (memTotalKb - memAvailableKb) / BYTES_PER_MB;

  // df -P -B1: Filesystem, 1-blocks, Used, Available, Capacity, Mounted on.
  let diskUsed = 0;
  let totalDisk = 0;
  const diskRow = get('DISK').find((l) => /^\S+\s+\d+\s+\d+\s+\d+/.test(l));
  if (diskRow) {
    const [, blocks, used, available] = diskRow.trim().split(/\s+/).map(Number);
    totalDisk = blocks / BYTES_PER_GB;
    if (used + available > 0) diskUsed = (used / (used + available)) * 100;
  }

  // /proc/net/dev: "iface: rx-bytes ... (8 fields) tx-bytes ...".
  let rxBytes = 0;
  let txBytes = 0;
  for (const line of get('NET')) {
    const match = /^\s*\S+:\s*(.*)$/.exec(line);
    if (!match) continue;
    const fields = match[1].trim().split(/\s+/).map(Number);
    if (fields.length < 9 || fields.some(Number.isNaN)) continue;
    rxBytes += fields[0];
    txBytes += fields[8];
  }

  const uptime = Math.floor(Number(get('UPTIME')[0]?.split(/\s+/)[0]) || 0);

  const host = get('HOST').map((l) => l.trim());
  const kernel = host[0] ?? '';
  const arch = host[1] ?? '';
  const cpuCores = Number(host[2]) || 0;

  const distro = parseDistro(get('OS').filter((l) => l.trim() !== ''));

  return {
    cpu: parseCpuPercent(get('CPU')),
    cpuModel: cpuInfo.model,
    cpuCores,
    cpuPhysicalCores: cpuInfo.physicalCores,
    cpuSpeed: cpuInfo.speedMhz,
    os: distro,
    distro,
    kernel,
    arch,
    memUsed: memTotalGB > 0 ? (memUsedGB / memTotalGB) * 100 : 0,
    memUsedGB,
    memTotal: memTotalGB,
    uptime,
    diskUsed,
    totalDisk,
    networkIn: rxBytes / BYTES_PER_MB,
    networkOut: txBytes / BYTES_PER_MB,
  };
}
