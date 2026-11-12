import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
} from 'drizzle-orm/pg-core';
import { application } from '../applications/application.schema';
import { bucket } from '../buckets/bucket.schema';
import { compose } from '../compose/compose.schema';
import { isoTimestamp, nanoidPk } from '../db/columns';

// No previewDeploymentId FK — Phase 25 stores preview hosts on the
// preview_deployment row itself. The 'preview' enum value stays because the
// Traefik generators' domainType still reads it.
//
// Exactly one of applicationId/composeId/bucketId is set, enforced in three places,
// none of which replaces another:
//
//   - `createDomainSchema`'s `superRefine` refuses a body carrying both, at a
//     field path — **the half a caller needs**, since the constraint below can
//     only answer with a 500 naming a database constraint. It is deliberately
//     beside `refineDomainRules` rather than inside it, because that arm is
//     shared with `updateDomainSchema` where "exactly one is present" is false
//     for every legitimate PATCH body; see the DTO.
//   - `DomainsService.create` names all fifteen columns, writing the parent
//     `findParentService` resolved and `checkServiceAccess` authorized — which
//     also covers the service-seam callers (`PlanApplier`, a Template's
//     compose part among its creates, and `AiService.deploy`), where the
//     global pipe never runs.
//   - {@link domainExactlyOneParent}, the only one of the three that a *fourth*
//     write path cannot get wrong.

/**
 * Exactly one owning service, as a database fact (the `domain` half of
 * the constraint named for `patch` and first declined).
 *
 * `<>` on two `IS NULL` tests is XOR, so a row with **both** parents is
 * refused — the cross-tenant write, which landed a Traefik router on the
 * victim's Compose stack — and so is a row with **neither**, which is an
 * orphan: `DomainsService.findParentService` answers it with
 * `BadRequestException('applicationId or composeId is required')` and nothing
 * that emits Traefik config can resolve it.
 *
 * **Neither-parent rows were never producible, checked against history rather
 * than assumed.** `findParentService` has thrown that `BadRequestException`
 * as its final statement in every version of this module, and it runs before
 * the insert, so the strict `<>` costs no existing install a row. Both-parent
 * rows *were* producible once, which is why the migration normalizes
 * them before it adds this — see `0063_exactly-one-parent-id.sql`.
 *
 * **A bucket on a Server is the third parent.** Its Domain routes to
 * its Garage container's S3 API, so presigned URLs and browser uploads work
 * as they do on S3 (ADR-0037). `num_nonnulls(…) = 1` says "exactly one" for
 * three columns as `<>` said it for two; a both-parent row was normalized
 * away by `0063_exactly-one-parent-id.sql` before, so no row fails it.
 *
 * **The parent columns are these three, and `'preview'` is none of them.** `domainType`'s
 * `'preview'` value is wire-parity for the Traefik generators and not a third
 * parent: Phase 25 stores preview hosts on the `preview_deployment` row itself
 * and this table carries no `previewDeploymentId`, so a `'preview'` domain row
 * still hangs off its Application.
 */
export const domainExactlyOneParent = check(
  'domain_exactly_one_parent',
  sql`num_nonnulls("application_id", "compose_id", "bucket_id") = 1`,
);

export const domainTypeEnum = pgEnum('domain_type', [
  'compose',
  'application',
  'preview',
  'bucket',
]);

export type DomainType = (typeof domainTypeEnum.enumValues)[number];

/**
 * Shared by the domain, certificate, console-domain and forward-auth tables.
 * `stored` — a certificate from Settings → Certificates — is a Domain's
 * answer only; the other tables' DTOs still take the first three. A Domain
 * on a Service in a Cloud account takes none of them: its certificate
 * is its own DNS-validated ACM one, the cloud certificate below, and this
 * stays `none`.
 */
export const certificateTypeEnum = pgEnum('certificate_type', [
  'letsencrypt',
  'none',
  'custom',
  'stored',
]);

export type CertificateType = (typeof certificateTypeEnum.enumValues)[number];

/**
 * The cloud certificate kind: where a cloud Domain's own
 * ACM certificate is — requested and waiting for the operator's validation
 * record, the record seen and ACM checking, issued and attached to the load
 * balancer's listener, or failed (ACM refused it, or 72 hours passed
 * without the record).
 */
export const cloudCertificateStatusEnum = pgEnum('cloud_certificate_status', [
  'waiting-for-dns',
  'checking',
  'live',
  'failed',
]);

export type CloudCertificateStatus =
  (typeof cloudCertificateStatusEnum.enumValues)[number];

/** One DNS record as the operator copies it to their DNS provider. */
export interface DnsRecord {
  name: string;
  type: string;
  value: string;
}

