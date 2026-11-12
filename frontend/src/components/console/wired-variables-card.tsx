import { useState } from "react";

import { Card } from "@/components/console/card";
import { ConfigLockNote, lockRefusal } from "@/components/console/config-lock";
import type { ConfigLock } from "@/components/console/config-lock";
import { MetaStrip } from "@/components/console/meta-strip";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type {
  LinkingType,
  WiredVariable,
} from "@/lib/api/endpoints/wired-variables";
import type { Gate } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";

import { LinkForm } from "./wired-link-form";
import {
  useSaveWiredVariables,
  useWiredVariables,
} from "@/lib/api/use-wired-variables";

/**
 * A Service's **wired variables** (ADR-0031): each one a row reading
 * `DATABASE_URL ← pg-1.url`, with no value — it is filled in from the source's
 * Output at each deploy and never stored, shown or fetchable — and so nothing
 * to type into.
 *
 * Where the Project's config is kept decides what the card offers:
 *
 * - **Cloudgate-kept**, for a Service the config describes: "Link a variable"
 *   picks a source and Output, and Unlink takes one away. Each is a console
 *   Save — the config's `env` entry and the Service's links are written
 *   together as an applied plan, so the next plan has nothing to change.
 * - **Repository-kept**: the rows are read-only and the card names the file,
 *   the one place a link is set, so the console keeps no second record.
 * - **None**, or a Service the config lists as console-managed: no links, and
 *   the card is not shown.
 */
export function WiredVariablesCard({
  serviceType,
  serviceId,
  environmentId,
  typedNames,
  lock,
  gate,
}: {
  serviceType: LinkingType;
  serviceId: string;
  environmentId?: string;
  /** The names the Service's own variables give a typed value. */
  typedNames: readonly string[];
  /** A repository-kept config's lock on this Service, or `null`. */
  lock: ConfigLock | null;
  /** Whether this caller may save the Service's variables, and why not. */
  gate: Gate;
}) {
  const wired = useWiredVariables(serviceType, serviceId);
  const save = useSaveWiredVariables(serviceType, serviceId, environmentId);
  const [linking, setLinking] = useState(false);

  const view = wired.data;
  if (!view) return null;
  const { links } = view;
  const fromFile = view.keptIn === "repository";
  if (links.length === 0 && !view.editable && !(fromFile && lock)) return null;

  const editable = view.editable && !fromFile;
  const refusal = !gate.allowed
    ? gate.refusal
    : view.sources.length === 0
      ? "No Service in this Environment hands out an Output this one can reach."
      : undefined;
  const canLink = editable && gate.allowed && view.sources.length > 0;

  const unlink = async (name: string) => {
    try {
      await save.mutateAsync(links.filter((link) => link.name !== name));
      toast.done(`${name} is no longer linked.`, {
        description:
          "The Project config no longer lists it. Deploy for the running container to lose it.",
      });
    } catch (failure) {
      toast.error(failure);
    }
  };

  return (
    <Card>
      <Card.Header
        title="Wired variables"
        sub="Filled in from another Service's Output at each deploy."
        headingLevel={2}
        actions={
          editable && !linking ? (
            <Button
              size="xs"
              variant="pri"
              disabled={!canLink}
              title={refusal}
              onClick={() => canLink && setLinking(true)}
            >
              <Icon name="plus" size={14} />
              Link a variable
            </Button>
          ) : null
        }
      />
      <MetaStrip>
        {fromFile && lock ? (
          <ConfigLockNote lock={lock} what="These links are" />
        ) : (
          <>
            A link has no value here: the deploy builds it from the source and
            hands it to the container, and nothing stores or shows it.
          </>
        )}
      </MetaStrip>
      <Card.Body>
        {linking ? (
          <LinkForm
            sources={view.sources}
            typedNames={typedNames}
            linkedNames={links.map((link) => link.name)}
            save={(link) => save.mutateAsync([...links, link])}
            onDone={() => setLinking(false)}
          />
        ) : links.length === 0 ? (
          <p className="text-body text-tx-2">
            No variable is linked. Link one to hand this Service another
            Service&rsquo;s URL, host or password without typing it.
          </p>
        ) : (
          <ul className="grid gap-2" aria-label="Wired variables">
            {links.map((link) => (
              <LinkRow
                key={link.name}
                link={link}
                action={
                  editable ? (
                    <Button
                      size="xs"
                      disabled={!gate.allowed || save.isPending}
                      title={gate.allowed ? undefined : gate.refusal}
                      onClick={() => gate.allowed && void unlink(link.name)}
                      aria-label={`Unlink ${link.name}`}
                    >
                      Unlink
                    </Button>
                  ) : fromFile && lock ? (
                    <span
                      className="text-meta text-tx-3"
                      title={lockRefusal(lock)}
                    >
                      Set in {lock.path}
                    </span>
                  ) : null
                }
              />
            ))}
          </ul>
        )}
      </Card.Body>
    </Card>
  );
}

/** `DATABASE_URL ← pg-1.url`: a name and its source, never a value. */
function LinkRow({
  link,
  action,
}: {
  link: WiredVariable;
  action: React.ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2">
      <span className="font-mono text-body wrap-anywhere">
        <span className="text-tx">{link.name}</span>{" "}
        <span aria-hidden="true" className="text-tx-3">
          ←
        </span>
        <span className="sr-only">links to</span>{" "}
        <span className="text-tx-2">
          {link.source}.{link.output}
        </span>
      </span>
      {action}
    </li>
  );
}
