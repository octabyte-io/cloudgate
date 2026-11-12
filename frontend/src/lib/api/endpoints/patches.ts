import { api } from "../client";

/**
 * `patch/patch.controller.ts` — per-file source patches applied on top of the
 * cloned repository **before** a build.
 *
 * A patch is not a diff in the git sense: it is a whole file plus what to do
 * with it. `create` writes a file the repository does not have, `update`
 * replaces one it does, and `delete` removes one. The diff a screen renders is
 * therefore something the *screen* computes, between the repository's copy and
 * the patch's — and **both sides are now reachable**: `GET /patches/repo/file`
 * takes `source=patch|repo`
 * so the copy an
 * `update` patch replaces can be read alongside the patch itself. `readFile`
 * below has the two answers written out.
 *
 * Two routes on this controller answer with a bare string, and Nest sends those
 * as `text/plain`: `POST /patches/repo/ensure` (the repo path it cloned to) and
 * `GET /patches/repo/file` (the file). Both use `postText` / `getText` — see
 * rule 4 under **The data layer** in `frontend/docs/design-system.md`. Typing
 * either as JSON gives back `undefined` with a type that says otherwise, which
 * is what took a dialog down in F09.
 *
 * `content` is `encryptedText` on the row: a patch is file content headed for a
 * build tree and may well be a config file with a credential in it.
 */

export type PatchType = "create" | "update" | "delete";

/** Which of the two owners a patch hangs off. */
export type PatchEntityType = "application" | "compose";

export interface Patch {
  patchId: string;
  type: PatchType;
  /** Relative to the repository root. Unique per file per owner. */
  filePath: string;
  enabled: boolean;
  content: string;
  createdAt: string;
  updatedAt: string | null;
  applicationId: string | null;
  composeId: string | null;
}

export interface CreatePatchInput {
  filePath: string;
  content: string;
  type?: PatchType;
  enabled?: boolean;
  applicationId?: string;
  composeId?: string;
}

/** A patch cannot be re-pointed at another service. */
export type UpdatePatchInput = Partial<{
  filePath: string;
  content: string;
  type: PatchType;
  enabled: boolean;
}>;

/** One node of the repository's tracked-file tree (`git ls-tree -r`). */
export interface DirectoryEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: DirectoryEntry[];
}

export const patchesApi = {
  listByEntity: (id: string, type: PatchEntityType = "application") =>
    api.get<Patch[]>("/patches", { query: { id, type } }),

  findOne: (patchId: string) => api.get<Patch>(`/patches/${patchId}`),

  create: (input: CreatePatchInput) => api.post<Patch>("/patches", input),

  update: (patchId: string, input: UpdatePatchInput) =>
    api.patch<Patch>(`/patches/${patchId}`, input),

  /** Its own route rather than a `PATCH`, so a row toggle is one call. */
  toggle: (patchId: string, enabled: boolean) =>
    api.post<Patch>(`/patches/${patchId}/toggle`, { enabled }),

  remove: (patchId: string) => api.delete<Patch>(`/patches/${patchId}`),

  /** The editor's write half: upserts the patch for this path. */
  saveFile: (input: {
    id: string;
    type: PatchEntityType;
    filePath: string;
    content: string;
    patchType?: "create" | "update";
  }) => api.post<Patch>("/patches/save-file", input),

  /** Records that the build should remove this file. */
  markForDeletion: (input: {
    id: string;
    type: PatchEntityType;
    filePath: string;
  }) => api.post<Patch>("/patches/mark-for-deletion", input),

  /**
   * Clones the source into the patch-repos tree so its files can be browsed.
   * **Answers with the repo path as `text/plain`** — useful to show, and the
   * signal that there is now a clone to list, but not something the listing
   * needs: `readDirectories` derives the same path from the entity.
   */
  ensureRepo: (id: string, type: PatchEntityType = "application") =>
    api.postText("/patches/repo/ensure", { id, type }),

  /**
   * The repository's tracked files, folded into a tree. JSON, unlike its two
   * neighbours. **The directory is the entity's own clone, always** — the route
   * derives it, and there is no parameter for asking about another one.
   */
  readDirectories: (input: { id: string; type: PatchEntityType }) =>
    api.get<DirectoryEntry[]>("/patches/repo/directories", { query: input }),

  /**
   * A file's content. **`text/plain`.**
   *
   * **`source` picks which of the two answers you want**
   * and it exists
   * because this one route used to have only one:
   *
   * - **`"patch"` (the default, and the historical behaviour)** — whatever the
   *   build will use. A patch standing in front of the path answers for it; with
   *   no patch, the repository's copy. A `delete` patch is the odd one: it answers
   *   the repository file it will remove, and falls back to the sentinel string
   *   `(File not found in repo - will be removed if it exists)` when that file is
   *   already gone.
   * - **`"repo"`** — the repository's own copy of the path, always, skipping that
   *   resolution entirely. This is the **"before" side an `update` patch hides**:
   *   `update` is the default patch type, and once one exists the thing it
   *   replaces was unreachable through the API, so a diff of *what this patch
   *   changes* could not be drawn. A path the repository does not have is a
   *   **404** here rather than the delete branch's sentinel — a sentinel that
   *   claims a removal would be the wrong answer to "what is there now".
   *
   * Both need the entity's clone to exist, so both want `ensureRepo` first.
   */
  readFile: (input: {
    id: string;
    type: PatchEntityType;
    filePath: string;
    /** Defaults to `"patch"` server-side. See above — the two are not the same. */
    source?: "patch" | "repo";
  }) => api.getText("/patches/repo/file", { query: input }),

  /**
   * Wipes every clone under the patch-repos tree on the Server named, or on the
   * platform host when none is.
   *
   * **The two branches take different boundaries.** A named Server
   * asks for owner or admin of the caller's own Organization; the platform host
   * asks for authority over the *instance* (ADR-0013), because the tree there is
   * shared by every Organization and the glob is the whole of it. This client
   * gates neither — the sentence is here for the same reason
   * `local-shell-card.tsx` carries ADR-0010's, so a reader of the call knows
   * which refusal to expect.
   */
  cleanRepos: (serverId?: string) =>
    api.post<boolean>("/patches/repo/clean", { serverId }),
};
