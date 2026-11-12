"use client";

import { LinkButton } from "@/components/console/link-button";
import { MetaStrip } from "@/components/console/meta-strip";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { TabPending } from "@/components/console/tab-pending";
import { Outcome } from "@/components/console/outcome";
import { Tabs } from "@/components/console/tabs";
import { errorMessage } from "@/lib/api/error-message";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { ADVANCED_SECTIONS, SaveScope } from "../advanced/advanced-sections";
import { BuildServerCard } from "../advanced/build-server-card";
import { kindRefusals } from "../config-kind";
import { DeleteApplicationCard } from "../lifecycle/delete-application-card";
import { mountsSpec } from "../advanced/mounts-spec";
import {
  portsSpec,
  redirectsSpec,
  securitySpec,
} from "../advanced/networking-specs";
import { ResourceList } from "@/components/console/resource-list";
import { CopyRangeCard } from "../advanced/copy-range-card";
import { ResourcesCard } from "../advanced/resources-card";
import { PortCard } from "../advanced/port-card";
import { RuntimeCard } from "../advanced/runtime-card";
import { SwarmSection } from "../advanced/swarm/swarm-section";
import { TraefikCard } from "../advanced/traefik-card";
import {
  useMountMutations,
  useMounts,
  useNetworking,
  useNetworkingMutations,
  useServers,
} from "../advanced/use-advanced";
import {
  rejectedRedirectIds,
  rejectedSecurityIds,
} from "../traefik-status/rejections";
import { useTraefikConfigStatus } from "../traefik-status/use-config-status";
import {
  useApplication,
  useSetCopyRange,
  useUpdateApplication,
} from "../use-application";
import { onGoogleCloud } from "@/lib/api/endpoints/applications";