export const domain = pgTable(
  'domain',
  {
    domainId: nanoidPk('domain_id'),
    host: text('host').notNull(),
    https: boolean('https').notNull().default(false),
    port: integer('port').default(3000),
    path: text('path').default('/'),
    /** Path prepended before proxying (addprefix middleware). */
    internalPath: text('internal_path').default('/'),
    /** Strip the public path prefix before proxying (stripprefix middleware). */
    stripPath: boolean('strip_path').notNull().default(false),
    /** The compose service the domain routes into (compose domains only). */
    serviceName: text('service_name'),
    domainType: domainTypeEnum('domain_type').default('application'),
    /**
     * Suffixes Traefik router/service/middleware names, so two domains on one app
     * cannot mint the same router.
     *
     * **It is a table-wide `serial`, not per-app** — the name says what it is
     * *for*, not how it is scoped, and the two were confused here before. What
     * makes a router name unique is `appName` in front of it
     * (`${appName}-${uniqueConfigKey}-${entrypoint}` in
     * `createComposeDomainLabels`), so nothing depends on the scoping. Worth
     * knowing for tests: a suite asserting a literal `…-1-…` router name is
     * relying on `resetDb`'s `restart identity` to put the sequence back, not on
     * any per-app numbering.
     */
    uniqueConfigKey: serial('unique_config_key'),
    certificateType: certificateTypeEnum('certificate_type')
      .notNull()
      .default('none'),
    customCertResolver: text('custom_cert_resolver'),
    /** Route on a custom entrypoint instead of web/websecure. */
    customEntrypoint: text('custom_entrypoint'),
    /** Extra middleware names attached verbatim to the router. */
    middlewares: text('middlewares')
      .array()
      .default(sql`ARRAY[]::text[]`),
    forwardAuthEnabled: boolean('forward_auth_enabled')
      .notNull()
      .default(false),
    // A cloud Domain's certificate. Set on every Domain of a Service
    // in a Cloud account and on no other: it is what makes a Domain one.
    cloudCertificateStatus: cloudCertificateStatusEnum(
      'cloud_certificate_status',
    ),
    /** The ACM certificate's ARN, once a Cloud run has requested it. */
    acmCertificateArn: text('acm_certificate_arn'),
    /**
     * On Google Cloud: the Certificate Manager certificate's full
     * name, once the network's Cloud run has made it; its poller asks
     * about it by this. The ACM ARN's twin.
     */
    googleCertificateName: text('google_certificate_name'),
    /** The CNAME ACM validates the host by, as ACM names it. */
    validationRecord: jsonb('validation_record').$type<DnsRecord>(),
    /** When the current certificate was requested: its 72 hours start here. */
    certificateRequestedAt: text('certificate_requested_at'),
    /** When the ACM poller last asked about it. */
    certificateLastPolledAt: text('certificate_last_polled_at'),
    /** When ACM said it was issued; the next Cloud run attaches it. */
    certificateIssuedAt: text('certificate_issued_at'),
    /**
     * Which certificate of this Domain is the current one: Ask again and a
     * new host each request a new one, under a new address in the state.
     */
    certificateAttempt: integer('certificate_attempt').notNull().default(1),
    /** Why the certificate failed, in ACM's words or Cloudgate's. */
    certificateFailure: text('certificate_failure'),
    /** The validation record was seen in DNS: informational, a tick. */
    validationRecordFound: boolean('validation_record_found')
      .notNull()
      .default(false),
    /** The host was seen pointing at the load balancer: informational, a tick. */
    pointsAtLoadBalancer: boolean('points_at_load_balancer')
      .notNull()
      .default(false),
    createdAt: isoTimestamp('created_at'),
    applicationId: text('application_id').references(
      () => application.applicationId,
      { onDelete: 'cascade' },
    ),
    composeId: text('compose_id').references(() => compose.composeId, {
      onDelete: 'cascade',
    }),
    /** A Server bucket's Domain: routed to its Garage's S3 API. */
    bucketId: text('bucket_id').references(() => bucket.bucketId, {
      onDelete: 'cascade',
    }),
  },
  () => [domainExactlyOneParent],
);

export const domainRelations = relations(domain, ({ one }) => ({
  application: one(application, {
    fields: [domain.applicationId],
    references: [application.applicationId],
  }),
  compose: one(compose, {
    fields: [domain.composeId],
    references: [compose.composeId],
  }),
  bucket: one(bucket, {
    fields: [domain.bucketId],
    references: [bucket.bucketId],
  }),
}));

export type Domain = typeof domain.$inferSelect;
