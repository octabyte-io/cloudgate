import { z, type ZodRawShape } from "zod";

import { example, type FieldSpec } from "@/components/console/form-spec";
import type {
  GitConnection,
  GitProviderKind,
} from "@/lib/api/endpoints/git-providers";
import type { IconName } from "@/lib/design/icons";

/**
 * **The four git providers, as data.**
 *
 * The same argument as `notifications/channels.ts`, on a smaller surface: four
 * controllers with the identical three reads and the identical two writes,
 * differing only in which credentials they ask for. One `ProviderForm`
 * parameterised by an entry here, not four forms.
 *
 * F09 already built the half a *source picker* needs — `REPOSITORY_ADAPTER` in
 * `endpoints/git-providers.ts` — and imports it rather than writing a second
 * one. This file is the other half: what it takes to *connect*.
 *
 * ---
 *
 * **What this table used to encode was the absence of an OAuth callback**
 * Cloudgate had
 * ported every *consumer* of a grant — `refreshGitlabToken`,
 * `refreshGiteaToken`, `getGithubToken` — and none of the routes that produce the
 * values they consume, so every connection was credentials created by hand at the
 * provider and pasted in.
 *
 * **OAuth connecting works now**: `/git-providers/oauth/…` holds the GitHub App manifest
 * conversion and a GitLab and a Gitea authorization-code callback, wired up in
 * `connect-github-app.tsx` and its two siblings. What survives is that **the fields are still per
 * provider, and so is how much of them you fill in by hand** — GitHub's whole set
 * arrives from the manifest conversion, while GitLab's and Gitea's client ID and
 * secret are yours to register and paste, with only the token pair arriving from
 * the handshake. So `requirement` below stays: it says what a connection needs
 * before it can reach anything, on the screen, before the save, rather than
 * leaving it to be discovered when a repository list comes back empty.
 */

export type ProviderValues = {
  name: string;
} & Record<string, unknown>;

export type ProviderDescriptor = {
  kind: GitProviderKind;
  label: string;
  icon: IconName;
  /** One line on the card. What connecting gets you. */
  blurb: string;
  /** How to get the credentials, in the provider's own words. */
  steps: readonly string[];
  fields: FieldSpec<ProviderValues>[];
  shape: ZodRawShape;
  secrets: string[];
  toDefaults: (connection: GitConnection | null) => Record<string, unknown>;
  toBody: (values: ProviderValues) => Record<string, unknown>;
  /** The identity line under a connection's name. Never a secret. */
  summary: (connection: GitConnection) => string;
  /**
   * **What this kind needs before it can actually reach the provider.**
   *
   * Said before the save, so a half-filled connection is a known state rather
   * than a surprise at first clone.
   *
   * This once was
   * also what the *listing* filtered on, so a connection missing these columns
   * saved and then vanished, taking the only copy of its strategy id with it.
   * All four `list()` methods are unfiltered now: an incomplete connection is
   * listed, can be opened, and can be completed by editing it. What is missing
   * costs you the clone, not the row.
   *
   * `null` for Bitbucket, which needs nothing beyond the credentials it asks for.
   */
  requirement: string | null;
};

const SECRET_HINT =
  "Stored encrypted and never shown again. Leave it empty when editing to keep the one already saved.";

