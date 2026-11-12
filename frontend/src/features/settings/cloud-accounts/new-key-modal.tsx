import { useState } from "react";

import { FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type {
  GcpCloudAccount,
  GoogleKeyChanged,
  GoogleNewKey,
} from "@/lib/api/endpoints/cloud-accounts";

import { downloadGoogleSetup, downloadNewOnlyJwks } from "./download-template";
import {
  useCheckNewCloudAccountKey,
  useNewCloudAccountKey,
} from "./use-cloud-accounts";

/**
 * Change a Google Cloud account's key, in the order that
 * never locks Cloudgate out:
 *
 * 1. Cloudgate makes a new key pair and hands out a JWKS with **both** public
 *    halves — and the setup script carrying it — to upload to the provider.
 *    It keeps signing with the old key meanwhile.
 * 2. "Check with the new key" runs the connect check signed with it. A
 *    refusal stays in the dialog and changes nothing; a pass switches to the
 *    new key and drops the old one.
 * 3. The dialog then reminds the operator to upload the JWKS holding the new
 *    key alone, and offers it, so the provider stops trusting the old key.
 *
 * A key change already waiting (`hasPendingSigningKey`) can be checked
 * straight away, or replaced by asking for another key.
 */
export function NewKeyModal({
  account,
  onClose,
}: {
  account: GcpCloudAccount;
  onClose: () => void;
}) {
  const make = useNewCloudAccountKey();
  const check = useCheckNewCloudAccountKey();
  const [made, setMade] = useState<GoogleNewKey | null>(null);
  const [changed, setChanged] = useState<GoogleKeyChanged | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const waiting = made !== null || account.hasPendingSigningKey;

  async function makeKey() {
    setRefusal(null);
    try {
      setMade(await make.mutateAsync(account.cloudAccountId));
    } catch (error) {
      setRefusal(errorMessage(error));
    }
  }

  async function checkKey() {
    setRefusal(null);
    try {
      setChanged(await check.mutateAsync(account.cloudAccountId));
    } catch (error) {
      setRefusal(errorMessage(error));
    }
  }

  if (changed) {
    const keyId = changed.cloudAccount.signingKeyId;
    return (
      <Modal open onOpenChange={(next) => !next && onClose()}>
        <Modal.Header
          title={`${account.name} signs with its new key`}
          description="The old key is dropped from Cloudgate."
        />
        <Modal.Body>
          <p className="rounded-lg border border-warn-line bg-warn-tint px-3 py-2.5 text-meta text-tx wrap-anywhere">
            {changed.message}.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() =>
                downloadNewOnlyJwks(account.cloudAccountId, keyId, changed.jwks)
              }
            >
              Download the new-only JWKS
            </Button>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Button type="button" variant="pri" onClick={onClose}>
            Done
          </Button>
        </Modal.Footer>
      </Modal>
    );
  }

  return (
    <Modal open onOpenChange={(next) => !next && onClose()} keepOpen={waiting}>
      <Modal.Header
        title={`New key for ${account.name}`}
        description="Cloudgate keeps signing with the current key until a check signed with the new one passes."
      />
      <Modal.Body>
        {made ? (
          <>
            <ol className="list-decimal space-y-1.5 pl-5 text-meta text-tx-2">
              <li>
                Upload the JWKS with both keys to provider{" "}
                <span className="font-mono text-tx wrap-anywhere">
                  {account.workloadIdentityProvider}
                </span>
                , or run the setup script again: it updates the provider.
              </li>
              <li>Check with the new key.</li>
            </ol>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() =>
                  downloadGoogleSetup(
                    account.cloudAccountId,
                    made.template,
                    "jwks",
                  )
                }
              >
                Download the JWKS with both keys
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() =>
                  downloadGoogleSetup(
                    account.cloudAccountId,
                    made.template,
                    "script",
                  )
                }
              >
                Download the setup script
              </Button>
            </div>
            <div className="flex items-center gap-2 text-meta text-tx-2">
              <span>New key id</span>
              <span className="font-mono text-tx wrap-anywhere">
                {made.signingKeyId}
              </span>
            </div>
          </>
        ) : (
          <p className="text-body text-tx-2">
            {account.hasPendingSigningKey
              ? "A new key is already waiting for its check. Check with it, or make another in its place."
              : "Cloudgate makes a new key pair and hands out a JWKS with both public halves, to upload to the provider."}
          </p>
        )}
        <FormError message={refusal ?? undefined} />
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button type="button">Cancel</Button>} />
        {made ? null : (
          <Button
            type="button"
            variant={account.hasPendingSigningKey ? undefined : "pri"}
            disabled={make.isPending}
            aria-busy={make.isPending || undefined}
            onClick={makeKey}
          >
            Make a new key
          </Button>
        )}
        {waiting ? (
          <Button
            type="button"
            variant="pri"
            disabled={check.isPending}
            aria-busy={check.isPending || undefined}
            onClick={checkKey}
          >
            {check.isPending
              ? "Checking the new key…"
              : "Check with the new key"}
          </Button>
        ) : null}
      </Modal.Footer>
    </Modal>
  );
}
