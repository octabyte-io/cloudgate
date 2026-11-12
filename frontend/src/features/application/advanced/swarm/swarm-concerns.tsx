import type { FieldSpec } from "../resource-spec";
import { durationToNanos, readDuration } from "@/lib/format/units";
import type { SwarmValues } from "./swarm-values";
import { example } from "@/components/console/form-spec";

/**
 * **The eleven Swarm concerns, as data.**
 *
 * The eleven are one table read by one form, not eleven form components each
 * fetching the Application with its own submit and its own toast — which is what
 * F10's brief asks for ("one `Card` per concern … sharing a single form context
 * — not 11 separate pages") and what stops the phase turning into forty
 * near-identical files.
 *
 * Two of them are literally the same six fields, because `updateConfigSwarm` and
 * `rollbackConfigSwarm` are the same zod schema on the backend. `updateFields`
 * is written once and called twice.
 *
 * Every duration here is typed in **seconds** (or with `ms`, `m`, `h`) and
 * stored as the nanoseconds `mechanize.ts` passes straight through to the
 * Docker Engine API; `swarm-values.ts` converts. They used to be typed
 * raw, where `30` was thirty nanoseconds and a health check set to that ran
 * continuously. Each still carries a live reading, so `90` says `= 1.5m`.
 */

/** The eleven cards, by id — and, below, which column each of them edits. */
export type SwarmConcernId =
  | "mode"
  | "placement"
  | "labels"
  | "network"
  | "restart"
  | "update"
  | "rollback"
  | "health"
  | "endpoint"
  | "stop"
  | "ulimits";

/**
 * The concerns an AI model's API refuses to change: its networks keep
 * it on `cloudgate-ai` alone, and its health check and endpoint spec are the
 * runtime's and the gateway's. The console does not offer them.
 */
export const AI_MODEL_LOCKED_CONCERNS: readonly SwarmConcernId[] = [
  "network",
  "health",
  "endpoint",
];

/**
 * The seven a described Service's Project config owns as `native.docker`
 * (ADR-0044): placement, networks, the endpoint spec and the mode
 * name a host or differ per Environment, so they stay the console's.
 */
export const CONFIG_OWNED_CONCERNS: readonly SwarmConcernId[] = [
  "labels",
  "restart",
  "update",
  "rollback",
  "health",
  "stop",
  "ulimits",
];

/**
 * **The seven a kind with no long-lived Swarm service refuses**, by
 * concern: a hand mirror of the backend's `DOCKER_KEYS_CLOSED_ON_KIND`
 * (`backend/src/native/docker-native.ts`), which a test reads back. A `cron`
 * takes Labels, the stop grace period and ulimits; a `bucket` takes Labels
 * alone. Every kind not listed takes all seven.
 */
export const CONCERNS_CLOSED_ON_KIND: Readonly<
  Record<string, readonly SwarmConcernId[]>
> = {
  cron: ["health", "restart", "update", "rollback"],
  bucket: ["health", "restart", "update", "rollback", "stop", "ulimits"],
};

/**
 * The concerns a described Service's file owns for its kind:
 * the seven less the ones its kind refuses, which stay the console's (and
 * which the console's save refuses a value for on a Cron service).
 */
export function configOwnedConcerns(
  kind: string | null | undefined,
): readonly SwarmConcernId[] {
  const closed = (kind && CONCERNS_CLOSED_ON_KIND[kind]) || [];
  return CONFIG_OWNED_CONCERNS.filter((id) => !closed.includes(id));
}

/** How the lock note names each of the seven, in its order. */
const OWNED_WORDS: Readonly<Record<string, string>> = {
  labels: "Labels",
  restart: "the restart policy",
  update: "the update config",
  rollback: "the rollback config",
  health: "the health check",
  stop: "the stop grace period",
  ulimits: "ulimits",
};

