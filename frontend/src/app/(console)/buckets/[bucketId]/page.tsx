import type { Metadata } from "next";

import { BucketScreen } from "@/features/bucket/bucket-screen";

/**
 * A Bucket's page. Not a tab scope: a bucket has one view, its facts,
 * and nothing to edit outside the Project config.
 */
type Props = { params: Promise<{ bucketId: string }> };

export const metadata: Metadata = { title: "Bucket" };

export default async function Page({ params }: Props) {
  const { bucketId } = await params;
  return <BucketScreen bucketId={bucketId} />;
}
