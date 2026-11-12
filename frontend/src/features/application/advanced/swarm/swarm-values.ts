import type {
  EndpointSpecSwarm,
  HealthCheckSwarm,
  LabelsSwarm,
  NetworkSwarm,
  PlacementSwarm,
  RestartPolicySwarm,
  ServiceModeSwarm,
  UlimitsSwarm,
  UpdateConfigSwarm,
} from "@/lib/api/endpoints/swarm";
import type { ApplicationDetail } from "@/lib/api/endpoints/applications";
import { durationToNanos, nanosToSeconds } from "@/lib/format/units";

/**
 * The eleven Swarm columns, flattened into one form and folded back out.
 *
 * **Flat, and deliberately.** These are eleven nullable JSON columns holding
 * nested objects and arrays of objects, and react-hook-form over a nested tree
 * of optional records is where this phase would have gone wrong: every path is
 * `possibly undefined`, an empty object is not the same as a null, and the
 * moment two of them share a shape (update config and rollback config are
 * *literally the same schema*) you either duplicate the wiring or generalise it
 * into something nobody can follow. One flat record of strings in, eleven typed
 * objects out, in two functions that can be read side by side.
 *
 * Three rules the folding follows, and each exists because breaking it loses
 * somebody's configuration:
 *
 * 1. **An empty concern is `null`, not `{}`.** Every column is nullable and the
 *    engine tests it for truthiness (`generateConfigContainer`), so `{}` would
 *    read as "overridden with nothing" and, for update config, would send a
 *    `Parallelism`/`Order` pair the DTO requires and the form never filled in.
 * 2. **Unshown keys are preserved.** Each fold merges over the value already on
 *    the row, so a key this form does not render — a network's `DriverOpts`, a
 *    placement `Platform` written by an API client — survives a save from this
 *    screen. Same principle as F09 leaving a non-chosen builder's columns alone.
 * 3. **A blank field clears its key.** `""` folds to `undefined`, which drops
 *    out of the object rather than becoming `0` — and `0` is a real value for
 *    every one of these numbers.
 */

/**
 * A `kind: "number"` box's value. `num()` puts a string there from the row —
 * `""` for none — and once the box is typed in, `ResourceField` holds a number,
 * or `undefined` for an emptied one, so `int` reads all three. The
 * durations — seconds in the box, nanoseconds in the column — are
 * `kind: "text"` boxes and the `rows` columns
 * (`endpointPorts`, `ulimits`) are registered by `RowsField`; both stay
 * `string`.
 */
export type NumberBox = string | number | undefined;

export type SwarmValues = {
  // Mode
  modeKind: "" | "replicated" | "global" | "replicatedJob" | "globalJob";
  modeReplicas: NumberBox;
  modeMaxConcurrent: NumberBox;
  modeTotalCompletions: NumberBox;
  // Placement
  placementConstraints: string;
  placementMaxReplicas: NumberBox;
  placementPreferences: { spread: string }[];
  placementPlatforms: { architecture: string; os: string }[];
  // Labels
  labels: { key: string; value: string }[];
  // Networks
  networks: { target: string; aliases: string }[];
  // Restart policy
  restartCondition: "" | "none" | "on-failure" | "any";
  restartDelay: string;
  restartMaxAttempts: NumberBox;
  restartWindow: string;
  // Update config
  updateParallelism: NumberBox;
  updateDelay: string;
  updateFailureAction: "" | "pause" | "continue" | "rollback";
  updateMonitor: string;
  updateMaxFailureRatio: string;
  updateOrder: "" | "start-first" | "stop-first";
  // Rollback config — the same six fields, because it is the same schema
  rollbackParallelism: NumberBox;
  rollbackDelay: string;
  rollbackFailureAction: "" | "pause" | "continue" | "rollback";
  rollbackMonitor: string;
  rollbackMaxFailureRatio: string;
  rollbackOrder: "" | "start-first" | "stop-first";
  // Health check
  healthTest: string;
  healthInterval: string;
  healthTimeout: string;
  healthStartPeriod: string;
  healthRetries: NumberBox;
  // Endpoint spec
  endpointMode: "" | "vip" | "dnsrr";
  endpointPorts: {
    protocol: string;
    targetPort: string;
    publishedPort: string;
    publishMode: string;
  }[];
  // Stop grace period
  stopGracePeriod: string;
  // Ulimits
  ulimits: { name: string; soft: string; hard: string }[];
};

