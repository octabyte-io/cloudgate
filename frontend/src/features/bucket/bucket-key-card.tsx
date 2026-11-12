import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Card } from "@/components/console/card";
import { FormError } from "@/components/console/field";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import {
  bucketsApi,
  type Bucket,
  type KeyRotation,
  type KeyRotationRedeploy,
} from "@/lib/api/endpoints/buckets";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { usePermission } from "@/lib/auth/use-permission";
import { timeExact } from "@/lib/format/time";

/** Why Rotate key is off, for a role the route would refuse. */
export const ROTATE_REFUSAL =
  "Your role cannot rotate this bucket's key — that needs service update.";

/**
 * A bucket's **Rotate key** (ADR-0037) — the key itself is shown only
 * as "Set", on the facts card (ADR-0019): a rotation that makes a new key, redeploys
 * every Service linking it with that key, and removes the old one only once
 * they all succeeded. `POST /buckets/:id/rotate-key`, `service: ['update']`.
 * On Google Cloud the key is the bucket's own service account's
 * HMAC key, made and deleted by short Cloud runs of the bucket.
 * The rotation runs after the press answers; its progress and its end —
 * naming a Service whose redeploy failed — are read back from the bucket.
 */
export function BucketKeyCard({ bucket }: { bucket: Bucket }) {
  const invalidate = useInvalidate();
  const canUpdate = usePermission({ service: ["update"] });
  const [confirming, setConfirming] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const rotate = useMutation({
    mutationFn: () => bucketsApi.rotateKey(bucket.bucketId),
    onSettled: () => invalidate.bucket(bucket.bucketId),
  });
  const rotation = bucket.keyRotation;
  const running = rotation?.status === "running";
  const onGoogle =
    bucket.place.kind === "cloud" && bucket.place.cloud === "gcp";
  const unavailable = !canUpdate.allowed
    ? ROTATE_REFUSAL
    : !bucket.hasKey
      ? onGoogle
        ? "This bucket's Cloud run makes its key with it; there is none to rotate yet."
        : "Garage makes this bucket's key on its first deploy; there is none to rotate yet."
      : running
        ? "A rotation of this key is running."
        : null;

  async function confirm() {
    setConfirming(false);
    setRefusal(null);
    try {
      await rotate.mutateAsync();
      toast.done(`Rotating ${bucket.configName}'s key.`);
    } catch (error) {
      setRefusal(errorMessage(error));
    }
  }

  return (
    <Card>
      <Card.Header
        title="Key"
        sub="The one key every Service linking this bucket reads and writes it with."
        headingLevel={2}
        actions={
          <Button
            type="button"
            disabled={
              !canUpdate.allowed || unavailable !== null || rotate.isPending
            }
            title={unavailable ?? undefined}
            onClick={() => setConfirming(true)}
          >
            Rotate key
          </Button>
        }
      />
      <Card.Body className="grid gap-3.5">
        <KVList>
          <KVRow
            label="Last rotation"
            value={rotation ? rotationLine(rotation) : "Never rotated"}
            title={rotation ? rotationLine(rotation) : "Never rotated"}
          />
        </KVList>
        {rotation ? <RotationDetail rotation={rotation} /> : null}
        <FormError message={refusal ?? undefined} />
      </Card.Body>
      <Modal open={confirming} onOpenChange={setConfirming}>
        <Modal.Header
          title={`Rotate ${bucket.configName}'s key?`}
          description="Every Service that links this bucket's key is deployed again with a new one."
        />
        <Modal.Body>
          <ul className="flex flex-col gap-2 text-body text-tx-2">
            <li>
              {onGoogle
                ? "Cloudgate makes a new HMAC key for the bucket's own service account, beside the one in use."
                : "Garage makes a new key, read and write on this bucket only."}
            </li>
            <li>
              Each Service linking the key is redeployed with it. The old key
              keeps working meanwhile.
            </li>
            <li>
              Only once every redeploy succeeded is the old key{" "}
              {onGoogle ? "turned off and deleted" : "removed"}. If one fails,
              the old key stays, the new one is removed and the Service is
              named.
            </li>
          </ul>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Cancel</Button>} />
          <Button
            type="button"
            variant="pri"
            disabled={!canUpdate.allowed}
            onClick={() => void confirm()}
          >
            Rotate key
          </Button>
        </Modal.Footer>
      </Modal>
    </Card>
  );
}

/** The rotation in one line: running, or how and when it ended. */
function rotationLine(rotation: KeyRotation): string {
  if (rotation.status === "running") {
    return rotation.phase === "putting-back"
      ? "Failed — putting Services back on the old key"
      : "Running — redeploying the Services that link it";
  }
  const at = rotation.finishedAt
    ? ` ${timeExact(rotation.finishedAt) ?? rotation.finishedAt}`
    : "";
  return rotation.status === "done" ? `Done${at}` : `Failed${at}`;
}

/** Each redeploy and how it is going, and the sentence an ended one left. */
function RotationDetail({ rotation }: { rotation: KeyRotation }) {
  const putting = rotation.phase === "putting-back";
  const shown = putting ? rotation.putBacks : rotation.redeploys;
  return (
    <div className="grid gap-2">
      {rotation.message ? (
        <p
          className={
            rotation.status === "failed"
              ? "text-body text-bad"
              : "text-body text-tx-2"
          }
        >
          {rotation.message}
        </p>
      ) : null}
      {rotation.status === "running" && shown.length > 0 ? (
        <ul
          className="grid gap-1"
          aria-label={putting ? "Put back on the old key" : "Redeploys"}
        >
          {shown.map((one) => (
            <li
              key={`${one.serviceType}-${one.serviceId}`}
              className="flex justify-between gap-3 text-body"
            >
              <span className="font-mono">{one.configName}</span>
              <span className="text-tx-2">{outcomeWord(one)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function outcomeWord(one: KeyRotationRedeploy): string {
  if (one.outcome === "done") return "Deployed";
  if (one.outcome === "failed") return "Failed";
  return "Deploying";
}
