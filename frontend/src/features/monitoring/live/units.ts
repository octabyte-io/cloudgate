import type { DockerStatsSample } from "@/lib/realtime/gateways";

/**
 * The arithmetic behind the live meters — `docker stats` prints strings, and every
 * one of these turns one into a number the card can draw or refuses to.
 *
 * Pure, and separate from the card for that reason: each function here is a claim
 * about Docker's output format rather than about the screen.
 */

/** `"0.15%"` → `0.15`. `null` when the frame carried nothing. */
export function percent(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value.replace("%", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Every total zero — see the note on the `unmeasured` branch in
 * `live-readings.tsx`.
 *
 * The test is on the **totals**, not on the values: a container really can be at
 * 0.00% CPU and have written 0B, and calling that unmeasured would hide a
 * genuinely idle container. Nothing has zero bytes of memory fitted.
 */
export function isUnmeasured(sample: DockerStatsSample): boolean {
  const total = sample.memory ? bytes(sample.memory.value.total) : null;
  const diskTotal = sample.disk?.value.diskTotal ?? null;
  return total === 0 && (diskTotal === null || diskTotal === 0);
}

/**
 * `{ used: "8.316MiB", total: "7.653GiB" }` → a percentage, or `null`.
 *
 * **Both sides are converted to bytes first.** `docker stats` prints whichever
 * unit fits each side — a container using 8MiB of a 7.6GiB host prints two
 * different units on one line — so dividing the numbers as printed gives a bar
 * that is 1024 times too long. The first version of this required the two units
 * to match and went `mute` when they did not, which was safe and useless: that is
 * the *normal* case, and it muted the meter on every real reading.
 *
 * `null` only for a unit that is not in the table, which is the one case where
 * there is nothing honest to draw.
 */
export function memoryPercent(memory: {
  used: string;
  total: string;
}): number | null {
  const used = bytes(memory.used);
  const total = bytes(memory.total);
  if (used === null || total === null || total === 0) return null;
  return Math.min(100, (used / total) * 100);
}

/** Docker's units, IEC and SI, since it prints both. `null` for anything else. */
const UNITS: Record<string, number> = {
  B: 1,
  kB: 1e3,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
};

function bytes(value: string): number | null {
  const match = /^([0-9.]+)\s*([A-Za-z]*)$/.exec(value.trim());
  if (!match) return null;
  const parsed = Number.parseFloat(match[1]);
  if (!Number.isFinite(parsed)) return null;
  const unit = match[2] === "" ? "B" : match[2];
  const scale = UNITS[unit];
  return scale === undefined ? null : parsed * scale;
}

/**
 * One byte formatter for the whole live card: IEC units, two decimals,
 * a space before the unit — `"13.03 GiB"`, `"512 B"`.
 *
 * The card used to print each figure the way its source happened to: memory as
 * `docker stats`' `13.03GiB` with no space, Network in MB, Block IO in GiB and
 * Disk as a bare `GB` with no unit on the total. Every one of them is a byte
 * count, so every one goes through here. IEC because the host's own figures are
 * binary — `/proc/meminfo`, and `df -B1` divided by 1024³ — and `docker stats`
 * prints memory in IEC too; its SI network and block figures are converted.
 */
export function formatBytes(value: number): string {
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"] as const;
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(2)} ${units[unit]}`;
}

/**
 * A size as `docker stats` or the host gateway printed it, in
 * {@link formatBytes}' units. A string in a unit this does not know is shown as
 * it came, rather than as a number in the wrong unit.
 */
export function readingBytes(value: string): string {
  const parsed = bytes(value);
  return parsed === null ? value : formatBytes(parsed);
}

/** The host's disk figures arrive as GiB (`df -B1` / 1024³), as numbers. */
export function gibToBytes(gib: number): number {
  return gib * 1024 ** 3;
}
