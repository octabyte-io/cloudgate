import { z } from "zod";

import { example, type FieldSpec } from "@/components/console/form-spec";
import type { MetricsConfigInput } from "@/lib/api/endpoints/monitoring";
import type { MetricsConfig } from "@/lib/api/endpoints/servers";
import { configCollects } from "@/lib/format/sampling";

/**
 * How a host is sampled, as a form.
 *
 * **Written for a Server, and it serves the web server too**
 * The two setup
 * routes take the same body — identical zod schemas, member for member — so what
 * varies between the per-Server dialog and the instance-wide one is the wording
 * and the mutation, not the form. Everything here therefore works on a bare
 * `metricsConfig` rather than on a `Server` row: the web server has no `server`
 * row, which is the whole reason this exists, and a spec that demanded one would
 * have forced a second copy of these eight fields.
 *
 * **Eight fields out of the route's eleven, and the three that are missing are
 * the finding.** Setup takes the whole `metricsConfig`, and three of its members
 * change nothing in this backend:
 *
 * - **`token`** is read by `registerServer` as `if (!config?.server?.token) return`,
 *   so to this form it is the on switch. So it is not a field: a text box whose
 *   empty value silently means "collect nothing, for ever" is the worst possible
 *   spelling of a switch. The form generates one when there is none, and
 *   `stopCollecting` below is how it is turned off — named for what it does
 *   rather than "clear the token".
 *
 *   **It is also a credential, and that is what changed.** Possession of it is
 *   the whole of `POST /notifications/receive`'s authentication, and the copy on
 *   the `web_server_settings` singleton authenticates the *instance-wide* branch
 *   — one forged alert into every organization's channels. `GET
 *   /settings/web-server` is open to any authenticated member, so the route now
 *   projects the value out and sends `server.hasToken` in its place. Two
 *   consequences: `configCollects` (`lib/format/sampling.ts`) reads the switch
 *   from whichever of the two arrived, and `toMetricsConfig` below can no
 *   longer re-submit a value it cannot see — it **omits** the field, and the
 *   route keeps what is stored.
 * - **`port`** and **`urlCallback`** describe where an *external* metrics agent
 *   would post to `POST /notifications/receive`. Cloudgate deploys no agent; it
 *   samples over SSH from `MonitoringService`. They are stored and read by
 *   nothing, so they are not fields either — but they are **carried through
 *   untouched**, because a host configured for a real external agent must not
 *   have its callback quietly replaced by a form that does not show it.
 *
 * The other subtlety is that `defaultMetricsConfig` **cannot be submitted**: it
 * ships `urlCallback: ''` and `cronJob: ''`, which the DTO refuses (`z.url()` and
 * `min(1)`). So a form prefilled straight off the row would 400 on a host nobody
 * had configured yet, which is every Server and this instance. `valuesFor`
 * substitutes a valid value only where the stored one would be refused.
 */

/** What the form holds — flat, because a `FieldSpec` name is one key. */
export interface MetricsFormValues {
  refreshRate: number;
  retentionDays: number;
  cronJob: string;
  cpuThreshold: number;
  memoryThreshold: number;
  containerRefreshRate: number;
  include: string;
  exclude: string;
}

export const metricsFormSchema = z.object({
  refreshRate: z.coerce
    .number()
    .int("Whole seconds.")
    .min(2, "Cloudgate cannot sample more often than every 2 seconds."),
  retentionDays: z.coerce
    .number()
    .int("Whole days.")
    .min(1, "Samples have to be kept for at least a day."),
  cronJob: z.string().trim().min(1, "The cleanup needs a schedule."),
  cpuThreshold: z.coerce
    .number()
    .min(0, "A percentage, or 0 to raise no CPU alert.")
    .max(100, "A percentage cannot go above 100."),
  memoryThreshold: z.coerce
    .number()
    .min(0, "A percentage, or 0 to raise no memory alert.")
    .max(100, "A percentage cannot go above 100."),
  containerRefreshRate: z.coerce
    .number()
    .int("Whole seconds.")
    .min(2, "Cloudgate cannot sample more often than every 2 seconds."),
  include: z.string(),
  exclude: z.string(),
}) satisfies z.ZodType<MetricsFormValues>;

/** A cleanup that runs nightly, for a Server that has never had one. */
const DEFAULT_CRON = "0 3 * * *";

/** Only ever used to satisfy `z.url()` on a field nothing reads. */
const PLACEHOLDER_CALLBACK = "http://127.0.0.1:4500/metrics";

