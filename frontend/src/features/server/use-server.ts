import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import { useForgetVisited } from "@/components/shell/recents";
import {
  serversApi,
  type CreateServerInput,
  type UpdateServerInput,
} from "@/lib/api/endpoints/servers";
import { traefikApi } from "@/lib/api/endpoints/traefik";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";
import type { LiveLog } from "@/lib/realtime/live-log";
import { useSocketStream } from "@/lib/realtime/use-socket-stream";
import type { SocketStatus } from "@/lib/realtime/use-socket-stream";

import { toSetupLines } from "./infrastructure/setup-log-tones";
import {
  SETUP_NOT_RUNNING_CLOSE_CODE,
  readOutcome,
  watchSetupRun,
} from "./setup-run-watch";

/**
 * The Server row, and everything that happens *to* a Server.
 *
 * Containers, Swarm and the cluster are `docker/use-server-docker.ts`; the
 * telemetry series is `telemetry/use-server-metrics.ts`. The **list** is
 * `lib/api/use-servers.ts`, where F11 put it because three features pick from it.
 *
 * Three route shapes decided the shape of this module, and each one is worth
 * knowing before reading a panel:
 *
 * 1. **`validate`, `audit` and `setup` are actions, not reads**, whatever their
 *    HTTP verb. All three open an SSH session to the host; two of them are `GET`
 *    only because they answer with something. So `validate` is a mutation
 *    (F09's rule about `POST /domains/validate` applies unchanged: it reaches a
 *    real machine, so it happens when somebody asks), and `audit` is a query that
 *    never refetches on its own — see `useServerAudit`.
 * 2. **`setup` is not a request at all any more.** It runs for minutes, so holding
 *    a response open for it never worked — the proxy closed it while the script
 *    went on succeeding. Now it has a socket, `/listen-server-setup`, and
 *    `useServerSetupRun` is the only thing on this screen that starts one.
 * 3. **`enableDockerCleanup` has no writer on this controller.**
 *    `updateServerSchema` does not carry the column, so the only route that writes
 *    it is `POST /settings/docker-cleanup` — see `serversApi.setDockerCleanup`.
 */

/** One Server.
 *
 * Keyed exactly the way `use-scope-queries.ts` keys the masthead's identity query,
 * so a panel opens with the row already in cache and the two can never disagree
 * about the Server's name.
 *
 * **It does not poll.** `serverStatus` is `active | inactive` and nothing in this
 * backend ever moves it: the column defaults to `active` at creation and no service
 * writes it again. A poll would spend a request a second re-reading a constant, and
 * a spinner over it would imply a transition that is not coming. What genuinely
 * changes about a host is its readiness, and that is `useServerAudit`.
 */
export function useServer(serverId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.servers.detail(organizationId, serverId),
    queryFn: () => serversApi.findOne(serverId),
    enabled: organizationId !== null && serverId !== "",
  });
}

/**
 * What the readiness script found on the host.
 *
 * **Opening the tab is the asking**, which is why this runs on mount — the audit
 * *is* the Infrastructure tab's content, and a screen whose only card needs a
 * button pressed before it says anything is a screen that has hidden itself. What
 * it will not do is run again by itself: `staleTime: Infinity` and no refocus
 * refetch, so switching windows does not open an SSH session, and `retry: false`
 * because a host that refused once will refuse again and three attempts only make
 * the failure slower to read.
 *
 * `useInvalidate().serverReadiness()` is the one thing that drops it, and a finished
 * setup run is the one thing that calls that.
 */
export function useServerAudit(serverId: string, enabled = true) {
  const { organizationId } = useActiveOrganizationId();
  const invalidate = useInvalidate();
  return useQuery({
    queryKey: keys.servers.audit(organizationId, serverId),
    // The audit stores how reaching the Server went, so the row is
    // re-read once it settles — either way — and every card reading the stored
    // answer agrees with the one reading this query.
    queryFn: async () => {
      try {
        return await serversApi.audit(serverId);
      } finally {
        void invalidate.server(serverId);
      }
    },
    enabled: enabled && organizationId !== null && serverId !== "",
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
}

/** `POST /servers`. Answers with the row, so creating can end on its own screen. */
export function useCreateServer() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateServerInput) => serversApi.create(input),
    onSuccess: (row) => invalidate.server(row.serverId),
  });
}