/** The owned concerns as one phrase: "Labels, the stop grace period and ulimits". */
export function ownedConcernWords(owned: readonly SwarmConcernId[]): string {
  const words = owned.map((id) => OWNED_WORDS[id] ?? id);
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * **The inverse of `toSwarmColumns`, for refusals**.
 *
 * The eleven columns are folded out of forty-odd flat fields, so a 400 comes
 * back naming `labelsSwarm` while the form's own names are `labels.0.key` and
 * the like. Every one of them used to miss, and the whole refusal — the
 * traefik-namespace rule among them — was read out under all eleven cards as
 * "The backend refused a value this form does not show — labelsSwarm: …",
 * which named an internal column and said the form does not show a card that
 * is right there.
 *
 * There is no mechanical inverse to derive: a column is folded from several
 * fields and which of them is at fault is not in the issue. The card is,
 * though, and that is what this says. `swarm-section.test.tsx` holds it against
 * `toSwarmColumns`' own keys, so a twelfth column cannot arrive without one.
 */
export const CONCERN_OF_COLUMN: Partial<Record<string, SwarmConcernId>> = {
  modeSwarm: "mode",
  placementSwarm: "placement",
  labelsSwarm: "labels",
  networkSwarm: "network",
  restartPolicySwarm: "restart",
  updateConfigSwarm: "update",
  rollbackConfigSwarm: "rollback",
  healthCheckSwarm: "health",
  endpointSpecSwarm: "endpoint",
  stopGracePeriodSwarm: "stop",
  ulimitsSwarm: "ulimits",
};

export type SwarmConcern = {
  id: SwarmConcernId;
  title: string;
  lede: string;
  fields: FieldSpec<SwarmValues>[];
  /** A sentence under the fields that is about consequences, not syntax. */
  note?: React.ReactNode;
};

const ORDER_OPTIONS = [
  { value: "", label: "Not set" },
  { value: "start-first", label: "start-first — new task before old stops" },
  { value: "stop-first", label: "stop-first — old task stops before new starts" },
] as const;

/**
 * The three failure actions. The empty choice is written at the field below
 * rather than here, because what it deploys differs between the two cards.
 */
const FAILURE_ACTIONS = [
  { value: "pause", label: "pause — stop rolling out" },
  { value: "continue", label: "continue — keep going" },
  { value: "rollback", label: "rollback — go back to the previous spec" },
] as const;

/** The six fields `UpdateConfig` and `RollbackConfig` both have. */
function updateFields(
  prefix: "update" | "rollback",
  values: SwarmValues,
): FieldSpec<SwarmValues>[] {
  const name = <K extends string>(suffix: K) =>
    `${prefix}${suffix}` as keyof SwarmValues & string;
  const delay = values[name("Delay")] as string;
  const monitor = values[name("Monitor")] as string;

  return [
    {
      kind: "number",
      name: name("Parallelism"),
      label: "Parallelism",
      min: 0,
      hint: "How many tasks are replaced at once. Zero replaces them all together.",
    },
    {
      kind: "select",
      name: name("Order"),
      label: "Order",
      options: ORDER_OPTIONS,
      hint: "start-first keeps capacity through the change and needs room for both. stop-first is the safe choice when a volume can only be held once.",
    },
    {
      kind: "text",
      name: name("Delay"),
      label: "Delay",
      optional: true,
      mono: true,
      placeholder: example("10"),
      hint: duration(delay, "Between one batch of tasks and the next."),
    },
    {
      kind: "select",
      name: name("FailureAction"),
      label: "On failure",
      optional: true,
      // **The empty choice says what it deploys**. Leaving it alone used
      // to change it: a saved update config replaced Cloudgate's default block
      // whole, so an operator who filled in Parallelism and Order — the two the
      // Docker Engine API requires — deployed with Docker's `pause` instead of
      // Cloudgate's `rollback`, and a failing release stopped rolling back.
      // `mechanize.ts` now lays the fields that are set over the defaults, and
      // this label is which default that leaves standing: `rollback` for an
      // update, and the Engine's own for a rollback, which Cloudgate does not
      // set.
      options: [
        {
          value: "",
          label:
            prefix === "update"
              ? "Not set — deployed as rollback"
              : "Not set — left to the Docker Engine",
        },
        ...FAILURE_ACTIONS,
      ],
    },
    {
      kind: "text",
      name: name("Monitor"),
      label: "Monitor",
      optional: true,
      mono: true,
      placeholder: example("5"),
      hint: duration(
        monitor,
        "How long a task has to stay up before it counts as a success.",
      ),
    },
    {
      kind: "text",
      name: name("MaxFailureRatio"),
      label: "Maximum failure ratio",
      optional: true,
      mono: true,
      placeholder: "0.1",
      hint: "Between 0 and 1. The share of tasks allowed to fail before the failure action runs.",
    },
  ];
}

/**
 * The kind of mode Swarm compares: "Not set" deploys a replicated service, so
 * it and "Replicated" are one kind and moving between them is an update.
 */
function modeFamily(kind: SwarmValues["modeKind"]) {
  return kind === "" ? "replicated" : kind;
}

/**
 * `saved` is the mode the Application was loaded with. A choice of another kind
 * of mode is what the Service mode card warns about before it is saved.
 */
export function swarmConcerns(
  values: SwarmValues,
  saved?: Pick<SwarmValues, "modeKind">,
): SwarmConcern[] {
  const replacesService =
    saved !== undefined &&
    modeFamily(values.modeKind) !== modeFamily(saved.modeKind);

  return [
    {
      id: "mode",
      title: "Service mode",
      lede: "How many tasks Swarm runs, and whether they finish.",
      fields: [
        {
          kind: "select",
          name: "modeKind",
          label: "Mode",
          options: [
            { value: "", label: "Not set — replicated, from the Replicas field" },
            { value: "replicated", label: "Replicated — a fixed number of tasks" },
            { value: "global", label: "Global — one task on every node" },
            { value: "replicatedJob", label: "Replicated job — runs and finishes" },
            { value: "globalJob", label: "Global job — runs once per node" },
          ],
        },
        {
          kind: "number",
          name: "modeReplicas",
          label: "Replicas",
          min: 0,
          when: (v) => v.modeKind === "replicated",
        },
        {
          kind: "number",
          name: "modeMaxConcurrent",
          label: "Maximum concurrent",
          optional: true,
          min: 0,
          when: (v) => v.modeKind === "replicatedJob",
        },
        {
          kind: "number",
          name: "modeTotalCompletions",
          label: "Total completions",
          optional: true,
          min: 0,
          when: (v) => v.modeKind === "replicatedJob",
        },
      ],
      // Swarm refuses to change a service's mode in place, so a
      // Deployment removes the service and creates it again. Said always, and
      // said first once a different kind of mode is chosen — the console cannot
      // tell from the row whether a service exists (a row stopped by an older
      // version wears the never-deployed `idle`, and `error` is either), so the
      // sentence is conditional on it.
      note: (
        <>
          {replacesService ? (
            <strong className="font-medium text-tx">
              This replaces the service.{" "}
            </strong>
          ) : null}
          Swarm cannot change the mode of a service that exists, so when this
          Application is deployed its next Deployment removes the service and
          creates it again: its domains answer nothing until the new tasks are
          running. Volumes are kept. Setting a mode here also{" "}
          <strong>overrides the Replicas field</strong> on the Resources card;
          the two are never combined.
        </>
      ),
    },

    {
      id: "placement",
      title: "Placement",
      lede: "Which nodes this may run on, and how it spreads across them.",
      fields: [
        {
          kind: "lines",
          name: "placementConstraints",
          label: "Constraints",
          optional: true,
          rows: 3,
          placeholder: "node.role == worker\nnode.labels.disk == ssd",
          hint: "One per line. A task with no node satisfying every one of these stays pending for ever, with nothing in the Deployment log to say so.",
        },
        {
          kind: "number",
          name: "placementMaxReplicas",
          label: "Maximum replicas per node",
          optional: true,
          min: 0,
        },
        {
          kind: "rows",
          name: "placementPreferences",
          label: "Spread preferences",
          addLabel: "Add a preference",
          emptyLabel: "No preference — Swarm places tasks wherever it likes.",
          hint: "Soft, unlike a constraint: Swarm balances across the values of a label instead of refusing to place.",
          columns: [
            {
              name: "spread",
              label: "Spread descriptor",
              kind: "text",
              placeholder: "node.labels.zone",
            },
          ],
        },
        {
          kind: "rows",
          name: "placementPlatforms",
          label: "Platforms",
          addLabel: "Add a platform",
          emptyLabel: "Any platform.",
          columns: [
            {
              name: "architecture",
              label: "Architecture",
              kind: "text",
              placeholder: example("amd64"),
            },
            { name: "os", label: "OS", kind: "text", placeholder: example("linux") },
          ],
        },
      ],
    },

    {
      id: "labels",
      title: "Labels",
      lede: "Docker labels on the service, for anything reading them.",
      fields: [
        {
          kind: "rows",
          name: "labels",
          label: "Labels",
          addLabel: "Add a label",
          emptyLabel: "No labels.",
          hint: "These reach the Swarm service, not the container image. Traefik's own labels are written by Cloudgate and do not belong here.",
          columns: [
            { name: "key", label: "Key", kind: "text", placeholder: example("team") },
            { name: "value", label: "Value", kind: "text", placeholder: example("storefront") },
          ],
        },
      ],
    },

    {
      id: "network",
      title: "Networks",
      lede: "Overlay networks this attaches to, beyond the default one.",
      fields: [
        {
          kind: "rows",
          name: "networks",
          label: "Networks",
          addLabel: "Add a network",
          emptyLabel: "Only cloudgate-network, which every service joins.",
          hint: "The network has to exist on the Server already — nothing here creates one.",
          columns: [
            {
              name: "target",
              label: "Network",
              kind: "text",
              placeholder: example("internal-db"),
            },
            {
              name: "aliases",
              label: "Aliases",
              kind: "text",
              placeholder: example("db, primary"),
            },
          ],
        },
      ],
      // A saved list used to replace cloudgate-network, and every domain
      // answered 502. It is added to it now, which is what the lede promised.
      note: "cloudgate-network is always attached, because it is how this Application's domains reach it; list it here only to give it aliases. Aliases are comma-separated. Anything else already set on a network — driver options, for instance — is kept when this saves.",
    },

    {
      id: "restart",
      title: "Restart policy",
      lede: "What Swarm does when a task exits.",
      fields: [
        {
          kind: "select",
          name: "restartCondition",
          label: "Condition",
          optional: true,
          options: [
            { value: "", label: "Not set" },
            { value: "any", label: "any — always restart" },
            { value: "on-failure", label: "on-failure — only on a non-zero exit" },
            { value: "none", label: "none — never restart" },
          ],
        },
        {
          kind: "text",
          name: "restartDelay",
          label: "Delay",
          optional: true,
          mono: true,
          placeholder: example("5"),
          hint: duration(values.restartDelay, "Before restarting."),
        },
        {
          kind: "number",
          name: "restartMaxAttempts",
          label: "Maximum attempts",
          optional: true,
          min: 0,
          hint: "Within the window below. Zero means keep trying.",
        },
        {
          kind: "text",
          name: "restartWindow",
          label: "Window",
          optional: true,
          mono: true,
          placeholder: example("120"),
          hint: duration(
            values.restartWindow,
            "The period the attempt count is measured over.",
          ),
        },
      ],
    },

    {
      id: "update",
      title: "Update config",
      lede: "How a new version replaces the running one.",
      fields: updateFields("update", values),
      note: "Parallelism and Order are both required by the Docker Engine API, so this concern is only saved once both are filled in.",
    },

    {
      id: "rollback",
      title: "Rollback config",
      lede: "The same, for when Swarm puts the previous version back.",
      fields: updateFields("rollback", values),
      note: "Docker's own rollback, not the Rollbacks tab — this is what happens when an update's failure action is `rollback`.",
    },

    {
      id: "health",
      title: "Health check",
      lede: "How Swarm decides this task is working.",
      fields: [
        {
          kind: "lines",
          name: "healthTest",
          label: "Test",
          optional: true,
          rows: 3,
          placeholder: "CMD-SHELL\ncurl -f http://localhost:3000/health || exit 1",
          hint: "One argument per line, Docker's array form. The first line is usually CMD or CMD-SHELL; NONE on its own disables the image's own check.",
        },
        {
          kind: "text",
          name: "healthInterval",
          label: "Interval",
          optional: true,
          mono: true,
          placeholder: example("30"),
          hint: duration(values.healthInterval, "Between checks."),
        },
        {
          kind: "text",
          name: "healthTimeout",
          label: "Timeout",
          optional: true,
          mono: true,
          placeholder: example("10"),
          hint: duration(values.healthTimeout, "Before a check counts as failed."),
        },
        {
          kind: "text",
          name: "healthStartPeriod",
          label: "Start period",
          optional: true,
          mono: true,
          placeholder: example("60"),
          hint: duration(
            values.healthStartPeriod,
            "Grace while the container boots — failures in this window do not count.",
          ),
        },
        {
          kind: "number",
          name: "healthRetries",
          label: "Retries",
          optional: true,
          min: 0,
          hint: "Consecutive failures before the task is unhealthy and replaced.",
        },
      ],
    },

    {
      id: "endpoint",
      title: "Endpoint spec",
      lede: "How Swarm publishes this service on the network.",
      fields: [
        {
          kind: "select",
          name: "endpointMode",
          label: "Mode",
          optional: true,
          options: [
            { value: "", label: "Not set" },
            { value: "vip", label: "vip — one virtual IP, Swarm load balances" },
            { value: "dnsrr", label: "dnsrr — DNS returns every task's address" },
          ],
        },
        {
          kind: "rows",
          name: "endpointPorts",
          label: "Published ports",
          addLabel: "Add a port",
          emptyLabel: "No ports published through the endpoint spec.",
          hint: "The Docker Engine's own port list. Separate from the Ports section above, which is Cloudgate's table — and the reason that one is worth having is that it survives a change here.",
          columns: [
            {
              name: "targetPort",
              label: "Container",
              kind: "number",
              narrow: true,
              placeholder: example("3000"),
            },
            {
              name: "publishedPort",
              label: "Host",
              kind: "number",
              narrow: true,
              placeholder: example("8080"),
            },
            { name: "protocol", label: "Protocol", kind: "text", placeholder: example("tcp") },
            {
              name: "publishMode",
              label: "Publish mode",
              kind: "text",
              placeholder: example("ingress"),
            },
          ],
        },
      ],
    },

    {
      id: "stop",
      title: "Stop grace period",
      lede: "How long a task has to shut down cleanly.",
      fields: [
        {
          kind: "text",
          name: "stopGracePeriod",
          label: "Stop grace period",
          optional: true,
          mono: true,
          placeholder: example("30"),
          hint: duration(
            values.stopGracePeriod,
            "Between SIGTERM and SIGKILL. Too short is how in-flight requests get dropped on every Deployment.",
          ),
        },
      ],
    },

    {
      id: "ulimits",
      title: "Ulimits",
      lede: "Kernel resource limits inside the container.",
      fields: [
        {
          kind: "rows",
          name: "ulimits",
          label: "Ulimits",
          addLabel: "Add a ulimit",
          emptyLabel: "The image's own limits apply.",
          // Mono, not backticks: the literal characters rendered on screen here.
          // `nofile` is a kernel limit's name, so it is set the way the
          // Name column below will show it once it is typed.
          hint: (
            <>
              <code className="font-mono">nofile</code> is the one most services
              need raised, and the one whose absence shows up as a connection
              failure under load rather than as an error about limits.
            </>
          ),
          columns: [
            { name: "name", label: "Name", kind: "text", placeholder: example("nofile") },
            { name: "soft", label: "Soft", kind: "number", narrow: true },
            { name: "hard", label: "Hard", kind: "number", narrow: true },
          ],
        },
      ],
    },
  ];
}

/** The live reading first, then what the field is for. */
function duration(value: string, explanation: string): React.ReactNode {
  const nanos = durationToNanos(value);
  const reading =
    nanos === null || Number.isNaN(nanos) ? null : readDuration(String(nanos));
  if (!reading) return `In seconds. ${explanation}`;
  return (
    <>
      <strong className="font-medium text-tx-2">= {reading}</strong>
      {" · "}
      {explanation}
    </>
  );
}
