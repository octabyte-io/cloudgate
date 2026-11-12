import { useMutation, useQuery } from "@tanstack/react-query";

import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { usersApi, type CreateApiKeyInput, type UpdateProfileInput } from "@/lib/api/endpoints/users";

/**
 * The signed-in person's own record — profile, sessions, personal keys, 2FA.
 *
 * **All of it under `keys.account`**, which is the root that survives an
 * Organization switch: none of these change when the tenant does, and scoping
 * them per-Organization would refetch the same rows under a new key. `keys.ts`
 * says this; this file is the one place it matters most, because a person with
 * three Organizations has one password.
 *
 * **`users.controller.ts` and not the auth client**, for everything here except
 * the password. Nest wraps these four better-auth calls so it can forward the
 * rotated `Set-Cookie` — `verifyTOTP` deletes the old session and issues a new
 * one, and a client-side call would leave the browser holding a cookie the
 * server has already dropped. Changing a password is the exception and goes
 * straight to `authClient.changePassword`: `users.controller.ts` has no route
 * for it, better-auth's own endpoint is not on `disabledPaths`, and F02's proxy
 * keeps `/api/auth/*` first-party.
 */

export function useProfile() {
  return useQuery({
    queryKey: keys.me(),
    queryFn: usersApi.me,
  });
}

export function useUpdateProfile() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: UpdateProfileInput) => usersApi.updateMe(input),
    onSettled: () => invalidate.session(),
  });
}

/**
 * Every session this account currently holds.
 *
 * `listSessions` returns rows for **every device**, and the one making the
 * request is not marked in any way — the rows carry no credential at all,
 * and the current
 * session's token lives in an httpOnly cookie the page cannot read.
 * `sessions-card.tsx` explains how the current one is identified instead, and
 * why the answer had to come from somewhere else.
 */
export function useSessions() {
  return useQuery({
    queryKey: keys.mySessions(),
    queryFn: usersApi.listSessions,
  });
}

/** Takes a session **id** — the token is server-side now (ADR-0009). */
export function useRevokeSession() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (sessionId: string) => usersApi.revokeSession(sessionId),
    onSettled: () => invalidate.session(),
  });
}

/**
 * The personal keys this account has minted.
 *
 * The listing carries `start` — the first characters — and never the key.
 * That is better-auth's design and it is the right one: the secret exists in
 * exactly one response ever, and `api-keys-card.tsx` is built around that fact
 * rather than around a reveal control that could not work.
 */
export function useApiKeys() {
  return useQuery({
    queryKey: keys.myApiKeys(),
    queryFn: usersApi.listApiKeys,
  });
}

export function useCreateApiKey() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateApiKeyInput) => usersApi.createApiKey(input),
    onSettled: () => invalidate.account(),
  });
}

export function useDeleteApiKey() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => usersApi.deleteApiKey(id),
    onSettled: () => invalidate.account(),
  });
}
