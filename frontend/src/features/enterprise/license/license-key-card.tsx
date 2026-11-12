import { useState } from "react";

import { Card } from "@/components/console/card";
import { CopyButton } from "@/components/console/copy-button";
import { Skeleton } from "@/components/console/skeleton";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/design/icons";

import { useActivateLicense, useValidateLicense } from "../use-license";
import {
  ActivateForm,
  licenseKeySchema,
  maskKey,
  type LicenseKeyValues,
} from "./activate-license-form";
import { CheckKeyModal } from "./check-key-modal";

/**
 * The licence key: paste one, check the one that is stored, or read it back.
 *
 * ## The stored key is masked, and that is not theatre
 *
 * `getEnterpriseSettings` returns the key in plain text so a form can prefill
 * with it. That is the route's job — it is
 * owner-only, and it is the key that owner pasted in. But it is still a purchase
 * credential sitting in a query cache, and the question somebody actually has on
 * this screen is *which* key is active, which the last four characters answer.
 * So it is masked with a reveal, the same treatment F08 gave a variable.
 *
 * What activation does with the licence server is `activate-license-form.tsx`, and
 * why checking a stored key is a confirmed action is `check-key-modal.tsx`.
 */
export function LicenseKeyCard({
  loading,
  optedIn,
  storedKey,
}: {
  loading: boolean;
  optedIn: boolean;
  storedKey: string;
}) {
  const activate = useActivateLicense();
  const validate = useValidateLicense();
  const [revealed, setRevealed] = useState(false);
  const [checking, setChecking] = useState(false);

  const form = useApiForm<LicenseKeyValues>({
    schema: licenseKeySchema,
    defaultValues: { licenseKey: "" },
    onSubmit: async (values) => {
      await activate.mutateAsync(values.licenseKey);
      toast.done("The license key has been activated.");
      form.reset({ licenseKey: "" });
    },
  });

  if (loading) {
    return (
      <Card aria-busy="true">
        <Card.Header title="License key" headingLevel={2} />
        <Card.Body className="space-y-3">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-ctl w-full" />
        </Card.Body>
      </Card>
    );
  }

  if (storedKey) {
    return (
      <>
        <Card>
          <Card.Header
            title="License key"
            sub="The key this Organization is activated with."
            headingLevel={2}
            actions={
              <Button
                type="button"
                size="sm"
                onClick={() => setChecking(true)}
                disabled={validate.isPending}
              >
                Check with the license server
              </Button>
            }
          />
          <Card.Body className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-ui text-tx">
                {revealed ? storedKey : maskKey(storedKey)}
              </code>
              <Button
                type="button"
                size="sm"
                variant="gh"
                onClick={() => setRevealed((on) => !on)}
              >
                <Icon name={revealed ? "eyeOff" : "eye"} size={14} />
                {revealed ? "Hide" : "Show"}
              </Button>
              <CopyButton value={storedKey} label="license key" />
            </div>
            <p className="text-meta text-tx-2">
              Activating a different key here replaces this one without
              releasing it, so release the old key first if you intend to use it
              somewhere else.
            </p>
            <ActivateForm form={form} optedIn={optedIn} replacing />
          </Card.Body>
        </Card>

        {checking ? (
          <CheckKeyModal
            validate={validate}
            onClose={() => setChecking(false)}
          />
        ) : null}
      </>
    );
  }

  return (
    <Card>
      <Card.Header
        title="License key"
        sub="No key is stored for this Organization."
        headingLevel={2}
      />
      <Card.Body>
        <ActivateForm form={form} optedIn={optedIn} />
      </Card.Body>
    </Card>
  );
}