/** The ten duration fields: seconds in the box, nanoseconds in the column. */
export const DURATION_FIELDS = [
  "restartDelay",
  "restartWindow",
  "updateDelay",
  "updateMonitor",
  "rollbackDelay",
  "rollbackMonitor",
  "healthInterval",
  "healthTimeout",
  "healthStartPeriod",
  "stopGracePeriod",
] as const satisfies readonly (keyof SwarmValues)[];

// ── Row → form ─────────────────────────────────────────────────────────────

export function toSwarmValues(row: ApplicationDetail): SwarmValues {
  const mode = row.modeSwarm;
  const placement = row.placementSwarm;
  const restart = row.restartPolicySwarm;
  const update = row.updateConfigSwarm;
  const rollback = row.rollbackConfigSwarm;
  const health = row.healthCheckSwarm;
  const endpoint = row.endpointSpecSwarm;

  return {
    modeKind: modeKindOf(mode),
    modeReplicas: num(mode?.Replicated?.Replicas),
    modeMaxConcurrent: num(mode?.ReplicatedJob?.MaxConcurrent),
    modeTotalCompletions: num(mode?.ReplicatedJob?.TotalCompletions),

    placementConstraints: (placement?.Constraints ?? []).join("\n"),
    placementMaxReplicas: num(placement?.MaxReplicas),
    placementPreferences: (placement?.Preferences ?? []).map((item) => ({
      spread: item.Spread.SpreadDescriptor,
    })),
    placementPlatforms: (placement?.Platforms ?? []).map((item) => ({
      architecture: item.Architecture,
      os: item.OS,
    })),

    labels: Object.entries(row.labelsSwarm ?? {}).map(([key, value]) => ({
      key,
      value,
    })),

    networks: (row.networkSwarm ?? []).map((item) => ({
      target: item.Target ?? "",
      aliases: (item.Aliases ?? []).join(", "),
    })),

    restartCondition: (restart?.Condition ?? "") as SwarmValues["restartCondition"],
    restartDelay: nanosToSeconds(restart?.Delay),
    restartMaxAttempts: num(restart?.MaxAttempts),
    restartWindow: nanosToSeconds(restart?.Window),

    updateParallelism: num(update?.Parallelism),
    updateDelay: nanosToSeconds(update?.Delay),
    updateFailureAction: (update?.FailureAction ??
      "") as SwarmValues["updateFailureAction"],
    updateMonitor: nanosToSeconds(update?.Monitor),
    updateMaxFailureRatio: num(update?.MaxFailureRatio),
    updateOrder: (update?.Order ?? "") as SwarmValues["updateOrder"],

    rollbackParallelism: num(rollback?.Parallelism),
    rollbackDelay: nanosToSeconds(rollback?.Delay),
    rollbackFailureAction: (rollback?.FailureAction ??
      "") as SwarmValues["rollbackFailureAction"],
    rollbackMonitor: nanosToSeconds(rollback?.Monitor),
    rollbackMaxFailureRatio: num(rollback?.MaxFailureRatio),
    rollbackOrder: (rollback?.Order ?? "") as SwarmValues["rollbackOrder"],

    healthTest: (health?.Test ?? []).join("\n"),
    healthInterval: nanosToSeconds(health?.Interval),
    healthTimeout: nanosToSeconds(health?.Timeout),
    healthStartPeriod: nanosToSeconds(health?.StartPeriod),
    healthRetries: num(health?.Retries),

    endpointMode: (endpoint?.Mode ?? "") as SwarmValues["endpointMode"],
    endpointPorts: (endpoint?.Ports ?? []).map((port) => ({
      protocol: port.Protocol ?? "",
      targetPort: num(port.TargetPort),
      publishedPort: num(port.PublishedPort),
      publishMode: port.PublishMode ?? "",
    })),

    stopGracePeriod: nanosToSeconds(row.stopGracePeriodSwarm),

    ulimits: (row.ulimitsSwarm ?? []).map((limit) => ({
      name: limit.Name,
      soft: num(limit.Soft),
      hard: num(limit.Hard),
    })),
  };
}

