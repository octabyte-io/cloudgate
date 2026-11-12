import type { SourceAddress } from '../project-config/outputs/outputs';
import { GARAGE_S3_PORT } from './garage';

/** One of a bucket's Domains, as its address is read off it. */
export interface BucketDomain {
  readonly host: string;
  readonly https: boolean;
  readonly createdAt: string;
  /** The table-wide serial, which orders two Domains made in one instant. */
  readonly uniqueConfigKey: number;
}

/**
 * Where a Service reaches a bucket on a Server (ADR-0037), which the
 * Outputs module builds its `endpoint` from: its Domain while it has one,
 * so a presigned URL the Service hands a browser, and a browser upload,
 * resolve from the internet as they do on S3; with every Domain removed,
 * its Garage's S3 API inside the Server's network. Of several Domains, the
 * oldest, so adding one never moves `endpoint`. A Domain is reached on its
 * scheme's default port, `https` when it has HTTPS on. Pure.
 */
export function bucketAddress(
  appName: string,
  domains: readonly BucketDomain[],
): SourceAddress {
  const [first] = [...domains].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      a.uniqueConfigKey - b.uniqueConfigKey,
  );
  if (first) {
    return {
      host: first.host,
      port: first.https ? 443 : 80,
      tls: first.https,
      ca: null,
    };
  }
  // A Server reports no CA bundle, so `ca` is never among these Outputs.
  return { host: appName, port: GARAGE_S3_PORT, tls: false, ca: null };
}
