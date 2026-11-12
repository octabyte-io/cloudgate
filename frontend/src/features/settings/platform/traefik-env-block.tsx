import { useId, useState } from "react";
import type { UseMutationResult } from "@tanstack/react-query";

import { FormError } from "@/components/console/field";
import { Skeleton } from "@/components/console/skeleton";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/api/error-message";

import { useDraft } from "./use-draft";
import { useInstanceGate } from "./use-platform";

/**
 * Traefik's environment, as the container was started with it.
 *
 * A separate module rather than a closure inside the card: a component defined
 * during render is a *new type* every render, so React unmounts and remounts it —
 * and this one holds a draft somebody is typing into.
 *
 * **Save environment is off, with the reason, for a caller without instance
 * authority**: `POST /settings/traefik/env` runs `traefikTargetAuthority`,
 * and this screen sends no `serverId`, which is the platform host's branch —
 * `requireInstanceAuthority` (ADR-0013). The rule's case 2 beside
 * `usePermission`: the gate is the instance-authority read.
 */
export function EnvBlock({
  server,
  pending,
  save,
  recreating,
  onSaved,
}: {
  server: string;
  pending: boolean;
  save: UseMutationResult<boolean, Error, string>;
  /** A save's container has not been seen yet, so another save would read the old one. */
  recreating: boolean;
  /** The POST returned: the card holds `saved` until the new container is read. */
  onSaved: (saved: string) => void;
}) {
  const draft = useDraft(server);
  const [refusal, setRefusal] = useState<string | null>(null);
  const gate = useInstanceGate();
  const gateId = useId();

  return (
    <div className="grid gap-2">
      <div>
        <h3 className="text-body font-semibold text-tx">
          Environment variables
        </h3>
        <p className="mt-0.5 text-meta text-tx-2">
          One <code className="font-mono">KEY=value</code> per line, as the
          container was started with. A{" "}
          <code className="font-mono">{"${{…}}"}</code> reference is resolved on
          the way in.
        </p>
      </div>
      {pending ? (
        <Skeleton className="h-24 w-full rounded-lg" />
      ) : (
        <>
          <Textarea
            value={draft.value}
            rows={6}
            className="font-mono"
            aria-label="Traefik's environment variables"
            onChange={(event) => draft.set(event.target.value)}
          />
          <FormError message={refusal ?? undefined} />
          {gate.allowed ? null : (
            <p id={gateId} className="text-meta text-tx-2">
              {gate.refusal}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <SubmitButton
              type="button"
              pending={save.isPending || recreating}
              disabled={!gate.allowed || !draft.dirty}
              title={gate.allowed ? undefined : gate.refusal}
              aria-describedby={gate.allowed ? undefined : gateId}
              onClick={async () => {
                if (!gate.allowed) return;
                setRefusal(null);
                try {
                  await save.mutateAsync(draft.value);
                  onSaved(draft.value);
                  draft.reset();
                  toast.done("Saved. Traefik is being recreated.");
                } catch (error) {
                  setRefusal(errorMessage(error));
                }
              }}
            >
              Save environment
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
