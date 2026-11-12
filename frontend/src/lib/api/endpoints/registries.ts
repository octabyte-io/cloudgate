import { api } from "../client";

/**
 * `registries.controller.ts` — the container registries an image is pushed to
 * and pulled from, scoped to the Organization.
 *
 * F09 declared the read half for one control (which registry a build pushes to);
 * **F15 fills in the writes**, which is exactly the split that module's own
 * comment predicted.
 *
 * **The password never comes down.** `registries.service.ts` strips it on every
 * read, which is why `Registry` below has no `password` field and the edit form
 * starts with that box empty. A `PATCH` that does not mention the column leaves
 * it as it was — the rule F10 paid for on a mount's `volume_name`, working *for*
 * us here: leaving the box alone keeps the stored credential.
 */

/** `cloud` is Docker Hub and friends; `selfHosted` is a registry you run. */
export type RegistryType = "selfHosted" | "cloud";

export interface Registry {
  registryId: string;
  name: string;
  /** Prepended to the image name — an organization or a namespace. */
  imagePrefix: string | null;
  username: string;
  /** Empty string rather than null when the registry is Docker Hub's default. */
  url: string;
  registryType: RegistryType;
  createdAt: string;
  organizationId: string;
}

/**
 * `createRegistrySchema`. `url` is a **hostname, optionally with a port** — no
 * scheme, because the value goes into a `docker login` argument and the backend
 * refuses anything with shell metacharacters in it.
 */
export interface RegistryInput {
  name: string;
  username: string;
  password: string;
  url: string;
  /**
   * Optional because `createRegistrySchema` defaults it to `cloud` and no reader
   * anywhere distinguishes the two — the console stopped asking for it.
   * It stays on the
   * type because the route still takes it, and a client that has a reason to set
   * it may.
   */
  registryType?: RegistryType;
  imagePrefix?: string | null;
}

export const registriesApi = {
  list: () => api.get<Registry[]>("/registries"),

  create: (body: RegistryInput) => api.post<Registry>("/registries", body),

  /** Partial. Omitting `password` keeps the stored one. */
  update: (registryId: string, body: Partial<RegistryInput>) =>
    api.patch<Registry>(`/registries/${registryId}`, body),

  remove: (registryId: string) =>
    api.delete<Registry>(`/registries/${registryId}`),

  /**
   * A `docker login` with the values on screen, from the platform's own host —
   * or from a Server when `serverId` is given
   * An empty
   * `204` when the registry accepts it; **what it is for is the refusal**, a
   * `400` carrying the registry's own words.
   */
  testConnection: (
    body: Pick<RegistryInput, "url" | "username" | "password"> & {
      serverId?: string | null;
    },
  ) => api.post<unknown>("/registries/test-connection", body),

  /**
   * The same login **as it is saved**: the password comes off the row
   * server-side, because no read ever sends it back here.
   */
  testSavedConnection: (registryId: string, serverId?: string | null) =>
    api.post<unknown>(`/registries/${registryId}/test-connection`, {
      serverId,
    }),
};
