import { useId, useState } from "react";

import { Card } from "@/components/console/card";
import { CodeEditor } from "@/components/console/code-editor";
import { FormError } from "@/components/console/field";
import { Skeleton } from "@/components/console/skeleton";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { TraefikConfigKind } from "@/lib/api/endpoints/traefik";

import { useDraft } from "./use-draft";
import {
  useInstanceGate,
  useTraefikConfig,
  usePlatformMutations,
} from "./use-platform";

export type TraefikConfigDescriptor = {
  kind: TraefikConfigKind;
  title: string;
  /** Where it is on disk, so the reader can find it without this screen. */
  path: string;
  lede: React.ReactNode;
  /** What happens after a save. The three files differ and it matters. */
  effect: React.ReactNode;
};

/**
 * One of Traefik's three named files, edited.
 *
 * **Three cards from one component and one descriptor**, because the three
 * routes differ only in which file they touch — the F15 argument at a much
 * smaller scale, and the alternative is three near-identical editors that drift.
 *
 * **The editor is F12's `CodeEditor`**, which the F12 brief asked this phase to
 * reuse rather than choosing again. It is a `next/dynamic` boundary, so
 * CodeMirror is downloaded when a Traefik screen is opened and by nothing else.
 *
 * ## Two things this card has to say that a plain form would not
 *
 * 1. **What a save does *after* it writes.** `traefik.yml` is the static config
 *    and Traefik reads it **once at start** — the file provider's `watch: true`
 *    covers `dynamic/` only — so editing it changes nothing until the container
 *    restarts. The two files in `dynamic/` are watched and take effect in
 *    seconds. Same button, two completely different consequences, and the
 *    backend has the same asymmetry and says nothing about it either.
 * 2. **An empty file is not an error.** `readConfig` answers `null` when the file
 *    is not there, which Nest sends as an empty body. `dynamic/cloudgate.yml`
 *    genuinely does not exist until **Assign domain** creates it, and
 *    `middlewares.yml` may never exist on a Cloudgate instance at all. So the
 *    card says which file it is looking at and lets an empty box mean what it
 *    means, rather than claiming either "empty" or "missing".
 *
 * The save refuses an empty string (`z.string().min(1)`), which is why the
 * button goes off rather than sending one: a 400 for "you deleted everything" is
 * a worse way to learn the file cannot be emptied here.
 *
 * **And it refuses YAML Traefik could not load**, with the parser's line
 * and column, which lands in the `FormError` under the editor and leaves the
 * draft in place to fix. That refusal is the backend's alone — rejected: a
 * second parse here, which would be a second YAML dialect to keep in step with
 * the one that decides. It matters most for `traefik.yml`: nothing fails at the
 * save, because Traefik reads the file only when it starts, so without it a
 * broken edit took every domain down at the next restart instead.
 *
 * **Save is off, with the reason, for a caller without instance authority**
 * all three routes call `requireInstanceAuthority` and nothing else
 * (ADR-0013), so the card reads `useInstanceGate` — the rule's case 2 beside
 * `usePermission`. The editor stays live; reading the file is not the refused
 * act, and its own read takes the same authority anyway.
 */
export function TraefikConfigCard({
  descriptor,
}: {
  descriptor: TraefikConfigDescriptor;
}) {
  const config = useTraefikConfig(descriptor.kind);
  const { writeConfig } = usePlatformMutations();
  const [refusal, setRefusal] = useState<string | null>(null);
  const gate = useInstanceGate();
  const gateId = useId();
  const {
    value: content,
    set: setDraft,
    reset,
    dirty,
  } = useDraft(config.data ?? "");

  return (
    <Card aria-busy={config.isPending || undefined}>
      <Card.Header
        title={descriptor.title}
        sub={descriptor.lede}
        headingLevel={2}
        actions={
          <code className="hidden font-mono text-meta text-tx-3 sm:block">
            {descriptor.path}
          </code>
        }
      />
      <Card.Body className="grid gap-3">
        {config.isPending ? (
          <Skeleton className="h-log w-full rounded-lg" />
        ) : config.error ? (
          <p className="text-body wrap-anywhere text-tx-2">
            {errorMessage(config.error)}
          </p>
        ) : (
          <>
            {config.data === "" ? (
              <p className="rounded-lg border border-info-line bg-info-tint px-3.5 py-2.5 text-meta text-tx">
                There is nothing at <code className="font-mono">{descriptor.path}</code>{" "}
                yet. Saving here creates it.
              </p>
            ) : null}
            <CodeEditor
              value={content}
              onChange={setDraft}
              label={`${descriptor.title} (${descriptor.path})`}
            />
            <FormError message={refusal ?? undefined} />
            {gate.allowed ? null : (
              <p id={gateId} className="text-meta text-tx-2">
                {gate.refusal}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <SubmitButton
                pending={writeConfig.isPending}
                onClick={save}
                type="button"
                disabled={!gate.allowed || !dirty || content.trim() === ""}
                title={gate.allowed ? undefined : gate.refusal}
                aria-describedby={gate.allowed ? undefined : gateId}
              >
                Save {descriptor.title.toLowerCase()}
              </SubmitButton>
              {dirty ? (
                <Button type="button" onClick={reset}>
                  Discard changes
                </Button>
              ) : null}
              {content.trim() === "" && dirty ? (
                <span className="text-meta text-tx-3">
                  This file cannot be saved empty — delete it on the host
                  instead.
                </span>
              ) : null}
            </div>
          </>
        )}
      </Card.Body>
      <Card.Footer>{descriptor.effect}</Card.Footer>
    </Card>
  );

  async function save() {
    if (!gate.allowed) return;
    setRefusal(null);
    try {
      await writeConfig.mutateAsync({
        kind: descriptor.kind,
        content,
      });
      reset();
      toast.done(`${descriptor.title} saved.`);
    } catch (error) {
      setRefusal(errorMessage(error));
    }
  }
}
