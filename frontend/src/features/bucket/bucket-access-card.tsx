import { Card } from "@/components/console/card";
import { CopyButton } from "@/components/console/copy-button";
import { KVList, KVRow } from "@/components/console/kv-list";
import type { BucketGoogleAccess } from "@/lib/api/endpoints/buckets";
import { timeExact } from "@/lib/format/time";

/** What each access status reads as on the page. */
const ACCESS_WORDS: Record<BucketGoogleAccess["status"], string> = {
  waiting: "Waiting for access",
  ok: "Its key reaches the bucket",
  "no-access": "No access",
};

/**
 * An existing bucket on Google Cloud's access (ADR-0033 as
 * amended): Cloudgate never adds the grant, so the page shows the exact line
 * the operator runs and whether a list of one file made with the bucket's
 * key last succeeded. Read again each time the page is. Linked Services
 * deploy whatever it says.
 */
export function BucketAccessCard({
  bucketName,
  access,
}: {
  bucketName: string;
  access: BucketGoogleAccess;
}) {
  return (
    <Card>
      <Card.Header title="Access" headingLevel={2} />
      <Card.Body>
        <KVList>
          <KVRow label="Status" value={ACCESS_WORDS[access.status]} title={ACCESS_WORDS[access.status]} />
          <KVRow
            label="Key's service account"
            value={access.serviceAccount}
            title={access.serviceAccount}
            mono
            action={
              <CopyButton value={access.serviceAccount} label="service account" />
            }
          />
          {access.checkedAt ? (
            <KVRow label="Checked" value={timeExact(access.checkedAt)} title={timeExact(access.checkedAt)} />
          ) : null}
        </KVList>
        {access.sentence ? (
          <p className="mt-3.5 text-body text-tx">{access.sentence}</p>
        ) : null}
        <p className="mt-3.5 text-meta text-tx-2">
          Grant its key read and write on {bucketName}; Cloudgate never changes
          the bucket itself:
        </p>
        <div className="mt-1 flex items-start gap-2">
          <p className="min-w-0 flex-1 font-mono text-meta break-all text-tx">
            {access.grant}
          </p>
          <CopyButton value={access.grant} label="grant command" />
        </div>
      </Card.Body>
    </Card>
  );
}
