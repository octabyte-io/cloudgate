import { useState } from "react";

import { Card } from "@/components/console/card";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { Skeleton } from "@/components/console/skeleton";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/api/api-error";
import { errorMessage } from "@/lib/api/error-message";
import type { UserSession } from "@/lib/api/endpoints/users";
import { useSession } from "@/lib/auth/client";
import { useSignOut } from "@/lib/auth/use-sign-out";
import { useArrival } from "@/components/console/use-arrival";

import { sessionColumns } from "./session-columns";
import { useRevokeSession, useSessions } from "./use-account";

/**
 * Every session this account holds, and the way to end one.
 *
 * **Which row is you is not in the data, and that is the interesting part.**
 * `listSessions` answers with an id, the device, the address and two timestamps
 * for every session, and **no credential** — the
 * token stays server-side, so this page could not recognise itself by token
 * even if it wanted to. The one identifying *this* browser lives in an httpOnly
 * cookie the page cannot read, and better-auth marks nothing. So the current
 * row is found by asking the auth client for the session it already holds —
 * `useSession()` carries the row's `id` — and matching on that. Getting it
 * wrong is not cosmetic: the whole point of the screen is "sign out the one I
 * do not recognise", and a list where you cannot tell which one is the laptop
 * you are typing on is a list nobody dares use.
 *
 * **The current session has no Revoke.** Revoking it would work, and would then
 * leave this tab holding a dead cookie, showing a table it can no longer
 * refetch, until the next request bounced it to `/sign-in` — a sign-out with
 * extra steps and no word for what happened. It gets the real sign-out instead,
 * through F06's `useSignOut`, which also empties the query cache.
 *
 * `userAgent` is rendered as it arrives rather than parsed into "Chrome on
 * macOS". Parsing user agents is guesswork that is confidently wrong often
 * enough to matter, and this is a screen where somebody is deciding whether they
 * recognise a device — the raw string is at least *their* string.
 *
 * ## The stale-session state, which used to be most of the time
 *
 * **`GET /users/me/sessions` used to refuse any session older than a day**, and
 * that was the state this screen was usually in: better-auth's `listSessions`
 * rides `freshSessionMiddleware`, and with no `freshAge` configured the default 24
 * hours applied. It came back a **403** carrying "Session is not fresh", and F02's
 * status rules read a 403 as a *permission* problem — "your role in this
 * organization does not allow this", which is exactly wrong for the one screen
 * that is unambiguously your own.
 *
 * **`auth.config.ts` sets `freshAge: 0` now**
 * which skips the
 * check outright — better-auth guards the whole branch on `!== 0` — and the gate
 * was protecting nothing that Revoke does not already expose. So the state below
 * is a residual guard rather than the normal case. It stays because the refusal is
 * one config value away from coming back, and what it buys when it does is the
 * difference between a dead end and a two-word instruction: signing out and in
 * makes the list readable, and nothing else does.
 *
 * **Revoke keeps working through all of it**, because `revokeSession` rides
 * `sensitiveSessionMiddleware` instead. The console can end a session it cannot
 * name, which is a strange enough sentence that the state says it out loud.
 */
export function SessionsCard() {
  const sessions = useSessions();
  const arrival = useArrival(sessions.isPending);
  const revoke = useRevokeSession();
  const { data: current } = useSession();
  const { signOutNow, pending: signingOut } = useSignOut();
  const [busySessionId, setBusySessionId] = useState<string | null>(null);

  const currentId = current?.session?.id;
  const rows = sessions.data ?? [];

  return (
    <Card>
      <Card.Header
        title="Sessions"
        sub="Everywhere this account is signed in."
        headingLevel={2}
      />
      {sessions.isPending ? (
        <Card.Body>
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-row" />
            <Skeleton className="h-row" />
          </div>
        </Card.Body>
      ) : isStaleSession(sessions.error) ? (
        <Card.Body>
          <div className="rounded-lg border border-info-line bg-info-tint px-3.5 py-3">
            <p className="text-body font-medium text-tx">
              This list needs a session less than a day old
            </p>
            <p className="mt-1 text-body text-tx-2">
              Cloudgate refuses to enumerate your sessions from an old one, so
              signing out and in again is what makes this readable. Ending a
              session does not need that — if you are here because you think
              somebody else is signed in, change your password with{" "}
              <em>Sign out every other session</em>{" "}
              on, above.
            </p>
            <div className="mt-2.5">
              <Button
                type="button"
                variant="pri"
                size="sm"
                disabled={signingOut}
                aria-busy={signingOut || undefined}
                onClick={signOutNow}
              >
                Sign out
              </Button>
            </div>
          </div>
        </Card.Body>
      ) : sessions.error ? (
        <Card.Body>
          <p className="text-body text-tx-2">{errorMessage(sessions.error)}</p>
        </Card.Body>
      ) : (
        <Card.Body flush className={arrival}>
          <DataTable<UserSession>
            label="Your sessions"
            rows={rows}
            getRowId={(row) => row.id}
            empty={
              <EmptyState icon="lock" title="No sessions">
                Not even this one, which should not be possible. Reloading the
                page is the thing to try.
              </EmptyState>
            }
            columns={sessionColumns({
              currentId,
              busySessionId,
              signingOut,
              onSignOut: signOutNow,
              onRevoke: async (sessionId) => {
                setBusySessionId(sessionId);
                try {
                  await revoke.mutateAsync(sessionId);
                  toast.done("That session is signed out.");
                } catch (error) {
                  toast.error(error);
                } finally {
                  setBusySessionId(null);
                }
              },
            })}
          />
        </Card.Body>
      )}
    </Card>
  );
}

/**
 * Is this the freshness refusal rather than a real permission problem?
 *
 * **A lookup on the code, and it was a regex over the message until H-36.** The
 * comment that stood here called itself "the last string match left in the app"
 * and named the reason it had to be one: better-auth throws
 * `APIError.from("FORBIDDEN", BASE_ERROR_CODES.SESSION_NOT_FRESH)`, and
 * `callAuthApi` — the wrapper every Cloudgate route around `auth.api.*` goes
 * through, `GET /users/me/sessions` included — rebuilt it as `new
 * HttpException(message, status)` and dropped the code on the floor. A 403 and
 * an English sentence really was all that arrived. It carries the code now, so
 * the match is gone and the claim is true of nothing.
 *
 * The sweep behind that claim found no second one, which is the other half of
 * why this is worth the note: the app that was meant to have no string
 * matches is now that app, and the way to keep it that way is to make the
 * backend name a refusal rather than to recognise its wording here.
 *
 * `isApiError` rather than a bare `error.code` read, because `sessions.error` is
 * `unknown` — a network `TypeError` reaches this too, and it has no `code`.
 */
function isStaleSession(error: unknown): boolean {
  return isApiError(error) && error.code === "SESSION_NOT_FRESH";
}
