import { api } from "../client";

import type { UnreclaimedArtifact } from "./teardown";

/**
 * `traces/traces.controller.ts` — a Service's traces setting and
 * its Trace store (ADR-0028). Read by anyone who may read the Service, set by
 * anyone who may update it (`service: ['update']`). Only an Application or a
 * Compose has one.
 */

/** The two Service kinds a Trace store can serve (ADR-0028). */
export type TracesServiceType = "application" | "compose";

/** How many days a Trace store keeps traces; the backend refuses any other. */
export const TRACE_RETENTION_DAYS = [1, 3, 7] as const;
export type TraceRetentionDays = (typeof TRACE_RETENTION_DAYS)[number];
/** What a Service never set reads as; the backend's `DEFAULT_TRACE_RETENTION_DAYS`. */
export const DEFAULT_TRACE_RETENTION_DAYS: TraceRetentionDays = 3;

/** `TracesReadView` — the setting, and the store as it is on its Server now. */
export interface Traces {
  serviceType: TracesServiceType;
  serviceId: string;
  enabled: boolean;
  retentionDays: number;
  /** Whether the Service has a credential yet — never the credential. */
  hasCredential: boolean;
  /** False while off, and while on until the Service's next deploy starts it. */
  storeRunning: boolean;
  /** The store's directory on disk, in bytes; null while off or unreadable. */
  storeSizeBytes: number | null;
}

/** `PUT`'s answer: the setting, and what a turn-off could not remove. */
export type TracesWrite = Omit<Traces, "storeRunning" | "storeSizeBytes"> & {
  unreclaimedArtifacts?: UnreclaimedArtifact[];
};

export interface PutTracesInput {
  enabled: boolean;
  retentionDays: TraceRetentionDays;
}

/**
 * `TraceStoreFrameView` — where this viewer's frame opens the Trace store's
 * UI: its base path under a frame token, which every request from the frame
 * carries in its path because the sandboxed frame sends no session cookie
 * (ADR-0075), and when that token stops being accepted.
 */
export interface TraceStoreFrame {
  uiPath: string;
  expiresAt: string;
}

/**
 * The `sandbox` the tab's frame carries: the backend's `TRACE_STORE_SANDBOX`,
 * which it also sends on every answer from the store. Scripts, forms and
 * popups, and never `allow-same-origin` or `allow-top-navigation`: what the
 * store serves runs in an opaque origin, so it can never act with the
 * viewer's session (ADR-0075).
 */
export const TRACE_STORE_FRAME_SANDBOX = "allow-scripts allow-forms allow-popups";

/**
 * Where the tab's frame opens the Trace store's UI: its search page, under
 * the frame's base path (`TraceStoreFrame.uiPath`).
 *
 * **Not the UI's root.** The store serves its UI at the base path with a
 * trailing slash and redirects the bare path there, while the console's own
 * trailing-slash rule redirects the slashed path back — so either spelling of
 * the root is a redirect loop through the console (seen live). The
 * search page is a path of its own, answers directly, and is the page a
 * Member opens the tab for.
 */
export const traceStoreSearchPath = (frame: Pick<TraceStoreFrame, "uiPath">): string =>
  `${frame.uiPath}/search`;

export const tracesApi = {
  read: (serviceType: TracesServiceType, serviceId: string) =>
    api.get<Traces>(`/traces/${serviceId}`, { query: { serviceType } }),

  frame: (serviceId: string) => api.get<TraceStoreFrame>(`/traces/${serviceId}/frame`),

  put: (serviceType: TracesServiceType, serviceId: string, input: PutTracesInput) =>
    api.put<TracesWrite>(`/traces/${serviceId}`, input, {
      query: { serviceType },
    }),
};