export function useUpdateServer(serverId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: UpdateServerInput) =>
      serversApi.update(serverId, input),
    onSuccess: () => invalidate.server(serverId),
  });
}

/** Forget host key: the next connect records the key the Server presents. */
export function useForgetHostKey(serverId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => serversApi.forgetHostKey(serverId),
    onSuccess: () => invalidate.server(serverId),
  });
}

/**
 * Start Maintenance: nothing new starts on the Server until it is ended. The
 * row is re-read either way, so a 409 from a second operator who started it
 * first still leaves the page showing the notice.
 */
export function useStartMaintenance(serverId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => serversApi.startMaintenance(serverId),
    onSettled: () => invalidate.server(serverId),
  });
}

/** End Maintenance; re-reads the row either way, for the reason above. */
export function useEndMaintenance(serverId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => serversApi.endMaintenance(serverId),
    onSettled: () => invalidate.server(serverId),
  });
}

/**
 * Why Add a Server is off for this role. `server: ['create']` is not in
 * the base member's statements, so the control says so rather than opening a
 * dialog that ends in a 403.
 */
export const SERVER_CREATE_REFUSAL =
  "Your role in this Organization cannot add a Server. Ask an owner or an admin to add one, or to change your role.";

/**
 * Why the Settings tab's three cards are off for this role.
 * `PATCH /servers/:id` is `@RequirePermission('server', 'create')` — the
 * vocabulary has no `server: ['update']`, so the route asks for the statement
 * that makes a Server. Identity, Connection and Setup command are that one
 * route's doors.
 *
 * `roleRefusal`'s sentence, written out rather than called: this module is
 * imported by tests that mock `use-permission` down to `usePermission`, and a
 * call here at module scope would crash them. `settings-cards.test.tsx` holds
 * the two to the same words.
 */
export const SERVER_UPDATE_REFUSAL =
  "Your role in this Organization cannot change this Server. Ask an owner or an admin to do it, or to change your role.";

/**
 * `server: ['delete']`, which `DELETE /servers/:id` requires and the base
 * member does not hold. Written out for the reason above.
 */
export const SERVER_DELETE_REFUSAL =
  "Your role in this Organization cannot delete a Server. Ask an owner or an admin to do it, or to change your role.";

export function useDeleteServer(serverId: string) {
  const invalidate = useInvalidate();
  const forgetVisited = useForgetVisited();
  return useMutation({
    mutationFn: () => serversApi.remove(serverId),
    onSuccess: () => {
      forgetVisited([serverId]);
      // A Bought Server still Deleting is listed with the purchases.
      return Promise.all([
        invalidate.server(serverId),
        invalidate.boughtServers(),
      ]);
    },
  });
}

/**
 * `echo ok` over SSH.
 *
 * A mutation because it reaches a machine. The interesting answer is the failure:
 * the service wraps whatever ssh2 threw into a **400 carrying the SSH message**, so
 * "All configured authentication methods failed" and "connect ECONNREFUSED" arrive
 * as text a person can act on. That message is the whole point of the control, so
 * callers render `errorMessage(error)` rather than a sentence of their own.
 */
export function useValidateServer(serverId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => serversApi.validate(serverId),
    // The answer is stored on the row, which is what the card shows
    // once this mount's own result is gone.
    onSettled: () => invalidate.server(serverId),
  });
}

export { SETUP_NOT_RUNNING_CLOSE_CODE } from "./setup-run-watch";

/** The flag that makes a dial start a run. Sent on one dial only. */
const START_DIAL = { start: true } as const;

/**
 * Where a provisioning run got to.
 *
 * Seven states because the run has seven genuinely different endings. The first
 * two below are what the socket was for, and the third came later:
 *
 * - `interrupted` — the socket ended without the run saying how it went. **This is
 *   the only place the old "Cloudgate stopped waiting, it may still be going"
 *   sentence is still true**, and it is now the rare case rather than every case.
 * - `refused` — the gateway would not open the socket: no permission, or a bad
 *   parameter. Nothing was started on the machine.
 * - `blocked` — the browser would not construct the socket, so no gateway was
 *   asked. Opening the socket is what starts the run, so nothing was started
 *   here either — `interrupted`'s "carries on on the machine" would be false.
 * - `ended` — a redial found the run already over: it ended while the log was
 *   disconnected, so its last frame never arrived. The lines that did are kept,
 *   and how it went is read from the Server's stored record (`lastSetup`).
 */
