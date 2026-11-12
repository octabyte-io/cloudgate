import { api } from "../client";
import type { TeardownReport } from "./teardown";

/**
 * `projects.controller.ts`. Every route is scoped to the session's active
 * organization, and `GET /projects` is additionally row-level filtered: a
 * member sees only the Projects granted in their member row, so an empty list
 * is a legitimate answer and not a bug.
 */

/** The `project` row (`projects/project.schema.ts`). */
export interface Project {
  projectId: string;
  name: string;
  description: string | null;
  createdAt: string;
  organizationId: string;
  /**
   * Shared environment variables, as one encrypted dotenv blob.
   *
   * **Not inherited by anything below.** They are an interpolation source: a
   * service reaches one by writing `${{project.KEY}}` in its own variables, and
   * a key nobody references reaches no container.
   */
  env: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  env?: string;
}

export type UpdateProjectInput = Partial<CreateProjectInput>;

export const projectsApi = {
  list: () => api.get<Project[]>("/projects"),

  findOne: (projectId: string) => api.get<Project>(`/projects/${projectId}`),

  create: (input: CreateProjectInput) => api.post<Project>("/projects", input),

  update: (projectId: string, input: UpdateProjectInput) =>
    api.patch<Project>(`/projects/${projectId}`, input),

  /** Answers with what it kept, a bucket that holds files among it. */
  remove: (projectId: string) =>
    api.delete<Project & TeardownReport>(`/projects/${projectId}`),
};
