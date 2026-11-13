import { useMutation, useQuery } from "@tanstack/react-query";

import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { settingsApi } from "@/lib/api/endpoints/settings";
import {
  traefikApi,
  type TraefikConfigKind,
  type TraefikPort,
} from "@/lib/api/endpoints/traefik";
import { readGate, type Gate } from "@/lib/auth/use-permission";

import { RECREATION_POLL_MS } from "./use-recreation";

/**
 * How this instance is configured — every read and write behind the three
 * Platform sections.
 *
 * **All of it keyed under `instance`**, on the argument in `keys.ts`: there is
 * one `web_server_settings` row, one Traefik container and one Docker daemon on
 * the platform host, however many Organizations this deployment holds.
 *
 * **Every mutation invalidates the whole `instance` root** through
 * `invalidate.instanceSettings()`, and that is deliberate rather than lazy —
 * these settings reach each other through two shared artefacts. Assigning a
 * domain rewrites `dynamic/cloudgate.yml`, which the Traefik file editor is
 * showing. Toggling the dashboard republishes the container's ports, which the
 * ports form is showing. Saving ports recreates the container, which is what the
 * environment read came from. A caller that had to name the affected keys would
 * eventually name too few.
 *
 * ## The three routes that reach a container rather than a file
 *
 * `traefik/env`, `traefik/dashboard` and `traefik/ports` all inspect the running
 * `cloudgate-traefik` resource, so they **throw when Traefik is not running**
 * ("Resource type not found") rather than answering with nothing. That is
 * honest — there is no configuration to read when there is no container to read
 * it from — and it is why these three queries do not retry: a missing Traefik is
 * a deterministic answer, and F12's second defect is what happens when a
 * deterministic 500 meets a retrying client.
 *
 * They take `poll` for the one time they are repeated: after a save, until a
 * read shows the container that save recreated in the background — see
 * `useRecreation` for why the refetch a save triggers is not enough.
 */

/** The platform host. Every route here takes an optional `serverId` and gets none. */
const PLATFORM_HOST = null;


/**
 * What Traefik last said about the console's **own** routers (H-61).
 *
 * `retry: false` for the reason the three container-reading queries below take
 * it: every answer this route gives is deterministic. A member who is not an
 * operator of this instance gets a 403 that a retry cannot change, and a
 * platform host with no Traefik gets an `unavailable` **200** rather than an
 * error — the route never fails to say "nothing is known", which is the whole
 * distinction the card draws.
 *
 * No polling. The backend takes the observation when something *writes* a
 * Traefik configuration on this host, so between two writes there is nothing new
 * to fetch; `invalidate.instanceSettings()` after assigning the console domain
 * is what brings the fresh verdict in.
 */
export function useConsoleRouterStatus() {
  return useQuery({
    queryKey: keys.consoleRouterStatus(),
    queryFn: traefikApi.consoleConfigStatus,
    retry: false,
  });
}

export function useInstanceVersion() {
  return useQuery({
    queryKey: keys.instanceVersion(),
    queryFn: settingsApi.version,
    staleTime: Infinity,
  });
}

export function useInstanceReleaseTag() {
  return useQuery({
    queryKey: keys.instanceReleaseTag(),
    queryFn: settingsApi.releaseTag,
    staleTime: Infinity,
  });
}

export function useInstanceIp() {
  return useQuery({ queryKey: keys.instanceIp(), queryFn: settingsApi.ip });
}

export function useInfrastructureHealth() {
  return useQuery({
    queryKey: keys.instanceHealth(),
    queryFn: settingsApi.infrastructureHealth,
    retry: false,
  });
}

/**
 * Whether this caller administers the instance — the one question every write
 * on `/settings/instance` and `/settings/maintenance` asks (ADR-0013's
 * `checkInstanceAuthority`), answered the way `usePermission`'s rule says a
 * surface no statement names is answered: by the read beside those
 * writes that takes the same authority.
 *
 * `infrastructure-health` rather than `docker-disk-usage` or `log-cleanup`,
 * both of which take it too: it is the cheapest of the three to answer, the
 * instance screen already reads it for its health card, and it does not retry,
 * so a refusal lands on the first answer. One read for both screens, so the
 * two cannot disagree about who may press their buttons.
 */
export function useInstanceGate(): Gate {
  return readGate(useInfrastructureHealth());
}

/**
 * Whether a newer Cloudgate version has been published.
 *
 * Off by default: it is a `POST` that asks the GitHub API, whose
 * unauthenticated rate limit is per host, and nobody wants that on every visit
 * to a settings page. The card
 * asks for it when somebody presses Check.
 */