export type SetupRunState =
  | "idle"
  | "running"
  | "finished"
  | "failed"
  | "interrupted"
  | "ended"
  | "refused"
  | "blocked";

export interface ServerSetupRun {
  state: SetupRunState;
  /** The script's own output, as it arrives. */
  lines: readonly string[];
  /** Lines dropped off the front of the buffer. */
  dropped: number;
  /** What the socket is doing — worth showing while `state` is `running`. */
  connection: SocketStatus;
  /** The `❌ Setup failed:` message, or the gateway's refusal, in its own words. */
  reason: string | null;
  /** Start a run. Pressed again after one ended, it starts another. */
  start: () => void;
  /**
   * Watch the run whose Live log `key` names, in a box of the page's own —
   * **Read it here too** on a docked run. Its dials only watch, never start
   * (ADR-0058).
   */
  watch: (key: string) => void;
  /** Whether the output well stays on the newest line. Held by the run's Live log. */
  following: boolean;
  setFollowing: (following: boolean) => void;
  /**
   * The run's Live log, what a Dock control hands over; `null` before it is
   * built. Its `owner` says whether the page still holds it.
   */
  log: LiveLog | null;
}

/** The Live log key of one Setup run on `serverId`: `setup:<serverId>:<run>`. */
const setupLogPrefix = (serverId: string) => `setup:${serverId}:`;

/**
 * The Live log key a Bought Server's Setup card watches its first run under:
 * the run the backend starts by itself after Buy (the amendment to
 * ADR-0058), which no press on this console made.
 */
export const firstSetupRunKey = (serverId: string) =>
  `${setupLogPrefix(serverId)}first`;

/** Whether `log` is one of `serverId`'s Setup runs — on the page or in the Dock. */
export function isSetupLogOf(log: LiveLog, serverId: string): boolean {
  return log.key.startsWith(setupLogPrefix(serverId));
}

/** Presses on this console, so that each run is a log of its own. */
let presses = 0;

/** What a mounted card is watching, and whether its next open starts a run. */
type Watching = { serverId: string; key: string; start: boolean };

/**
 * Run the provisioning script, and watch it.
 *
 * `/listen-server-setup` both starts the run and streams it, so this hook is the
 * button and the log at once — there is no mutation here to speak of. Four
 * things about that are worth knowing before reading the card:
 *
 * 1. **Opening the tab must not provision a host.** So the socket is held closed
 *    until `start()` or `watch()`, and what it watches is component state rather
 *    than something derived: it resets when the panel unmounts, which is exactly
 *    what you want from a control that installs Docker.
 * 2. **Only `start()` starts a run (ADR-0058).** The dial it makes carries
 *    `start=true`, and no other dial does: the store's backoff redials after a
 *    drop only watch, so a drop in a run's last seconds cannot provision the host
 *    again; `watch()` — Read it here too — only watches; and the page never
 *    dials a docked run at all, so nothing in the Dock starts one. A watch that
 *    finds nothing running closes {@link SETUP_NOT_RUNNING_CLOSE_CODE}, which is
 *    `ended`.
 * 3. **Each press is a run, and each run a Live log of its own**
 *    (`setup:<serverId>:<run>`), so an ended run kept in the Dock as a record is
 *    never taken for the next one. If an earlier run is somehow still going,
 *    the gateway attaches the new dial to it instead of provisioning the host
 *    twice.
 * 4. **The run's Live log learns how it ended itself** (`watchSetupRun`), and
 *    re-reads the host's readiness and the Server's row then — on the app-wide
 *    client, so a docked run does it after the Server page is gone. It is a
 *    second opinion from the machine, which is why it fires on an *outcome*.
 */
