"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { CopyButton } from "@/components/console/copy-button";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import { composeApi } from "@/lib/api/endpoints/compose";
import type { TemplateSignIn } from "@/lib/api/endpoints/templates";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { Icon } from "@/lib/design/icons";
import { parseEnvBlob } from "@/lib/format/env-blob";
import { cn } from "@/lib/utils";

const MASK = "••••••••";

/**
 * How to sign in to the app just launched (#131), under its Open button, as
 * its template says (`signIn`). Cloudgate cannot tell an account's password
 * from a database's, so with no `signIn` there is no block at all.
 *
 * - An account made at setup: its username and password, read from the
 *   stack's own variables, the Variables tab's read and so no new exposure.
 *   A member that read refuses sees no block, so no password and no Show.
 *   The password stays masked until Show; Copy copies it either way. Shown,
 *   it is whole: the rows widen to the card and a long one wraps. With
 *   no username in the template (an app that asks only a password or a
 *   token, #140), no Username row. With a `path` or a `domain`, an Open link
 *   to that path (`/` without one), shown whether or not the read succeeds:
 *   where to sign in is no secret.
 * - An account made on the first visit: where to go to make it.
 *
 * `address` is the Domain the sign-in is on: the one `signIn.domain` names,
 * or else the first. The caller picks it, with `appAddress`.
 */
export function SignInBlock({
  appName,
  signIn,
  address,
  composeId,
}: {
  appName: string;
  signIn: TemplateSignIn;
  /** The sign-in's Domain's address, for its path's Open; null with none. */
  address: string | null;
  /** The template's stack, whose variables hold the account. */
  composeId: string | null;
}) {
  if ("firstVisit" in signIn) {
    const { path, note } = signIn.firstVisit;
    return (
      <Section>
        <p className="text-body wrap-anywhere text-tx-2">
          {appName} makes its first account on the first visit: open it at{" "}
          <span className="font-mono text-tx">{path}</span> and create yours.
          {note ? ` ${note}` : null}
        </p>
        <OpenPath address={address} path={path} />
      </Section>
    );
  }
  const path = signIn.path ?? (signIn.domain ? "/" : null);
  const open =
    path && address ? <OpenPath address={address} path={path} /> : null;
  return composeId ? (
    <MadeAtSetup
      appName={appName}
      signIn={signIn}
      open={open}
      composeId={composeId}
    />
  ) : open ? (
    <Section>{open}</Section>
  ) : null;
}

function MadeAtSetup({
  appName,
  signIn,
  open,
  composeId,
}: {
  appName: string;
  signIn: Extract<TemplateSignIn, { password: string }>;
  /** The Open link to the sign-in, outside what the read gates; null with none. */
  open: ReactNode;
  composeId: string;
}) {
  const { organizationId } = useActiveOrganizationId();
  // The stack's own read, the one its Variables tab makes: once, unpolled.
  const stack = useQuery({
    queryKey: keys.compose.detail(organizationId, composeId),
    queryFn: () => composeApi.findOne(composeId),
    enabled: organizationId !== null,
  });
  const [shown, setShown] = useState(false);

  if (stack.isPending) {
    return (
      <Section>
        <Skeleton className="h-12 w-full max-w-80" />
        {open}
      </Section>
    );
  }
  const onlyOpen = open ? <Section>{open}</Section> : null;
  if (stack.error) return onlyOpen;

  const variables = parseEnvBlob(stack.data.env);
  const valueOf = (name: string) =>
    variables.find((variable) => variable.key === name)?.value ?? null;
  const username =
    signIn.username === undefined
      ? null
      : typeof signIn.username === "string"
        ? valueOf(signIn.username)
        : signIn.username.value;
  const password = valueOf(signIn.password);
  if (username === null && password === null) return onlyOpen;

  return (
    <Section>
      <p className="text-meta text-tx-3">
        {`The account ${appName} was set up with.`}
      </p>
      {/*
        A shown password is read and copied whole: the list takes the card's
        width and the value breaks onto more lines rather than ending in "…".
      */}
      <KVList className={cn("w-full", !shown && "max-w-96")}>
        {username !== null ? (
          <KVRow
            label="Username"
            value={username}
            mono
            title={username}
            action={
              <CopyButton value={username} label="username" size="icon-xs" />
            }
          />
        ) : null}
        {password !== null ? (
          <KVRow
            label="Password"
            mono
            wrap={shown}
            title={shown ? password : undefined}
            value={
              shown ? (
                // Its lines start together, the block still against the right.
                <span className="inline-block text-left">{password}</span>
              ) : (
                <>
                  <span
                    aria-hidden="true"
                    className="tracking-widest text-tx-3"
                  >
                    {MASK}
                  </span>
                  <span className="sr-only">
                    Hidden. Choose Show to read it.
                  </span>
                </>
              )
            }
            action={
              <span className="flex items-center gap-1">
                <Button
                  size="xs"
                  onClick={() => setShown((on) => !on)}
                  aria-pressed={shown}
                >
                  <Icon name={shown ? "eyeOff" : "eye"} size={14} />
                  {shown ? "Hide" : "Show"}
                </Button>
                <CopyButton value={password} label="password" size="icon-xs" />
              </span>
            }
          />
        ) : null}
      </KVList>
      {open}
    </Section>
  );
}

/** Open, at a sign-in's path below its Domain's address; none without one. */
function OpenPath({ address, path }: { address: string | null; path: string }) {
  if (!address) return null;
  return (
    <a
      href={`${address.replace(/\/+$/, "")}${path}`}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 text-body text-brand-tx underline underline-offset-2"
    >
      Open {path}
      <Icon name="ext" size={13} className="flex-none" />
    </a>
  );
}

function Section({ children }: { children: ReactNode }) {
  return (
    <section
      aria-labelledby="sign-in-heading"
      className="grid w-full justify-items-start gap-2 border-t border-line pt-4"
    >
      <h2 id="sign-in-heading" className="text-body font-medium text-tx">
        How to sign in
      </h2>
      {children}
    </section>
  );
}
