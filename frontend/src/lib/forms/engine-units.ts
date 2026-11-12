import { z } from "zod";

import {
  coresToNanoCpus,
  durationToNanos,
  memoryToBytes,
} from "@/lib/format/units";

/**
 * The field rules for a CPU, a memory size and a duration, in the units an
 * operator types.
 *
 * One definition each, shared by an Application's and a database's Resources
 * card and the Swarm durations, because the moment each card writes its own
 * the same slip gets a different sentence — or, as `1` in the CPU limit did,
 * none at all. `units.ts` owns the conversion; this owns what is refused.
 *
 * **The floors are the Docker Engine's own**, and only on a limit: a CPU
 * limit under 0.01 core and a memory limit under 6 MB are what `docker run`
 * refuses (`--cpus` "range of CPUs is from 0.01", "Minimum memory limit allowed
 * is 6MB"), so a value under them is a slip of units rather than a choice. A
 * reservation that small is merely pointless, and is left alone.
 */

export const MIN_CPU_LIMIT_NANO = 10_000_000;
export const MIN_MEMORY_LIMIT_BYTES = 6 * 1024 * 1024;

/** Cores: `0.5`, `2`. Empty means no constraint. */
export function coresField(label: string, { limit = false } = {}) {
  return z
    .string()
    .trim()
    .superRefine((value, ctx) => {
      const nano = coresToNanoCpus(value);
      if (nano === null) return;
      if (Number.isNaN(nano)) {
        ctx.addIssue({
          code: "custom",
          message: `${label} is a number of cores, like 0.5 or 2, or empty for no limit.`,
        });
      } else if (limit && nano < MIN_CPU_LIMIT_NANO) {
        ctx.addIssue({
          code: "custom",
          message: `${label} has to be at least 0.01 core — Docker will not start a container on less.`,
        });
      }
    });
}

/** A size: `512 MB`, `1.5 GB`, or a bare number of MB. */
export function memoryField(label: string, { limit = false } = {}) {
  return z
    .string()
    .trim()
    .superRefine((value, ctx) => {
      const bytes = memoryToBytes(value);
      if (bytes === null) return;
      if (Number.isNaN(bytes)) {
        ctx.addIssue({
          code: "custom",
          message: `${label} is a size, like 512 MB or 1.5 GB, or empty for no limit.`,
        });
      } else if (limit && bytes < MIN_MEMORY_LIMIT_BYTES) {
        ctx.addIssue({
          code: "custom",
          message: `${label} has to be at least 6 MB — Docker will not start a container on less.`,
        });
      }
    });
}

/** Seconds, or a number with `ms`, `s`, `m` or `h`. */
export function durationIssue(label: string, value: string): string | null {
  const nanos = durationToNanos(value);
  if (nanos === null || !Number.isNaN(nanos)) return null;
  return `${label} is a number of seconds, like 30 or 1.5, or a number with ms, s, m or h.`;
}

/** What the API column takes: the Engine unit as a string, or `null` for none. */
export function stored(value: number | null): string | null {
  return value === null || Number.isNaN(value) ? null : String(value);
}
