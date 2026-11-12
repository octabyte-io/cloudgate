import { useState } from "react";

import { Button } from "@/components/ui/button";
import { usePermission } from "@/lib/auth/use-permission";

import { UseExistingCacheModal } from "./use-existing-cache-modal";
import { USE_EXISTING_REFUSAL } from "./existing-database-form";
import { UseExistingModal } from "./use-existing-modal";

/**
 * "Use an existing database" on the plan row that would create a `postgres`
 * a `mysql` or a `redis` in a Cloud account: the place to choose, per
 * Environment, a database the operator already has instead — an RDS
 * instance, or an ElastiCache replication group.
 */
export function UseExistingButton({
  environmentId,
  configName,
  kind = "postgres",
}: {
  environmentId: string;
  configName: string;
  kind?: "postgres" | "mysql" | "redis";
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
        title={allowed.allowed ? undefined : USE_EXISTING_REFUSAL}
        onClick={() => setOpen(true)}
      >
        {kind === "redis"
          ? "Use an existing cache"
          : "Use an existing database"}
      </Button>
      {!open ? null : kind === "redis" ? (
        <UseExistingCacheModal
          open={open}
          onOpenChange={setOpen}
          environmentId={environmentId}
          configName={configName}
        />
      ) : (
        <UseExistingModal
          open={open}
          onOpenChange={setOpen}
          environmentId={environmentId}
          configName={configName}
          kind={kind}
        />
      )}
    </div>
  );
}
