import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Card } from "@/components/console/card";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { UseExistingCacheModal } from "@/components/console/use-existing-cache-modal";
import { UseExistingModal } from "@/components/console/use-existing-modal";
import type { Database } from "@/lib/api/endpoints/databases";
import {
  existingRdsApi,
  switchOf,
} from "@/lib/api/endpoints/existing-postgres";
import {
  existingPlaceOf,
  existingRedisApi,
} from "@/lib/api/endpoints/existing-redis";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { usePermission } from "@/lib/auth/use-permission";

import { DATABASE_UPDATE_REFUSAL } from "../use-database";

/** What differs between a postgres's or mysql's switch and a redis's. */
const ENGINE = {
  postgres: {
    noun: "database",
    owned: "an RDS instance you already have",
    api: existingRdsApi("postgres"),
  },
  mysql: {
    noun: "database",
    owned: "an RDS instance you already have",
    api: existingRdsApi("mysql"),
  },
  redis: {
    noun: "cache",
    owned: "an ElastiCache replication group you already have",
    api: existingRedisApi,
  },
} as const;

/**
 * Switching a postgres between one Cloudgate made on RDS and an existing
 * database (ADR-0033), or a redis between one on ElastiCache and an
 * existing cache, on its page: asked for here, made by the next
 * plan, which removes one Service and adds the other — the Cloudgate-made
 * side with its usual destroy confirmation and final snapshot, the existing
 * side left untouched — and copies no data. A switch asked for reads its
 * sentence until that Apply, with Cancel. Shown on a cloud database and on
 * an Existing database only; `service: ['update']`.
 */
export function DatabaseSwitchCard({ row }: { row: Database }) {
  if (
    (row.kind !== "postgres" && row.kind !== "mysql" && row.kind !== "redis") ||
    (!existingPlaceOf(row) && !row.cloudAccountId)
  ) {
    return null;
  }
  return <SwitchCard row={row} kind={row.kind} />;
}

function SwitchCard({
  row,
  kind,
}: {
  row: Database;
  kind: "postgres" | "mysql" | "redis";
}) {
  const [open, setOpen] = useState(false);
  const allowed = usePermission({ service: ["update"] });
  const invalidate = useInvalidate();
  const engine = ENGINE[kind];
  const existing = existingPlaceOf(row);
  const pending = switchOf(row);
  const done = () =>
    invalidate.database({
      kind,
      databaseId: row.databaseId,
      environmentId: row.environmentId,
    });
  const toMade = useMutation({
    mutationFn: () => engine.api.switchToMade(row.databaseId),
    onSuccess: done,
  });
  const cancel = useMutation({
    mutationFn: () => engine.api.cancelSwitch(row.databaseId),
    onSuccess: done,
  });
  const gate = {
    disabled: !allowed.allowed,
    title: allowed.allowed ? undefined : DATABASE_UPDATE_REFUSAL,
  };

  return (
    <Card>
      <Card.Header
        title={`Switch ${engine.noun}`}
        sub={
          existing
            ? `Make ${row.configName} a ${engine.noun} Cloudgate makes instead of ${existing.identifier}.`
            : `Make ${row.configName} use ${engine.owned} instead of this one.`
        }
        headingLevel={2}
      />
      <Card.Body>
        {pending ? (
          <div className="grid gap-2.5">
            <p className="text-body text-tx">{pending.sentence}.</p>
            <div>
              <Button
                type="button"
                size="sm"
                variant="gh"
                {...gate}
                onClick={() =>
                  void cancel
                    .mutateAsync()
                    .then(() => toast.done("Switch cancelled."))
                    .catch((error: unknown) => toast.error(error))
                }
              >
                Cancel the switch
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-2.5">
            <p className="text-meta text-tx-2">
              The next plan removes one Service and adds the other. No data is
              copied.
            </p>
            <div>
              <Button
                type="button"
                size="sm"
                variant="gh"
                {...gate}
                onClick={
                  existing
                    ? () =>
                        void toMade
                          .mutateAsync()
                          .then(() =>
                            toast.done(
                              `${row.configName} switches at the next plan.`,
                              {
                                description: `Check for changes: ${existing.identifier} is left as it was.`,
                              },
                            ),
                          )
                          .catch((error: unknown) => toast.error(error))
                    : () => setOpen(true)
                }
              >
                {existing
                  ? `Switch to a ${engine.noun} Cloudgate makes`
                  : `Use an existing ${engine.noun} instead`}
              </Button>
            </div>
          </div>
        )}
      </Card.Body>
      {open && kind === "redis" ? (
        <UseExistingCacheModal
          open={open}
          onOpenChange={setOpen}
          environmentId={row.environmentId}
          configName={row.configName}
          switchFrom={row.databaseId}
        />
      ) : open ? (
        <UseExistingModal
          open={open}
          onOpenChange={setOpen}
          environmentId={row.environmentId}
          configName={row.configName}
          switchFrom={row.databaseId}
          kind={kind === "mysql" ? "mysql" : "postgres"}
        />
      ) : null}
    </Card>
  );
}
