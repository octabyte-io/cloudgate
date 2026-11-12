import { forwardAuthMiddlewareName } from './forward-auth';
import type { FileConfig } from './file-types';
import {
  addPrefixMiddlewareName,
  stripPrefixMiddlewareName,
} from './middleware';
import { redirectMiddlewareName } from './redirect';
import { securityMiddlewareName } from './security';
import {
  CONSOLE_ROUTER,
  CONSOLE_SECURE_ROUTER,
  GATEWAY_ROUTER,
  GATEWAY_SECURE_ROUTER,
} from './web-server';

/**
 * The router and service names one Domain owns, and the reverse map from any
 * emitted Traefik name back to the Cloudgate row that minted it (H-38).
 *
 * **Why the reverse map is built rather than parsed.** Traefik reports a
 * rejected config against its *own* names — `routerName=my-app-router-3@file` —
 * and the obvious move is to take that string apart. It does not survive
 * contact: `appName` is a free-form column and carries `-`, so
 * `my-app-router-3` splits four ways and `my-app-router-3-router-1` splits
 * worse. The names are *built* here, from rows whose ids we are holding, so the
 * mapping already exists in the only direction that is total — forwards. This
 * file turns that into a lookup: emit every name the app's rows produce, index
 * it, and match Traefik's string against the index. A name that is not in the
 * index belongs to another application and is not this app's to interpret.
 *
 * The three router/service builders were inlined in `domain.ts` in four places
 * and are exported here instead (§1.4): the reverse map and the generator have
 * to agree about the name to the byte, and two copies of a template string is
 * exactly where that stops being true.
 */
export const domainRouterName = (
  appName: string,
  uniqueConfigKey: number,
): string => `${appName}-router-${uniqueConfigKey}`;

export const domainSecureRouterName = (
  appName: string,
  uniqueConfigKey: number,
): string => `${appName}-router-websecure-${uniqueConfigKey}`;

export const domainServiceName = (
  appName: string,
  uniqueConfigKey: number,
): string => `${appName}-service-${uniqueConfigKey}`;

/**
 * The dynamic-config file a `stack` Compose's Domains are routed by,
 * without the extension — `dynamic/compose+<appName>.yml`.
 *
 * A stack's Swarm services carry their labels on the service, not on its task
 * containers, and the `docker` provider reads containers only, so a stack is
 * routed the way an Application is: by the file provider, with the Application
 * builders ({@link domainRouterName} and its siblings, keyed by the Domain's
 * `uniqueConfigKey`, which is a global serial and so already unique).
 *
 * **Why the file is not `<appName>.yml` like an Application's.** `appName` is
 * unique within the compose table and within the application table, not across
 * the two, so an Application and a stack Compose on one Server can share one.
 * Under one file name each would overwrite — and a Domain delete on either
 * would remove — the other's routing, across organizations on the platform
 * host. `+` is outside `APP_NAME_REGEX`, so no Application's file can be named
 * this. A subdirectory was the other way to keep the two apart and was
 * measured out: Traefik's file provider loads subdirectories but watches only
 * the top one, so a removed file kept routing until the next unrelated reload.
 */
export const composeStackConfigName = (appName: string): string =>
  `compose+${appName}`;

/**
 * The dynamic-config file a custom certificate's `tls.certificates` fragment
 * sits in, without the extension — `dynamic/certificate+<certificatePath>.yml`.
 * `+` keeps it out of every Application's `{appName}.yml`, as with {@link
 * composeStackConfigName}, and the top of `dynamic/` is where Traefik's watch
 * sees it (`traefik-writer.service.ts`' `certificateConfigPath`).
 */
export const certificateConfigName = (certificatePath: string): string =>
  `certificate+${certificatePath}`;

/**
 * A `docker-compose` Compose Domain's router name on one entrypoint, which its
 * labels also use as the Traefik service name (`createComposeDomainLabels`).
 * Here beside the
 * file-provider builders for their reason: the label writer and the Error-rate
 * forward index (`service-health/error-rate-index.ts`, ADR-0027) have to agree
 * about the name to the byte.
 */
export const composeRouterName = (
  appName: string,
  uniqueConfigKey: number,
  entrypoint: string,
): string => `${appName}-${uniqueConfigKey}-${entrypoint}`;

