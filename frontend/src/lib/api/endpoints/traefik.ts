import { api } from "../client";

/**
 * The Traefik file surface, on `settings.controller.ts`.
 *
 * **F10's endpoint audit asked which route reaches an Application's own Traefik
 * config, and the answer is the generic file pair** —
 * `GET /settings/traefik/file?path=` and `POST /settings/traefik/file` — not
 * `traefik/web-server-config` (that one is Cloudgate's *own* router) and not
 * `traefik/middlewares-config` (the shared middlewares file, which our backend
 * does not use for an Application: `traefik/app-config.service.ts` puts an
 * app's path, redirect and basic-auth middlewares in the app's own file).
 *
 * An Application's file is `<traefik dir>/dynamic/<appName>.yml`. **The absolute
 * path is not constructed here.** `MAIN_TRAEFIK_DIR` is resolved on the backend
 * from `CLOUDGATE_DIRECTORY`
 * `/etc/cloudgate/traefik`
 * is the default and an instance may be rooted anywhere else, so guessing it in the
 * browser would ship one host's filesystem layout in a client bundle and be wrong on
 * the next. `GET /settings/traefik/directories` answers with
 * every node's **full path as its `id`**, so `findAppConfigPath` below reads the
 * path out of the tree instead. A file that is not in the tree has no path — and
 * that is also the true answer to "has this Application got a config yet".
 *
 * `readFile` answers `text/plain` (`readConfigInPath` returns
 * `Promise<string | null>`), so it takes `getText`. Rule 4 under **The data
 * layer**.
 */

/** One node of the Traefik directory walk. `id` is the absolute path. */
export interface TreeDataItem {
  id: string;
  name: string;
  type: "file" | "directory";
  children?: TreeDataItem[];
  /**
   * Present only on a file the backend will not open or overwrite, and says
   * why: it holds private-key material — a certificate's `privkey.key`, or
   * `acme.json`. `GET /settings/traefik/file` answers 403 for it.
   */
  withheld?: string;
}

/**
 * The three named Traefik files, and the route segment each is reached by.
 *
 * A table rather than three methods, so the screen that edits them is one
 * component configured three times instead of three near-identical cards — the
 * same argument F15's channel table makes, at a much smaller scale.
 */
export type TraefikConfigKind = "main" | "web-server" | "middlewares";

export const TRAEFIK_CONFIG_PATH: Record<TraefikConfigKind, string> = {
  main: "config",
  "web-server": "web-server-config",
  middlewares: "middlewares-config",
};

/**
 * `GET /settings/traefik/requests`. The two fields are the two questions the
 * screen has to answer separately: is there a Traefik installation on this host
 * at all, and is it recording requests. A `false`/`false` pair is a host with no
 * `traefik.yml`; `true`/`false` is a Traefik that simply is not logging.
 */
export interface RequestLoggingState {
  present: boolean;
  enabled: boolean;
}

/**
 * `POST /settings/traefik/requests`. `restartRequired` is the route saying that
 * `accessLog` landed in the *static* config and nothing is recorded until
 * Traefik restarts — see `reloadTraefik`. Always `false` on a Server, whose
 * restart is part of the switch.
 */
export interface ToggleRequestsResult {
  written: boolean;
  restartRequired: boolean;
}

/** One published port of the Traefik resource. */
export interface TraefikPort {
  targetPort: number;
  publishedPort: number;
  protocol: "tcp" | "udp" | "sctp";
}

/**
 * One Cloudgate row named by a router Traefik refused to build.
 *
 * `kind` is the console's noun for the row rather than the middleware's Traefik
 * type, because the backend deliberately made it one: a person reading this has
 * a Domains screen and a Redirects screen in front of them and no screen at all
 * called `redirectRegex`.
 */
export type TraefikConfigSubject =
  | { kind: "domain"; domainId: string; host: string }
  | { kind: "redirect"; redirectId: string }
  | { kind: "security"; securityId: string }
  | { kind: "forwardAuth"; domainId: string };

/** One router Traefik dropped, and every row in the chain that could be why. */
export interface TraefikConfigRejection {
  routerName: string;
  /** Traefik's own sentence. Emitted secrets are already cut out server-side. */
  message: string;
  domain: { domainId: string; host: string };
  subjects: TraefikConfigSubject[];
  /** Docker's timestamp for the log line. */
  observedAt: string;
}

