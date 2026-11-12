import { api } from "../client";

/**
 * `domains.controller.ts` plus `cdn.controller.ts`'s one route.
 *
 * The CRUD lives under `/domains` and the by-parent listings hang off their
 * service's own path, which is why there is no `list()` here: a domain belongs
 * to an Application or to a Compose stack, and those are the only two ways in
 * (`byApplicationId` / `byComposeId`). There is no `GET /domains`.
 *
 * `POST /domains/validate` is the odd one out — it is served by the CDN module
 * but routed under `/domains`, because resolving a host and noticing a CDN in
 * front of it is the same question the operator is asking.
 */

/** `preview` exists for wire-parity with Traefik's generators (Phase 25). */
export type DomainType = "application" | "compose" | "preview" | "bucket";

/**
 * Who supplies a domain's certificate. `stored` is a certificate from Settings →
 * Certificates: TLS with no resolver, so Traefik serves the stored
 * certificate whose names cover the host.
 */
export type CertificateType = "letsencrypt" | "none" | "custom" | "stored";

/** A stored certificate, as a domain names it — never its material. */
export interface StoredCertificateRef {
  certificateId: string;
  name: string;
}

/** Where a cloud Domain's own ACM certificate is. */
export type CloudCertificateStatus =
  | "waiting-for-dns"
  | "checking"
  | "live"
  | "failed";

/** One DNS record to copy to the operator's DNS provider. */
export interface DnsRecordToCopy {
  name: string;
  type: string;
  value: string;
  /** Cloudgate has seen it in DNS. Informational: it never blocks anything. */
  seen: boolean;
}

/**
 * A Domain on a Service in a Cloud account, as the listing shows it:
 * its certificate's status, the two records the operator makes (Cloudgate
 * never writes DNS), and when a certificate waiting for DNS fails.
 */
export interface CloudDomainView {
  status: CloudCertificateStatus;
  failure: string | null;
  requestedAt: string | null;
  /** 72 hours after the request. */
  deadline: string | null;
  /** What the host points at, by its DNS name: a load balancer's, or a static site's distribution's. */
  loadBalancer: string | null;
  /** Which of the two it is; absent from an older API, which means a load balancer. */
  servedBy?: "load-balancer" | "cloudfront" | "fixed-ip" | null;
  records: {
    /** ACM's validation CNAME, once ACM has named it. */
    validation: DnsRecordToCopy | null;
    /** The host pointing at the load balancer: a CNAME, or an ALIAS for a bare name. */
    pointing: DnsRecordToCopy & { note: string };
  } | null;
}

/** What removing a cloud Domain answers: the records left at the DNS provider. */
export interface CloudDomainRemoval {
  deploymentId: string;
  dnsRecordsLeft: { name: string; type: string; value: string }[];
  message: string;
}

/**
 * The `domain` row.
 *
 * `uniqueConfigKey` is a serial the backend suffixes Traefik's router, service
 * and middleware names with. Nothing on screen reads it; it is here because the
 * row carries it and a type that omits a column silently is how drift starts.
 */
export interface Domain {
  domainId: string;
  host: string;
  https: boolean;
  port: number | null;
  path: string | null;
  /** Prepended before proxying — Traefik's `addprefix`. */
  internalPath: string | null;
  /** Strip the public prefix before proxying — Traefik's `stripprefix`. */
  stripPath: boolean;
  /** The Compose service the domain routes into. Null for an Application. */
  serviceName: string | null;
  domainType: DomainType | null;
  uniqueConfigKey: number;
  certificateType: CertificateType;
  customCertResolver: string | null;
  customEntrypoint: string | null;
  middlewares: string[] | null;
  forwardAuthEnabled: boolean;
  /**
   * The stored certificate Traefik serves for this host, whatever
   * `certificateType` says — one that covers the host wins over a resolver.
   * Null for an HTTP domain or when none covers it. Carried by the two
   * listings only (`byApplication`, `byCompose`), hence optional.
   */
  storedCertificate?: StoredCertificateRef | null;
  /** Set on a Domain of a Service in a Cloud account, by the listing. */
  cloud?: CloudDomainView;
  /** The short Deployment a cloud Domain's write queued. */
  deploymentId?: string;
  createdAt: string;
  applicationId: string | null;
  composeId: string | null;
  /** A Server bucket's Domain, routed to its Garage S3 API. */
  bucketId: string | null;
}

