import type { AcmCertificate } from '../cloud-accounts/cloud.port';
import type { GoogleCertificate } from '../cloud-accounts/google-cloud.port';
import type {
  CertificateType,
  CloudCertificateStatus,
  DnsRecord,
} from './domain.schema';

/**
 * A Domain on a cloud `web` ("Domains"), apart from the
 * runs and the poller that act on it: which fields it refuses, the DNS
 * records the operator is shown, and how its certificate moves from one
 * status to the next. Pure: no database, no AWS.
 */

/** The cloud a Domain is on, as its refusals name it. */
export type DomainCloudName = 'AWS' | 'Google Cloud';

/** HTTPS off on a cloud Domain (on Google Cloud). */
export function alwaysHttps(cloud: DomainCloudName): string {
  return `Domains on ${cloud} are always HTTPS`;
}

/** HTTPS off on a Domain on AWS. */
export const ALWAYS_HTTPS = alwaysHttps('AWS');

/**
 * AWS's quota of certificates on one Application Load Balancer, besides its
 * default one. An Environment's cloud Services share one load balancer
 * so this is per Environment.
 */
export const CERTIFICATES_PER_LOAD_BALANCER = 25;

/** The refusal of one Domain too many, naming the quota and how to raise it. */
export const QUOTA_REFUSAL = `This Environment's load balancer already holds ${CERTIFICATES_PER_LOAD_BALANCER} Domain certificates, AWS's "Certificates per Application Load Balancer" quota. Raise it in the AWS console under Service Quotas → Elastic Load Balancing, then add the Domain again`;

/** How long a requested certificate waits for its validation record. */
export const CERTIFICATE_WAIT_HOURS = 72;

const MINUTE = 60_000;
/** For this long after a request ACM is asked about once a minute… */
const FAST_POLL_MS = 30 * MINUTE;
/** …and afterwards about every 10 minutes. */
const SLOW_POLL_INTERVAL_MS = 10 * MINUTE;
/** Slack under each interval, so a tick a second early still asks. */
const TICK_SLACK_MS = 5_000;

/** The fields a cloud Domain is checked on: the row as it will be stored. */
export interface CloudDomainFields {
  https?: boolean | null;
  certificateType?: CertificateType | null;
  customCertResolver?: string | null;
  customEntrypoint?: string | null;
  middlewares?: string[] | null;
  forwardAuthEnabled?: boolean | null;
  stripPath?: boolean | null;
  internalPath?: string | null;
}

/**
 * Why a cloud Domain cannot be stored as it is, naming the field, or `null`.
 * Each refused field is something Traefik does on a Server that the cloud's
 * load balancer does not; the certificate is always the Domain's own one,
 * ACM's on AWS and Google-managed on Google Cloud.
 */
export function cloudDomainRefusal(
  row: CloudDomainFields,
  cloud: DomainCloudName = 'AWS',
): string | null {
  const notOnAws = (field: string, what: string) =>
    `${field}: ${what} is not available on a Domain on ${cloud}`;
  if (row.https === false) return alwaysHttps(cloud);
  if (row.forwardAuthEnabled)
    return notOnAws('forwardAuthEnabled', 'Forward auth');
  if (row.middlewares && row.middlewares.length > 0) {
    return notOnAws('middlewares', 'A custom middleware');
  }
  if (row.customEntrypoint) {
    return notOnAws('customEntrypoint', 'A custom entrypoint');
  }
  if (row.stripPath) return notOnAws('stripPath', 'Strip path');
  if (row.internalPath && row.internalPath !== '/') {
    return notOnAws('internalPath', 'An internal path');
  }
  if (row.certificateType && row.certificateType !== 'none') {
    return `certificateType: a Domain on ${cloud} has its own ${cloud === 'AWS' ? 'ACM' : 'Google-managed'} certificate, which Cloudgate requests; a ${row.certificateType === 'letsencrypt' ? "Let's Encrypt" : row.certificateType} certificate is not available`;
  }
  if (row.customCertResolver) {
    return notOnAws('customCertResolver', 'A certificate resolver');
  }
  return null;
}

/** Basic auth on a Service in a Cloud account. */
export const BASIC_AUTH_REFUSAL =
  'basicAuth: Basic auth is not available on a Service on AWS; its Domains are served by an AWS load balancer';

/**
 * A redirect on a Service in a Cloud account. A redirect is a Traefik
 * middleware on the Service's routers, and such a Service's Domains are
 * served by its cloud's load balancer, which Cloudgate gives no redirects.
 */
export const REDIRECTS_REFUSAL =
  "redirects: Redirects are not available on a Service in a Cloud account; its Domains are served by its cloud's load balancer, not by Traefik";

