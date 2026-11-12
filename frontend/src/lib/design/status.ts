/**
 * The status vocabulary. Ported from e-console.html:1129-1178, then cut back to
 * what the backend actually returns.
 *
 * Two rules hold everywhere this is used:
 *
 * 1. **Only real enum values.** `applicationStatus` is
 *    idle/running/done/error/stopped (`applicationStatusEnum`).
 *    `deployment.status` is
 *    pending/running/done/error/cancelled/held (`deploymentStatusEnum`).
 *    `serverStatus` is active/inactive (the `serverStatus` pgEnum). The
 *    prototype's
 *    `provisioning`, `unreachable`, `drift`, `planned` and `building` are not in
 *    any enum — they belong to the unbuilt provisioning work and are gone.
 *
 * 2. **Meaning never rests on a glyph or a hue alone.** Every mark a component
 *    renders must also render `label`, visibly or in an `sr-only` span. A dot on
 *    its own is not a status; it is a decoration next to one.
 *
 * A change type and a status are different vocabularies, so they get different
 * maps and different tone types. Conflating them would leak.
 */

export type Tone = "ok" | "warn" | "bad" | "info" | "mute";

export type Mark = {
  /** The glyph. Decoration — it never carries the meaning by itself. */
  glyph: string;
  tone: Tone;
  /** The word. Always rendered, visibly or for a screen reader. */
  label: string;
};

/**
 * The product's own statuses: the union of `applicationStatus`,
 * `deployment.status` and `serverStatus`. Nothing else exists.
 */
export const STATUS = {
  running: { glyph: "●", tone: "ok", label: "running" },
  done: { glyph: "●", tone: "ok", label: "done" },
  active: { glyph: "●", tone: "ok", label: "active" },
  pending: { glyph: "○", tone: "warn", label: "pending" },
  error: { glyph: "✕", tone: "bad", label: "error" },
  cancelled: { glyph: "⊘", tone: "mute", label: "cancelled" },
  // A build waiting on a plan: `warn` like `pending`, since it waits
  // on someone, with the glyph of a half-done thing.
  held: { glyph: "◐", tone: "warn", label: "held" },
  idle: { glyph: "○", tone: "mute", label: "idle" },
  // Scaled to zero on purpose, and `idle`'s opposite number rather than a
  // shade of it: `idle` is the column's default, so it is what a workload that
  // has never been deployed wears. `mute` because a stop is not a
  // fault — the glyph is `cancelled`'s, which is the other state an operator
  // chose.
  stopped: { glyph: "⊘", tone: "mute", label: "stopped" },
  inactive: { glyph: "○", tone: "mute", label: "inactive" },
} satisfies Record<string, Mark>;

export type StatusKey = keyof typeof STATUS;

/**
 * Docker's own container states, from `docker ps --format '{{.State}}'`
 * (`CONTAINER_LIST_FIELDS`, in `docker-ops/docker-ops.service.ts`). Third-party
 * strings keep their own names — this
 * is Docker's vocabulary, not ours, which is why it is not folded into STATUS.
 */
export const CONTAINER_STATE = {
  running: { glyph: "●", tone: "ok", label: "running" },
  created: { glyph: "○", tone: "warn", label: "created" },
  restarting: { glyph: "◐", tone: "warn", label: "restarting" },
  removing: { glyph: "◐", tone: "warn", label: "removing" },
  paused: { glyph: "⊘", tone: "warn", label: "paused" },
  exited: { glyph: "○", tone: "mute", label: "exited" },
  dead: { glyph: "✕", tone: "bad", label: "dead" },
} satisfies Record<string, Mark>;

export type ContainerState = keyof typeof CONTAINER_STATE;

/**
 * Swarm task desired states, from `docker service ps --format
 * '{{.DesiredState}}'`, lowercased on the way out of the backend
 * (`DockerOpsService.getTaskList`, which both task listings share). Swarm's
 * `ready` means "assigned, about to start" — it is a step on the way to running,
 * not a healthy resting state.
 */
export const TASK_STATE = {
  running: { glyph: "●", tone: "ok", label: "running" },
  ready: { glyph: "◐", tone: "warn", label: "ready" },
  accepted: { glyph: "○", tone: "warn", label: "accepted" },
  shutdown: { glyph: "⊘", tone: "mute", label: "shutdown" },
} satisfies Record<string, Mark>;

export type TaskState = keyof typeof TASK_STATE;

/** A signed change gutter: what this plan or diff does to a thing. */
export type ChangeTone = "add" | "chg" | "del" | "noop";

export type ChangeMark = {
  glyph: string;
  tone: ChangeTone;
  label: string;
};

export const GUT = {
  create: { glyph: "+", tone: "add", label: "create" },
  change: { glyph: "⇆", tone: "chg", label: "change" },
  replace: { glyph: "⇆", tone: "chg", label: "replace" },
  destroy: { glyph: "−", tone: "del", label: "destroy" },
  noop: { glyph: "○", tone: "noop", label: "no-op" },
  read: { glyph: "○", tone: "noop", label: "read" },
} satisfies Record<string, ChangeMark>;

export type ChangeKey = keyof typeof GUT;

/* ------------------------------------------------------------------ *
 * Tone → classes. The one place a tone becomes colour, so a pill, a
 * dot, a row tint and a chart series cannot drift apart.
 * ------------------------------------------------------------------ */

/** Text on a plain surface. */
export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
  info: "text-info",
  mute: "text-tx-3",
};

/** A bordered, tinted pill. */
export const TONE_PILL: Record<Tone, string> = {
  ok: "text-ok bg-ok-tint border-ok-line",
  warn: "text-warn bg-warn-tint border-warn-line",
  bad: "text-bad bg-bad-tint border-bad-line",
  info: "text-info bg-info-tint border-info-line",
  mute: "text-tx-3 bg-panel-2 border-line",
};

/** A bare fill: a dot, a bar, a sparkline. Always sits beside its word. */
export const TONE_FILL: Record<Tone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  info: "bg-info",
  mute: "bg-tx-4",
};

export const CHANGE_TEXT: Record<ChangeTone, string> = {
  add: "text-ok",
  chg: "text-warn",
  del: "text-bad",
  noop: "text-tx-3",
};

/* ------------------------------------------------------------------ *
 * Resolvers
 *
 * The product's own statuses are typed, so a wrong key is a compile
 * error. Docker's and Swarm's arrive as free text over SSH, so those
 * resolvers take a string and, when they meet a state Docker has added
 * since, label it with the word Docker used. An unknown state shows its
 * own name; it never shows "undefined".
 * ------------------------------------------------------------------ */

export function statusMark(key: StatusKey): Mark {
  return STATUS[key];
}

function resolve(map: Record<string, Mark>, state: string): Mark {
  const key = state.trim().toLowerCase();
  return (
    map[key] ?? { glyph: "○", tone: "mute", label: key || "unknown" }
  );
}

export function containerMark(state: string): Mark {
  return resolve(CONTAINER_STATE, state);
}

export function taskMark(state: string): Mark {
  return resolve(TASK_STATE, state);
}

export function changeMark(kind: ChangeKey): ChangeMark {
  return GUT[kind];
}