/**
 * Everything about *how* this Application runs, as opposed to what it is.
 *
 * The longest screen in the console, and the one where the shared scaffolding
 * earns itself: three of its cards are `SettingsCard` configurations, **four** are
 * `ResourceList`s, and the eleven Swarm concerns are one form over a table of
 * field specs. F10's brief warned that a careless build turns this into forty
 * near-identical form files; what is here is six components and nine
 * configuration files.
 *
 * **The three stated absences are gone.** Ports, redirects and basic-auth rules
 * had no list route, so this tab shipped three `UnlistableCard`s rather than three
 * empty tables with add buttons — an empty table would have claimed something
 * about the Application's configuration that only a missing route was saying, and
 * on basic auth it would have claimed the Application was protected.
 * Each now has `GET /?applicationId=`, so they are three ordinary
 * `ResourceList`s now (`networking-specs.tsx`), and `UnlistableCard` had no other
 * caller and is gone with them.
 *
 * The order is deliberate and it is not the reference's: the things every
 * Application has (resources, what it runs, what it mounts) come first, the
 * things most have none of (ports, redirects, basic auth) next, and the Docker
 * Engine passthrough — which most people should never touch — last. After it,
 * the one card that removes the Application altogether.
 *
 * **One sub-section at a time**: the same order, as five sub-tabs —
 * Resources, Runtime, Routing, Docker Swarm, Danger zone — each opening on how
 * its cards save. `advanced-sections.tsx` says why, and what was rejected.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const application = useApplication(id);
  const servers = useServers();
  const mounts = useMounts(id);
  const networking = useNetworking(id);
  // H-38/H-62. Traefik reads two of the four tables on this tab, and when it
  // refuses the file it names the *router* and not the link — so a rejection
  // arrives as a set of rows, and the rows are here.
  const traefik = useTraefikConfigStatus(id);
  const troubledRedirects = rejectedRedirectIds(traefik.data);
  const troubledUsers = rejectedSecurityIds(traefik.data);

  const row = application.data;
  const update = useUpdateApplication(id, row?.environmentId);
  const copyRange = useSetCopyRange(id, row?.environmentId);
  const mountMutations = useMountMutations(id);
  const net = useNetworkingMutations(id);

  const save = (input: Record<string, unknown>) =>
    update.mutateAsync(input as never);

  if (application.error) {
    return (
      <Outcome
        // `bad`, not `info`: the id is fine — the shell would have said so — so
        // something between here and the row genuinely failed.
        tone="bad"
        icon="sliders"
        title="This Application could not be read"
        action={<LinkButton href="/projects">Back to Projects</LinkButton>}
      >
        {errorMessage(application.error)}
      </Outcome>
    );
  }

  if (!row) return <TabPending />;
  const aiModel = Boolean(row.aiModel);
  // A web-private publishes no port, which the API refuses.
  const portRefused = kindRefusals(row.configKind)?.port ?? null;

  const mounts$ = mountsSpec({
    applicationId: id,
    create: (input) => mountMutations.create.mutateAsync(input as never),
    update: (mountId, input) =>
      mountMutations.update.mutateAsync({ mountId, input: input as never }),
    remove: (mountId) => mountMutations.remove.mutateAsync(mountId),
  });

  const ports$ = portsSpec({
    applicationId: id,
    create: (input) => net.ports.create.mutateAsync(input as never),
    update: (portId, input) =>
      net.ports.update.mutateAsync({ portId, input: input as never }),
    remove: (portId) => net.ports.remove.mutateAsync(portId),
  });

  const redirects$ = redirectsSpec({
    applicationId: id,
    troubled: (redirect) => troubledRedirects.has(redirect.redirectId),
    create: (input) => net.redirects.create.mutateAsync(input as never),
    update: (redirectId, input) =>
      net.redirects.update.mutateAsync({ redirectId, input: input as never }),
    remove: (redirectId) => net.redirects.remove.mutateAsync(redirectId),
  });

  const security$ = securitySpec({
    applicationId: id,
    troubled: (user) => troubledUsers.has(user.securityId),
    create: (input) => net.security.create.mutateAsync(input as never),
    update: (securityId, input) =>
      net.security.update.mutateAsync({ securityId, input: input as never }),
    remove: (securityId) => net.security.remove.mutateAsync(securityId),
  });

  return (
    <Page className="grid gap-3">
      <PageHeader
        title={label}
        icon={icon}
        lede="What this Application is allowed to use, what it can reach, and how Swarm runs it."
      />

      <Tabs defaultValue="resources">
        <Tabs.Bar aria-label="Advanced settings">
          {ADVANCED_SECTIONS.map((section) => (
            <Tabs.Tab key={section.id} value={section.id}>
              {section.label}
            </Tabs.Tab>
          ))}
        </Tabs.Bar>

        {/* `keepMounted`, so an edit typed into one sub-section is still
            there after a look at another — the Swarm form above all, whose
            eleven cards share one Save. */}
        <Tabs.Panel value="resources" keepMounted className="grid gap-3">
          <SaveScope section="resources" />
          {onGoogleCloud(row.cloudPlace) && row.configKind !== "worker" ? (
            // S10: Cloud Run's copy range, set there on save. A
            // Worker's worker pool has none: its replicas are its instance
            // count.
            <CopyRangeCard application={row} save={copyRange.mutateAsync} />
          ) : null}
          <ResourcesCard application={row} save={save} />
        </Tabs.Panel>

        <Tabs.Panel value="runtime" keepMounted className="grid gap-3">
          <SaveScope section="runtime" />
          {aiModel ? (
            // What the API refuses on an AI model is not offered.
            <MetaStrip>
              An AI model&rsquo;s run command, published ports, networks, health
              check and endpoint spec are the platform&rsquo;s: it is reached
              through its gateway endpoint on the <strong>Model</strong> tab,
              and nothing else.
            </MetaStrip>
          ) : (
            <RuntimeCard application={row} save={save} />
          )}
          <ResourceList spec={mounts$} query={mounts} />
          <BuildServerCard
            application={row}
            servers={servers.data ?? []}
            serversPending={servers.isPending}
            save={save}
          />
        </Tabs.Panel>

        <Tabs.Panel value="routing" keepMounted className="grid gap-3">
          <SaveScope section="routing" />
          {!aiModel &&
          (row.configKind === "web" || row.configKind === "web-private") ? (
            <PortCard
              application={row}
              save={(input) => update.mutateAsync(input as never)}
            />
          ) : null}
          {aiModel ? null : portRefused !== null ? (
            <MetaStrip>{portRefused}</MetaStrip>
          ) : (
            <ResourceList
              spec={ports$}
              query={networking.ports}
              note={
                <MetaStrip>
                  A published port bypasses Traefik entirely — it is bound on
                  the Server itself. A domain on the <strong>Domains</strong>{" "}
                  tab is the usual way in, and the right one for anything
                  speaking HTTP.
                </MetaStrip>
              }
            />
          )}

          <ResourceList
            spec={redirects$}
            query={networking.redirects}
            note={
              troubledRedirects.size > 0 ? (
                <MetaStrip>
                  A router Traefik refused names{" "}
                  <strong>{troubledRedirects.size}</strong> of these. Traefik
                  drops the whole router when any middleware in its chain fails
                  to build and does not say which one, so the marked rows are
                  the candidates — the <strong>Domains</strong> tab names the
                  host that stopped being served and carries what Traefik
                  actually said.
                </MetaStrip>
              ) : undefined
            }
          />

          <ResourceList
            spec={security$}
            query={networking.security}
            note={
              <MetaStrip>
                {troubledUsers.size > 0 ? (
                  <>
                    A router Traefik refused names the basic-auth middleware
                    these users are in, so the marked rows are candidates for
                    what it could not build — the <strong>Domains</strong> tab
                    carries what Traefik said.{" "}
                  </>
                ) : null}
                Basic auth is checked by Traefik, so it protects every domain
                this Application answers on and nothing reaching a published
                port. A password is never sent back to the browser — editing a
                user replaces it.
              </MetaStrip>
            }
          />

          <TraefikCard application={row} />
        </Tabs.Panel>

        <Tabs.Panel value="swarm" keepMounted className="grid gap-3">
          <SaveScope section="swarm" />
          <SwarmSection application={row} save={save} />
        </Tabs.Panel>

        {/* Its own sub-section, where the Compose stack and the database
            keep theirs last, rather than under all of the above. */}
        <Tabs.Panel value="danger" keepMounted className="grid gap-3">
          <DeleteApplicationCard application={row} />
        </Tabs.Panel>
      </Tabs>
    </Page>
  );
}