/**
 * Two-part public suffixes under which a name of three labels is still bare
 * (`example.co.uk`). Enough for the instruction to be right for the common
 * cases; a name it misses is shown the CNAME, which its DNS provider refuses
 * at the apex, saying so.
 */
const SECOND_LEVELS = new Set(['co', 'com', 'net', 'org', 'gov', 'ac', 'edu']);

/** A bare (apex) name: one with no label in front of the registered name. */
export function isBareName(host: string): boolean {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length <= 2) return true;
  return (
    labels.length === 3 &&
    labels[2].length === 2 &&
    SECOND_LEVELS.has(labels[1])
  );
}

/** A record to copy, and whether Cloudgate has seen it in DNS. */
export interface RecordToCopy extends DnsRecord {
  seen: boolean;
}

/** The record pointing the host at the load balancer. */
export interface PointingRecord extends RecordToCopy {
  /** What to make at a DNS provider, and what never to. */
  note: string;
}

/**
 * What a cloud Service's Domains point at: the Environment network's load
 * balancer, or a `static` site's own CloudFront distribution,
 * by its DNS name; on Google Cloud, the network's load balancer by its
 * fixed IP, which lives as long as the network does.
 */
export interface PointTarget {
  readonly dnsName: string;
  readonly kind: 'load-balancer' | 'cloudfront' | 'fixed-ip';
}

/** How the records name what a Domain points at. */
const TARGET_WORDS: Record<
  PointTarget['kind'],
  { what: string; whose: string }
> = {
  'load-balancer': {
    what: 'the load balancer',
    whose: "the load balancer's",
  },
  cloudfront: {
    what: 'the CloudFront distribution',
    whose: "CloudFront's",
  },
  'fixed-ip': {
    what: "the load balancer's fixed IP",
    whose: "the load balancer's",
  },
};

/**
 * The record pointing a host at what serves it: on Google Cloud an `A`
 * record to the fixed IP, a bare name alike; on AWS a CNAME,
 * or an ALIAS for a bare name, since AWS's addresses change.
 */
function pointingType(host: string, kind: PointTarget['kind']): string {
  if (kind === 'fixed-ip') return 'A';
  return isBareName(host) ? 'ALIAS' : 'CNAME';
}

/**
 * The two records a cloud Domain needs at the operator's DNS provider:
 * ACM's validation CNAME, once ACM has named it, and the host
 * pointing at the load balancer, or at a `static` site's distribution.
 * Cloudgate never writes DNS.
 */
export function dnsRecordsOf(
  row: {
    host: string;
    validationRecord: DnsRecord | null;
    validationRecordFound: boolean;
    pointsAtLoadBalancer: boolean;
  },
  dnsName: string,
  kind: PointTarget['kind'] = 'load-balancer',
): { validation: RecordToCopy | null; pointing: PointingRecord } {
  const bare = isBareName(row.host);
  const { what, whose } = TARGET_WORDS[kind];
  return {
    validation: row.validationRecord
      ? { ...row.validationRecord, seen: row.validationRecordFound }
      : null,
    pointing: {
      name: row.host,
      type: pointingType(row.host, kind),
      value: dnsName,
      seen: row.pointsAtLoadBalancer,
      note:
        kind === 'fixed-ip'
          ? `An A record to ${what}, which stays as long as the Environment network does`
          : bare
            ? `${row.host} is a bare name, which cannot be a CNAME: make it an ALIAS, ANAME or flattened CNAME to ${what}, whichever your DNS provider offers — never an A record, because ${whose} addresses change`
            : `A CNAME to ${what} — never an A record, because ${whose} addresses change`,
    },
  };
}

/** The records a removed Domain leaves at the operator's DNS provider. */
export function recordsLeftBehind(
  row: { host: string; validationRecord: DnsRecord | null },
  albDnsName: string | null,
  kind: PointTarget['kind'] = 'load-balancer',
): DnsRecord[] {
  return [
    ...(row.validationRecord ? [row.validationRecord] : []),
    {
      name: row.host,
      type: pointingType(row.host, kind),
      value: albDnsName ?? 'the load balancer',
    },
  ];
}

/** When a requested certificate stops waiting (72 hours). */
export function certificateDeadline(requestedAt: string): Date {
  return new Date(
    Date.parse(requestedAt) + CERTIFICATE_WAIT_HOURS * 60 * MINUTE,
  );
}

/**
 * Whether the poller asks ACM about a certificate on this tick: about once a
 * minute for the first half hour after its request, then about every 10
 * minutes.
 */
