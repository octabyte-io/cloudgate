import { api } from "../client";

import type { ServiceType } from "./applications";

/**
 * `mounts.controller.ts` — one polymorphic table for the three kinds of thing
 * that can be mounted into a container, discriminated by `serviceType`.
 *
 * **This is the module the other six of F10's lists are shaped after.** It was the
 * one with a list route (`GET /mounts?serviceId=&serviceType=`) when ports,
 * redirects and security had none; they have since been given
 * one each and follow this module's shape, with `?applicationId=` rather than a
 * service pair because those three tables hang off `application` alone.
 *
 * Which optional column matters depends on `type`, and **the backend enforces
 * none of them** (`mount.dto.ts` says so out loud) — so the
 * form is where a bind mount without a host path gets refused, not the DTO.
 */

export type MountType = "bind" | "volume" | "file";

export interface Mount {
  mountId: string;
  type: MountType;
  /** `bind` only — the path on the host. */
  hostPath: string | null;
  /** `volume` only — the named Docker volume. */
  volumeName: string | null;
  /** `file` only — where under the mount path the file lands. */
  filePath: string | null;
  /** `file` only. Encrypted at rest, so it comes back and can carry a secret. */
  content: string | null;
  serviceType: ServiceType;
  /** Where it appears inside the container. */
  mountPath: string;
  applicationId: string | null;
  composeId: string | null;
}

export interface CreateMountInput {
  type: MountType;
  hostPath?: string;
  volumeName?: string;
  filePath?: string;
  content?: string;
  mountPath: string;
  serviceType: ServiceType;
  serviceId: string;
}

/** A mount cannot be re-pointed at another service, so no ids here. */
export type UpdateMountInput = Partial<
  Omit<CreateMountInput, "serviceType" | "serviceId">
>;

export const mountsApi = {
  listByService: (serviceId: string, serviceType: ServiceType = "application") =>
    api.get<Mount[]>("/mounts", { query: { serviceId, serviceType } }),

  findOne: (mountId: string) => api.get<Mount>(`/mounts/${mountId}`),

  create: (input: CreateMountInput) => api.post<Mount>("/mounts", input),

  update: (mountId: string, input: UpdateMountInput) =>
    api.patch<Mount>(`/mounts/${mountId}`, input),

  remove: (mountId: string) => api.delete<Mount>(`/mounts/${mountId}`),
};
