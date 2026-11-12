import { useId, useState } from "react";

import { Card } from "@/components/console/card";
import { CodeEditor } from "@/components/console/code-editor";
import { FormError } from "@/components/console/field";
import { Skeleton } from "@/components/console/skeleton";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import { usePermission } from "@/lib/auth/use-permission";

import { useDraft } from "./use-draft";
import {
  useInstanceGate,
  usePlatformMutations,
  useTraefikDirectories,
  TRAEFIK_FILES_WRITE_REFUSAL,
  useTraefikFile,
} from "./use-platform";
import { FileTree, isGenerated } from "./traefik-file-tree";

/**
 * Every file under Traefik's directory, and an editor for the one you pick.
 *
 * **The paths come out of the tree and are never constructed here**, which is
 * `endpoints/traefik.ts`'s standing rule and is load-bearing rather than tidy:
 * `MAIN_TRAEFIK_DIR` is resolved on the backend from `CLOUDGATE_DIRECTORY`
 * — `/etc/cloudgate` is
 * only its default, and any instance may be rooted elsewhere. So guessing it in the
 * browser would put one host's filesystem layout in a client bundle and be wrong on
 * the next instance. `readDirectory` answers with each node's **absolute path as its
 * `id`**, so the tree is the only thing that has to know.
 *
 * **The three cards above this one are here too, and that is deliberate.**
 * `traefik.yml` and `dynamic/cloudgate.yml` appear in the tree like anything
 * else, so this card can edit them by the generic route as well. They keep their
 * own cards because *what a save does* differs per file and a generic browser
 * cannot say — a card that knows it is looking at the static config can tell you
 * a restart is needed, and this one cannot.
 *
 * **A per-service file is the interesting case, and it is a trap.**
 * `dynamic/app-*.yml` is regenerated from the domain, redirect and security rows
 * on every change and deleted when an Application's last domain goes
 * (`traefik/app-config.service.ts`), so a hand edit survives until the next one
 * of those and then vanishes. F10 shipped that as a read-only `CodeWell` on the
 * Application's own screen for that reason. Here it is writable, because this is
 * the Traefik file surface and hiding half of it would be the stranger choice —
 * with the warning on screen whenever the selected file looks generated.
 *
 * **Save file is off, with the reason, for a caller the route would refuse**.
 * `POST /settings/traefik/file` asks two things, and this card reads
 * both: `@RequirePermission('traefikFiles', 'write')`, and — because this card
 * writes the platform host, never a Server — `traefikFileTarget`'s
 * `requireInstanceAuthority` (ADR-0013). Each is a refusal the route gives to
 * everyone who fails it, so either one turns the button off; the statement's
 * reason is shown first because the decorator's guard answers first.
 */
export function TraefikFilesCard() {
  const tree = useTraefikDirectories();
  const [path, setPath] = useState<string | null>(null);
  const file = useTraefikFile(path);
  const { writeFile } = usePlatformMutations();
  const [refusal, setRefusal] = useState<string | null>(null);
  const permission = usePermission({ traefikFiles: ["write"] });
  const instance = useInstanceGate();
  const allowed = permission.allowed && instance.allowed;
  const gateReason = !permission.allowed
    ? TRAEFIK_FILES_WRITE_REFUSAL
    : instance.refusal;
  const gateId = useId();

  const {
    value: content,
    set: setDraft,
    reset,
    dirty,
  } = useDraft(file.data ?? "");

  return (
    <Card aria-busy={tree.isPending || undefined}>
      <Card.Header
        title="Files"
        sub="Everything under Traefik's directory on this host."
        headingLevel={2}
      />
      {tree.isPending ? (
        <Card.Body>
          <div className="grid gap-2">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-4 w-40" />
          </div>
        </Card.Body>
      ) : tree.error ? (
        <Card.Body>
          <p className="text-body wrap-anywhere text-tx-2">
            {errorMessage(tree.error)}
          </p>
        </Card.Body>
      ) : (
        <Card.Body className="grid gap-3.5 lg:grid-cols-[16rem_1fr]">
          <nav
            aria-label="Traefik files"
            className="max-h-72 overflow-auto rounded-lg border border-line bg-panel-2 p-1.5 lg:max-h-none"
          >
            {(tree.data ?? []).length === 0 ? (
              <p className="px-2 py-1.5 text-meta text-tx-2">
                Traefik&rsquo;s directory is empty, or it is not on this host.
              </p>
            ) : (
              <FileTree
                nodes={tree.data ?? []}
                selected={path}
                onSelect={(next) => {
                  reset();
                  setRefusal(null);
                  setPath(next);
                }}
              />
            )}
          </nav>

          <div className="min-w-0 grid gap-3">
            {path === null ? (
              <p className="rounded-lg border border-line bg-panel-2 px-3.5 py-8 text-center text-body text-tx-2">
                Choose a file to read or edit it.
              </p>
            ) : file.isPending ? (
              <Skeleton className="h-log w-full rounded-lg" />
            ) : file.error ? (
              <p className="text-body wrap-anywhere text-tx-2">
                {errorMessage(file.error)}
              </p>
            ) : (
              <>
                {isGenerated(path) ? (
                  <p className="rounded-lg border border-warn-line bg-warn-tint px-3.5 py-2.5 text-meta text-tx">
                    Cloudgate writes this file. It is regenerated from that
                    service&rsquo;s domains, redirects and security rules on every
                    change, and deleted when its last domain goes — so an edit
                    here survives only until one of those happens.
                  </p>
                ) : null}
                <CodeEditor
                  value={content}
                  onChange={setDraft}
                  label={`${path}`}
                />
                <FormError message={refusal ?? undefined} />
                {allowed ? null : (
                  <p id={gateId} className="text-meta text-tx-2">
                    {gateReason}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <SubmitButton
                    type="button"
                    pending={writeFile.isPending}
                    disabled={!allowed || !dirty || content.trim() === ""}
                    title={allowed ? undefined : gateReason}
                    aria-describedby={allowed ? undefined : gateId}
                    onClick={save}
                  >
                    Save file
                  </SubmitButton>
                  {dirty ? (
                    <Button type="button" onClick={reset}>
                      Discard changes
                    </Button>
                  ) : null}
                  <code className="ml-auto font-mono text-meta wrap-anywhere text-tx-3">
                    {path}
                  </code>
                </div>
              </>
            )}
          </div>
        </Card.Body>
      )}
      <Card.Footer>
        Files under <code className="font-mono">dynamic/</code>{" "}
        are watched and
        take effect within seconds.{" "}
        <code className="font-mono">traefik.yml</code>{" "}
        is read once at start and
        needs a restart. Files holding private keys — a certificate&rsquo;s{" "}
        <code className="font-mono">privkey.key</code> and{" "}
        <code className="font-mono">acme.json</code> — are listed but never
        shown, and basic-auth password hashes read as{" "}
        <code className="font-mono">&lt;redacted&gt;</code>; saving keeps the
        stored ones.
      </Card.Footer>
    </Card>
  );

  async function save() {
    if (path === null || !allowed) return;
    setRefusal(null);
    try {
      await writeFile.mutateAsync({ path, content });
      reset();
      toast.done("File saved.");
    } catch (error) {
      setRefusal(errorMessage(error));
    }
  }
}
