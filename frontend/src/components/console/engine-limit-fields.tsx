import type { FieldSpec } from "@/components/console/form-spec";
import {
  bytesToMemory,
  coresToNanoCpus,
  memoryToBytes,
  nanoCpusToCores,
  readMemory,
} from "@/lib/format/units";
import { coresField, memoryField, stored } from "@/lib/forms/engine-units";

/**
 * **The four CPU and memory fields a Swarm service's Resources card holds**,
 * in cores and sizes, for an Application and a database alike.
 *
 * Both cards edit the same four text columns and the API keeps them in
 * nano-CPUs and bytes; this is the one place that turns one into the other.
 * They lived as two copies of the same raw-unit fields — F11 copied F10's
 * card rather than reuse it because it took an `ApplicationDetail` — and a
 * unit change made in one copy and not the other is exactly the drift a
 * shared module stops.
 */

/** The schema half, to spread into a card's own `z.object`. */
export const limitShape = {
  cpuLimit: coresField("CPU limit", { limit: true }),
  cpuReservation: coresField("CPU reservation"),
  memoryLimit: memoryField("Memory limit", { limit: true }),
  memoryReservation: memoryField("Memory reservation"),
};

export type LimitValues = {
  cpuLimit: string;
  cpuReservation: string;
  memoryLimit: string;
  memoryReservation: string;
};

type LimitRow = {
  cpuLimit: string | null;
  cpuReservation: string | null;
  memoryLimit: string | null;
  memoryReservation: string | null;
};

/** The row's Engine units, as the field shows them. */
export function limitDefaults(row: LimitRow): LimitValues {
  return {
    cpuLimit: nanoCpusToCores(row.cpuLimit),
    cpuReservation: nanoCpusToCores(row.cpuReservation),
    memoryLimit: bytesToMemory(row.memoryLimit),
    memoryReservation: bytesToMemory(row.memoryReservation),
  };
}

/**
 * The fields back in Engine units. Empty is `null`, not `""`: the engine tests
 * these for truthiness before parsing (`calculateResources`), so an empty
 * string would work by accident and stop working the day something reads the
 * column as "was a value set".
 */
export function limitColumns(values: LimitValues): LimitRow {
  return {
    cpuLimit: stored(coresToNanoCpus(values.cpuLimit)),
    cpuReservation: stored(coresToNanoCpus(values.cpuReservation)),
    memoryLimit: stored(memoryToBytes(values.memoryLimit)),
    memoryReservation: stored(memoryToBytes(values.memoryReservation)),
  };
}

/**
 * The four fields. `locked` is a config file's claim on the limits;
 * `memoryLimitNote` and `memoryReservationNote` are each card's own sentence
 * about what going past or over-reserving costs it.
 */
export function limitFields<Values extends LimitValues>(
  values: Values,
  {
    locked,
    memoryLimitNote,
    memoryReservationNote,
  }: {
    locked?: string;
    memoryLimitNote: string;
    memoryReservationNote: string;
  },
): FieldSpec<Values>[] {
  return [
    {
      kind: "text",
      name: "cpuLimit",
      locked,
      label: "CPU limit",
      optional: true,
      mono: true,
      placeholder: "1",
      hint: "In cores — 0.5 is half of one. Empty means no ceiling.",
    },
    {
      kind: "text",
      name: "cpuReservation",
      label: "CPU reservation",
      optional: true,
      mono: true,
      placeholder: "0.5",
      hint: "In cores. Capacity Swarm holds free before scheduling this anywhere.",
    },
    {
      kind: "text",
      name: "memoryLimit",
      locked,
      label: "Memory limit",
      optional: true,
      mono: true,
      placeholder: "512 MB",
      hint: reading(values.memoryLimit, `In MB, or with GB. ${memoryLimitNote}`),
    },
    {
      kind: "text",
      name: "memoryReservation",
      label: "Memory reservation",
      optional: true,
      mono: true,
      placeholder: "256 MB",
      hint: reading(values.memoryReservation, memoryReservationNote),
    },
  ];
}

/**
 * The size as typed, read back in the unit that holds it best — `1536` reads
 * `= 1.5 GB` — so a bare number's unit is never a guess.
 */
function reading(value: string, explanation: string): React.ReactNode {
  const bytes = memoryToBytes(value);
  const read =
    bytes === null || Number.isNaN(bytes) ? null : readMemory(String(bytes));
  if (!read) return explanation;
  return (
    <>
      <strong className="font-medium text-tx-2">= {read}</strong>
      {" · "}
      {explanation}
    </>
  );
}
