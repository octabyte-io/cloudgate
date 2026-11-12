"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { usersApi } from "@/lib/api/endpoints/users";
import { errorMessage } from "@/lib/api/error-message";
import { keys } from "@/lib/api/keys";
import { signIn, signOut, useSession } from "@/lib/auth/client";

import { Dump, Failure, Panel, Row } from "./panel";

/**
 * Proves the two halves of authentication against a live backend: better-auth
 * puts a session cookie in place, and the typed client rides it to a route Nest
 * guards.
 */
export function SessionPanel() {
  const { data: session, isPending } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const me = useQuery({
    queryKey: keys.me(),
    queryFn: () => usersApi.me(),
    enabled: Boolean(session),
  });

  async function handleSignIn(event: { preventDefault: () => void }) {
    event.preventDefault();
    setBusy(true);
    setSignInError(null);
    const { error } = await signIn.email({ email, password });
    if (error) setSignInError(error.message ?? "Those credentials were refused.");
    setBusy(false);
  }

  return (
    <Panel
      title="Session"
      blurb="Sign in through better-auth, then read a guarded route with the typed client. If GET /users/me answers, the cookie is reaching Nest."
    >
      {isPending ? <p className="text-body text-tx-2">Reading the session…</p> : null}

      {!isPending && !session ? (
        <form onSubmit={handleSignIn} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-ui text-tx-3">
            Email
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-ctl rounded-lg border border-line bg-ground px-2.5 text-body text-tx"
            />
          </label>
          <label className="flex flex-col gap-1 text-ui text-tx-3">
            Password
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-ctl rounded-lg border border-line bg-ground px-2.5 text-body text-tx"
            />
          </label>
          <Button type="submit" disabled={busy} className="self-start">
            {busy ? "Signing in…" : "Sign in"}
          </Button>
          {signInError ? <Failure message={signInError} /> : null}
        </form>
      ) : null}

      {session ? (
        <>
          <Row label="Signed in as">{session.user.email}</Row>
          <Row label="Active organization">
            {(session.session as { activeOrganizationId?: string | null })
              .activeOrganizationId ?? "none"}
          </Row>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void me.refetch()}>
              Refetch /users/me
            </Button>
            <Button variant="outline" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
          {me.error ? <Failure message={errorMessage(me.error)} /> : null}
          {me.data ? <Dump value={me.data} /> : null}
        </>
      ) : null}
    </Panel>
  );
}
