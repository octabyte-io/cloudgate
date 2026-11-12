import { relations, sql } from 'drizzle-orm';
import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { Leftover } from '../cloud-accounts/aws/delete-check';
import { cloudAccount } from '../cloud-accounts/cloud-account.schema';
import type { GoogleLeftover } from '../cloud-accounts/gcp/delete-check';
import type { NetworkLinkKind } from '../cloud-accounts/definitions/network-links';
import { isoTimestamp, nanoidPk } from '../db/columns';
import type { DnsRecord } from '../domains/domain.schema';
import { environment } from './environment.schema';

/**
 * Where an Environment network is in its life (ADR-0038):
 *
 * - `creating`: an Apply is making it; its Deployment is the network's run.
 * - `ready`: made, its ids saved; a Service's definition reads them.
 * - `create-failed`: the run that was making it ended without its ids. What
 *   it made stays in its Infrastructure state, so the next plan lists the
 *   network again and its Apply runs against that same state rather than a
 *   new one, so nothing is made twice.
 * - `deleting` and `delete-incomplete`: its removal, the second
 *   with the row's `leftovers` naming what it left.
 */
export const environmentNetworkStatusEnum = pgEnum(
  'environment_network_status',
  ['creating', 'ready', 'create-failed', 'deleting', 'delete-incomplete'],
);

/** What a network's removal leaves: in AWS, or in Google Cloud. */
export type NetworkLeftover = Leftover | GoogleLeftover;

export type EnvironmentNetworkStatus =
  (typeof environmentNetworkStatusEnum.enumValues)[number];

/**
 * An **Environment network** (CONTEXT.md): the VPC, subnets and
 * load balancer one Environment's cloud Services share in one Cloud account
 * and region, at most one per (Environment, Cloud account, region).
 *
 * A plan reads this table to know whether a cloud `web` it creates needs the
 * network made first: no row, or one whose create failed, and the plan
 * carries a network step and writes the Service's definition with stand-in
 * ids. The row is written by the Apply that makes it, `creating`
 * until its run ends, and is the **Deployment parent** that run is recorded
 * under (ADR-0017). The saved ids are that run's outputs, not secrets, and
 * `null` until it saves them; a Service's definition reads them back in
 * place of the stand-ins.
 *
 * Neither key cascades: the network's AWS resources outlive nothing by
 * accident. The Cloud account's Delete is refused while a row names it;
 * the Environment's Delete removes the network itself, after its
 * cloud Services, and drops the row only once AWS is clean or the operator
 * Forgets it (ADR-0038).
 */
export const environmentNetwork = pgTable(
  'environment_network',
  {
    environmentNetworkId: nanoidPk('environment_network_id'),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environment.environmentId, { onDelete: 'no action' }),
    cloudAccountId: text('cloud_account_id')
      .notNull()
      .references(() => cloudAccount.cloudAccountId, {
        onDelete: 'no action',
      }),
    region: text('region').notNull(),
    status: environmentNetworkStatusEnum('status')
      .notNull()
      .default('creating'),
    vpcId: text('vpc_id'),
    /** The two public subnets, one per zone, that tasks run in. */
    publicSubnetIds: jsonb('public_subnet_ids').$type<[string, string]>(),
    /** The two private subnets, empty until slice 4's databases. */
    privateSubnetIds: jsonb('private_subnet_ids').$type<[string, string]>(),
    clusterArn: text('cluster_arn'),
    albArn: text('alb_arn'),
    /** The load balancer's address, which an operator's DNS record points at. */
    albDnsName: text('alb_dns_name'),
    albZoneId: text('alb_zone_id'),
    httpsListenerArn: text('https_listener_arn'),
    albSecurityGroupId: text('alb_security_group_id'),
    /** The self-signed certificate the HTTPS listener answers with by default. */
    defaultCertificateArn: text('default_certificate_arn'),
    /**
     * The Cloud Map private DNS namespace its Private web services are
     * listed in, saved by the Apply that adds it. Null until the
     * first `web-private` needs it, and on Google Cloud.
     */
    privateDnsNamespaceId: text('private_dns_namespace_id'),
    /*
     * A Google network's outputs, saved by its Apply as the
     * AWS ids above are; every one null on AWS, and the AWS ones null here.
     */
    /** Its VPC network's name, which a Service's Direct VPC egress joins. */
    networkName: text('network_name'),
    /** Its one subnet's name. */
    subnetName: text('subnet_name'),
    /** The load balancer's fixed global IP, which a Domain's `A` record points at. */
    ipAddress: text('ip_address'),
    /** The URL map that holds every Domain's host rule. */
    urlMapName: text('url_map_name'),
    /** The certificate map the HTTPS proxy serves from. */
    certificateMapName: text('certificate_map_name'),
    /**
     * The parts the network gains only once a Service needs them, each
     * added by the Apply of the first plan that creates such a Service and
     * kept until the network goes, so every later run of the network writes
     * it again (`network-links.ts`): on Google Cloud the private link of a
     * kind of database (the spec's "The private link"), on AWS the
     * private DNS namespace of its Private web services. Empty on a
     * network nothing has needed one of yet.
     */
    privateLinks: jsonb('private_links')
      .$type<NetworkLinkKind[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * What a removal could not take away, each named for the operator, while
     * the network is `delete-incomplete` (ADR-0038). Empty otherwise.
     */
    leftovers: jsonb('leftovers')
      .$type<NetworkLeftover[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /*
     * Google's subnet hold (the spec's "The subnet hold", S13): Google
     * keeps a used subnet 1–2 hours after its services are gone, so a
     * removal it refuses for that keeps the network `delete-incomplete` and
     * Cloudgate tries again by itself. Both null on AWS, and on a network
     * Google holds nothing of; a Retry by hand clears both.
     */
    /**
     * When Cloudgate's own next try is due, an ISO timestamp: the once-a-
     * minute sweep, armed at start-up, queues a removal once it has passed.
     * Null once no try of its own is left.
     */
    holdNextTryAt: text('hold_next_try_at'),
    /**
     * How many of Cloudgate's own tries are left (2, then 1, then 0, when it
     * waits for Retry or Forget); null when Google holds nothing.
     */
    holdTriesLeft: integer('hold_tries_left'),
    /**
     * The DNS records the Domains of the Services that ran in it left at the
     * operator's DNS provider, gathered as each such Service's row went:
     * Cloudgate never writes DNS, so removing the network names them
     * once more, when nothing else still knows them.
     */
    dnsRecordsLeft: jsonb('dns_records_left')
      .$type<DnsRecord[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: isoTimestamp('created_at'),
  },
  (table) => [
    uniqueIndex('environment_network_place_unique').on(
      table.environmentId,
      table.cloudAccountId,
      table.region,
    ),
  ],
);

export const environmentNetworkRelations = relations(
  environmentNetwork,
  ({ one }) => ({
    environment: one(environment, {
      fields: [environmentNetwork.environmentId],
      references: [environment.environmentId],
    }),
    cloudAccount: one(cloudAccount, {
      fields: [environmentNetwork.cloudAccountId],
      references: [cloudAccount.cloudAccountId],
    }),
  }),
);

export type EnvironmentNetwork = typeof environmentNetwork.$inferSelect;
