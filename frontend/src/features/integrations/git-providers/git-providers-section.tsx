"use client";

import { Suspense } from "react";

import { Banner, BannerRow } from "@/components/console/banner";
import { ResourceList } from "@/components/console/resource-list";
import type { GitProviderKind } from "@/lib/api/endpoints/git-providers";
import { useInvalidate } from "@/lib/api/use-invalidate";

import { useGitConnections, useGitProviders } from "../use-integrations";
import { ConnectGithubApp } from "./connect-github-app";
import { ConnectedNotice } from "./connected-notice";
import { PROVIDERS } from "./providers";
import { providerSpec } from "./provider-spec";
import { RepositoryCheck } from "./repository-check";
import { UnlistedConnections } from "./unlisted-connections";

/**
 * Four lists, one per provider, each the same `ResourceList` over a descriptor —
 * plus the two things driving this screen turned up.
 *
 * The banner is the first, and what it says has changed.
 * It used to explain
 * why there was no "Connect with GitHub" button: this backend had every consumer
 * of an OAuth grant and none of the routes that produce one. Those routes exist
 * now, so the banner's job is the opposite — saying which of the four providers
 * can send you to itself, and what each still wants from you first, because the
 * answer is different for all four.
 *
 * The second is `UnlistedConnections`. It was built
 * when an incomplete
 * connection really did vanish from its provider's listing; that is fixed, and
 * the section now reports the narrower state its own doc block describes — a base
 * row no listing returns, meaning the connection's two halves disagree.
 */
export function GitProvidersSection() {
  const providers = useGitProviders();
  const connections = {
    github: useGitConnections("github"),
    gitlab: useGitConnections("gitlab"),
    gitea: useGitConnections("gitea"),
    bitbucket: useGitConnections("bitbucket"),
  };

  // A base row whose strategy row is in no per-kind list. Computed only once
  // every list has landed, or a slow request would be reported as a lost row —
  // F07's confident-zero, in the most alarming possible wording.
  const settled = Object.values(connections).every(
    (query) => query.data !== undefined,
  );
  const listed = new Set(
    Object.values(connections).flatMap((query) =>
      (query.data ?? []).map((connection) => connection.gitProviderId),
    ),
  );
  const unlisted =
    settled && providers.data
      ? providers.data.filter((row) => !listed.has(row.gitProviderId))
      : [];

  return (
    <>
      <Suspense fallback={null}>
        <ConnectedNotice />
      </Suspense>

      <Banner
        title="How much of connecting is done for you differs by provider"
        icon="info"
      >
        {/* One sentence a row (rule 8). What is behind each: GitHub's manifest
            flow sends back the app ID, private key, client secret and webhook
            secret, so none is ever on screen; GitLab refuses every call without
            the token expiry the Authorize trip records; Bitbucket has no
            redirect to make; a connection saved without every credential is
            listed and opens, and only the clone fails until it is finished. */}
        <BannerRow
          tone="ok"
          title="GitHub needs nothing from you at github.com first."
          description={
            <>
              {/* `{" "}` after the `<em>`: the space in the source does not
                  survive the JSX text node. */}
              Use <em>Create the GitHub App for me</em>{" "}
              below, or paste an existing App&rsquo;s credentials.
            </>
          }
        />
        <BannerRow
          tone="info"
          title="GitLab and Gitea want an OAuth application registered first."
          description={
            <>
              Save its client ID and secret here, then press{" "}
              <em>Authorize</em>{" "}
              on the connection and register the callback URL it fills in at
              the provider.
            </>
          }
        />
        <BannerRow
          tone="mute"
          title="Bitbucket takes a token, with no redirect."
          description="Create an Atlassian API token or a repository app password and paste it in."
        />
        <BannerRow
          tone="info"
          title="A connection can be saved before it is finished."
          description="Each form says what its provider is still waiting for; edit the connection to finish it."
        />
        <BannerRow
          tone="info"
          title="Cloudgate never shows a credential again."
          description="Leave a stored field empty to keep what is saved; typing in it replaces it."
        />
      </Banner>

      <UnlistedConnections unlisted={unlisted} />

      {PROVIDERS.map((provider) => (
        <ProviderList
          key={provider.kind}
          kind={provider.kind}
          query={connections[provider.kind]}
        />
      ))}
    </>
  );
}

function ProviderList({
  kind,
  query,
}: {
  kind: GitProviderKind;
  query: ReturnType<typeof useGitConnections>;
}) {
  const invalidate = useInvalidate();

  return (
    <div className="grid gap-3">
      {/* Above the list rather than inside its add dialog: the one-press path
          does not fill a form in, it leaves the page. Only GitHub has it —
          GitLab and Gitea authorize a connection that already exists, which is
          a row control, and Bitbucket has no handshake at all. */}
      {kind === "github" ? (
        <ConnectGithubApp onDone={invalidate.gitProviders} />
      ) : null}
      <ResourceList
        spec={providerSpec(kind, invalidate.gitProviders)}
        query={query}
      />
      <RepositoryCheck kind={kind} connections={query.data ?? []} />
    </div>
  );
}
