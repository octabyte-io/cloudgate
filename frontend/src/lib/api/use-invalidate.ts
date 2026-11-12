import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { authClient, useActiveOrganizationId } from "@/lib/auth/client";
import { endAllTerminals } from "@/lib/realtime/gateways";

import { keys } from "./keys";

/**
 * When Traefik's verdict on a rewritten Application file is read again, in ms
 * after the write returns — see `traefikConfig` below.
 */
export const TRAEFIK_VERDICT_REREADS_MS = [3_000, 8_000] as const;

/**
 * What a mutation invalidates, declared once.
 *
 * Every mutation in the app calls one of these instead of assembling query keys
 * itself. That is the whole point: when a route starts returning something new,
 * the fan-out changes here and nowhere else, and no screen is left showing a
 * list that no longer matches what it just changed.
 *
 * Each method takes the ids the mutation already has to hand, and widens from
 * there to whatever else the change could have made stale.
 */
export function useInvalidate() {
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganizationId();

  return useMemo(() => {
    const invalidate = (queryKey: readonly unknown[]) =>
      queryClient.invalidateQueries({ queryKey });

    /**
     * Every Project config this Organization has read: a console Save
     * on a Cloudgate-kept config rewrites its text, and a Service write knows
     * its Service, not its Project.
     */
    const projectConfigs = () =>
      queryClient.invalidateQueries({
        predicate: ({ queryKey }) => {
          const config = keys.projects.config(organizationId, "");
          return (
            queryKey.length === config.length &&
            queryKey.every(
              (part, at) => at === config.length - 2 || part === config[at],
            )
          );
        },
      });

    return {
      /**
       * The active Organization changed. Drop every tenant subtree rather than
       * refetching it: the previous Organization's rows are not stale, they are
       * not ours to hold. Account keys survive — the person did not change.
       *
       * Every open terminal ends here too, at once: a shell docked in
       * the console layout outlives the page, and a switch does not reload it.
       * The lease would end it within 30 s (ADR-0012); a shell into the old
       * Organization's container should not get those 30 s. Here, because
       * every way of switching — the masthead, *Not a member*, Settings —
       * ends by calling this.
       */
      organizationChanged: () => {
        endAllTerminals();
        queryClient.removeQueries({ queryKey: ["org"] });
        return invalidate(keys.account);
      },

      /** Profile, sessions, API keys — anything about the signed-in person. */
      account: () => invalidate(keys.account),

      /**
       * An account write changed what `get-session` answers — the session's
       * `user` or its `id`.
       *
       * **The account keys go, and a store that is not TanStack's is told
       * too**, which is `membership()`'s `$listOrg` argument again. The avatar
       * menu's name and the Sessions card's "This session" read `useSession()`,
       * better-auth's nanostore, and it refetches off `$sessionSignal` — which
       * the client raises only for writes made through its *own* endpoints
       * (`/update-user`, `/revoke-session`, …). The account screens write
       * through Nest instead (`use-account.ts` says why), so none of them raised
       * it: a saved name stayed old in the menu until a reload, and turning
       * two-factor on or off, which **rotates this browser's session**, left the
       * card matching rows against a session id that no longer existed. No row
       * said "This session", and the one that was this browser offered Revoke.
       *
       * Called for the profile, the two-factor switch both ways, and ending a
       * session — though revoking *another* device's changes nothing
       * `get-session` reports here: it is the write better-auth's own client
       * raises the signal for, and matching that costs one GET. Minting or
       * deleting an API key touches neither, and stays on `account()`.
       */
      session: () => {
        authClient.$store.notify("$sessionSignal");
        return invalidate(keys.account);
      },

      /** Members, invitations, teams and the Organization row itself. */
      organization: () => invalidate(keys.org(organizationId)),

      /**
       * A Project was created, renamed or deleted. Environments go too: a
       * deleted Project cascades to them, and the rail reads both.
       */
      project: (projectId?: string) =>
        Promise.all([
          invalidate(keys.projects.all(organizationId)),
          projectId
            ? invalidate(keys.projects.detail(organizationId, projectId))
            : Promise.resolve(),
          invalidate(keys.environments.all(organizationId)),
        ]),

      /**
       * A Project config's whole YAML was saved: every Environment of
       * the Project has a new plan, and a text that changes nothing was
       * stored at once.
       */
      projectConfigSaved: (projectId: string) =>
        Promise.all([
          invalidate(keys.projects.config(organizationId, projectId)),
          invalidate(keys.environments.all(organizationId)),
        ]),

      /**
       * A plan was applied: it wrote Services in its Environment,
       * queued their Deployments and stored the Project's config text, which
       * moves every other Environment's plan with it.
       */
      planApplied: (options: { projectId: string; environmentId: string }) =>
        Promise.all([
          invalidate(keys.projects.config(organizationId, options.projectId)),
          invalidate(keys.environments.all(organizationId)),
          invalidate(keys.applications.all(organizationId)),
          invalidate(keys.databases.all(organizationId)),
          invalidate(keys.deployments.all(organizationId)),
          invalidate(keys.domains.all(organizationId)),
        ]),

      /**
       * A Tag was created, renamed, deleted, attached or detached.
       *
       * The whole `tags` subtree goes every time, deliberately: renaming a Tag
       * changes the chip on every Project carrying it, deleting one takes it off
       * every Project at once (`project_tag` cascades), and neither the row nor
       * the response says which Projects those were. Narrowing this would leave
       * a stale chip on a screen nobody thought to invalidate.
       */
      tag: () => invalidate(keys.tags.all(organizationId)),

      /**
       * An Environment changed. `projectId` narrows the list that has to
       * refetch; without it every Environment list does.
       */
      environment: (options?: { environmentId?: string; projectId?: string }) =>
        Promise.all([
          options?.projectId
            ? invalidate(
                keys.environments.byProject(organizationId, options.projectId),
              )
            : invalidate(keys.environments.all(organizationId)),
          options?.environmentId
            ? invalidate(
                keys.environments.detail(organizationId, options.environmentId),
              )
            : Promise.resolve(),
        ]),

      /**
       * What an Environment's next plan reads changed outside the Project
       * config: an entry now stands for an existing bucket.
       */
      environmentPlan: (environmentId: string) =>
        invalidate(keys.environments.plan(organizationId, environmentId)),

      /**
       * An Environment's Pending setups changed: one was cancelled, or the
       * cancel failed and the list may no longer be what it showed.
       */
      pendingSetups: (environmentId: string) =>
        invalidate(
          keys.environments.pendingSetups(organizationId, environmentId),
        ),

      /**
       * An Environment's networks changed: a network Delete
       * retried, a network state rebuilt.
       */
      environmentNetworks: (environmentId: string) =>
        invalidate(keys.environments.networks(organizationId, environmentId)),

      /**
       * An Application changed. Creating or deleting one changes what its
       * Environment contains, so pass `environmentId` when you have it.
       */
      application: (options?: {
        applicationId?: string;
        environmentId?: string;
      }) =>
        Promise.all([
          options?.applicationId
            ? invalidate(
                keys.applications.detail(organizationId, options.applicationId),
              )
            : invalidate(keys.applications.all(organizationId)),
          options?.environmentId
            ? invalidate(
                keys.environments.detail(organizationId, options.environmentId),
              )
            : Promise.resolve(),
          projectConfigs(),
        ]),

      /**
       * A managed database changed — renamed, re-credentialled, deployed,
       * started, stopped, rebuilt or deleted (F11).
       *
       * Keyed by **engine and id**, because that pair is what addresses one.
       * `environmentId` goes with it when the caller has it, for the same
       * reason `application()` takes one: creating or deleting a database
       * changes what its Environment holds, and the rail reads that.
       */
      database: (options?: {
        kind?: string;
        databaseId?: string;
        environmentId?: string;
      }) =>
        Promise.all([
          options?.kind && options?.databaseId
            ? invalidate(
                keys.databases.detail(
                  organizationId,
                  options.kind,
                  options.databaseId,
                ),
              )
            : invalidate(keys.databases.all(organizationId)),
          options?.environmentId
            ? invalidate(
                keys.environments.detail(organizationId, options.environmentId),
              )
            : Promise.resolve(),
          projectConfigs(),
        ]),

      /**
       * A deploy was triggered or finished. The Application goes too — its
       * `applicationStatus` moves with the build.
       */
      deployments: (applicationId: string) =>
        Promise.all([
          invalidate(
            keys.deployments.byApplication(organizationId, applicationId),
          ),
          invalidate(keys.applications.detail(organizationId, applicationId)),
        ]),

      /**
       * A build held for a plan was released. Its plan lists it, and
       * a plan's key is under its Environment's, so every Environment's goes
       * with the Application's builds.
       */
      heldBuild: (applicationId: string) =>
        Promise.all([
          invalidate(
            keys.deployments.byApplication(organizationId, applicationId),
          ),
          invalidate(keys.applications.detail(organizationId, applicationId)),
          invalidate(keys.environments.all(organizationId)),
        ]),

      /**
       * A Compose stack changed — renamed, re-sourced, its file edited,
       * deployed, started, stopped or deleted (F12).
       *
       * The **containers go with it**, and that is the part worth stating: every
       * one of those actions changes what `docker ps` would say, and the
       * Containers and Logs tabs are reading exactly that. The whole `docker`
       * subtree goes rather than one app's slice, because a container listing is
       * keyed by host and app *type* and a stack that has just been deleted no
       * longer tells us which of those it was.
       */
      compose: (options?: { composeId?: string; environmentId?: string }) =>
        Promise.all([
          options?.composeId
            ? invalidate(keys.compose.detail(organizationId, options.composeId))
            : invalidate(keys.compose.all(organizationId)),
          options?.composeId
            ? invalidate(
                keys.compose.services(organizationId, options.composeId),
              )
            : Promise.resolve(),
          options?.environmentId
            ? invalidate(
                keys.environments.detail(organizationId, options.environmentId),
              )
            : Promise.resolve(),
          invalidate(keys.docker.all(organizationId)),
          projectConfigs(),
        ]),

      /**
       * A stack was deployed. The **stack row goes too** — its `composeStatus`
       * moves with the build and the masthead badge reads it — which is the same
       * pairing `deployments()` does for an Application.
       */
      composeDeployments: (composeId: string) =>
        Promise.all([
          invalidate(keys.deployments.byCompose(organizationId, composeId)),
          invalidate(keys.compose.detail(organizationId, composeId)),
        ]),

      /** Only what `docker ps` would answer — a container was started or killed. */
      containers: () => invalidate(keys.docker.all(organizationId)),

      /**
       * A domain was added, edited or removed.
       *
       * Only the owning service's list goes: a domain cannot move between
       * services (`PATCH /domains/:id` takes no parent id), so no other list can
       * have changed. Called with neither id — which nothing does today — it
       * falls back to the whole subtree rather than silently doing nothing.
       */
      domains: (options?: {
        applicationId?: string;
        composeId?: string;
        bucketId?: string;
      }) => {
        // A Domain is also an HTTP Uptime check's target: an edit moves what
        // the check probes and a removal deletes the check, so the
        // Service's Health tab goes stale with its Domains list.
        if (options?.applicationId) {
          return Promise.all([
            invalidate(
              keys.domains.byApplication(organizationId, options.applicationId),
            ),
            invalidate(
              keys.serviceHealth.byService(
                organizationId,
                "application",
                options.applicationId,
              ),
            ),
          ]);
        }
        if (options?.composeId) {
          return Promise.all([
            invalidate(
              keys.domains.byCompose(organizationId, options.composeId),
            ),
            invalidate(
              keys.serviceHealth.byService(
                organizationId,
                "compose",
                options.composeId,
              ),
            ),
          ]);
        }
        // A bucket's Domains have no Uptime check; its page reads them alone.
        if (options?.bucketId) {
          return invalidate(
            keys.domains.byBucket(organizationId, options.bucketId),
          );
        }
        return Promise.all([
          invalidate(keys.domains.all(organizationId)),
          invalidate(keys.serviceHealth.all(organizationId)),
        ]);
      },

      /**
       * An Uptime check was added, edited, turned off or on, or deleted.
       * The whole summary goes, every page of it: the check, its
       * strip and any Incident the change closed are one read.
       */
      serviceHealth: (serviceType: string, serviceId: string) =>
        Promise.all([
          invalidate(
            keys.serviceHealth.byService(
              organizationId,
              serviceType,
              serviceId,
            ),
          ),
          // The Environment's Health column holds this Service's row.
          invalidate(keys.serviceHealth.environment(organizationId)),
        ]),

      /** A bucket's browser-upload origins were set, or its key rotated. */
      bucket: (bucketId: string) =>
        invalidate(keys.buckets.detail(organizationId, bucketId)),

      /** A Service's traces were turned on or off, or its retention changed. */
      traces: (serviceType: string, serviceId: string) =>
        invalidate(
          keys.traces.byService(organizationId, serviceType, serviceId),
        ),

      /**
       * Cloudgate rewrote an Application's Traefik file — a domain, a redirect
       * or a basic-auth user was added, edited or removed.
       *
       * **The file view goes now; Traefik's verdict goes later, twice.** The
       * write itself finishes inside the request (`regenerate` awaits
       * `writeConfig`), so the generated file and the directory walk that finds
       * it are stale the moment the mutation returns — and a first domain is
       * what creates the file, a last one what deletes it. The verdict is not:
       * `verifyInBackground` waits `RELOAD_GRACE_MS` (2 s) for Traefik's
       * watcher and then reads its log over another round trip, and until it
       * lands `GET /traefik/config-status` answers with the *previous* reading
       * — or, before any write, a fallback stamped with the time of the
       * request, which would print "Observed just now" beside words about no
       * write at all. So nothing is read straight away. The first re-read
       * comes after the grace with headroom for a local host, the second for
       * a remote one where each `docker` call is an SSH round trip. Nothing
       * here can tell the two answers apart from the outside, which is why
       * this is a schedule rather than a poll that stops on a change.
       */
      traefikConfig: (applicationId: string) => {
        const traefik = keys.traefik.all(organizationId);
        const status = keys.traefik.configStatus(organizationId, applicationId);
        for (const delay of TRAEFIK_VERDICT_REREADS_MS) {
          setTimeout(() => void invalidate(status), delay);
        }
        return Promise.all([
          invalidate([...traefik, "directories"]),
          invalidate([...traefik, "file"]),
        ]);
      },

      /**
       * A mount was added, edited or removed (F10).
       *
       * The **Application** goes too, and that is the part worth stating: a
       * mount is not shown on the Application row, but adding one changes what
       * the next Deployment will produce, and the Advanced tab reads both in one
       * screen. Same for every method below it.
       */
      mounts: (serviceId: string) =>
        Promise.all([
          invalidate(keys.mounts.byService(organizationId, serviceId)),
          invalidate(keys.applications.detail(organizationId, serviceId)),
        ]),

      /**
       * A published port, a redirect or a basic-auth user changed.
       *
       * Three groups, one method, because all three answer the same question on
       * the same screen and none of them can change without the Advanced tab
       * wanting to re-read it. Takes the **Application** rather than a service:
       * these three tables hang off `application` alone.
       *
       * The Application goes too, on `mounts()`' argument — none of the three is
       * shown on the Application row, and all three change what the next
       * Deployment will produce.
       */
      networking: (applicationId: string) =>
        Promise.all([
          invalidate(keys.ports.byApplication(organizationId, applicationId)),
          invalidate(
            keys.redirects.byApplication(organizationId, applicationId),
          ),
          invalidate(
            keys.security.byApplication(organizationId, applicationId),
          ),
          invalidate(keys.applications.detail(organizationId, applicationId)),
        ]),

      /**
       * A rollback point was used or deleted.
       *
       * Using one **deploys**, so the Deployment list and the Application's own
       * status move with it — the same fan-out `deployments()` does, plus the
       * rollback list itself.
       */
      rollbacks: (applicationId: string) =>
        Promise.all([
          invalidate(
            keys.rollbacks.byApplication(organizationId, applicationId),
          ),
          invalidate(
            keys.deployments.byApplication(organizationId, applicationId),
          ),
          invalidate(keys.applications.detail(organizationId, applicationId)),
        ]),

      /** A preview was redeployed or torn down. */
      previewDeployments: (applicationId: string) =>
        invalidate(
          keys.previewDeployments.byApplication(organizationId, applicationId),
        ),

      /** A schedule was created, edited, enabled, run or deleted. */
      schedules: (serviceId: string) =>
        invalidate(keys.schedules.byService(organizationId, serviceId)),

      /** A volume backup was created, edited, run, restored or deleted. */
      volumeBackups: (serviceId: string) =>
        invalidate(keys.volumeBackups.byService(organizationId, serviceId)),

      /**
       * A patch changed.
       *
       * The **repo reads go with it**, and they have to: `GET /patches/repo/file`
       * answers with the *patch's* content when one exists for the path and the
       * repository's copy otherwise, so saving a patch changes what that route
       * returns for a path nothing else touched. Keeping the file cache would
       * show the editor the file it was replacing.
       */
      patches: (entityId: string) =>
        Promise.all([
          invalidate(keys.patches.byEntity(organizationId, entityId)),
          invalidate(keys.patches.repo(organizationId, entityId)),
        ]),

      /**
       * A Server changed. Its audit and validate results are not invalidated:
       * both shell out over SSH, and re-running them is a decision someone
       * makes, not a side effect of a rename.
       */
      server: (serverId?: string) =>
        Promise.all([
          invalidate(keys.servers.list(organizationId)),
          serverId
            ? invalidate(keys.servers.detail(organizationId, serverId))
            : Promise.resolve(),
        ]),

      /** A Server's Access log was switched on or off. */
      serverRequestLogging: (serverId: string) =>
        invalidate(keys.traefik.requestLogging(organizationId, serverId)),

      /**
       * After a setup run, the host's readiness genuinely did change.
       *
       * **The `docker` subtree goes with it (F13)**, and that is the point of
       * running setup: it installs Docker, initialises the Swarm, creates the
       * overlay network and starts Traefik. Every container listing and every
       * node listing for that host is a different answer afterwards.
       */
      serverReadiness: (serverId: string) =>
        Promise.all([
          invalidate(keys.servers.audit(organizationId, serverId)),
          invalidate(keys.servers.validate(organizationId, serverId)),
          invalidate(keys.docker.all(organizationId)),
        ]),

      /**
       * A Server's monitoring configuration changed (F14).
       *
       * **Three subtrees, and the third is the one that is easy to miss.** The
       * `server` row carries `metricsConfig`, and every screen that decides
       * whether to ask for samples at all reads `token` off it — so the row has
       * to be refetched or the Monitoring screen goes on saying "not set up"
       * about a Server it has just set up. The **samples** go too, because the
       * old series was fetched under a `limit` derived from the *previous*
       * refresh rate, so it is now an answer to a question nobody is asking.
       *
       * The samples are invalidated at `monitoring.all` rather than per window:
       * every window of one host is stale together, and a screen with three
       * ranges open has three keys the caller does not know about.
       */
      serverMonitoring: (serverId: string) =>
        Promise.all([
          invalidate(keys.servers.list(organizationId)),
          invalidate(keys.servers.detail(organizationId, serverId)),
          invalidate(keys.monitoring.all(organizationId)),
        ]),

      /**
       * Traefik's request logging was switched, or Traefik was restarted (F14).
       *
       * Both keys are under `instance`, so this does not take an
       * `organizationId` — and the *analytics* are invalidated too, because
       * turning logging on is the change that makes them answerable at all.
       */
      traefikRequests: () =>
        Promise.all([
          invalidate(keys.traefikRequests()),
          invalidate(keys.instanceHealth()),
          invalidate(keys.monitoring.all(organizationId)),
        ]),

      /**
       * An SSH key was added, renamed or deleted (F13).
       *
       * **The Servers go too**, because deleting a key does not refuse while
       * Servers are using it — `server.sshKeyId` is `onDelete: 'set null'`, so
       * every Server that used it now has none, and the fleet's key column and
       * each Server's Access tab are both reading that column. Renaming changes
       * what those same screens print.
       */
      sshKeys: () =>
        Promise.all([
          invalidate(keys.sshKeys.all(organizationId)),
          invalidate(keys.servers.all(organizationId)),
        ]),

      /**
       * A git provider connection was added, edited or deleted (F15).
       *
       * Widens to the whole `gitProviders` subtree rather than to one kind,
       * because the base rows and the four per-kind connection lists are two
       * views of the same change — and the repository and branch lists hang
       * under the connection, so an edited credential must not leave a stale
       * repository list that was fetched with the old one.
       */
      gitProviders: () => invalidate(keys.gitProviders.all(organizationId)),

      /**
       * A registry was added, edited or deleted (F15).
       *
       * **The Applications go too.** `application.registryId` and
       * `buildRegistryId` are `onDelete: 'set null'`, so removing a registry
       * silently un-picks it on every service that was pushing there, and F09's
       * Build card is reading that column.
       */
      registries: () =>
        Promise.all([
          invalidate(keys.registries.all(organizationId)),
          invalidate(keys.applications.all(organizationId)),
        ]),

      /**
       * A destination was added, edited or deleted (F15). F10's volume backups
       * and F11's database backups both pick from this list.
       */
      destinations: () => invalidate(keys.destinations.all(organizationId)),

      /** A Cloud account was connected. */
      cloudAccounts: () => invalidate(keys.cloudAccounts.all(organizationId)),

      /** A notification channel was added, edited or deleted (F15). */
      notifications: () => invalidate(keys.notifications.all(organizationId)),

      /**
       * An AI provider was added, edited, enabled or deleted (F15).
       *
       * The **models** cache under this subtree goes too, which is the point of
       * widening: an edited `apiUrl` is a different provider's model list, and
       * the key that list is held under is the URL.
       */
      ai: () => invalidate(keys.ai.all(organizationId)),

      /** A certificate was added, edited or removed (F16). */
      certificates: () => invalidate(keys.certificates.all(organizationId)),

      /**
       * A member was invited, re-roled or removed, a team changed, or the
       * Organization itself was renamed (F16).
       *
       * Widens to the whole tenant subtree through `organization()` **and** takes
       * the account subtree with it, which is the part worth stating: the member
       * list, the invitations, the teams and `GET /organizations` (which is the
       * signed-in person's, under `account`) are four views of one membership
       * table, and the two roots would otherwise disagree about which
       * Organizations you are in.
       *
       * **There is a third root, and it is not TanStack's**.
       * better-auth keeps its own list of the Organizations you belong to, and
       * that list — not `GET /organizations` — is what the masthead switcher
       * renders (`OrgSwitcher`). Its store refreshes off the `$listOrg` signal,
       * which the client raises for `/organization/create`, `/update` and
       * `/delete`; this console calls none of those, because `auth.config.ts`
       * puts all three on `disabledPaths` so the self-hosted owner rules are
       * enforced in Nest instead (`useOrganizations`). So every write that went
       * through here left the switcher on the old name, or without the
       * Organization just created, until a full reload — client navigation did
       * not help, because nothing invalidated a store React Query does not own.
       * Raising the signal here rather than at the three call sites is the same
       * argument the two keys above are declared here for: the fan-out is one
       * fact about what a membership write makes stale.
       */
      membership: () => {
        authClient.$store.notify("$listOrg");
        return Promise.all([
          invalidate(keys.org(organizationId)),
          invalidate(keys.myOrganizations()),
        ]);
      },

      /**
       * How this instance is configured changed (F16).
       *
       * One method for the whole `instance` root rather than nine, and that is
       * deliberate: these settings reach each other. Assigning a domain rewrites
       * `dynamic/cloudgate.yml`, so the Traefik file editor is stale; toggling
       * the dashboard republishes the container's ports, so the ports list is;
       * saving ports recreates the container, so its environment read is. Every
       * one of those is a route in the same controller writing the same two
       * artefacts, and a caller that had to name which ones it touched would
       * eventually get it wrong in the direction that leaves a screen confidently
       * showing the old value.
       *
       * `instanceHealth` and `traefikRequests` are under this root too, so they
       * refresh with it — which is right: restarting Traefik is exactly when the
       * health card's second leg changes.
       */
      instanceSettings: () => invalidate(keys.instance),

      /**
       * The instance was rebranded. Its own key rather than
       * `instanceSettings`, which would refetch every probe on the Instance and
       * Traefik screens to repaint a logo.
       */
      branding: () => invalidate(keys.branding()),

      /**
       * Maintenance's "Delete metrics" deleted the platform host's stored
       * samples. Everything `instanceSettings` drops, **and the sample
       * subtree**: the host's series lives under `monitoring`, not `instance`,
       * and a stopped host's series is not polled — so without this the
       * Monitoring screen went on drawing rows that no longer exist until the
       * cache aged out.
       */
      hostMetricsDeleted: () =>
        Promise.all([
          invalidate(keys.instance),
          invalidate(keys.monitoring.all(organizationId)),
        ]),

      /**
       * The licence was enabled, activated, revalidated or released (F18).
       *
       * **This one widens to the whole tenant subtree, and it has to.** A licence
       * is not a setting alongside the others — it is the switch that decides
       * whether five sections may read anything at all. Every SSO, SCIM,
       * forward-auth and custom-role write answers `403 Valid enterprise license
       * required` without it, and those refusals are cached like any other
       * result. Narrowing this to the licence keys would leave five screens
       * holding a refusal that has just stopped being true, with no way to
       * discover it short of a reload.
       *
       * It goes the other way too: `deactivate` and a failed `validate` both
       * turn the licence off, and the sections that were showing real data are
       * now showing data the backend would no longer serve.
       */
      license: () => invalidate(keys.org(organizationId)),

      /**
       * A custom role was created, edited, renamed or deleted (F18).
       *
       * **The members go too**, and that is the non-obvious half: `member.role`
       * holds the role *name*, so a rename rewrites every member row holding it
       * in the same request — the member table's Role column is reading a value
       * this mutation just changed. Deleting is the safe direction only because
       * the backend refuses while anyone holds it.
       */
      roles: () =>
        Promise.all([
          invalidate(keys.roles.all(organizationId)),
          invalidate(keys.organization.members(organizationId)),
        ]),

      /**
       * An SSO provider or a trusted origin changed (F18).
       *
       * **Forward-auth goes with it.** `GET /forward-auth/providers` is the same
       * `sso_provider` table filtered to the OIDC rows, and
       * `forwardAuthSettings.providerId` is `onDelete: 'set null'` — so deleting
       * a provider silently un-picks it on every server whose proxy was
       * authenticating against it, and the forward-auth screen is reading that
       * column.
       */
      sso: () =>
        Promise.all([
          invalidate(keys.sso.all(organizationId)),
          invalidate(keys.forwardAuth.all(organizationId)),
        ]),

      /**
       * SSO enforcement was switched (F18).
       *
       * Under `instance`, so it takes no `organizationId` — and it invalidates
       * the **sign-in screen's** read with it, which is the point: `ssoSignIn`
       * and `ssoEnforce` together decide whether the door renders a password
       * form at all, and they must not disagree.
       */
      ssoEnforce: () =>
        Promise.all([
          invalidate(keys.ssoEnforce()),
          invalidate(keys.ssoSignIn()),
        ]),

      /** A SCIM provider was created or deleted (F18). */
      scim: () => invalidate(keys.scim.all(organizationId)),

      /**
       * A forward-auth target's settings or proxy changed (F18). Widens to the
       * whole subtree rather than to one `serverId`: `serverStatus` reports every
       * target in one response, so a change to any of them restates all of them.
       */
      forwardAuth: () => invalidate(keys.forwardAuth.all(organizationId)),

      /**
       * A domain's forward-auth gate was switched (F18).
       *
       * Narrow on purpose, and the only method here that does not widen: this is
       * the half of the controller that is **not** licensed and is reached from
       * an Application's own screen, where dropping the tenant subtree would
       * refetch a Deployment list and a log to answer a switch.
       */
      forwardAuthDomain: (domainId: string) =>
        invalidate(keys.forwardAuth.domain(organizationId, domainId)),

      /**
       * Billing changed — the Add-ons set, or invoice mail switched (F18).
       *
       * Only billing: a change of plan or Add-ons never touches a Server
       * (ADR-0048), so the fleet has nothing new to read. The allowance
       * a Server create checks is billing's own `can-create-server`, which
       * `keys.billing.all` covers.
       *
       * A checkout is deliberately **not** invalidated through here: it hands off
       * to Stripe and the subscription only exists once the webhook has been
       * delivered, so there is nothing to refetch at the moment the button is
       * pressed.
       */
      billing: () => invalidate(keys.billing.all(organizationId)),

      /**
       * A Bought Server was bought, paid for or cancelled (ADR-0071): the
       * purchases waiting or being made, the fleet (a paid one becomes a
       * Server), and billing's `can-create-server`, which counts it from Buy.
       */
      boughtServers: () =>
        Promise.all([
          invalidate(keys.boughtServers.purchases(organizationId)),
          invalidate(keys.servers.all(organizationId)),
          invalidate(keys.billing.all(organizationId)),
        ]),

      /**
       * An Operator suspended or lifted an Organization: the Operator
       * page's list, and the billing standing — the frozen banner — in case
       * the Operator's own active Organization is the one they acted on.
       */
      operatorOrganizations: () =>
        Promise.all([
          invalidate(keys.operatorOrganizations()),
          invalidate(keys.billing.all(organizationId)),
        ]),

      /**
       * An Operator changed the Server markup or the margin floor: the
       * Bought Servers section, its settings and flags (one prefix), and
       * the buy page's prices, which the markup makes.
       */
      operatorBoughtServers: () =>
        Promise.all([
          invalidate(keys.operatorBoughtServers()),
          invalidate(keys.boughtServers.catalogue(organizationId)),
        ]),

      /** An Operator forwarded or closed an abuse report (#1401). */
      operatorAbuseReports: () => invalidate(keys.operatorAbuseReports()),

      /**
       * An Operator powered a Bought Server off or on (#1401): the Bought
       * Servers section, and the Servers in case it is the Operator's own.
       */
      operatorPower: () =>
        Promise.all([
          invalidate(keys.operatorBoughtServers()),
          invalidate(keys.servers.all(organizationId)),
        ]),
    };
  }, [queryClient, organizationId]);
}
