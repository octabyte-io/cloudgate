import {
  parseServerStats,
  SERVER_STATS_COMMAND,
} from '../../src/monitoring/collectors/server-stats.collector';

// A full stats-command output worked by hand. Expected values below are
// computed independently from these raw numbers:
//  - cpu: gopsutil's busy/total delta between the two /proc/stat samples —
//    t1 total 1000+50+300+8000+200+0+50+0 = 9600, busy 9600-8000-200 = 1400;
//    t2 total 1200+60+330+8700+250+0+60+0 = 10600, busy 10600-8700-250 = 1650;
//    (1650-1400)/(10600-9600)*100 = 25.
//  - mem: 8388608 kB = 8 GB total, 2097152 kB = 2 GB available → 6 GB used,
//    75% used.
//  - disk: df 1-blocks 107374182400 B = 100 GB; used/(used+avail) =
//    53687091200/(53687091200+42949672960) = 5/9 → 55.55…%.
//  - net: rx 1048576+104857600 = 105906176 B = 101 MB;
//    tx 1048576+52428800 = 53477376 B = 51 MB.
const STATS_OUTPUT = `===CLOUDGATE_CPU===
cpu  1000 50 300 8000 200 0 50 0 0 0
cpu  1200 60 330 8700 250 0 60 0 0 0
===CLOUDGATE_CPUINFO===
processor\t: 0
vendor_id\t: GenuineIntel
model name\t: Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz
cpu MHz\t\t: 2394.454
physical id\t: 0
core id\t: 0

processor\t: 1
vendor_id\t: GenuineIntel
model name\t: Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz
cpu MHz\t\t: 2394.454
physical id\t: 0
core id\t: 0
===CLOUDGATE_MEMINFO===
MemTotal:        8388608 kB
MemFree:          221876 kB
MemAvailable:    2097152 kB
Buffers:          123456 kB
===CLOUDGATE_DISK===
Filesystem        1-blocks        Used   Available Capacity Mounted on
/dev/vda1     107374182400 53687091200 42949672960      56% /
===CLOUDGATE_NET===
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1048576    1000    0    0    0     0          0         0  1048576    1000    0    0    0     0       0          0
  eth0: 104857600  50000    0    0    0     0          0         0 52428800   30000    0    0    0     0       0          0
===CLOUDGATE_UPTIME===
123456.78 654321.90
===CLOUDGATE_HOST===
5.15.0-91-generic
x86_64
2
===CLOUDGATE_OS===
NAME="Ubuntu"
VERSION="22.04.3 LTS (Jammy Jellyfish)"
ID=ubuntu
PRETTY_NAME="Ubuntu 22.04.3 LTS"
`;

describe('parseServerStats', () => {
  it('parses the composite command output into a server metric sample', () => {
    const sample = parseServerStats(STATS_OUTPUT);

    expect(sample.cpu).toBeCloseTo(25, 10);
    expect(sample.cpuModel).toBe(
      'GenuineIntel Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz',
    );
    expect(sample.cpuCores).toBe(2);
    expect(sample.cpuPhysicalCores).toBe(1);
    expect(sample.cpuSpeed).toBeCloseTo(2394.454, 6);
    expect(sample.os).toBe('Ubuntu 22.04.3 LTS');
    expect(sample.distro).toBe('Ubuntu 22.04.3 LTS');
    expect(sample.kernel).toBe('5.15.0-91-generic');
    expect(sample.arch).toBe('x86_64');
    expect(sample.memUsed).toBeCloseTo(75, 10);
    expect(sample.memUsedGB).toBeCloseTo(6, 10);
    expect(sample.memTotal).toBeCloseTo(8, 10);
    expect(sample.uptime).toBe(123456);
    expect(sample.diskUsed).toBeCloseTo((5 / 9) * 100, 10);
    expect(sample.totalDisk).toBeCloseTo(100, 10);
    expect(sample.networkIn).toBeCloseTo(101, 10);
    expect(sample.networkOut).toBeCloseTo(51, 10);
  });

  it('falls back to NAME + VERSION when os-release has no PRETTY_NAME', () => {
    const output = STATS_OUTPUT.replace(
      /===CLOUDGATE_OS===[\s\S]*$/,
      '===CLOUDGATE_OS===\nNAME="Debian GNU/Linux"\nVERSION="12 (bookworm)"\nID=debian\n',
    );
    expect(parseServerStats(output).distro).toBe(
      'Debian GNU/Linux 12 (bookworm)',
    );
  });

  it('maps a system-release body to the Go fallback names', () => {
    const output = STATS_OUTPUT.replace(
      /===CLOUDGATE_OS===[\s\S]*$/,
      '===CLOUDGATE_OS===\nRed Hat Enterprise Linux release 9.3 (Plow)\n',
    );
    expect(parseServerStats(output).distro).toBe('rhel');
  });

  it('reports zero cpu when the two /proc/stat samples are identical', () => {
    const output = STATS_OUTPUT.replace(
      'cpu  1200 60 330 8700 250 0 60 0 0 0',
      'cpu  1000 50 300 8000 200 0 50 0 0 0',
    );
    expect(parseServerStats(output).cpu).toBe(0);
  });

  it('falls back to the processor count when cpuinfo lacks physical ids', () => {
    const output = STATS_OUTPUT.replace(/physical id\t: 0\n/g, '').replace(
      /core id\t: 0\n/g,
      '',
    );
    expect(parseServerStats(output).cpuPhysicalCores).toBe(2);
  });

  it('samples /proc/stat twice a second apart in one shell trip', () => {
    expect(SERVER_STATS_COMMAND).toContain("grep '^cpu ' /proc/stat");
    expect(SERVER_STATS_COMMAND).toContain('sleep 1');
    expect(SERVER_STATS_COMMAND).toContain('df -P -B1 /');
    expect(SERVER_STATS_COMMAND).toContain('/proc/net/dev');
    expect(SERVER_STATS_COMMAND).toContain('/etc/os-release');
  });
});
