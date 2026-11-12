import { api } from "../client";

/**
 * The three per-Application networking tables — published ports, Traefik
 * redirects, and basic-auth users — in one module, because they share one shape
 * and one history.
 *
 * They were **write-only** until
 * Each controller was
 * `POST /` · `GET /:id` · `PATCH /:id` · `DELETE /:id`, and
 * `GET /applications/:id` carries none of the three relations, so nothing handed
 * out an id to call `GET /:id` with. All three now have `GET /?applicationId=`
 * — `listByApplication` on each service, resolving the parent Application
 * org-scoped and then gating on `service: read` — so a row created here can be
 * read back, edited and removed.
 *
 * Two things about the list routes are worth knowing before rendering one:
 *
 * 1. **`applicationId` is required, and it is the only filter.** There is no
 *    organization-wide list of ports, redirects or basic-auth users, and no
 *    Compose equivalent of any of them — these three tables hang off
 *    `application` alone.
 * 2. **`security` never sends a password**, on the list or anywhere else: every
 *    route projects the column away (`stripPassword`). So a basic-auth user can
 *    be listed and renamed and its password can only be *replaced*, never shown.
 */

export type Protocol = "tcp" | "udp";
export type PublishMode = "ingress" | "host";

export interface Port {
  portId: string;
  publishedPort: number;
  publishMode: PublishMode;
  targetPort: number;
  protocol: Protocol;
  applicationId: string;
}

export interface CreatePortInput {
  publishedPort: number;
  targetPort: number;
  protocol?: Protocol;
  publishMode?: PublishMode;
  applicationId: string;
}

export type UpdatePortInput = Partial<Omit<CreatePortInput, "applicationId">>;

export interface Redirect {
  redirectId: string;
  regex: string;
  replacement: string;
  permanent: boolean;
  /** Suffixes the generated Traefik middleware name. Server-side. */
  uniqueConfigKey: number;
  createdAt: string;
  applicationId: string;
}

export interface CreateRedirectInput {
  regex: string;
  replacement: string;
  permanent?: boolean;
  applicationId: string;
}

export type UpdateRedirectInput = Partial<
  Omit<CreateRedirectInput, "applicationId">
>;

/**
 * A basic-auth user. The password stays write-only even now that the rows list:
 * every route projects it away (`stripPassword`), so it is absent from this
 * shape and there is nothing to render — only a new one to set.
 */
export interface Security {
  securityId: string;
  username: string;
  createdAt: string;
  applicationId: string;
}

export interface CreateSecurityInput {
  username: string;
  password: string;
  applicationId: string;
}

export type UpdateSecurityInput = Partial<
  Omit<CreateSecurityInput, "applicationId">
>;

export const portsApi = {
  /** The ports one Application publishes. Unordered — the route selects
   * with no `orderBy`, so a table here sorts its own rows. */
  list: (applicationId: string) =>
    api.get<Port[]>("/ports", { query: { applicationId } }),

  findOne: (portId: string) => api.get<Port>(`/ports/${portId}`),
  create: (input: CreatePortInput) => api.post<Port>("/ports", input),
  update: (portId: string, input: UpdatePortInput) =>
    api.patch<Port>(`/ports/${portId}`, input),
  remove: (portId: string) => api.delete<Port>(`/ports/${portId}`),
};

export const redirectsApi = {
  /** One Application's Traefik redirects. Unordered, like the other two. */
  list: (applicationId: string) =>
    api.get<Redirect[]>("/redirects", { query: { applicationId } }),

  findOne: (redirectId: string) => api.get<Redirect>(`/redirects/${redirectId}`),
  create: (input: CreateRedirectInput) =>
    api.post<Redirect>("/redirects", input),
  update: (redirectId: string, input: UpdateRedirectInput) =>
    api.patch<Redirect>(`/redirects/${redirectId}`, input),
  remove: (redirectId: string) =>
    api.delete<Redirect>(`/redirects/${redirectId}`),
};

export const securityApi = {
  /** One Application's basic-auth users, passwords projected away. */
  list: (applicationId: string) =>
    api.get<Security[]>("/security", { query: { applicationId } }),

  findOne: (securityId: string) => api.get<Security>(`/security/${securityId}`),
  create: (input: CreateSecurityInput) =>
    api.post<Security>("/security", input),
  update: (securityId: string, input: UpdateSecurityInput) =>
    api.patch<Security>(`/security/${securityId}`, input),
  remove: (securityId: string) => api.delete<Security>(`/security/${securityId}`),
};