// ── Form → the eleven columns ──────────────────────────────────────────────

export function toSwarmColumns(
  values: SwarmValues,
  current: ApplicationDetail,
): Record<string, unknown> {
  return {
    modeSwarm: foldMode(values),
    placementSwarm: foldPlacement(values, current.placementSwarm),
    labelsSwarm: foldLabels(values),
    networkSwarm: foldNetworks(values, current.networkSwarm),
    restartPolicySwarm: foldRestart(values, current.restartPolicySwarm),
    updateConfigSwarm: foldUpdate(
      values.updateParallelism,
      values.updateDelay,
      values.updateFailureAction,
      values.updateMonitor,
      values.updateMaxFailureRatio,
      values.updateOrder,
      current.updateConfigSwarm,
    ),
    rollbackConfigSwarm: foldUpdate(
      values.rollbackParallelism,
      values.rollbackDelay,
      values.rollbackFailureAction,
      values.rollbackMonitor,
      values.rollbackMaxFailureRatio,
      values.rollbackOrder,
      current.rollbackConfigSwarm,
    ),
    healthCheckSwarm: foldHealth(values, current.healthCheckSwarm),
    endpointSpecSwarm: foldEndpoint(values, current.endpointSpecSwarm),
    stopGracePeriodSwarm: nanos(values.stopGracePeriod) ?? null,
    ulimitsSwarm: foldUlimits(values),
  };
}

function foldMode(values: SwarmValues): ServiceModeSwarm | null {
  switch (values.modeKind) {
    case "replicated":
      return { Replicated: drop({ Replicas: int(values.modeReplicas) }) };
    case "global":
      return { Global: {} };
    case "replicatedJob":
      return {
        ReplicatedJob: drop({
          MaxConcurrent: int(values.modeMaxConcurrent),
          TotalCompletions: int(values.modeTotalCompletions),
        }),
      };
    case "globalJob":
      return { GlobalJob: {} };
    default:
      return null;
  }
}

function foldPlacement(
  values: SwarmValues,
  current: PlacementSwarm | null,
): PlacementSwarm | null {
  const constraints = lines(values.placementConstraints);
  const preferences = values.placementPreferences
    .filter((item) => item.spread.trim() !== "")
    .map((item) => ({ Spread: { SpreadDescriptor: item.spread.trim() } }));
  const platforms = values.placementPlatforms
    .filter((item) => item.architecture.trim() !== "" || item.os.trim() !== "")
    .map((item) => ({
      Architecture: item.architecture.trim(),
      OS: item.os.trim(),
    }));

  return nullIfEmpty({
    ...current,
    Constraints: constraints,
    Preferences: preferences.length > 0 ? preferences : undefined,
    MaxReplicas: int(values.placementMaxReplicas),
    Platforms: platforms.length > 0 ? platforms : undefined,
  });
}

