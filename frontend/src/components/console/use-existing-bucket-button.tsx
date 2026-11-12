import { useState } from "react";

import { Button } from "@/components/ui/button";
import { usePermission } from "@/lib/auth/use-permission";

import {
  USE_EXISTING_BUCKET_REFUSAL,
  UseExistingBucketModal,
} from "./use-existing-bucket-modal";

/**
 * "Use an existing bucket" on the plan row that would create a `bucket` in
 * a Cloud account: the place to choose, per Environment, an S3
 * bucket the operator already has instead.
 */
export function UseExistingBucketButton({
  environmentId,
  configName,
}: {
  environmentId: string;
  configName: string;
}) {
  const [open, setOpen] = useState(false);
  const allowed = usePermission({ service: ["create"] });
  return (
    <div>
      <Button
        type="button"
        size="sm"
        variant="gh"
        disabled={!allowed.allowed}
        title={allowed.allowed ? undefined : USE_EXISTING_BUCKET_REFUSAL}
        onClick={() => setOpen(true)}
      >
        Use an existing bucket
      </Button>
      {open ? (
        <UseExistingBucketModal
          open={open}
          onOpenChange={setOpen}
          environmentId={environmentId}
          configName={configName}
        />
      ) : null}
    </div>
  );
}
