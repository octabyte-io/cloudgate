import { useId, useState } from "react";
import type { UseMutationResult } from "@tanstack/react-query";

import { FormError } from "@/components/console/field";
import { Skeleton } from "@/components/console/skeleton";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/error-message";
import type { TraefikPort } from "@/lib/api/endpoints/traefik";

import { useDraft } from "./use-draft";
import { useInstanceGate } from "./use-platform";

/**
 * The published-port list.
 *
 * The draft is held as **JSON text** rather than as an array, so `useDraft`'s one
 * rule still applies: a draft knows what it was a draft of, and a refetch that
 * returns the same ports leaves what somebody is typing alone while one that
 * returns different ports wins. An array would compare by reference and every
 * refetch would look like a change.
 *
 * **Save ports, Add a port and Remove are off, with the reason, for a caller
 * without instance authority**: `POST /settings/traefik/ports` runs
 * `traefikTargetAuthority`, and this screen sends no `serverId`, which is the
 * platform host's branch — `requireInstanceAuthority` (ADR-0013). Add and
 * Remove write only the draft, but a draft nobody here may save is the form
 * the rule beside `usePermission` exists to stop offering.
 */
export function PortsBlock({
  rows,
  pending,
  save,
  recreating,
  onSaved,
}: {
  rows: TraefikPort[];
  pending: boolean;
  save: UseMutationResult<boolean, Error, TraefikPort[]>;
  /** A save's container has not been seen yet, so another save would read the old one. */
  recreating: boolean;
  /** The POST returned: the card holds `saved` until the new container is read. */
  onSaved: (saved: TraefikPort[]) => void;
}) {
  const draft = useDraft(JSON.stringify(rows));
  const [refusal, setRefusal] = useState<string | null>(null);
  const gate = useInstanceGate();
  const gateId = useId();
  /** What every control that changes the list carries when it is off. */
  const off = gate.allowed
    ? {}
    : { title: gate.refusal, "aria-describedby": gateId };

  const parsed = parsePorts(draft.value);

  function write(next: TraefikPort[]) {
    if (!gate.allowed) return;
    draft.set(JSON.stringify(next));
  }

  return (
    <div className="grid gap-2">
      <div>
        <h3 className="text-body font-semibold text-tx">Published ports</h3>
        <p className="mt-0.5 text-meta text-tx-2">
          Extra ports Traefik binds on this host, beyond 80 and 443 — those two
          are always published and are not listed here. Saving replaces the whole
          list, so removing 8080 also turns the dashboard off.
        </p>
      </div>

      {pending ? (
        <Skeleton className="h-16 w-full rounded-lg" />
      ) : (
        <>
          {parsed.length === 0 ? (
            <p className="rounded-lg border border-line bg-panel-2 px-3.5 py-2.5 text-meta text-tx-2">
              Traefik publishes only 80 and 443 on this host.
            </p>
          ) : (
            <ul className="grid gap-2">
              {parsed.map((port, index) => (
                <li
                  key={index}
                  className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-panel-2 p-2.5"
                >
                  <PortField
                    label="On the host"
                    value={port.publishedPort}
                    onChange={(value) =>
                      write(
                        parsed.map((row, i) =>
                          i === index ? { ...row, publishedPort: value } : row,
                        ),
                      )
                    }
                  />
                  <PortField
                    label="In the container"
                    value={port.targetPort}
                    onChange={(value) =>
                      write(
                        parsed.map((row, i) =>
                          i === index ? { ...row, targetPort: value } : row,
                        ),
                      )
                    }
                  />
                  <div className="min-w-0">
                    <span className="mb-1 block text-meta font-medium text-tx-3">
                      Protocol
                    </span>
                    <span className="inline-flex h-ctl items-center rounded-md border border-line bg-panel px-2.5 font-mono text-ui text-tx-2">
                      {port.protocol}
                    </span>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="dngr"
                    className="ml-auto"
                    disabled={!gate.allowed}
                    {...off}
                    onClick={() => write(parsed.filter((_, i) => i !== index))}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <FormError message={refusal ?? undefined} />
          {gate.allowed ? null : (
            <p id={gateId} className="text-meta text-tx-2">
              {gate.refusal}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!gate.allowed}
              {...off}
              onClick={() =>
                write([
                  ...parsed,
                  { publishedPort: 8080, targetPort: 8080, protocol: "tcp" },
                ])
              }
            >
              Add a port
            </Button>
            <SubmitButton
              type="button"
              pending={save.isPending || recreating}
              disabled={!gate.allowed || !draft.dirty}
              {...off}
              onClick={async () => {
                if (!gate.allowed) return;
                setRefusal(null);
                try {
                  await save.mutateAsync(parsed);
                  onSaved(parsed);
                  draft.reset();
                  toast.done("Saved. Traefik is being recreated.");
                } catch (error) {
                  setRefusal(errorMessage(error));
                }
              }}
            >
              Save ports
            </SubmitButton>
            {draft.dirty ? (
              <Button type="button" onClick={draft.reset}>
                Discard changes
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function PortField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="min-w-0 basis-32">
      <span className="mb-1 block text-meta font-medium text-tx-3">{label}</span>
      <Input
        type="number"
        min={1}
        max={65535}
        value={Number.isFinite(value) ? value : ""}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

/** Never throws: the draft is our own JSON, but a parse that can crash a card is
 * one nobody wants to be wrong about. */
function parsePorts(text: string): TraefikPort[] {
  try {
    const parsed: unknown = JSON.parse(text || "[]");
    return Array.isArray(parsed) ? (parsed as TraefikPort[]) : [];
  } catch {
    return [];
  }
}
