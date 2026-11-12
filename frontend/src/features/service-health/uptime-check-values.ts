import { z } from "zod";

import type { PickerOption } from "@/components/console/picker";
import type { Domain } from "@/lib/api/endpoints/domains";

import { parseExpectedStatuses } from "./health-words";

/**
 * **An Uptime check's form values**: the schema the modal
 * validates, the options its pickers offer, and how the write-only header
 * value becomes a create's or an update's body. Split out of
 * `uptime-check-spec.tsx`, which is the table and the fields over these.
 *
 * The bounds are `CreateUptimeCheckDto`'s, said here first so the form refuses
 * before the route does: an interval of 30 s to an hour, a timeout of 1 to 60 s
 * and never longer than the interval (one check's Probes must not overlap its
 * own schedule), 1 to 20 downs in a row, and expected statuses as classes
 * (`2xx`) or codes (`301`).
 */

const STATUS = /^(?:[1-5]xx|[1-5]\d\d)$/;

/** `CreateUptimeCheckDto`'s header-name rule: an RFC 9110 token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Node's header-value rule: one line, a tab and printable Latin-1. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
/** What the route refuses to let a check set (`RESERVED_HEADERS`). */
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-connection",
]);

export const uptimeCheckSchema = z
  .object({
    kind: z.enum(["http", "tcp"]),
    domainId: z.string(),
    /** A picker's value, so a string; the create and update send a number. */
    port: z.string(),
    intervalSeconds: z
      .number({ message: "How often to probe, in seconds." })
      .int("Whole seconds.")
      .min(30, "At least every 30 seconds.")
      .max(3600, "At most every hour (3600 seconds)."),
    timeoutSeconds: z
      .number({ message: "How long to wait, in seconds." })
      .int("Whole seconds.")
      .min(1, "At least 1 second.")
      .max(60, "At most 60 seconds."),
    expectedStatuses: z.string(),
    downAfter: z
      .number({ message: "How many downs in a row open an Incident." })
      .int("A whole number.")
      .min(1, "At least 1.")
      .max(20, "At most 20."),
    enabled: z.boolean(),
    keyword: z.string().max(256, "At most 256 characters."),
    headerName: z
      .string()
      .max(128, "At most 128 characters.")
      .refine((name) => name === "" || HEADER_NAME.test(name), {
        message: "Letters, digits and dashes, such as Authorization.",
      })
      .refine((name) => !RESERVED_HEADERS.has(name.toLowerCase()), {
        message: "That header decides how the request is routed or framed, and cannot be set.",
      }),
    /** What to do with a stored value; asked only when there is one. */
    headerValueAction: z.enum(["keep", "replace", "remove"]),
    headerValue: z
      .string()
      .max(4096, "At most 4096 characters.")
      .refine((value) => HEADER_VALUE.test(value), {
        message: "One line of printable characters.",
      }),
    /** Carried, never a field: whether the row has a stored value, and is an edit. */
    hasStoredValue: z.boolean(),
    editing: z.boolean(),
  })
  .refine((values) => values.timeoutSeconds <= values.intervalSeconds, {
    message: "The timeout cannot be longer than the interval.",
    path: ["timeoutSeconds"],
  })
  .superRefine((values, issues) => {
    const issue = (path: string, message: string) =>
      issues.addIssue({ code: "custom", path: [path], message });
    if (values.kind === "tcp") {
      if (values.port === "") issue("port", "Pick one of this Service's published ports.");
      return;
    }
    if (values.domainId === "") issue("domainId", "Pick one of this Service's Domains.");
    const statuses = parseExpectedStatuses(values.expectedStatuses);
    if (statuses.length === 0) issue("expectedStatuses", "At least one status, such as 2xx.");
    else if (statuses.length > 20) issue("expectedStatuses", "At most 20 statuses.");
    else if (!statuses.every((status) => STATUS.test(status))) {
      issue("expectedStatuses", "Each one a class such as 2xx or a code such as 301.");
    }
    if (sendsNewValue(values) && values.headerValue === "") {
      issue("headerValue", "Type the new value, or keep the saved one.");
    }
    if (values.headerValue !== "" && values.headerName.trim() === "") {
      issue("headerName", "A header value is sent under a name; add one.");
    }
  });

export type UptimeCheckValues = z.infer<typeof uptimeCheckSchema>;

/** Whether the form is setting a value: Replace chosen, or no value stored. */
function sendsNewValue(values: UptimeCheckValues): boolean {
  return values.hasStoredValue
    ? values.headerValueAction === "replace"
    : values.headerValue !== "";
}

/**
 * The write-only value as an update carries it: a string replaces, `null`
 * removes, and `undefined` — left out of the body — keeps it. A header name
 * cleared removes the value with it, on the route, so nothing is sent then.
 */
export function headerValueChange(values: UptimeCheckValues): string | null | undefined {
  if (values.headerName.trim() === "") return undefined;
  if (values.hasStoredValue && values.headerValueAction === "remove") return null;
  return sendsNewValue(values) ? values.headerValue : undefined;
}

export const KIND_OPTIONS: PickerOption[] = [
  { value: "http", label: "HTTP — a request to one of its Domains" },
  { value: "tcp", label: "TCP — a connection to one of its published ports" },
];

export const HEADER_ACTION_OPTIONS: PickerOption[] = [
  { value: "keep", label: "Keep the saved value" },
  { value: "replace", label: "Replace it" },
  { value: "remove", label: "Remove it" },
];

/** A Domain as the target picker offers it: exactly the URL that is probed. */
export function domainOption(domain: Domain): PickerOption {
  return {
    value: domain.domainId,
    label: `${domain.https ? "https" : "http"}://${domain.host}${domain.path ?? ""}`,
  };
}