function foldLabels(values: SwarmValues): LabelsSwarm | null {
  const entries = values.labels
    .filter((pair) => pair.key.trim() !== "")
    .map((pair) => [pair.key.trim(), pair.value] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function foldNetworks(
  values: SwarmValues,
  current: NetworkSwarm[] | null,
): NetworkSwarm[] | null {
  const rows = values.networks
    .map((row, index) => {
      if (row.target.trim() === "") return null;
      const aliases = row.aliases
        .split(",")
        .map((alias) => alias.trim())
        .filter(Boolean);
      return drop({
        // Whatever this row already carried — `DriverOpts` above all — is kept.
        ...current?.[index],
        Target: row.target.trim(),
        Aliases: aliases.length > 0 ? aliases : undefined,
      }) as NetworkSwarm;
    })
    .filter((row): row is NetworkSwarm => row !== null);
  return rows.length > 0 ? rows : null;
}

function foldRestart(
  values: SwarmValues,
  current: RestartPolicySwarm | null,
): RestartPolicySwarm | null {
  return nullIfEmpty({
    ...current,
    Condition: blank(values.restartCondition),
    Delay: nanos(values.restartDelay),
    MaxAttempts: int(values.restartMaxAttempts),
    Window: nanos(values.restartWindow),
  });
}

/**
 * Update and rollback config, which are one schema — and the one place a
 * half-filled concern is refused rather than trimmed.
 *
 * `updateConfigSwarmSchema` makes `Parallelism` and `Order` **required**, so an
 * object holding only a `Delay` is a 400 from the DTO rather than a partial
 * override. Returning `null` for that case is what makes "I only wanted to set
 * the delay" behave as "leave this concern alone" instead of failing the whole
 * save — and the form's hint says both are needed.
 */
function foldUpdate(
  parallelism: NumberBox,
  delay: string,
  failureAction: string,
  monitor: string,
  maxFailureRatio: string,
  order: string,
  current: UpdateConfigSwarm | null,
): UpdateConfigSwarm | null {
  const parsedParallelism = int(parallelism);
  const trimmedOrder = blank(order);
  if (parsedParallelism === undefined || trimmedOrder === undefined) return null;

  return drop({
    ...current,
    Parallelism: parsedParallelism,
    Order: trimmedOrder,
    Delay: nanos(delay),
    FailureAction: blank(failureAction),
    Monitor: nanos(monitor),
    MaxFailureRatio: float(maxFailureRatio),
  }) as UpdateConfigSwarm;
}

function foldHealth(
  values: SwarmValues,
  current: HealthCheckSwarm | null,
): HealthCheckSwarm | null {
  return nullIfEmpty({
    ...current,
    Test: lines(values.healthTest),
    Interval: nanos(values.healthInterval),
    Timeout: nanos(values.healthTimeout),
    StartPeriod: nanos(values.healthStartPeriod),
    Retries: int(values.healthRetries),
  });
}

function foldEndpoint(
  values: SwarmValues,
  current: EndpointSpecSwarm | null,
): EndpointSpecSwarm | null {
  const ports = values.endpointPorts
    .filter((port) => port.targetPort.trim() !== "")
    .map((port) =>
      drop({
        Protocol: blank(port.protocol),
        TargetPort: int(port.targetPort),
        PublishedPort: int(port.publishedPort),
        PublishMode: blank(port.publishMode),
      }),
    );

  return nullIfEmpty({
    ...current,
    Mode: blank(values.endpointMode),
    Ports: ports.length > 0 ? ports : undefined,
  });
}

function foldUlimits(values: SwarmValues): UlimitsSwarm | null {
  const rows = values.ulimits
    .filter((limit) => limit.name.trim() !== "")
    .map((limit) => ({
      Name: limit.name.trim(),
      Soft: int(limit.soft) ?? 0,
      Hard: int(limit.hard) ?? 0,
    }));
  return rows.length > 0 ? rows : null;
}

// ── The six conversions every fold above is built from ─────────────────────

const num = (value: number | null | undefined) =>
  value === null || value === undefined ? "" : String(value);

/**
 * A duration field, in seconds or with its own unit, as the
 * nanoseconds every Swarm duration is. Unreadable folds to `undefined` like
 * any blank; the form's schema has refused it before this runs.
 */
const nanos = (value: string) => {
  const parsed = durationToNanos(value);
  return parsed === null || Number.isNaN(parsed) ? undefined : parsed;
};

const blank = (value: string) =>
  value.trim() === "" ? undefined : value.trim();

const int = (value: NumberBox) => {
  const trimmed = String(value ?? "").trim();
  if (trimmed === "" || !/^-?\d+$/.test(trimmed)) return undefined;
  return Number.parseInt(trimmed, 10);
};

const float = (value: string) => {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const lines = (value: string) => {
  const rows = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return rows.length > 0 ? rows : undefined;
};

/** Drops the keys that folded to `undefined`, so `{}` is genuinely empty. */
function drop<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

/** …and an object with nothing left in it is a `null` column, not `{}`. */
function nullIfEmpty<T extends object>(value: T): T | null {
  const kept = drop(value);
  return Object.keys(kept).length > 0 ? kept : null;
}

function modeKindOf(mode: ServiceModeSwarm | null): SwarmValues["modeKind"] {
  if (!mode) return "";
  if (mode.Replicated) return "replicated";
  if (mode.Global) return "global";
  if (mode.ReplicatedJob) return "replicatedJob";
  if (mode.GlobalJob) return "globalJob";
  return "";
}