export function certificatePollDue(
  row: {
    certificateRequestedAt: string | null;
    certificateLastPolledAt: string | null;
  },
  now: Date,
): boolean {
  if (!row.certificateRequestedAt) return false;
  if (!row.certificateLastPolledAt) return true;
  const since = now.getTime() - Date.parse(row.certificateLastPolledAt);
  const age = now.getTime() - Date.parse(row.certificateRequestedAt);
  const interval = age < FAST_POLL_MS ? MINUTE : SLOW_POLL_INTERVAL_MS;
  return since >= interval - TICK_SLACK_MS;
}

/** What one poll makes of a certificate. */
export interface CertificateState {
  status: CloudCertificateStatus;
  /** ACM has issued it; a run attaches it, and then it is live. */
  issued: boolean;
  failure: string | null;
}

/**
 * A certificate's next status from what ACM said and whether its validation
 * record is in DNS. **Issued** stays `checking` until a run has put it on the
 * listener: only then is the Domain live.
 */
export function nextCertificateState(
  row: { certificateRequestedAt: string | null },
  acm: AcmCertificate,
  validationSeen: boolean,
  now: Date,
): CertificateState {
  if (acm.status === 'ISSUED') {
    return { status: 'checking', issued: true, failure: null };
  }
  if (acm.status !== 'PENDING_VALIDATION') {
    return {
      status: 'failed',
      issued: false,
      failure: `ACM ended the certificate ${acm.status}${acm.reason ? ` (${acm.reason})` : ''}. Ask again requests a new one`,
    };
  }
  if (
    row.certificateRequestedAt &&
    now.getTime() >= certificateDeadline(row.certificateRequestedAt).getTime()
  ) {
    return {
      status: 'failed',
      issued: false,
      failure: `ACM saw no validation record within ${CERTIFICATE_WAIT_HOURS} hours. Add the record, then Ask again`,
    };
  }
  return {
    status: validationSeen ? 'checking' : 'waiting-for-dns',
    issued: false,
    failure: null,
  };
}

/**
 * A Google-managed certificate's next status (S5), from what
 * Certificate Manager said and whether its authorization CNAME is in DNS.
 * Its map entry serves it from the Domain's own run, so **active is live**:
 * no second run attaches it, as one does on AWS.
 */
export function nextGoogleCertificateState(
  row: { certificateRequestedAt: string | null },
  certificate: GoogleCertificate,
  validationSeen: boolean,
  now: Date,
): CertificateState {
  if (certificate.state === 'ACTIVE') {
    return { status: 'live', issued: true, failure: null };
  }
  if (certificate.state === 'FAILED') {
    return {
      status: 'failed',
      issued: false,
      failure: `Google Cloud ended the certificate FAILED${certificate.reason ? ` (${certificate.reason})` : ''}. Ask again requests a new one`,
    };
  }
  if (
    row.certificateRequestedAt &&
    now.getTime() >= certificateDeadline(row.certificateRequestedAt).getTime()
  ) {
    return {
      status: 'failed',
      issued: false,
      failure: `Google Cloud saw no authorization record within ${CERTIFICATE_WAIT_HOURS} hours${certificate.reason ? ` (${certificate.reason})` : ''}. Add the record, then Ask again`,
    };
  }
  return {
    status: validationSeen ? 'checking' : 'waiting-for-dns',
    issued: false,
    failure: null,
  };
}

/**
 * A Domain refused past a Certificate Manager quota (S5): the
 * quota as Google's refusal names it, never a number of Cloudgate's own,
 * and what to do; `null` for any other refusal. The walk confirms Google's
 * exact words.
 */
export function googleQuotaRefusal(message: string): string | null {
  if (
    !/quota/i.test(message) ||
    !/\b429\b|RESOURCE_EXHAUSTED|QUOTA_EXCEEDED|exceeded/i.test(message)
  ) {
    return null;
  }
  const limit = /\blimit '([^']+)'/i.exec(message)?.[1];
  const metric = /quota metric '([^']+)'/i.exec(message)?.[1];
  const quota = /\bquota '([^']+)'/i.exec(message)?.[1];
  const service = /of service '([^']+)'/i.exec(message)?.[1];
  const count = /\bLimit:\s*(\d+)/i.exec(message)?.[1];
  const named = limit ?? quota ?? metric;
  const then =
    'Ask Google for more in the Google Cloud console under IAM & Admin → Quotas, or remove a Domain, then Ask again';
  if (!named) {
    return `Google Cloud refused the Domain's certificate past a quota: "${message.trim()}". ${then}`;
  }
  return `Google Cloud refused the Domain's certificate: its quota "${named}"${service ? ` of ${service}` : ''}${count ? `, ${count},` : ''} is reached. ${then}`;
}

/** Whether a DNS answer names `target` (trailing dot and case aside). */
export function dnsNames(answer: readonly string[], target: string): boolean {
  const plain = (name: string) => name.toLowerCase().replace(/\.$/, '');
  return answer.some((name) => plain(name) === plain(target));
}
