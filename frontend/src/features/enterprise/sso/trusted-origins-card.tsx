import { useState } from "react";

import { Card } from "@/components/console/card";
import { EmptyState } from "@/components/console/empty-state";
import { Field } from "@/components/console/field";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/lib/design/icons";
import { useArrival } from "@/components/console/use-arrival";

import type { Stopped } from "../business-plan";
import { SectionFailed, SectionPending } from "../../settings/section-states";
import {
  useAddTrustedOrigin,
  useRemoveTrustedOrigin,
  useTrustedOrigins,
} from "./use-sso";

/**
 * The origins Cloudgate will talk to an identity provider on.
 *
 * **Two gates read this list, and for a while the card only knew about one.**
 * `assertIssuerTrusted` is Cloudgate's: it refuses an *update* that changes a
 * provider's issuer to a host that is not here. The other is inside the SSO
 * plugin, which refuses to fetch a discovery document from an untrusted origin —
 * so *registering* a provider consults it too, and on a fresh install, where the
 * list is empty, that is what stops the first provider from being added at all
 * The Add dialog
 * offers to make that entry itself, which is why an operator can go a long time
 * without opening this card; what it is for is seeing the list and taking a host
 * back off it.
 *
 * The list itself is stored on the **Organization owner's user row**
 * (`user.trustedOrigins`), so an admin edits the same list the owner does.
 * Adding one already present is a no-op and the comparison is
 * case-insensitive, both of which are the backend's own behaviour.
 *
 * `DELETE /sso/trusted-origins` is the only route in the app that names what to
 * delete in a **body** — a trusted origin is a string in a `jsonb` array with no
 * id to put in a path — which is why `api.deleteWithBody` exists.
 */
export function TrustedOriginsCard({
  stopped = null,
}: {
  stopped?: Stopped | null;
}) {
  const origins = useTrustedOrigins();
  const add = useAddTrustedOrigin();
  const remove = useRemoveTrustedOrigin();
  const [draft, setDraft] = useState("");

  const arrival = useArrival(origins.isPending);
  if (origins.isPending) {
    return <SectionPending title="Trusted origins" rows={2} />;
  }
  if (origins.error) {
    return (
      <SectionFailed title="Trusted origins" error={origins.error}>
        The list lives on the Organization owner&rsquo;s record, so an owner or
        admin can read it and nobody else can.
      </SectionFailed>
    );
  }

  const rows = origins.data ?? [];

  async function submit(event: React.SyntheticEvent) {
    event.preventDefault();
    const value = draft.trim();
    if (!value || add.isPending || stopped) return;
    try {
      await add.mutateAsync(value);
      toast.done(`${value} is trusted.`);
      setDraft("");
    } catch (error) {
      toast.error(error);
    }
  }

  return (
    <Card className={arrival}>
      <Card.Header
        title="Trusted origins"
        sub="Hosts Cloudgate may fetch a provider's configuration from, and origins a browser may sign in from."
        headingLevel={2}
      />
      <Card.Body className="grid gap-3.5">
        {rows.length === 0 ? (
          <EmptyState icon="globe" title="No trusted origins yet">
            Add an origin below, or add a provider and its issuer lands here for you.
            No identity provider can be reached until one is listed.
          </EmptyState>
        ) : (
          <ul className="grid gap-1.5">
            {rows.map((origin) => (
              <li
                key={origin}
                className="flex items-center gap-2 rounded-lg border border-line bg-panel-2 py-1.5 pr-1.5 pl-3"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-ui text-tx">
                  {origin}
                </span>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="qt"
                  aria-label={`Stop trusting ${origin}`}
                  disabled={remove.isPending}
                  onClick={async () => {
                    try {
                      await remove.mutateAsync(origin);
                      toast.done(`${origin} is no longer trusted.`);
                    } catch (error) {
                      toast.error(error);
                    }
                  }}
                >
                  <Icon name="x" size={14} />
                </Button>
              </li>
            ))}
          </ul>
        )}

        {/* The button is on its own row, and the field row starts its items at
            the same top rather than ending them at the same bottom.

            `items-end` on a row of two is right only while both items have the
            same internal stack, and this field carries a hint: it bottom-aligned
            *Trust it* against the sentence under the input, so the button sat a
            line below the control it submits at every width. The local-shell fix is the same
            rule with the same cause on the local-shell card, where the wrapped
            item was a second field rather than a button; these two were the only
            `items-end` wrap rows in the tree with a hint inside the row.

            The nested flex row is not a wrapper for its own sake: `flex-1` is
            inert in a grid, so dropping it would silently change what the field
            does with the width it is given. `manage-keys-modal.tsx` is the same
            shape. */}
        <form method="post" noValidate onSubmit={submit} className="grid gap-2">
          <div className="flex flex-wrap items-start gap-2">
            <Field
              name="origin"
              label="Add an origin"
              hint="An origin — scheme and host, e.g. https://login.example.com."
              className="min-w-56 flex-1"
            >
              <Input
                value={draft}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setDraft(event.target.value)}
              />
            </Field>
          </div>
          <Button
            type="submit"
            className="justify-self-start"
            disabled={stopped !== null || add.isPending || draft.trim() === ""}
            title={stopped?.reason}
            aria-busy={add.isPending || undefined}
          >
            Trust it
          </Button>
        </form>
      </Card.Body>
    </Card>
  );
}
