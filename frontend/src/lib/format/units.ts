/**
 * The three Docker Engine units an operator should never have to type, and the
 * conversions to and from the ones they think in.
 *
 * `memoryLimit` / `memoryReservation` are stored as **bytes**, `cpuLimit` /
 * `cpuReservation` as **nano-CPUs** (1e9 per core) and every Swarm duration as
 * **nanoseconds**, because that is exactly what `calculateResources` and
 * `mechanize.ts` hand the Docker Engine API. The API keeps those units; the
 * console converts at its edge.
 *
 * **These used to stay raw in the field**, with a reading underneath, on the
 * argument that "512 MB" has to pick a definition of MB and round-trip through
 * an integer. This is what that cost: `1` in the CPU limit saved cleanly and
 * capped the container at one nano-CPU, and `512MB` was refused as "not a whole
 * number". So the fields take cores, sizes and seconds, and the definitions
 * are settled here, once:
 *
 * - **A MB is 1024 × 1024 bytes**, which is what `docker run --memory 512m`
 *   means, so a value typed here and one typed at the Docker CLI agree.
 * - **A stored value that is not a whole number of the unit shown is shown in a
 *   smaller one** (`1073741825` reads as `1073741825 B`), so opening the card
 *   and saving it never rewrites a value set through the API.
 * - **A fraction is rounded to the nearest whole Engine unit**, which is the
 *   only rounding anywhere in the round trip.
 */

const NANO = 1_000_000_000;
const KIB = 1024;

const SIZE_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  byte: 1,
  bytes: 1,
  k: KIB,
  kb: KIB,
  kib: KIB,
  m: KIB ** 2,
  mb: KIB ** 2,
  mib: KIB ** 2,
  g: KIB ** 3,
  gb: KIB ** 3,
  gib: KIB ** 3,
  t: KIB ** 4,
  tb: KIB ** 4,
  tib: KIB ** 4,
};

const DURATION_UNITS: Readonly<Record<string, number>> = {
  ns: 1,
  us: 1_000,
  "µs": 1_000,
  ms: 1_000_000,
  s: NANO,
  sec: NANO,
  m: 60 * NANO,
  min: 60 * NANO,
  h: 3600 * NANO,
};

/**
 * `"1.5"` → `1500000000`. `null` for an empty field, `NaN` for anything that
 * is not a number of cores.
 */
export function coresToNanoCpus(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return Number.NaN;
  return Math.round(Number(trimmed) * NANO);
}

/** `"1500000000"` → `"1.5"`; empty for no value. Exact: no float in between. */
export function nanoCpusToCores(value: string | number | null | undefined): string {
  const whole = toWholeNumber(String(value ?? ""));
  return whole === null ? "" : decimalOf(whole, 9);
}

/**
 * `"512 MB"`, `"1.5g"` or a bare `"512"` (megabytes) → bytes. `null` for an
 * empty field, `NaN` for anything unreadable.
 */
export function memoryToBytes(input: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(input.trim());
  if (input.trim() === "") return null;
  if (!match) return Number.NaN;
  const unit = match[2].toLowerCase();
  const factor = unit === "" ? KIB ** 2 : SIZE_UNITS[unit];
  if (factor === undefined) return Number.NaN;
  return Math.round(Number(match[1]) * factor);
}

/**
 * Bytes → the largest unit that holds them exactly: `"536870912"` →
 * `"512 MB"`, `"1610612736"` → `"1536 MB"`. Empty for no value.
 */
export function bytesToMemory(value: string | number | null | undefined): string {
  const bytes = toWholeNumber(String(value ?? ""));
  if (bytes === null) return "";
  for (const [unit, factor] of [
    ["TB", KIB ** 4],
    ["GB", KIB ** 3],
    ["MB", KIB ** 2],
    ["KB", KIB],
  ] as const) {
    if (bytes >= factor && bytes % factor === 0) return `${bytes / factor} ${unit}`;
  }
  return `${bytes} B`;
}

/**
 * `"30"` (seconds), `"1.5s"`, `"500ms"` or `"2m"` → nanoseconds. `null` for
 * an empty field, `NaN` for anything unreadable.
 */
export function durationToNanos(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const match = /^(\d+(?:\.\d+)?)\s*([a-zµ]*)$/i.exec(trimmed);
  if (!match) return Number.NaN;
  const unit = match[2].toLowerCase();
  const factor = unit === "" ? NANO : DURATION_UNITS[unit];
  if (factor === undefined) return Number.NaN;
  return Math.round(Number(match[1]) * factor);
}

/** Nanoseconds → seconds: `30000000000` → `"30"`, `1500000` → `"0.0015"`. */
export function nanosToSeconds(value: string | number | null | undefined): string {
  const whole = toWholeNumber(String(value ?? ""));
  return whole === null ? "" : decimalOf(whole, 9);
}

/** `whole / 10^places`, written exactly — `1500000000, 9` → `"1.5"`. */
function decimalOf(whole: number, places: number): string {
  const digits = String(whole).padStart(places + 1, "0");
  const integer = digits.slice(0, -places);
  const fraction = digits.slice(-places).replace(/0+$/, "");
  return fraction === "" ? integer : `${integer}.${fraction}`;
}

/** `536870912` → `512 MB`. Empty for anything that is not a whole number. */
export function readMemory(value: string): string | null {
  const bytes = toWholeNumber(value);
  if (bytes === null) return null;
  if (bytes === 0) return "no limit";

  const units = ["bytes", "KB", "MB", "GB", "TB"] as const;
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  // Whole numbers where the value is a clean power of two, one decimal
  // otherwise — 1.5 GB is worth saying, 1.0 GB is not.
  const rounded = Math.round(size * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${units[unit]}`;
}

/**
 * `2097152` → `2 MB`: a **size**, of a file or a directory on disk. Not
 * {@link readMemory}, which reads a limit somebody typed and says "no limit"
 * for zero — the wrong sentence for something that is genuinely empty, which
 * is `0 bytes` here.
 */
export function readBytes(bytes: number): string {
  if (bytes === 0) return "0 bytes";
  const units = ["bytes", "KB", "MB", "GB", "TB"] as const;
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const rounded = Math.round(size * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${units[unit]}`;
}

/**
 * `30000000000` → `30s`.
 *
 * The third raw unit on this tab, and the one most likely to be typed wrong:
 * every duration in a Swarm service spec is **nanoseconds** — health-check
 * intervals and timeouts, restart delays and windows, update delays and
 * monitors, the stop grace period. `mechanize.ts` passes each of them straight
 * through to the Docker Engine API, so `30` means thirty *nanoseconds* and the
 * health check that was meant to run twice a minute runs continuously.
 */
export function readDuration(value: string): string | null {
  const nanos = toWholeNumber(value);
  if (nanos === null) return null;
  if (nanos === 0) return "none";

  const seconds = nanos / 1_000_000_000;
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${trim(seconds)}s`;
  if (seconds < 3600) return `${trim(seconds / 60)}m`;
  return `${trim(seconds / 3600)}h`;
}

const trim = (value: number) => String(Math.round(value * 100) / 100);

function toWholeNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}