/** `""` → left out. For a credential, where empty means "keep the stored one". */
function keep(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed === "" ? undefined : trimmed;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Each provider's own example: "Acme on GitHub" was on all four. */
const nameField = (provider: string): FieldSpec<ProviderValues> => ({
  name: "name",
  label: "Name",
  kind: "text",
  placeholder: example(`Acme on ${provider}`),
  hint: "What this connection is called in Cloudgate. Only you see it.",
});

export const PROVIDERS: ProviderDescriptor[] = [
  {
    kind: "github",
    label: "GitHub",
    icon: "branch",
    blurb:
      "A GitHub App installed on your account or organization. Cloudgate mints a short-lived token per clone.",
    steps: [
      "On GitHub, go to Settings → Developer settings → GitHub Apps and create one.",
      "Give it repository permissions for Contents (read) and Metadata (read), and Webhooks if you want push deploys.",
      "Generate a private key, and copy the App ID and the client ID off the app's page.",
      "Install the app on the account or organization whose repositories you want, then copy the installation ID out of the URL you land on.",
    ],
    fields: [
      nameField("GitHub"),
      {
        name: "appName",
        label: "App name",
        kind: "text",
        optional: true,
        hint: "The app's slug on GitHub. Only used to link back to it.",
      },
      {
        name: "appId",
        label: "App ID",
        kind: "number",
        min: 1,
        hint: "A number, on the app's own settings page.",
      },
      {
        name: "installationId",
        label: "Installation ID",
        kind: "text",
        mono: true,
        hint: "The number at the end of the URL after you install the app. Without it Cloudgate can authenticate as the app and reach no repositories.",
      },
      { name: "clientId", label: "Client ID", kind: "text", mono: true, optional: true },
      {
        name: "clientSecret",
        label: "Client secret",
        kind: "password",
        optional: true,
        hint: SECRET_HINT,
      },
      {
        name: "privateKey",
        label: "Private key",
        kind: "textarea",
        rows: 5,
        mono: true,
        placeholder: "-----BEGIN RSA PRIVATE KEY-----",
        hint: "The whole .pem file, including its header and footer lines. " + SECRET_HINT,
      },
      {
        name: "webhookSecret",
        label: "Webhook secret",
        kind: "password",
        optional: true,
        // `SECRET_HINT` belongs here since
        // The column is
        // `encryptedText` and `sanitize()` strips it, so this box behaves like the
        // other two credentials and the banner's "marked as stored encrypted"
        // promise now covers it.
        hint:
          "Only needed for push deploys. It is what makes an inbound webhook provable. " +
          SECRET_HINT,
      },
    ],
    shape: {
      appName: z.string(),
      // `""` from the defaults, `undefined` once typed in and emptied.
      appId: z.union([
        z.literal(""),
        z.undefined(),
        z.coerce.number().int().min(1),
      ]),
      installationId: z.string(),
      clientId: z.string(),
      clientSecret: z.string(),
      privateKey: z.string(),
      webhookSecret: z.string(),
    },
    secrets: ["clientSecret", "privateKey", "webhookSecret"],
    toDefaults: (connection) => ({
      appName: connection?.appName ?? "",
      appId: connection?.appId ?? "",
      installationId: connection?.installationId ?? "",
      clientId: connection?.clientId ?? "",
      clientSecret: "",
      privateKey: "",
      webhookSecret: "",
    }),
    toBody: (values) => ({
      appName: text(values.appName) || undefined,
      appId:
        values.appId === "" || values.appId === undefined
          ? undefined
          : Number(values.appId),
      installationId: text(values.installationId) || undefined,
      clientId: text(values.clientId) || undefined,
      clientSecret: keep(values.clientSecret),
      privateKey: keep(values.privateKey),
      webhookSecret: keep(values.webhookSecret),
    }),
    summary: (connection) =>
      connection.appName ? `App ${connection.appName}` : "GitHub App",
    // What `getGithubToken` needs before it can authenticate as the App. Now
    // there is a path that fills all three in for you — "Create the GitHub
    // App for me", above this list — and this form is the other one, for an App
    // you already have.
    requirement:
      "an App ID, a private key and an installation ID — save without them and the connection is listed, but it cannot clone until the app is installed",
  },

  {
    kind: "gitea",
    label: "Gitea",
    icon: "branch",
    blurb:
      "A Gitea or Forgejo instance, yours or someone else's, reached with an OAuth application's token.",
    steps: [
      "In Gitea, go to Settings → Applications and create an OAuth2 application.",
      "Copy its client ID and client secret in below, and save.",
      "Press Authorize on the connection — or, if you would rather not register an application, paste an access token from Settings → Applications → Access tokens instead.",
    ],
    fields: [
      nameField("Gitea"),
      {
        name: "giteaUrl",
        label: "Gitea URL",
        kind: "text",
        mono: true,
        placeholder: "https://gitea.example.com",
      },
      {
        name: "giteaInternalUrl",
        label: "Internal URL",
        kind: "text",
        mono: true,
        optional: true,
        hint: "Used instead of the public URL when Cloudgate can reach Gitea on a private address.",
      },
      { name: "clientId", label: "Client ID", kind: "text", mono: true },
      {
        name: "clientSecret",
        label: "Client secret",
        kind: "password",
        hint: SECRET_HINT,
      },
      {
        name: "redirectUri",
        label: "Callback URL",
        kind: "text",
        mono: true,
        optional: true,
        hint: "Where Gitea sends you back. Leave it empty and Cloudgate fills in its own the first time you authorize — then register that exact value in the Gitea application.",
      },
      {
        name: "accessToken",
        label: "Access token",
        kind: "password",
        optional: true,
        hint: "What Cloudgate actually clones and lists with. Authorizing fills it in; paste one instead if you would rather not register an application. " + SECRET_HINT,
      },
      {
        name: "refreshToken",
        label: "Refresh token",
        kind: "password",
        optional: true,
        hint: "Authorizing fills this in. Without one, a pasted access token is used until it expires and then stops working.",
      },
    ],
    shape: {
      giteaUrl: z.string().min(1, "A Gitea URL is needed."),
      giteaInternalUrl: z.string(),
      clientId: z.string(),
      clientSecret: z.string(),
      redirectUri: z.string(),
      accessToken: z.string(),
      refreshToken: z.string(),
    },
    secrets: ["clientSecret", "accessToken", "refreshToken"],
    toDefaults: (connection) => ({
      giteaUrl: connection?.giteaUrl ?? "",
      giteaInternalUrl: connection?.giteaInternalUrl ?? "",
      clientId: connection?.clientId ?? "",
      clientSecret: "",
      redirectUri: connection?.redirectUri ?? "",
      accessToken: "",
      refreshToken: "",
    }),
    toBody: (values) => ({
      giteaUrl: text(values.giteaUrl),
      giteaInternalUrl: text(values.giteaInternalUrl) || null,
      clientId: text(values.clientId) || undefined,
      clientSecret: keep(values.clientSecret),
      redirectUri: keep(values.redirectUri),
      accessToken: keep(values.accessToken),
      refreshToken: keep(values.refreshToken),
    }),
    summary: (connection) => connection.giteaUrl ?? "",
    // Gitea's OAuth pair is genuinely optional: `GiteaService.refreshToken`
    // returns the row untouched when any of the three OAuth values is missing,
    // so a connection carrying only an access token lists repositories
    // perfectly well. It used to be hidden from `GET /gitea` anyway, which is
    // now fixed — the listing no longer filters on these columns.
    requirement:
      "either one press of Authorize, or an access token pasted in — Gitea is the one provider that works both ways, because its refresh path returns the row untouched rather than throwing when the OAuth values are missing",
  },

  {
    kind: "gitlab",
    label: "GitLab",
    icon: "branch",
    blurb:
      "A GitLab instance reached with an OAuth application's token pair.",
    steps: [
      "In GitLab, go to Settings → Applications and create one with the api, read_user and read_repository scopes.",
      "Copy its application ID and secret in below, and save.",
      "Press Authorize on the connection. GitLab sends you back with the token pair and the expiry.",
    ],
    fields: [
      nameField("GitLab"),
      {
        name: "gitlabUrl",
        label: "GitLab URL",
        kind: "text",
        mono: true,
        placeholder: "https://gitlab.com",
      },
      {
        name: "gitlabInternalUrl",
        label: "Internal URL",
        kind: "text",
        mono: true,
        optional: true,
        hint: "Used instead of the public URL when Cloudgate can reach GitLab on a private address.",
      },
      { name: "applicationId", label: "Application ID", kind: "text", mono: true },
      {
        name: "secret",
        label: "Application secret",
        kind: "password",
        hint: SECRET_HINT,
      },
      {
        name: "redirectUri",
        label: "Callback URL",
        kind: "text",
        mono: true,
        optional: true,
        hint: "Where GitLab sends you back. Leave it empty and Cloudgate fills in its own the first time you authorize — then register that exact value in the GitLab application.",
      },
      {
        name: "accessToken",
        label: "Access token",
        kind: "password",
        optional: true,
        hint: "Authorizing fills this in. Paste one only if you already hold it. " + SECRET_HINT,
      },
      {
        name: "refreshToken",
        label: "Refresh token",
        kind: "password",
        optional: true,
        hint: "Authorizing fills this in too, along with the expiry that makes the pair usable. " + SECRET_HINT,
      },
      {
        name: "groupName",
        label: "Groups",
        kind: "text",
        optional: true,
        placeholder: "acme, acme/platform",
        hint: "Comma-separated. Leave it empty and Cloudgate offers your personal projects only, which is GitLab's own default here.",
      },
    ],
    shape: {
      gitlabUrl: z.string().min(1, "A GitLab URL is needed."),
      gitlabInternalUrl: z.string(),
      applicationId: z.string(),
      secret: z.string(),
      redirectUri: z.string(),
      accessToken: z.string(),
      refreshToken: z.string(),
      groupName: z.string(),
    },
    secrets: ["secret", "accessToken", "refreshToken"],
    toDefaults: (connection) => ({
      gitlabUrl: connection?.gitlabUrl ?? "https://gitlab.com",
      gitlabInternalUrl: connection?.gitlabInternalUrl ?? "",
      applicationId: connection?.applicationId ?? "",
      secret: "",
      redirectUri: connection?.redirectUri ?? "",
      accessToken: "",
      refreshToken: "",
      groupName: connection?.groupName ?? "",
    }),
    toBody: (values) => ({
      gitlabUrl: text(values.gitlabUrl),
      gitlabInternalUrl: text(values.gitlabInternalUrl) || null,
      applicationId: text(values.applicationId) || undefined,
      secret: keep(values.secret),
      redirectUri: keep(values.redirectUri),
      accessToken: keep(values.accessToken),
      refreshToken: keep(values.refreshToken),
      groupName: text(values.groupName) || undefined,
    }),
    summary: (connection) => connection.gitlabUrl ?? "",
    // **GitLab is the provider the OAuth routes actually unblocked.**
    // `refreshGitlabToken` runs the refresh grant *unconditionally* whenever
    // `expiresAt` is absent or past, and throws when it fails — so before there
    // was a callback to record an expiry, a GitLab connection assembled by hand
    // refused every call however valid its access token was. It was the one
    // provider of the four that could not be made to work at all.
    // Authorizing is now what supplies all three, which is why this asks for the
    // application rather than for tokens.
    requirement:
      "an application ID and secret, and then one press of Authorize — that trip records the token pair and the expiry, and without an expiry GitLab refuses every call",
  },

  {
    kind: "bitbucket",
    label: "Bitbucket",
    icon: "branch",
    blurb:
      "Bitbucket Cloud, reached with an Atlassian API token or a repository app password.",
    steps: [
      "For an API token: create one at id.atlassian.com and use it with your account email.",
      "For an app password: Personal settings → App passwords, with Repositories (read).",
      "Set the workspace if you want repositories other than your own.",
    ],
    fields: [
      nameField("Bitbucket"),
      {
        name: "bitbucketUsername",
        label: "Username",
        kind: "text",
        optional: true,
        hint: "Your Bitbucket username. Used with an app password.",
      },
      {
        name: "bitbucketEmail",
        label: "Atlassian account email",
        kind: "text",
        optional: true,
        hint: "Used with an API token. Bitbucket refuses a token without it.",
      },
      {
        name: "apiToken",
        label: "API token",
        kind: "password",
        optional: true,
        hint: SECRET_HINT,
      },
      {
        name: "appPassword",
        label: "App password",
        kind: "password",
        optional: true,
        hint: "The older style. Used only when there is no API token. " + SECRET_HINT,
      },
      {
        name: "bitbucketWorkspaceName",
        label: "Workspace",
        kind: "text",
        optional: true,
        placeholder: example("acme"),
        hint: "Leave it empty for your own repositories.",
      },
    ],
    shape: {
      bitbucketUsername: z.string(),
      bitbucketEmail: z.string(),
      apiToken: z.string(),
      appPassword: z.string(),
      bitbucketWorkspaceName: z.string(),
    },
    secrets: ["apiToken", "appPassword"],
    toDefaults: (connection) => ({
      bitbucketUsername: connection?.bitbucketUsername ?? "",
      bitbucketEmail: connection?.bitbucketEmail ?? "",
      apiToken: "",
      appPassword: "",
      bitbucketWorkspaceName: connection?.bitbucketWorkspaceName ?? "",
    }),
    toBody: (values) => ({
      bitbucketUsername: text(values.bitbucketUsername) || undefined,
      bitbucketEmail: text(values.bitbucketEmail) || undefined,
      apiToken: keep(values.apiToken),
      appPassword: keep(values.appPassword),
      bitbucketWorkspaceName: text(values.bitbucketWorkspaceName) || undefined,
    }),
    summary: (connection) =>
      connection.bitbucketWorkspaceName
        ? `Workspace ${connection.bitbucketWorkspaceName}`
        : (connection.bitbucketUsername ?? ""),
    // **The one that never filtered its `list()`**, so a Bitbucket connection
    // always came back however incomplete it was, and now the other three
    // behave the same way. Its own trap is at use rather than at listing:
    // `bitbucketAuthHeaders` throws when an API token has no account email
    // beside it.
    requirement: null,
  },
];

export function providerOf(kind: GitProviderKind): ProviderDescriptor {
  const found = PROVIDERS.find((provider) => provider.kind === kind);
  if (!found) throw new Error(`Unknown git provider: ${kind}`);
  return found;
}
