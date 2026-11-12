import { z } from 'zod';

/**
 * The one list of Size names, for every kind: `xsmall` is 0.25 CPU and
 * 512 MB, and each name after it doubles both, up to `2xlarge` at 8 CPU and
 * 16 GB. A Size is a cap only; how much a Server sets aside for a Service stays
 * Cloudgate's, so nothing here speaks of reservations.
 *
 * Memory is held in MB (1 GB = 1024 MB) because that is the unit both a name
 * and a custom pair can state exactly; the bytes the `memory_limit` column
 * takes come from {@link sizeLimits}.
 */
export const SIZES = {
  xsmall: { cpu: 0.25, memoryMb: 512 },
  small: { cpu: 0.5, memoryMb: 1024 },
  medium: { cpu: 1, memoryMb: 2048 },
  large: { cpu: 2, memoryMb: 4096 },
  xlarge: { cpu: 4, memoryMb: 8192 },
  '2xlarge': { cpu: 8, memoryMb: 16384 },
} as const;

export type SizeName = keyof typeof SIZES;

export const SIZE_NAMES = Object.keys(SIZES) as [SizeName, ...SizeName[]];

/**
 * A Size as the backend reads it: CPUs and MB, with the name kept when the
 * config used one, so a generated config can write the name back rather than
 * the pair it stands for.
 */
export interface Size {
  readonly name?: SizeName;
  readonly cpu: number;
  readonly memoryMb: number;
}

/**
 * `<number> MB` or `<number> GB`, the space optional. A bare number is refused
 * rather than read as MB: `memory: 1` meaning one megabyte is the kind of
 * silent misreading an operator finds out about when the container is killed.
 */
export const MEMORY_REGEX = /^(\d+(?:\.\d+)?) ?(MB|GB)$/;

/** Memory in MB from a `MEMORY_REGEX` string; whole MB only. */
export function memoryToMb(memory: string): number | null {
  const parts = MEMORY_REGEX.exec(memory);
  if (!parts) return null;
  const mb = Number(parts[1]) * (parts[2] === 'GB' ? 1024 : 1);
  return Number.isInteger(mb) && mb > 0 ? mb : null;
}

/** The wire form of `size`: a name, or a custom pair with both fields. */
export const sizeWireSchema = z.union([
  z.enum(SIZE_NAMES),
  z.strictObject({
    cpu: z
      .number()
      .positive('must be more than 0')
      .refine((cpu) => Math.abs(cpu * 1e9 - Math.round(cpu * 1e9)) < 1e-3, {
        message: 'may have at most nine decimal places',
      }),
    memory: z
      .string()
      .regex(MEMORY_REGEX, 'must be a number of MB or GB, e.g. 512 MB or 2 GB')
      .refine((memory) => memoryToMb(memory) !== null, {
        message: 'must be a whole number of MB, more than 0',
      }),
  }),
]);

export type SizeWire = z.infer<typeof sizeWireSchema>;

export function toSize(wire: SizeWire): Size {
  if (typeof wire === 'string') return { name: wire, ...SIZES[wire] };
  return { cpu: wire.cpu, memoryMb: memoryToMb(wire.memory) as number };
}

/**
 * A Size in the units the `cpu_limit` and `memory_limit` columns already take:
 * Docker's `NanoCPUs` and `MemoryBytes`, as the strings `docker.utils.ts`'s
 * resource mapping parses.
 */
export function sizeLimits(size: Size): {
  cpuLimit: string;
  memoryLimit: string;
} {
  return {
    cpuLimit: String(Math.round(size.cpu * 1e9)),
    memoryLimit: String(size.memoryMb * 1024 * 1024),
  };
}