export function valuesFor(config: MetricsConfig): MetricsFormValues {
  return {
    refreshRate: config.server.refreshRate || 60,
    retentionDays: config.server.retentionDays || 2,
    // The stored default is `''`, which the route refuses.
    cronJob: config.server.cronJob.trim() || DEFAULT_CRON,
    cpuThreshold: config.server.thresholds.cpu,
    memoryThreshold: config.server.thresholds.memory,
    containerRefreshRate: config.containers.refreshRate || 60,
    include: (config.containers.services.include ?? []).join("\n"),
    exclude: (config.containers.services.exclude ?? []).join("\n"),
  };
}

/** One entry per line, blanks dropped — `lines` is a textarea. */
function toList(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Form values → the route's body, carrying through what the form does not show.
 *
 * **`token` has three cases and they are not interchangeable.** The invariant
 * has not moved — saving a change to a host that is already collecting must not
 * rotate a value someone may have configured an external agent with — but the
 * console can no longer see that value on the web server, so the way it is
 * honoured did:
 *
 * - the host has none → generate one, which is what "Start sampling" means;
 * - the host has one and the route sent it (a `server` row off `GET /servers`,
 *   which is now the only read that still carries the value) → send it
 *   back unchanged, exactly as before;
 * - the host has one and the route withheld it (`hasToken` — the web-server
 *   singleton, and now the nested `server` on any service read too) →
 *   **omit the field**, and the route keeps what is stored. Both setup routes
 *   accept an omitted `token` for exactly this; it was once required on the
 *   per-Server one, which refused this body. An empty string would
 *   mean the opposite — `stopCollecting` below is the only thing entitled to
 *   send one.
 */
export function toMetricsConfig(
  config: MetricsConfig,
  values: MetricsFormValues,
): MetricsConfigInput {
  const stored = config.server;
  const callback = stored.urlCallback.trim();
  const token = (stored.token ?? "").trim();

  return {
    server: {
      refreshRate: values.refreshRate,
      port: stored.port || 4500,
      // `undefined` drops the key from the JSON body, which is the "keep the
      // stored token" case; a generated one only ever replaces nothing.
      token: token || (configCollects(config) ? undefined : generateToken()),
      urlCallback: isUrl(callback) ? callback : PLACEHOLDER_CALLBACK,
      retentionDays: values.retentionDays,
      cronJob: values.cronJob.trim(),
      thresholds: { cpu: values.cpuThreshold, memory: values.memoryThreshold },
    },
    containers: {
      refreshRate: values.containerRefreshRate,
      services: {
        include: toList(values.include),
        exclude: toList(values.exclude),
      },
    },
  };
}

/**
 * The same config with an empty token — which is the only way to stop
 * collecting. `registerTarget` unregisters every job before it checks the token,
 * so this really does tear the intervals down rather than leaving them running.
 */
export function stopCollecting(config: MetricsConfig): MetricsConfigInput {
  const current = toMetricsConfig(config, valuesFor(config));
  return { ...current, server: { ...current.server, token: "" } };
}

/*
 * `configCollects` and `samplingState` — is this host being sampled, and was it
 * ever — lived here until a Server's Telemetry tab needed them too. They are
 * `lib/format/sampling.ts` now (§1.4's promotion rule).
 */

/**
 * The services a host would collect container samples for. **Empty is the
 * default and it means "no container metrics, ever"** — there is no value that
 * means everything, so a form that shipped this default without saying so would
 * be a trap (note 3 in `endpoints/monitoring.ts`). Both forms say it.
 */
export function includedFrom(config: MetricsConfig | null): string[] {
  return (config?.containers.services.include ?? []).filter(
    (entry) => entry.trim() !== "",
  );
}

/**
 * The entries in **"Never collect for"** that suppress every container `name`
 * could reach — empty when none of them does.
 *
 * **This is a question the console can answer and was sending to the backend.**
 * Put a running service in both lists — which the form invites, since the two
 * are edited side by side — and the exclusion wins, as the form's own hint says
 * ("checked first — an exclusion beats an inclusion"). The read then refuses the
 * name with "Either nothing running here matches that name, or collection has
 * not stored its first sample yet", and both halves of that are false: the
 * container is running, and collection will never store a sample for it. The one
 * true cause was the only one not offered. `resolveServiceName` cannot tell the
 * two apart — it resolves against stored rows, so an excluded name and an
 * unknown one look identical there — but the config is right here, in the card's
 * own props.
 *
 * **Both lists match as substrings of the *container's* name**
 * (`shouldMonitorContainer`), so what can be claimed depends on which name is
 * being asked about:
 *
 * - An entry that is a substring of `name` catches **every** container `name`
 *   can match, whatever is running. That is the reported case (one name in both
 *   boxes) and the answer is certain without knowing the container list.
 * - An entry that merely overlaps it the other way — `app-nk3zbo.1` excluded
 *   while `app-nk3zbo` is asked about — catches some containers and not others,
 *   and which is which is not knowable from the config. It is deliberately
 *   **not** returned, because this sentence promises that nothing will ever be
 *   sampled and that promise is false when replica 2 is still being collected.
 *   Swapping a vague truth for a confident falsehood is the defect being fixed,
 *   not a new spelling of it. That case is not left unsaid, though — the read
 *   hedges instead, and the last paragraph here is where that lives.
 *
 * Passing a **whole container name** (as `ContainerHistory` does, where the
 * picker's target is Docker's full name) makes the first case exact: it is then
 * the same test collection itself runs.
 *
 * **The backend asks this too, and its copy is the authoritative one.**
 * `exclusionsForAppName` in `monitoring/collectors/container-stats.collector.ts`
 * applies the identical rule and `unresolvedAppNameRefusal` puts it on the wire,
 * which is what a caller that is not this console gets. This copy exists because
 * of what the console does with the answer: it explains the row *instead of*
 * that refusal, and `useContainerMetrics` does not issue the request at all for
 * an excluded name — so the one thing it cannot do is ask the backend a question
 * whose answer is the refusal it is trying to explain. Two spellings of one
 * rule, one per package, each beside that package's own matcher. Change one and
 * read the other.
 *
 * The backend carries a second arm this file deliberately does not,
 * `partialExclusionsForAppName`: an entry the queried name sits *inside*
 * (`app-nk3zbo` asked about, `app-nk3zbo.1` excluded) suppresses some replicas
 * and not others, so it earns a hedged sentence rather than this one. Neither
 * caller here can reach that case — `ContainerHistory` passes a whole container
 * name, where this test is exact, and the Containers card meets it only as the
 * backend's refusal, which says it. An arm nothing can exercise is not symmetry.
 */
export function exclusionsFor(
  config: MetricsConfig | null,
  name: string,
): string[] {
  return (config?.containers.services.exclude ?? []).filter(
    // A blank entry is a substring of everything, which would exclude the world.
    (entry) => entry.trim() !== "" && name.includes(entry),
  );
}

function isUrl(value: string): boolean {
  return URL.canParse(value);
}

/** 32 hex characters. Presence is all that is read; length is just hygiene. */
function generateToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * The fields. Every hint says what the number *does*, because every one of them
 * has a consequence that is not obvious from its name: an interval decides which
 * spikes are visible at all, a retention window decides how far back the
 * "7 days" range can really reach, and a threshold of 0 is off rather than
 * "alert always".
 *
 * `reach` completes "samples of this host, …" — the only sentence in the eight
 * that differs between a Server and the instance's own machine, because one is
 * read over SSH and the other through the local shell.
 */
export function metricsFields(reach: string): FieldSpec<MetricsFormValues>[] {
  return [
    {
      name: "refreshRate",
      label: "Sample every",
      kind: "number",
      min: 2,
      hint: `Seconds between samples of this host, ${reach}. A host sampled once a minute cannot show a spike that lasted twenty seconds.`,
    },
    {
      name: "retentionDays",
      label: "Keep samples for",
      kind: "number",
      min: 1,
      hint: "Days. Older samples are deleted by the cleanup below, so this is also how far back the longest range on the Monitoring screen can reach.",
    },
    {
      name: "cronJob",
      label: "Run the cleanup",
      kind: "text",
      mono: true,
      hint: "A cron expression. This is the job that enforces the retention window.",
    },
    {
      name: "cpuThreshold",
      label: "Notify above CPU",
      kind: "number",
      min: 0,
      max: 100,
      hint: "A percentage. Every sample above it notifies the Organization's channels. 0 raises no CPU alert.",
    },
    {
      name: "memoryThreshold",
      label: "Notify above memory",
      kind: "number",
      min: 0,
      max: 100,
      hint: "A percentage of memory in use. 0 raises no memory alert.",
    },
    {
      name: "containerRefreshRate",
      label: "Sample containers every",
      kind: "number",
      min: 2,
      hint: "Seconds. Only used when at least one service is included below.",
    },
    {
      name: "include",
      label: "Collect container metrics for",
      kind: "lines",
      rows: 3,
      optional: true,
      placeholder: "storefront-web-p1\nredis-12sp3x",
      hint: "One name per line. Leave this empty and no container metrics are collected at all — there is no value that means everything. Use each container's whole name, or a Swarm service's whole name: a substring is enough to start collecting and not enough to read the samples back.",
    },
    {
      name: "exclude",
      label: "Never collect for",
      kind: "lines",
      rows: 2,
      optional: true,
      placeholder: example("buildkit"),
      hint: "Also substrings, and checked first — an exclusion beats an inclusion.",
    },
  ];
}