/**
 * `GET /traefik/config-status`. **`state` is the whole point of this shape and
 * a screen must not flatten it.**
 *
 * - `checked` with rejections — Traefik refused those routers, and the Domain
 *   each one serves is answering through the catch-all right now.
 * - `checked` with none — *this is what the log said*, which is **not** "the
 *   configuration is good". Traefik logs nothing at all for a reload it
 *   accepted, so an accepted config and a reload that has not happened yet are
 *   the same silence. Rendering a green tick here invents a fact.
 * - `unavailable` — the log could not be read: no Traefik container to ask, or
 *   nothing has written this Application's config since the backend started.
 *   Also not health.
 *
 * And nothing here is live: the check runs when Cloudgate *writes* the config,
 * and a byte-identical regeneration produces no log line at all, so a config
 * that was already broken stays unreported until some write changes the file.
 * `checkedAt` is what says how old the answer is.
 */
export interface TraefikConfigStatus {
  applicationId: string;
  appName: string;
  state: "checked" | "unavailable";
  reason?: string;
  checkedAt: string;
  rejections: TraefikConfigRejection[];
}

/** Which operator surface wrote a router that has no Application behind it. */
export type TraefikConsoleSource = "console-domain" | "operator-middlewares";

/** One refused router from `dynamic/cloudgate.yml` or `dynamic/middlewares.yml`. */
export interface TraefikConsoleRejection {
  routerName: string;
  message: string;
  source: TraefikConsoleSource;
  /** The middlewares that router names; any one of them can be the failure. */
  middlewares: string[];
  observedAt: string;
}

/**
 * `GET /traefik/config-status/console` — the same three states, for the routers
 * that put *this console* on a hostname.
 *
 * Instance authority, not `service:read`: the two files behind it are
 * instance-wide and both are written behind the same check.
 */
export interface TraefikConsoleStatus {
  state: "checked" | "unavailable";
  reason?: string;
  checkedAt: string;
  rejections: TraefikConsoleRejection[];
}

/**
 * `GET /settings/traefik/dns-challenge` — one machine's DNS-01 setup, or `null`
 * when it has none.
 *
 * **The credential values never come back.** `credentialKeys` names the keys
 * that are set and nothing else (ADR-0019), so a screen can say "set" beside a
 * key and has nothing to prefill a value from.
 */
export interface DnsChallengeSetup {
  /** A lego provider code, e.g. `cloudflare`. */
  provider: string;
  credentialKeys: string[];
}

/**
 * `PUT /settings/traefik/dns-challenge`. **Omitting `credentials` keeps the
 * stored ones** (only when a setup exists); a map replaces the whole set.
 */
export interface DnsChallengeInput {
  serverId: string | null;
  provider: string;
  credentials?: Record<string, string>;
}

