import { z } from "zod";

import type { ResourceSpec } from "@/components/console/resource-spec";
import {
  ERROR_RATE_THRESHOLD_WINDOWS,
  type ErrorRateThreshold,
  type PutErrorRateThresholdInput,
} from "@/lib/api/endpoints/service-health";

import { minutesLabel, thresholdWords } from "./health-words";

/**
 * **An Error-rate threshold, as a `ResourceSpec`**: the modal that adds
 * and edits a Service's one threshold, and the confirmation that removes it.
 * `ThresholdSection` renders them; there is no list, because a Service has at
 * most one.
 *
 * The bounds are `PutErrorRateThresholdDto`'s, said here first: a percentage
 * of 1 to 100, a window of 1, 5, 15 or 30 minutes, at least one request.
 * The console asks for a whole percent — a number box steps by one — though
 * the route takes a fraction of one.
 *
 * **Add and edit are the same `PUT`**, with the whole rule: the threshold is
 * named by its Service, not by an id of its own.
 */

const WINDOWS = ERROR_RATE_THRESHOLD_WINDOWS.map(String) as [string, ...string[]];

const schema = z.object({
  percentage: z
    .number({ message: "The share of requests, in percent." })
    .int("A whole percent.")
    .min(1, "At least 1 %.")
    .max(100, "At most 100 %."),
  windowMinutes: z.enum(WINDOWS, { message: "Pick a window." }),
  minRequests: z
    .number({ message: "How many requests make a window worth judging." })
    .int("A whole number.")
    .min(1, "At least 1.")
    .max(1_000_000, "At most 1,000,000."),
  enabled: z.boolean(),
});

export type ErrorRateThresholdValues = z.infer<typeof schema>;

/** The defaults the backend puts on a `PUT {}`: 5 % over 5 minutes, 20 requests, on. */
export const THRESHOLD_DEFAULTS: PutErrorRateThresholdInput = {
  percentage: 5,
  windowMinutes: 5,
  minRequests: 20,
  enabled: true,
};

export function toThresholdInput(
  values: ErrorRateThresholdValues,
): PutErrorRateThresholdInput {
  return {
    percentage: values.percentage,
    windowMinutes: Number(values.windowMinutes),
    minRequests: values.minRequests,
    enabled: values.enabled,
  };
}

export function errorRateThresholdSpec({
  put,
  remove,
}: {
  put: (input: PutErrorRateThresholdInput) => Promise<unknown>;
  remove: () => Promise<unknown>;
}): ResourceSpec<ErrorRateThreshold, ErrorRateThresholdValues> {
  return {
    noun: "Error-rate threshold",
    plural: "Error-rate thresholds",
    title: "Error-rate threshold",
    icon: "gauge",
    addLabel: "Add a threshold",
    emptyTitle: "No threshold",
    emptyBody: "",
    // No table: `ThresholdSection` shows the one threshold as facts.
    columns: [],
    getRowId: (row) => row.errorRateThresholdId,
    rowName: (row) => `the ${thresholdWords(row)} threshold`,

    schema,
    fields: [
      {
        kind: "number",
        name: "percentage",
        label: "Error rate (%)",
        min: 1,
        max: 100,
        hint: "A window whose share of 5xx answers is at least this opens an Incident. The first window under it closes the Incident.",
      },
      {
        kind: "select",
        name: "windowMinutes",
        label: "Window",
        options: ERROR_RATE_THRESHOLD_WINDOWS.map((minutes) => ({
          value: String(minutes),
          label: `The last ${minutesLabel(minutes)}`,
        })),
        hint: "Judged at every collection, about once a minute, over this trailing window.",
      },
      {
        kind: "number",
        name: "minRequests",
        label: "Minimum requests in the window",
        min: 1,
        hint: "A window with fewer requests is too quiet to judge: it neither opens nor closes an Incident, so a Service nobody calls never pages.",
      },
      {
        kind: "switch",
        name: "enabled",
        label: "Enabled",
        hint: "Turning it off stops the judging and keeps its history. An open Incident closes as turned off.",
      },
    ],

    toDefaults: (row) => {
      const rule = row ?? THRESHOLD_DEFAULTS;
      return {
        percentage: rule.percentage,
        windowMinutes: String(rule.windowMinutes),
        minRequests: rule.minRequests,
        enabled: rule.enabled,
      };
    },

    // Every write is `service: ['update']` on the Service, turning it
    // off or on included.
    permissions: {
      create: { service: ["update"] },
      update: { service: ["update"] },
      remove: { service: ["update"] },
    },
    create: (values) => put(toThresholdInput(values)),
    update: (_row, values) => put(toThresholdInput(values)),
    remove: () => remove(),

    deleteDescription:
      "This removes the Error-rate threshold with its Incident history. It cannot be put back.",
    deleteNote: () => (
      <>
        The Error rate stops being judged, and the threshold&rsquo;s Incidents
        are deleted with it.{" "}
        <strong className="font-medium text-tx">Nothing is announced</strong>:
        an Incident open now is not closed on your notification channels. Turn
        the threshold off instead to close it and keep the history.
      </>
    ),
  };
}
