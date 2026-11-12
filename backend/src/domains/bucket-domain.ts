import { GARAGE_S3_PORT } from '../buckets/garage';

/**
 * A Domain on a bucket on a Server (ADR-0037): Traefik routes its whole
 * host to the bucket's Garage S3 API, so a presigned URL or a browser upload
 * signed for `https://<host>/<bucket>/<key>` reaches Garage with the host and
 * path it was signed for. Pure: which fields such a Domain refuses.
 */

/** The fields a bucket's Domain is checked on: the row as it will be stored. */
export interface BucketDomainFields {
  port?: number | null;
  path?: string | null;
  internalPath?: string | null;
  stripPath?: boolean | null;
  serviceName?: string | null;
  forwardAuthEnabled?: boolean | null;
}

/**
 * Why a bucket's Domain cannot be stored as it is, naming the field, or
 * `null`. A path, a rewritten path or a sign-in in front of Garage would
 * each break the signature of every S3 request through it, and the port is
 * Garage's S3 API, the only one it answers on.
 */
export function bucketDomainRefusal(row: BucketDomainFields): string | null {
  const refused = (field: string, why: string) =>
    `${field}: ${why} on a bucket's Domain, which routes its whole host to Garage's S3 API`;
  if (row.port != null && row.port !== GARAGE_S3_PORT) {
    return refused('port', `the port is always ${GARAGE_S3_PORT}`);
  }
  if (row.path != null && row.path !== '/') {
    return refused(
      'path',
      'a path breaks every signed request and is not available',
    );
  }
  if (row.internalPath != null && row.internalPath !== '/') {
    return refused('internalPath', 'a rewritten path is not available');
  }
  if (row.stripPath) {
    return refused('stripPath', 'a rewritten path is not available');
  }
  if (row.serviceName != null && row.serviceName !== '') {
    return refused('serviceName', 'a compose service is not available');
  }
  if (row.forwardAuthEnabled) {
    return refused(
      'forwardAuthEnabled',
      'an S3 client cannot sign in, so forward auth is not available',
    );
  }
  return null;
}