/**
 * What `POST /domains` accepts (`dto/domain.dto.ts`).
 *
 * The three cross-field rules the backend refuses on are worth knowing before
 * writing a form against it: `https` requires a `certificateType`, a `custom`
 * certificate requires a `customCertResolver`, and `stripPath` requires a `path`
 * that is not `/`. And one it checks against the stored rows: an HTTPS `stored`
 * domain is refused when no certificate in Settings → Certificates covers its
 * host.
 */
export interface CreateDomainInput {
  host: string;
  path?: string;
  internalPath?: string;
  stripPath?: boolean;
  port?: number;
  https?: boolean;
  certificateType?: CertificateType;
  customCertResolver?: string | null;
  customEntrypoint?: string | null;
  middlewares?: string[];
  forwardAuthEnabled?: boolean;
  serviceName?: string;
  domainType?: "application" | "compose";
  applicationId?: string;
  composeId?: string;
  bucketId?: string;
}

/** Everything but the parent ids — a domain does not move between services. */
export type UpdateDomainInput = Partial<
  Omit<CreateDomainInput, "applicationId" | "composeId" | "bucketId">
>;

/**
 * What the resolver found, and whether it is what this Server wants.
 *
 * A host behind a CDN comes back **valid with a warning**: the proxy's address
 * is the honest answer to "what does this resolve to", and Cloudgate cannot see
 * past it to check the origin. `error` carries the sentence in that case too, so
 * a screen must read `isValid` rather than the presence of `error`
 * (`cdn.service.ts`).
 */
export interface DomainValidation {
  isValid: boolean;
  /** Every A record, comma-joined, as the backend assembles it. */
  resolvedIp?: string;
  /** The CDN in front of the origin, by name, when one was recognised. */
  cdnProvider?: string;
  error?: string;
}

export const domainsApi = {
  byApplication: (applicationId: string) =>
    api.get<Domain[]>(`/applications/${applicationId}/domains`),

  byCompose: (composeId: string) =>
    api.get<Domain[]>(`/compose/${composeId}/domains`),

  /** A Server bucket's Domains. */
  byBucket: (bucketId: string) =>
    api.get<Domain[]>(`/buckets/${bucketId}/domains`),

  findOne: (domainId: string) => api.get<Domain>(`/domains/${domainId}`),

  create: (input: CreateDomainInput) => api.post<Domain>("/domains", input),

  update: (domainId: string, input: UpdateDomainInput) =>
    api.patch<Domain>(`/domains/${domainId}`, input),

  remove: (domainId: string) =>
    api.delete<Domain & Partial<CloudDomainRemoval>>(`/domains/${domainId}`),

  /** A failed cloud Domain's certificate, requested again. */
  askAgain: (domainId: string) =>
    api.post<Domain>(`/domains/${domainId}/ask-again`),

  /**
   * A host on `sslip.io` carrying the Server's address, so a service is
   * reachable before anyone owns a domain.
   *
   * **`postText`, not `post`.** `generateDomain` returns `Promise<string>`, so
   * Nest sends `text/plain` and JSON-parsing it yields `undefined` — which is how
   * an undefined host reached a form field and crashed the dialog.
   *
   * `serverId` is passed through as-is, null included. It used to be spread
   * conditionally to strip the null, because the DTO spelled the field
   * `.optional()` and answered 400 to the very value a platform-host row carries.
   * The DTO is `.nullish()` now, so the strip is dead weight — do not put
   * it back.
   */
  generate: (appName: string, serverId?: string | null) =>
    api.postText("/domains/generate", { appName, serverId }),

  /**
   * Resolve a host and compare it with where it should point. `serverIp` is
   * optional: without it this only reports what the host resolves to, which is
   * still the useful half when the service runs on the platform's own host and
   * nothing knows that address from here.
   */
  validate: (domain: string, serverIp?: string) =>
    api.post<DomainValidation>("/domains/validate", {
      domain,
      ...(serverIp ? { serverIp } : {}),
    }),
};