export function useServerSetupRun(
  serverId: string,
  /** The Server's name, for the Dock tab: "<name> · Setup run". */
  name?: string,
): ServerSetupRun {
  const invalidate = useInvalidate();
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganizationId();
  // Which Server a press or a watch is for, rather than a flag: a change of
  // `serverId` under a mounted card must not carry the start flag to a Server
  // nobody pressed anything for.
  const [run, setRun] = useState<Watching | null>(null);
  const watching = run !== null && run.serverId === serverId ? run : null;

  const stream = useSocketStream({
    path: "/listen-server-setup",
    params: { serverId },
    logKey: watching?.key ?? `${setupLogPrefix(serverId)}idle`,
    enabled: watching !== null && serverId !== "",
    // Read when a log opens: only the open right after a press carries it.
    firstDialParams: watching?.start ? START_DIAL : undefined,
    // Docked, a redial keeps the lines held and skips the replay's first ones:
    // a watch-dial is sent the run's buffered output from its first line.
    resume: "replay",
  });

  const {
    status,
    lines,
    closeReason,
    closeCode,
    dropped,
    following,
    setFollowing,
    log,
    readHereToo,
  } = stream;

  // The run's name for the Dock, and its own watch on how it ends: both go
  // with it to the Dock. `watch` starts once per log, and the log stops it.
  const tabName = `${name ?? "Server"} · Setup run`;
  const active = watching !== null;
  useEffect(() => {
    if (!log || !active) return;
    log.describe({ name: tabName, toLines: toSetupLines });
    log.watch("setup-run", () =>
      watchSetupRun(log, {
        client: queryClient,
        organizationId,
        serverId,
        settled: () =>
          Promise.all([
            invalidate.serverReadiness(serverId),
            invalidate.server(serverId),
          ]),
      }),
    );
  }, [log, active, tabName, queryClient, organizationId, serverId, invalidate]);

  const notRunning =
    status === "refused" && closeCode === SETUP_NOT_RUNNING_CLOSE_CODE;
  const live =
    status === "connecting" || status === "open" || status === "reconnecting";
  // Only read the outcome once the stream has stopped: while it is open the
  // answer cannot be in the buffer yet, and scanning a few thousand lines every
  // flush to learn that would be work spent to find nothing.
  const outcome = live ? null : readOutcome(lines);

  const state: SetupRunState = !active
    ? "idle"
    : live
      ? "running"
      : outcome
        ? outcome.failure === null
          ? "finished"
          : "failed"
        : notRunning
          ? "ended"
          : status === "refused"
            ? "refused"
            : status === "blocked"
              ? "blocked"
              : "interrupted";

  const start = useCallback(() => {
    // A new run is a new Live log, opened with the start flag on its first
    // dial alone; the run before it — ended, or docked — is left as it was.
    presses += 1;
    setRun({
      serverId,
      key: `${setupLogPrefix(serverId)}${presses}`,
      start: true,
    });
  }, [serverId]);

  const watchKey = watching?.key ?? null;
  const watch = useCallback(
    (key: string) => {
      // The run this box already held: a fresh Live log of it, beside the
      // docked one. Another run — one docked on an earlier visit — is a change
      // of key, which is a fresh log too. Neither carries the flag.
      if (watchKey === key) readHereToo();
      setRun({ serverId, key, start: false });
    },
    [watchKey, readHereToo, serverId],
  );

  return {
    state,
    lines,
    dropped,
    connection: status,
    reason:
      outcome?.failure ??
      (status === "refused" && !notRunning ? closeReason : null),
    start,
    watch,
    following,
    setFollowing,
    log,
  };
}

/** The nightly prune, on or off. Lives on the settings controller — see the module. */
export function useSetDockerCleanup(serverId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      serversApi.setDockerCleanup(serverId, enabled),
    onSuccess: () => invalidate.server(serverId),
  });
}

/**
 * Whether this Server's Traefik writes an Access log:
 * `GET /settings/traefik/requests` for this Server. `retry: false`, because it
 * reads `traefik.yml` over SSH and an unreachable host will not answer the
 * second time either.
 */
export function useServerRequestLogging(serverId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.traefik.requestLogging(organizationId, serverId),
    queryFn: () => traefikApi.haveActivateRequests(serverId),
    enabled: organizationId !== null && serverId !== "",
    retry: false,
  });
}
