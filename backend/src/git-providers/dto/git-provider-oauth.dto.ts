import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The routes that *produce* an OAuth grant. Two kinds of shape here: what
 * the console sends to *start* a handshake, and what a provider sends back on
 * the callback — the latter in the provider's own snake_case, because it is
 * their query string, not ours.
 */

// Starts the GitHub App manifest flow: `name` names the connection Cloudgate
// creates for the app that is about to exist.
export const startGithubManifestSchema = z.object({
  name: z.string().min(1, 'name cannot be empty'),
  /**
   * The app's name at github.com, which must be unique across all of GitHub.
   * Defaults to the connection's name.
   */
  appName: z.string().min(1).optional(),
  /**
   * Create the app under a GitHub organization rather than under the signed-in
   * user. It decides which github.com form the manifest is POSTed to.
   */
  organizationName: z.string().min(1).optional(),
});

export class StartGithubManifestDto extends createZodDto(
  startGithubManifestSchema,
) {}

// GitHub's redirect to `redirect_url` after the app is created from a manifest.
export const githubSetupQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

export class GithubSetupQueryDto extends createZodDto(githubSetupQuerySchema) {}

// GitHub's redirect to the manifest's `setup_url` after the app is installed:
// the installation id, what happened, and the `state` the install URL
// carried there and GitHub hands back untouched.
export const githubInstallQuerySchema = z.object({
  installation_id: z.string().min(1),
  state: z.string().min(1),
  /** `install` or `update`. Recorded by GitHub, not acted on here. */
  setup_action: z.string().optional(),
});

export class GithubInstallQueryDto extends createZodDto(
  githubInstallQuerySchema,
) {}

// GitLab's and Gitea's redirect after the user approves the OAuth application.
export const oauthCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

export class OauthCallbackQueryDto extends createZodDto(
  oauthCallbackQuerySchema,
) {}

/** What the console needs to send the browser to github.com. */
export interface GithubManifestStartDto {
  /** The connection row the app's credentials will land on. */
  githubId: string;
  gitProviderId: string;
  state: string;
  /** The github.com form to POST `manifest` to, as a `<form action>`. */
  action: string;
  /** The manifest document, to be sent as the form's `manifest` field. */
  manifest: Record<string, unknown>;
}

/** What the console needs to send the browser to GitLab or Gitea. */
export interface OauthAuthorizeStartDto {
  state: string;
  /** The provider's authorize page, with the state and redirect_uri on it. */
  url: string;
  /**
   * The callback URL this handshake will use. Worth returning: the OAuth
   * application at the provider has to have this exact value registered, and
   * until now nothing told anybody what it was.
   */
  redirectUri: string;
}
