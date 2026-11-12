/**
 * A cloud Service's access to the buckets it links (ADR-0032): on AWS a
 * link is the access, given to the Service's own task role, never a key.
 * Pure: shared by the web definition, which writes each role's inline
 * policy, and the setup template, whose permissions boundary is the most
 * any task role can hold.
 */

/**
 * What a linking Service may do to a bucket's objects (ADR-0032):
 * read, write, delete, and a multipart upload's parts.
 */
export const BUCKET_OBJECT_ACTIONS = [
  's3:GetObject',
  's3:PutObject',
  's3:DeleteObject',
  's3:AbortMultipartUpload',
  's3:ListMultipartUploadParts',
] as const;

/**
 * What it may do on the bucket itself: list its objects and its multipart
 * uploads in progress. Nothing of its settings — policy, CORS, versioning,
 * encryption, tags, deleting it.
 */
export const BUCKET_LIST_ACTIONS = [
  's3:ListBucket',
  's3:ListBucketMultipartUploads',
] as const;

/**
 * The task role's inline policy for the buckets a Service links: its
 * objects' actions on `<bucket>/*`, listing on the bucket, each bucket by
 * its real name and no other. Pure, so the generator's spec reads it.
 */
export function bucketAccessPolicy(buckets: readonly string[]): {
  Version: string;
  Statement: { Effect: 'Allow'; Action: string[]; Resource: string[] }[];
} {
  const names = [...new Set(buckets)].sort();
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: [...BUCKET_OBJECT_ACTIONS],
        Resource: names.map((name) => `arn:aws:s3:::${name}/*`),
      },
      {
        Effect: 'Allow',
        Action: [...BUCKET_LIST_ACTIONS],
        Resource: names.map((name) => `arn:aws:s3:::${name}`),
      },
    ],
  };
}
