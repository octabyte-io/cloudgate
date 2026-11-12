import { useState } from "react";

import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import {
  connectionId,
  gitProviderOauthApi,
  type GitConnection,
  type GitProviderKind,
  type OauthProviderKind,
} from "@/lib/api/endpoints/git-providers";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";

import { providerOf } from "./providers";

/** Which providers offer an authorize-me control on a saved connection. */
const AUTHORIZES: Record<GitProviderKind, boolean> = {
  github: false,
  gitlab: true,
  gitea: true,
  bitbucket: false,
};

export function authorizes(kind: GitProviderKind): kind is OauthProviderKind {
  return AUTHORIZES[kind];
}

/**
 * **Authorize a GitLab or Gitea OAuth application** and come back with a token
 * pair and an expiry.
 *
 * This is a row control rather than a card because it acts on one saved
 * connection: the application ID and secret have to be stored before there is
 * anything to authorize. For GitLab that makes this the step that decides whether
 * the connection works at all — `refreshToken` runs the refresh grant whenever
 * `expiresAt` is absent and throws when it fails, and only this records one.
 *
 * It navigates away, so there is no dialog to keep alive across a refetch.
 */
export function AuthorizeConnection({
  kind,
  connection,
}: {
  kind: OauthProviderKind;
  connection: GitConnection;
}) {
  const [pending, setPending] = useState(false);
  // `POST /git-providers/oauth/<kind>/:id/authorize` is
  // `gitProviders: ['create']`.
  const canAuthorize = usePermission({ gitProviders: ["create"] });
  const label = providerOf(kind).label;

  return (
    <Button
      type="button"
      size="sm"
      disabled={pending || !canAuthorize.allowed}
      title={canAuthorize.allowed ? undefined : AUTHORIZE_REFUSAL}
      aria-busy={pending || undefined}
      onClick={async () => {
        if (!canAuthorize.allowed) return;
        setPending(true);
        try {
          const started = await gitProviderOauthApi.authorize(
            kind,
            connectionId(kind, connection),
          );
          window.location.assign(started.url);
        } catch (error) {
          // Almost always one of two things: the application ID and secret are
          // not saved yet, or the callback URL is not registered at the
          // provider. Both are in the message.
          toast.error(error);
          setPending(false);
        }
      }}
    >
      {connection.expiresAt ? `Re-authorize at ${label}` : "Authorize"}
    </Button>
  );
}

const AUTHORIZE_REFUSAL = roleRefusal("authorize a git connection");
