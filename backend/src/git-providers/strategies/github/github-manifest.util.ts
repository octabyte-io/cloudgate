import { OAUTH_CALLBACK_PATH } from '../../oauth-callback.util';

/**
 * The GitHub App **manifest conversion** flow: instead of creating an app
 * by hand at github.com and pasting seven values back in, the browser POSTs a
 * *manifest* — a JSON description of the app we want — to github.com, and
 * GitHub hands back a one-time `code` that
 * `POST /app-manifests/{code}/conversions` turns into an app id, a private key,
 * a client secret and a webhook secret.
 *
 * The manifest is therefore the whole of the app's future capability: every URL
 * in it has to be a route this backend really serves *on an origin the install
 * publishes* — the console's, through its `/backend` rewrite (see
 * `oauth-callback.util.ts`) — and every permission has to be one some shipped
 * call needs.
 *
 * https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 */
export interface GithubAppManifest {
  name: string;
  /** The app's homepage on github.com — this instance's console. */
  url: string;
  /** Where GitHub sends the conversion code. */
  redirect_url: string;
  /**
   * Where GitHub sends the browser once the app is installed, with
   * `installation_id`, `setup_action` and the `state` the install URL carried.
   * Absent, the installation ends on github.com and the connection's
   * installation id is never stored.
   */
  setup_url: string;
  /** Whether a later change to the installation also returns here. */
  setup_on_update: boolean;
  /**
   * User-authorization callbacks. Cloudgate does not ask GitHub to identify
   * the user (`request_oauth_on_install` is unset), so the install return is
   * `setup_url`; this still names the same answering route.
   */
  callback_urls: string[];
  hook_attributes: { url: string };
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
}

export interface GithubAppManifestParams {
  /** The app's name at github.com. Must be unique across all of GitHub. */
  name: string;
  /**
   * What every URL here hangs off: the console's origin plus the prefix it
   * proxies to this backend — `providerFacingBaseOf`.
   */
  base: string;
  /** The console screen the handshake returns to; also the app's homepage. */
  consoleUrl: string;
}

const trimSlash = (value: string) => value.replace(/\/+$/, '');

export function buildGithubAppManifest({
  name,
  base: untrimmed,
  consoleUrl,
}: GithubAppManifestParams): GithubAppManifest {
  const base = trimSlash(untrimmed);
  const installCallback = `${base}/${OAUTH_CALLBACK_PATH}/github/callback`;
  return {
    name,
    url: consoleUrl,
    redirect_url: `${base}/${OAUTH_CALLBACK_PATH}/github/setup`,
    setup_url: installCallback,
    // An update keeps the installation id, so there is nothing to record, and
    // GitHub carries no state on that return for the callback to accept.
    setup_on_update: false,
    callback_urls: [installCallback],
    // GithubController's own webhook route — the one that verifies
    // x-hub-signature-256 against the connection's webhook secret.
    hook_attributes: { url: `${base}/github/webhook` },
    // Installed on the account that created it and nowhere else.
    public: false,
    default_permissions: {
      // SourceCloneService clones with an installation token.
      contents: 'read',
      metadata: 'read',
      // GithubService.postPrComment comments on a preview deployment's PR.
      pull_requests: 'write',
    },
    // The two events GithubController.webhook handles beyond ping.
    default_events: ['pull_request', 'push'],
  };
}

/**
 * The github.com form the manifest is POSTed to. A GitHub App belongs either to
 * a user or to an organization, and which one is decided by the URL rather than
 * by anything in the manifest.
 */
export function githubAppCreationUrl({
  state,
  organizationName,
}: {
  state: string;
  organizationName?: string | null;
}): string {
  const query = new URLSearchParams({ state }).toString();
  if (organizationName) {
    return `https://github.com/organizations/${encodeURIComponent(
      organizationName,
    )}/settings/apps/new?${query}`;
  }
  return `https://github.com/settings/apps/new?${query}`;
}

/**
 * The second leg: conversion produces an app, and an app reaches no repository
 * until it is *installed* somewhere. The setup callback redirects here straight
 * after conversion, and the fresh state is what proves the installation
 * callback belongs to the connection this backend just wrote.
 */
export function githubAppInstallUrl({
  slug,
  state,
}: {
  slug: string;
  state: string;
}): string {
  const query = new URLSearchParams({ state }).toString();
  return `https://github.com/apps/${encodeURIComponent(
    slug,
  )}/installations/new?${query}`;
}
