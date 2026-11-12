import { useState } from "react";

import { Card } from "@/components/console/card";
import { LinkButton } from "@/components/console/link-button";
import { Skeleton } from "@/components/console/skeleton";
import { errorMessage } from "@/lib/api/error-message";
import { cn } from "@/lib/utils";

import { homeListClass } from "./home-row";

/**
 * One of the home page's four cards (e-console.html:2820-2830).
 *
 * The shape is the same for all four — a title, a count, a way to the full list,
 * and a short list of rows — so it is one component and the four differ only in
 * what they put in it.
 *
 * It owns the three states a list has besides "here they are", because getting
 * those wrong is how a home page lies:
 *
 * - **Pending** is skeleton rows, not an empty list. "No Servers yet" while the
 *   request is in flight is the most alarming thing this page could say.
 * - **Refused** is `errorMessage(error)`, never `error.message`, and it does not
 *   swallow the card: the other two lists may be fine.
 * - **Empty** is one sentence and the control that creates the first one, where
 *   there is one. It used to be the sentence alone, because the flow that
 *   creates a Server did not exist until F13 — and nobody came back once it did,
 *   so a new instance's first screen said what a Server and a Project were and
 *   offered no way to make either; the only pointer was a 24px "All", which
 *   reads as "see all" rather than "start here". Recents has no action: nothing
 *   creates a visit but visiting. Nor has Starred: a star is made on the
 *   resource's own header.
 */
export function ListCard({
  title,
  count,
  all,
  pending,
  error,
  empty,
  emptyAction,
  children,
}: {
  title: string;
  /** The quiet second line — "2 total · 2 active". Absent while pending. */
  count?: string;
  /** Where the whole list lives. Absent for a list that has no "all" — Recents
   *  is this browser's five, not the first five of anything, and Starred is
   *  already the whole of this browser's stars. */
  all?: { href: string; label: string };
  pending: boolean;
  error: unknown;
  /** One sentence for when there is genuinely nothing. */
  empty: string;
  /** What makes the first one, under that sentence. Only shown when empty. */
  emptyAction?: React.ReactNode;
  children?: React.ReactNode;
}) {
  // Only a list that was waited for arrives with motion. Recents and Starred
  // are this browser's own and are never pending, so they just appear.
  const [waited] = useState(pending);

  return (
    <Card>
      <Card.Header
        title={title}
        sub={pending ? undefined : count}
        headingLevel={2}
        actions={
          all ? (
            <LinkButton href={all.href} size="xs" aria-label={all.label}>
              All
            </LinkButton>
          ) : undefined
        }
      />
      <Card.Body>
        {error ? (
          <p className="text-body text-tx-2">{errorMessage(error)}</p>
        ) : pending ? (
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
          </div>
        ) : children ? (
          // Mounts once, when the skeleton gives way: the list arrives as one block.
          <div className={cn(homeListClass, waited && "animate-rise")}>{children}</div>
        ) : (
          <div className={cn("grid justify-items-start gap-3", waited && "animate-fade")}>
            <p className="text-body text-tx-2">{empty}</p>
            {emptyAction}
          </div>
        )}
      </Card.Body>
    </Card>
  );
}
