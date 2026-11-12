import { api } from "../client";

/**
 * `certificates.controller.ts` — the TLS material an Organization brings with
 * it, for hosts Let's Encrypt cannot issue for (an internal domain, a wildcard
 * bought elsewhere, a corporate CA).
 *
 * **The private key never comes back.** `certificatesService.stripPrivateKey`
 * removes it from every response, which is why `Certificate` below has no
 * `privateKey` field and no screen can offer to show one. The *certificate*
 * half does come back and is public by definition, so the list renders it.
 *
 * **There is no `autoRenew`.** Such a column would be written and never read,
 * so neither the table nor the create DTO has one
 * — a stored
 * certificate is material somebody pasted in, and renewing it means pasting the
 * next one. Automatic renewal is a Let's Encrypt concern: it needs an ACME
 * account and a resolver, and it belongs on the Domain rather than here.
 */

/** A `certificate` row as the API returns it — the key is stripped server-side. */
export interface Certificate {
  certificateId: string;
  name: string;
  certificateData: string;
  /** The directory under Traefik's certs dir the pair is written to. */
  certificatePath: string;
  certificateType: "letsencrypt" | "none" | "custom";
  createdAt: string;
  organizationId: string;
  serverId: string | null;
}

export interface CreateCertificateInput {
  name: string;
  certificateData: string;
  privateKey: string;
  serverId?: string | null;
}

/** Every field is optional: `updateCertificateSchema` is `.partial()`. */
export type UpdateCertificateInput = Partial<
  Omit<CreateCertificateInput, "serverId">
>;

export const certificatesApi = {
  list: () => api.get<Certificate[]>("/certificates"),

  create: (input: CreateCertificateInput) =>
    api.post<Certificate>("/certificates", input),

  update: (certificateId: string, input: UpdateCertificateInput) =>
    api.patch<Certificate>(`/certificates/${certificateId}`, input),

  remove: (certificateId: string) =>
    api.delete<Certificate>(`/certificates/${certificateId}`),
};