export function useUpdateData(enabled: boolean) {
  return useQuery({
    queryKey: keys.instanceUpdate(),
    queryFn: settingsApi.updateData,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function useDockerDiskUsage() {
  return useQuery({
    queryKey: keys.dockerDiskUsage(),
    queryFn: settingsApi.dockerDiskUsage,
    retry: false,
  });
}

export function useLogCleanup() {
  return useQuery({
    queryKey: keys.logCleanup(),
    queryFn: settingsApi.logCleanup,
  });
}

export function useTraefikConfig(kind: TraefikConfigKind) {
  return useQuery({
    queryKey: keys.traefikConfig(kind),
    queryFn: () => traefikApi.readConfig(kind),
    retry: false,
  });
}

export function useTraefikDirectories() {
  return useQuery({
    queryKey: keys.instanceTraefikFiles(),
    queryFn: () => traefikApi.directories(PLATFORM_HOST),
    retry: false,
  });
}

export function useTraefikFile(path: string | null) {
  return useQuery({
    queryKey: keys.instanceTraefikFile(path ?? ""),
    queryFn: () => traefikApi.readFile(path as string, PLATFORM_HOST),
    enabled: path !== null,
    retry: false,
  });
}

export function useTraefikEnv(poll = false) {
  return useQuery({
    queryKey: keys.traefikEnv(PLATFORM_HOST),
    queryFn: () => traefikApi.readEnv(PLATFORM_HOST),
    retry: false,
    refetchInterval: poll ? RECREATION_POLL_MS : false,
  });
}

export function useTraefikDashboard(poll = false) {
  return useQuery({
    queryKey: keys.traefikDashboard(PLATFORM_HOST),
    queryFn: () => traefikApi.dashboardEnabled(PLATFORM_HOST),
    retry: false,
    refetchInterval: poll ? RECREATION_POLL_MS : false,
  });
}

export function useTraefikPorts(poll = false) {
  return useQuery({
    queryKey: keys.traefikPorts(PLATFORM_HOST),
    queryFn: () => traefikApi.ports(PLATFORM_HOST),
    retry: false,
    refetchInterval: poll ? RECREATION_POLL_MS : false,
  });
}

/**
 * Everything that writes.
 *
 * One hook rather than fourteen, because every one of them does the same thing
 * afterwards and the sections read better as `platform.assignDomain.mutateAsync(…)`
 * than as fourteen imports.
 */
export function usePlatformMutations() {
  const invalidate = useInvalidate();
  const settled = { onSettled: () => invalidate.instanceSettings() };

  return {
    updateIp: useMutation({
      mutationFn: (serverIp: string) => settingsApi.updateIp(serverIp),
      ...settled,
    }),
    updateBuildsConcurrency: useMutation({
      mutationFn: (value: number) => settingsApi.updateBuildsConcurrency(value),
      ...settled,
    }),
    updateCloudRunsConcurrency: useMutation({
      mutationFn: (value: number) =>
        settingsApi.updateCloudRunsConcurrency(value),
      ...settled,
    }),
    updateCloudRunTimeLimit: useMutation({
      mutationFn: (minutes: number) =>
        settingsApi.updateCloudRunTimeLimit(minutes),
      ...settled,
    }),
    updateRequestedPreviewMaxTtl: useMutation({
      mutationFn: (minutes: number) =>
        settingsApi.updateRequestedPreviewMaxTtl(minutes),
      ...settled,
    }),
    assignDomain: useMutation({
      mutationFn: settingsApi.assignDomain,
      ...settled,
    }),
    updateDockerCleanup: useMutation({
      mutationFn: (on: boolean) => settingsApi.updateDockerCleanup(on),
      ...settled,
    }),
    updateLogCleanup: useMutation({
      mutationFn: (cron: string | null) => settingsApi.updateLogCleanup(cron),
      ...settled,
    }),
    writeConfig: useMutation({
      mutationFn: ({
        kind,
        content,
      }: {
        kind: TraefikConfigKind;
        content: string;
      }) => traefikApi.writeConfig(kind, content),
      ...settled,
    }),
    writeFile: useMutation({
      mutationFn: ({ path, content }: { path: string; content: string }) =>
        traefikApi.writeFile({
          path,
          traefikConfig: content,
          serverId: PLATFORM_HOST,
        }),
      ...settled,
    }),
    writeEnv: useMutation({
      mutationFn: (env: string) => traefikApi.writeEnv(env, PLATFORM_HOST),
      ...settled,
    }),
    toggleDashboard: useMutation({
      mutationFn: (on: boolean) =>
        traefikApi.toggleDashboard(on, PLATFORM_HOST),
      ...settled,
    }),
    updatePorts: useMutation({
      mutationFn: (ports: TraefikPort[]) =>
        traefikApi.updatePorts(ports, PLATFORM_HOST),
      ...settled,
    }),
  };
}

/**
 * `roleRefusal("save Traefik's files")`, written out: a module-scope call
 * would crash every test that mocks `use-permission` with only `usePermission`.
 */
export const TRAEFIK_FILES_WRITE_REFUSAL =
  "Your role in this Organization cannot save Traefik's files. Ask an owner or an admin to do it, or to change your role.";
