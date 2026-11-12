"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { MetaStrip } from "@/components/console/meta-strip";
import { NoListing } from "@/components/console/no-listing";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { TabPending } from "@/components/console/tab-pending";
import { toast } from "@/components/console/toast";
import { Switch } from "@/components/ui/switch";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { PatchBrowser } from "../advanced/patch-browser";
import { PatchEditorModal } from "../advanced/patch-editor-modal";
import { patchReach, patchesSpec } from "../advanced/patches-spec";
import { ResourceList } from "@/components/console/resource-list";
import {
  usePatchMutations,
  usePatches,
  useRepoDirectories,
  useRepoFile,
} from "../advanced/use-patches";
import { sourceSummary } from "../source/providers";
import { useApplication } from "../use-application";

/**
 * Files this Application's build applies on top of the cloned source.
 *
 * Three things on one screen, and they are three because they are three
 * different jobs: **the patch list** (what is being changed, and whether each is
 * on), **the repository browser** (what there is to change), and **the editor**
 * (changing it, with the diff of what you are about to do).
 *
 * The list is a `ResourceList` configuration like every other list in this phase.
 * What this file adds is the enable/disable switch as a row control —
 * `POST /patches/:id/toggle` is its own route precisely so a toggle is one call
 * and not a read-modify-write of the whole row — and the browser-to-editor path,
 * which is the way a patch should normally be written: open the real file, change
 * it, save the result.
 *
 * **The clone is not the repository.** Cloudgate keeps its own copy under the
 * patch-repos tree so files can be read without touching the source, and cloning
 * it is a button (see `patch-browser.tsx`). A patch never reaches your
 * repository — it is applied to that clone, before a build, every time.
 *
 * **Not every source has either half.** `patchReach` says which: a Docker
 * image is never built, so this tab explains that and offers neither Add nor
 * Clone; uploaded files are built and patched but have no repository, so the
 * list stays and the file browser does not.
 *
 * **A Docker image no longer has the tab at all**. An earlier change kept it
 * in the rail and rejected hiding it per source because the tab table had no row to
 * read and a deep link would 404 for one Application and not the next. Now
 * both are answered: the table's `absentBecause` reads the row, and the route
 * still answers from the slug alone, so `/patches` on an image renders the
 * shell's "no Patches tab" page with the reason rather than a 404. The
 * `"never"` branch below is what that page replaced; it stays as the answer
 * should the panel ever be reached for an image (a row read before the
 * shell's), and says the same thing.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const application = useApplication(id);
  const patches = usePatches(id);
  const mutations = usePatchMutations(id);

  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const directories = useRepoDirectories(id, repoPath);
  const file = useRepoFile(id, editing);

  if (!application.data) return <TabPending />;

  const reach = patchReach(application.data.sourceType);
  const source = sourceSummary(application.data).label;

  if (reach === "never") {
    const kept = patches.data?.length ?? 0;
    return (
      <Page className="grid gap-3">
        <PageHeader
          title={label}
          icon={icon}
          lede="Changes applied to the source before every build, without changing the source."
        />
        <Card>
          <Card.Body flush>
            {/*
              `NoListing`, not `EmptyState`: this is not a list with nothing in
              it yet, and it may hold patches from before a source change —
              "none yet" and a create action would both be false (§3.10).
            */}
            <NoListing
              icon="pencil"
              title="Patches do not apply to a Docker image"
              footer={
                kept > 0
                  ? `Its ${kept === 1 ? "patch is" : `${kept} patches are`} kept, and ${kept === 1 ? "applies" : "apply"} again if the source changes back to a repository.`
                  : undefined
              }
            >
              Patches change source files before Cloudgate builds them. This
              Application runs a prebuilt image, so nothing is built and there
              is no source for a patch to change.
            </NoListing>
          </Card.Body>
        </Card>
      </Page>
    );
  }

  const spec = patchesSpec({
    applicationId: id,
    create: (input) => mutations.create.mutateAsync(input as never),
    update: (patchId, input) =>
      mutations.update.mutateAsync({ patchId, input: input as never }),
    remove: (patchId) => mutations.remove.mutateAsync(patchId),
  });

  const patchedPaths = new Set((patches.data ?? []).map((row) => row.filePath));

  return (
    <Page className="grid gap-3">
      <PageHeader
        title={label}
        icon={icon}
        lede="Changes applied to the source before every build, without changing the source."
      />

      <ResourceList
        spec={{
          ...spec,
          rowExtras: (row) => (
            <Switch
              checked={row.enabled}
              aria-label={`Apply the patch for ${row.filePath}`}
              disabled={mutations.toggle.isPending}
              onCheckedChange={async (next) => {
                try {
                  await mutations.toggle.mutateAsync({
                    patchId: row.patchId,
                    enabled: next,
                  });
                  toast.done(
                    next
                      ? `${row.filePath} will be patched again.`
                      : `${row.filePath} is no longer patched.`,
                    { description: "From the next build onwards." },
                  );
                } catch (error) {
                  toast.error(error);
                }
              }}
            />
          ),
        }}
        query={patches}
        note={
          <MetaStrip>
            Patches are applied to Cloudgate&rsquo;s own clone of the source, in
            order, <strong>before every build</strong>. Nothing here is pushed
            anywhere — your repository is never written to.
          </MetaStrip>
        }
      />

      {reach === "no-repository" ? (
        <Card>
          <Card.Header title="Repository files" headingLevel={2} />
          <Card.Body flush>
            <NoListing
              icon="folder"
              title="There is no repository to browse"
              footer="Patches still apply to it before every build. Add one above by its path."
            >
              This Application&rsquo;s source is {source.toLowerCase()}, so
              Cloudgate has nothing to clone.
            </NoListing>
          </Card.Body>
        </Card>
      ) : (
        <PatchBrowser
          repoPath={repoPath}
          entries={directories.data}
          pending={directories.isPending && repoPath !== null}
          error={directories.error}
          cloning={mutations.ensureRepo.isPending}
          onClone={async () => {
            // `text/plain` — the route is typed `Promise<string>`, so this comes
            // back through `postText`. It is also the only source of the path the
            // directory listing needs, which is why it is held in state here.
            const path = await mutations.ensureRepo.mutateAsync();
            setRepoPath(path);
          }}
          onOpen={setEditing}
          patchedPaths={patchedPaths}
        />
      )}

      <PatchEditorModal
        // Keyed on the path, so opening a second file mounts a fresh editor
        // rather than showing the first file's draft under the second's name.
        key={editing ?? "none"}
        filePath={editing}
        loaded={file.data}
        // The repository's own copy of the path. `undefined` when it has
        // none — a `create` patch — and the editor renders one tab fewer.
        original={file.original}
        pending={file.isPending && editing !== null}
        error={file.error}
        open={editing !== null}
        onOpenChange={(next) => {
          if (!next) setEditing(null);
        }}
        save={(input) => mutations.saveFile.mutateAsync(input)}
        markForDeletion={(filePath) =>
          mutations.markForDeletion.mutateAsync(filePath)
        }
      />
    </Page>
  );
}