/**
 * The entrypoints a `docker-compose` Compose Domain gets a router (and so a
 * Traefik service) on: its custom entrypoint alone, or `web` plus `websecure`
 * when it is HTTPS. `addDomainsToComposeSpec` emits labels for exactly these.
 */
export const composeDomainEntrypoints = (domain: {
  customEntrypoint?: string | null;
  https?: boolean | null;
}): string[] => {
  if (domain.customEntrypoint) return [domain.customEntrypoint];
  return domain.https ? ['web', 'websecure'] : ['web'];
};

/**
 * One Cloudgate row a dropped router's middleware chain names. `kind` is the
 * console's noun for the row, not the middleware's Traefik type: an operator
 * reading this has a Redirect screen and a Security screen in front of them,
 * and no screen at all called `redirectRegex`.
 */
export type TraefikConfigSubject =
  | { kind: 'domain'; domainId: string; host: string }
  | { kind: 'redirect'; redirectId: string }
  | { kind: 'security'; securityId: string }
  | { kind: 'forwardAuth'; domainId: string };

/** What one emitted router is, in Cloudgate's vocabulary. */
export interface TraefikRouterSubjects {
  /** The Domain the router routes; always present, since a router is a Domain. */
  domain: { domainId: string; host: string };
  /**
   * Every row the router's chain names, the Domain included. Traefik drops the
   * whole router when *any* link fails to build, and says which router without
   * saying which link, so the honest answer is the set — see
   * `config-status.service.ts` for why narrowing it further would mean reading
   * Traefik's prose.
   */
  subjects: TraefikConfigSubject[];
}

/** The rows a name index is built from — the three tables `regenerate` reads. */
export interface TraefikNameRows {
  domains: {
    domainId: string;
    host: string;
    uniqueConfigKey: number;
    forwardAuthEnabled?: boolean | null;
  }[];
  redirects: { redirectId: string; uniqueConfigKey: number }[];
  security: { securityId: string }[];
}

/**
 * Every router name this application emits, mapped to the rows behind it.
 *
 * The chain is read off the config that is about to be written rather than
 * re-derived from the rows, because the config is the thing Traefik will
 * actually load: `createRouterConfig` decides per entry point which middlewares
 * a router lists (a `web` router of an HTTPS domain lists only
 * `redirect-to-https`), and a second implementation of that decision here would
 * be a second thing to keep in step. `middlewares.yml`'s `redirect-to-https` and
 * a Domain's verbatim `middlewares` column resolve to no Cloudgate row and are
 * skipped rather than guessed at.
 */
export const buildRouterSubjectIndex = (
  appName: string,
  config: FileConfig,
  rows: TraefikNameRows,
): Map<string, TraefikRouterSubjects> => {
  const byMiddlewareName = new Map<string, TraefikConfigSubject>();
  for (const row of rows.redirects) {
    byMiddlewareName.set(redirectMiddlewareName(appName, row.uniqueConfigKey), {
      kind: 'redirect',
      redirectId: row.redirectId,
    });
  }

  const index = new Map<string, TraefikRouterSubjects>();
  for (const domainRow of rows.domains) {
    const key = domainRow.uniqueConfigKey;
    const owner = { domainId: domainRow.domainId, host: domainRow.host };
    const perDomain = new Map<string, TraefikConfigSubject>([
      [addPrefixMiddlewareName(appName, key), { kind: 'domain', ...owner }],
      [stripPrefixMiddlewareName(appName, key), { kind: 'domain', ...owner }],
      [
        forwardAuthMiddlewareName(appName, key),
        { kind: 'forwardAuth', domainId: domainRow.domainId },
      ],
      [
        `${forwardAuthMiddlewareName(appName, key)}-errors`,
        { kind: 'forwardAuth', domainId: domainRow.domainId },
      ],
    ]);

    for (const routerName of [
      domainRouterName(appName, key),
      domainSecureRouterName(appName, key),
    ]) {
      const router = config.http?.routers?.[routerName];
      if (!router) continue;

      const subjects: TraefikConfigSubject[] = [{ kind: 'domain', ...owner }];
      for (const middleware of router.middlewares ?? []) {
        const fromDomain = perDomain.get(middleware);
        if (fromDomain) {
          if (fromDomain.kind !== 'domain') subjects.push(fromDomain);
          continue;
        }
        const shared = byMiddlewareName.get(middleware);
        if (shared) {
          subjects.push(shared);
          continue;
        }
        if (middleware === securityMiddlewareName(appName)) {
          for (const row of rows.security) {
            subjects.push({ kind: 'security', securityId: row.securityId });
          }
        }
      }
      index.set(routerName, { domain: owner, subjects });
    }
  }

  return index;
};

