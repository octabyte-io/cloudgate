/**
 * Where an S3 client reaches Cloud Storage with an HMAC key (ADR-0032 as
 * amended): its XML API at `host`, addressed
 * path-style, signed for region `auto` whatever the bucket's location. The
 * one definition of it: a bucket's Outputs hand a linked Service this
 * (`wired-env.ts`), and an existing bucket's access check reaches it the
 * same way through the object-storage port.
 */
export const CLOUD_STORAGE_S3 = {
  host: 'storage.googleapis.com',
  endpoint: 'https://storage.googleapis.com',
  region: 'auto',
} as const;
