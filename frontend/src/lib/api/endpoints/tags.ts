import { api } from "../client";

/**
 * `tags.controller.ts`. A Tag is an Organization-level label, and the only thing
 * it labels is a Project — `project_tag` is the one join table
 * (`tags/tag.schema.ts`).
 *
 * Two shapes of read, and the difference matters to every caller:
 *
 * - **`list()`** — every Tag the Organization has, name-ordered. The vocabulary.
 * - **`listByProject(id)`** — the Tags on one Project. There is no batch route
 *   and no `tags` array on a `project` row, so a list of Projects showing its
 *   Tags costs one of these per row. That is a real cost and it is why the
 *   Projects screen fans out with `useQueries` rather than pretending otherwise.
 *
 * `assign` / `unassign` take the pair in the URL and send no body, which is why
 * they read as verbs here rather than as an update to a Tag.
 */

/** The `tag` row (`tags/tag.schema.ts`). */
export interface Tag {
  tagId: string;
  name: string;
  /**
   * A hex string. **Nothing in this console paints with
   * it** — an arbitrary hex cannot be guaranteed to clear 4.5:1 in both themes,
   * and the design system's rule is that a hue never carries meaning on its own.
   * Kept on the type because the column exists and a row really does carry it.
   */
  color: string | null;
  createdAt: string;
  organizationId: string;
}

export interface CreateTagInput {
  name: string;
  color?: string;
}

export type UpdateTagInput = Partial<CreateTagInput>;

export const tagsApi = {
  list: () => api.get<Tag[]>("/tags"),

  /** The Tags assigned to one Project. `GET /tags?projectId=…`. */
  listByProject: (projectId: string) =>
    api.get<Tag[]>("/tags", { query: { projectId } }),

  findOne: (tagId: string) => api.get<Tag>(`/tags/${tagId}`),

  create: (input: CreateTagInput) => api.post<Tag>("/tags", input),

  update: (tagId: string, input: UpdateTagInput) =>
    api.patch<Tag>(`/tags/${tagId}`, input),

  remove: (tagId: string) => api.delete<Tag>(`/tags/${tagId}`),

  /** Put this Tag on that Project. Answers with the join row. */
  assign: (tagId: string, projectId: string) =>
    api.post<{ id: string; tagId: string; projectId: string }>(
      `/tags/${tagId}/projects/${projectId}`,
    ),

  /** Take it off again. Answers 200 with no body. */
  unassign: (tagId: string, projectId: string) =>
    api.delete<void>(`/tags/${tagId}/projects/${projectId}`),
};