export const traefikApi = {
  /** What Traefik last said about one Application's routers. */
  configStatus: (applicationId: string) =>
    api.get<TraefikConfigStatus>("/traefik/config-status", {
      query: { applicationId },
    }),

  /** The same, for the console's own routers. Takes no id: there is one console. */
  consoleConfigStatus: () =>
    api.get<TraefikConsoleStatus>("/traefik/config-status/console"),

  /** The whole Traefik directory, local or over SSH when `serverId` is given. */
  directories: (serverId?: string | null) =>
    api.get<TreeDataItem[]>("/settings/traefik/directories", {
      query: { serverId: serverId ?? undefined },
    }),

  readFile: (path: string, serverId?: string | null) =>
    api.getText("/settings/traefik/file", {
      query: { path, serverId: serverId ?? undefined },
    }),

  writeFile: (input: {
    path: string;
    traefikConfig: string;
    serverId?: string | null;
  }) =>
    api.post<boolean>("/settings/traefik/file", {
      path: input.path,
      traefikConfig: input.traefikConfig,
      serverId: input.serverId ?? undefined,
    }),

  /**
   * The three named config files, as one pair of calls (F16).
   *
   * They are three routes in the controller and one shape here, because the
   * only thing that differs is which file is read: `traefik/config` is
   * `traefik.yml` itself, `traefik/web-server-config` is
   * `dynamic/cloudgate.yml` (the router that puts *this console* on a domain),
   * and `traefik/middlewares-config` is `dynamic/middlewares.yml`. All three are
   * owner-or-admin, and all three reach the **platform host only** — none of
   * them takes a `serverId`, unlike `readFile` above.
   *
   * **A missing file reads as an empty string, not as a failure.**
   * `readMainConfig` and `readConfig` answer `null` when the file is not there,
   * Nest sends that as an empty body, and `getText` yields `""`. Two of the
   * three genuinely do not exist until something creates them —
   * `dynamic/cloudgate.yml` is written by `assign-domain` and deleted when the
   * host is cleared — so the editor has to tell "not written yet" from "empty",
   * and it cannot: the screen says which file it is looking at and lets the
   * emptiness speak for itself rather than claiming either.
   *
   * **The write refuses an empty string.** `TraefikConfigDto` is
   * `z.string().min(1)`, so "select all, delete, save" comes back a 400 on
   * `traefikConfig` rather than emptying the file.
   */
  readConfig: (kind: TraefikConfigKind) =>
    api.getText(`/settings/traefik/${TRAEFIK_CONFIG_PATH[kind]}`),

  writeConfig: (kind: TraefikConfigKind, traefikConfig: string) =>
    api.post<boolean>(`/settings/traefik/${TRAEFIK_CONFIG_PATH[kind]}`, {
      traefikConfig,
    }),

  /**
   * Traefik's own environment, as the dotenv blob the container was started
   * with.
   *
   * `readEnvironmentVariables` inspects the running `cloudgate-traefik`
   * resource, so this **throws when Traefik is not running** rather than
   * answering with nothing — the same for `dashboard` and `ports` below. That is
   * the honest behaviour and the screen renders it as such: there is no
   * configuration to read when there is no container to read it from.
   *
   * Writing **recreates the container**, unawaited: `writeTraefikEnv` resolves
   * the `${{…}}` references, re-reads the current ports so they survive, and
   * kicks `writeTraefikSetup` off in the background. So a resolved promise means
   * "asked", and every connection on 80 and 443 goes when it lands.
   */
  readEnv: (serverId?: string | null) =>
    api.getText("/settings/traefik/env", {
      query: { serverId: serverId ?? undefined },
    }),

  writeEnv: (env: string, serverId?: string | null) =>
    api.post<boolean>("/settings/traefik/env", {
      env,
      serverId: serverId ?? undefined,
    }),

  /**
   * Is Traefik publishing its dashboard on 8080?
   *
   * Derived, not stored: the route reads the container's published ports and
   * asks whether one of them targets 8080. Toggling it on **checks the port
   * first** and answers `409` naming the container holding it.
   *
   * The dashboard has no authentication of its own. Publishing it puts Traefik's
   * full routing table — every host, every service, every middleware — on a port
   * anyone who can reach the machine can open, which is why the switch says so
   * rather than reading as a debug convenience.
   */
  dashboardEnabled: (serverId?: string | null) =>
    api.get<boolean>("/settings/traefik/dashboard", {
      query: { serverId: serverId ?? undefined },
    }),

  toggleDashboard: (enableDashboard: boolean, serverId?: string | null) =>
    api.post<boolean>("/settings/traefik/dashboard", {
      enableDashboard,
      serverId: serverId ?? undefined,
    }),

  /**
   * The ports Traefik publishes **beyond** 80 and 443.
   *
   * `readPorts` strips that pair deliberately, and `writeTraefikSetup` always
   * re-adds it — so the list is exactly what an operator added, and a save
   * cannot accidentally unbind the two ports the platform is reached on.
   *
   * The save **replaces the whole list**, and the dashboard's 8080 is in it when
   * the dashboard is on (that is how `toggleDashboard` stores the flag). Dropping
   * 8080 here therefore turns the dashboard off, which is consistent but is not
   * something the reader would guess — the form says it.
   *
   * Each entry is checked against the host before anything is written, and a
   * clash answers **400**, not 409: `updateTraefikPorts` catches its own
   * `ConflictException` and rethrows it as a `BadRequestException`, so the
   * conflicting container's name arrives in a 400's message.
   */
  ports: (serverId?: string | null) =>
    api.get<TraefikPort[]>("/settings/traefik/ports", {
      query: { serverId: serverId ?? undefined },
    }),

  updatePorts: (additionalPorts: TraefikPort[], serverId?: string | null) =>
    api.post<boolean>("/settings/traefik/ports", {
      additionalPorts,
      serverId: serverId ?? undefined,
    }),

  /**
   * Is Traefik writing an access log? Added by F14, because request analytics
   * have nothing to read until it is.
   *
   * **The two states this could not tell apart are now separate fields**
   * It used to
   * answer a bare `false` both when the `accessLog` block was absent *and* when
   * there was no `traefik.yml` at all, so "off" and "there is no Traefik on this
   * host" arrived as the same byte. `present` now says which.
   *
   * The Requests screen still establishes presence by asking `directories`,
   * which predates this and works. Now that `present` is authoritative and
   * costs no extra request, that second read is worth retiring — but it is a
   * screen change, not a client one.
   */
  haveActivateRequests: (serverId?: string | null) =>
    api.get<RequestLoggingState>(
      serverId
        ? `/settings/traefik/requests?serverId=${encodeURIComponent(serverId)}`
        : "/settings/traefik/requests",
    ),

  /**
   * Add or remove the `accessLog` block in `traefik.yml`.
   *
   * Two things the screen has to know:
   *
   * 1. **On a Server it restarts that Server's Traefik in the same request**
   *   , behind owner/admin — so the Request logging card confirms
   *    first, and the answer is `restartRequired: false`. **On the platform
   *    host it does not restart Traefik**: `accessLog` is in the *static*
   *    config, so the setting is on disk and Traefik runs without it until
   *    `reloadTraefik` below restarts it; the answer is `restartRequired: true`.
   * 2. **It 404s** when there is no `traefik.yml` to edit. It used to answer
   *    `200 false`, which was indistinguishable from "logging was already off".
   *
   * `serverId` goes over the wire as-is, null included: the null-stripping spread
   * that used to be here existed only because `ToggleRequestsDto` spelled the
   * field `.optional()` and 400'd on an explicit null.
   */
  toggleRequests: (enable: boolean, serverId?: string | null) =>
    api.post<ToggleRequestsResult>("/settings/traefik/requests", {
      enable,
      serverId,
    }),

  /**
   * Restart the `cloudgate-traefik` resource, so a static-config change takes
   * effect.
   *
   * Owner or admin only, and **it returns before the restart happens**: the
   * controller kicks `reloadDockerResource` off unawaited and answers `true`, so
   * a resolved promise means "asked", not "done". Every connection on 80 and 443
   * goes with it, which is why no screen calls this as a side effect of saving
   * something else.
   */
  reloadTraefik: (serverId?: string | null) =>
    api.post<boolean>("/settings/traefik/reload", {
      serverId: serverId ?? undefined,
    }),

  /**
   * **Enable request metrics** on the platform host (`null`) or a Server
   * (ADR-0027): writes the loopback `metrics` entryPoint into that
   * machine's `traefik.yml` and asks Docker to restart Traefik, which is why
   * the console only calls it from behind the restart confirmation. Same gate
   * as `reloadTraefik`; 404 on a machine with no `traefik.yml`. The state is
   * then `requestMetricsEnabled` on the Server row, or on the web-server
   * settings for the platform host.
   */
  enableRequestMetrics: (serverId: string | null) =>
    api.post<{ enabled: true }>("/settings/traefik/request-metrics", {
      serverId: serverId ?? undefined,
    }),

  /**
   * A machine's DNS-01 setup: the lego provider and which credential
   * keys are set, never their values. `null` when the machine has none.
   */
  dnsChallenge: (serverId: string | null) =>
    api.get<DnsChallengeSetup | null>("/settings/traefik/dns-challenge", {
      query: { serverId: serverId ?? undefined },
    }),

  /**
   * Save it. Like `writeEnv`, this **recreates Traefik on that machine** in the
   * background, so a resolved promise means "asked".
   */
  writeDnsChallenge: (input: DnsChallengeInput) =>
    api.put<DnsChallengeSetup>("/settings/traefik/dns-challenge", input),

  /**
   * Remove it. Answers **409** while an Application on that machine has the
   * Previews DNS-01 switch on, naming them — the sentence the screen shows.
   */
  removeDnsChallenge: (serverId: string | null) =>
    api.delete<unknown>("/settings/traefik/dns-challenge", {
      query: { serverId: serverId ?? undefined },
    }),
};

/**
 * The path of `dynamic/<appName>.yml` in a directory tree, or `null`.
 *
 * Walks rather than joining strings, for the reason in this module's own note:
 * the tree is the only thing that knows where the Traefik directory is.
 */
export function findAppConfigPath(
  tree: TreeDataItem[],
  appName: string,
): string | null {
  const wanted = `${appName}.yml`;

  const walk = (nodes: TreeDataItem[]): string | null => {
    for (const node of nodes) {
      if (node.type === "file" && node.name === wanted) return node.id;
      const found = node.children ? walk(node.children) : null;
      if (found) return found;
    }
    return null;
  };

  return walk(tree);
}