/**
 * Which operator surface wrote a router that has no Application behind it.
 *
 * Two, because the file provider watches two files nobody's Application owns:
 * `dynamic/cloudgate.yml`, written by the **Console domain** form
 * (`SettingsService.updateServerTraefik`, and `POST
 * /settings/traefik/web-server-config` for raw YAML), and
 * `dynamic/middlewares.yml`, written by `POST
 * /settings/traefik/middlewares-config` and seeded by server setup. The names
 * are the console's nouns for those two screens, not the file names, for the
 * same reason `TraefikConfigSubject.kind` is: an operator has a screen in front
 * of them, not a path.
 */
export type TraefikConsoleSource = 'console-domain' | 'operator-middlewares';

/**
 * The shared middlewares file, without the extension —
 * `dynamic/middlewares.yml`.
 *
 * Named here beside {@link buildConsoleRouterIndex}, which is the only thing in
 * `src/traefik` that reads it: an Application's own middlewares go in the
 * Application's own file (`app-config.service.ts` says so), so this file is
 * `redirect-to-https`, whatever `servers/server-setup.ts` seeded, and whatever
 * an operator has since written through `/settings/traefik/middlewares-config`.
 */
export const MIDDLEWARES_CONFIG_NAME = 'middlewares';

/** What one router with no Application is, in the console's vocabulary. */
export interface TraefikConsoleRouterSubjects {
  source: TraefikConsoleSource;
  /**
   * Every middleware the router names. As with an Application's chain, Traefik
   * drops the whole router when any link fails to build and says which router
   * rather than which link, so the honest answer is the set.
   */
  middlewares: string[];
}

/**
 * The routers in the two files that have no Application to be reported against
 * (H-61).
 *
 * **Why this exists at all.** `buildRouterSubjectIndex` above indexes one
 * Application's routers, and `config-status.service.ts` deliberately ignores a
 * rejection naming a router that is not in it — guessing from the string is
 * what this file exists to avoid. That leaves the console's own routers
 * unreported, and a rejection there is the one failure an operator cannot
 * diagnose from the console, because it is the console that goes dark. So the
 * same discipline is applied to the same question a second time: the names are
 * **read out of the files that define them**, never parsed out of Traefik's
 * string.
 *
 * **The two generated names are seeded even when the file cannot be read.**
 * `createWebServerConfig` mints exactly `cloudgate-router-app` and
 * `cloudgate-router-app-secure`, imported here rather than restated, so a
 * rejection naming one of them is recognised on an instance where the read of
 * `dynamic/cloudgate.yml` failed — which is precisely the instance most likely
 * to have something wrong with it. What the file adds on top is the middleware
 * chain and any router an operator hand-wrote, neither of which can be known
 * without reading it.
 *
 * A router in *both* files keeps the console file's attribution: Traefik would
 * refuse the duplicate anyway, and of the two the console's is the one this
 * product writes, so it is the more useful place to send someone first.
 */
export const buildConsoleRouterIndex = (
  consoleConfig: FileConfig | null,
  middlewaresConfig: FileConfig | null,
): Map<string, TraefikConsoleRouterSubjects> => {
  const index = new Map<string, TraefikConsoleRouterSubjects>();

  for (const routerName of [
    CONSOLE_ROUTER,
    CONSOLE_SECURE_ROUTER,
    // The Gateway's, written into the same file beside them.
    GATEWAY_ROUTER,
    GATEWAY_SECURE_ROUTER,
  ]) {
    index.set(routerName, { source: 'console-domain', middlewares: [] });
  }

  const add = (
    config: FileConfig | null,
    source: TraefikConsoleSource,
    overwrite: boolean,
  ) => {
    for (const [routerName, router] of Object.entries(
      config?.http?.routers ?? {},
    )) {
      if (!overwrite && index.has(routerName)) continue;
      index.set(routerName, { source, middlewares: router.middlewares ?? [] });
    }
  };

  add(consoleConfig, 'console-domain', true);
  add(middlewaresConfig, 'operator-middlewares', false);

  return index;
};
