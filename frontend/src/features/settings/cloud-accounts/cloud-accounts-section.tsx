"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { RowTime } from "@/components/console/rows/cells";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type {
  CloudAccount,
  GcpCloudAccount,
} from "@/lib/api/endpoints/cloud-accounts";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";

import { SectionFailed, SectionPending } from "../section-states";
import { ConnectCloudAccountModal } from "./connect-cloud-account-modal";
import { DeleteCloudAccountModal } from "./delete-cloud-account-modal";
import { EditCloudAccountModal } from "./edit-cloud-account-modal";
import { EditGoogleCloudAccountModal } from "./edit-google-cloud-account-modal";
import { NewKeyModal } from "./new-key-modal";
import { PolicyStandingCell } from "./policy-standing-cell";
import { useCloudAccounts } from "@/lib/api/use-cloud-accounts";
import { useCheckCloudAccount } from "./use-cloud-accounts";
import { cloudName } from "@/lib/api/endpoints/cloud-accounts";
import { Icon } from "@/lib/design/icons";
import { useArrival } from "@/components/console/use-arrival";

const CONNECT_REFUSAL = roleRefusal("connect a Cloud account");
const UPDATE_REFUSAL = roleRefusal("edit or check a Cloud account");
const DELETE_REFUSAL = roleRefusal("delete a Cloud account");

/**
 * Cloud accounts: the Organization's AWS accounts and Google Cloud
 * projects (slice 6), each with its last connect check, and the one way to
 * add one.
 *
 * **The last check is the column that matters.** Nothing checks a Cloud
 * account in the background, so when and how its last check
 * ended — and why, when it failed — is all a reader can know about whether it
 * still works; the reason is shown in full rather than behind a hover.
 *
 * Reading this list is `cloudAccount: ['read']`, which the base member does
 * not hold, so a 403 lands in `SectionFailed` saying so rather than as an
 * empty list (§3.5: a refusal is not an empty list).
 *
 * Edit, Check now and Delete sit on each row, and a Google Cloud one
 * has New key. Check now's outcome is
 * the row's own last check, which the refetch shows; the toast only says
 * which way it went. A failure found by a use rather than a check
 * shows in the same column, until a check passes.
 */
export function CloudAccountsSection() {
  const accounts = useCloudAccounts();
  const canConnect = usePermission({ cloudAccount: ["create"] });
  const canUpdate = usePermission({ cloudAccount: ["update"] });
  const canDelete = usePermission({ cloudAccount: ["delete"] });
  const check = useCheckCloudAccount();
  const [connecting, setConnecting] = useState(0);
  const [editing, setEditing] = useState<CloudAccount | null>(null);
  const [changingKey, setChangingKey] = useState<GcpCloudAccount | null>(null);
  const [deleting, setDeleting] = useState<CloudAccount | null>(null);

  const arrival = useArrival(accounts.isPending);
  if (accounts.isPending) {
    return <SectionPending title="Cloud accounts" rows={2} />;
  }
  if (accounts.error) {
    return (
      <SectionFailed title="Cloud accounts" error={accounts.error}>
        Reading Cloud accounts takes the Cloud account read permission, which
        owners and admins hold.
      </SectionFailed>
    );
  }

  const open = () => canConnect.allowed && setConnecting((n) => n + 1);

  async function checkNow(row: CloudAccount) {
    try {
      const checked = await check.mutateAsync(row.cloudAccountId);
      if (checked.lastCheckResult === "passed") {
        toast.done(`${row.name} passed its check.`);
      } else {
        toast.warn(`${row.name} failed its check.`);
      }
    } catch (error) {
      toast.error(error);
    }
  }
  const connectButton = (
    <Button
      size="sm"
      variant="pri"
      disabled={!canConnect.allowed}
      title={canConnect.allowed ? undefined : CONNECT_REFUSAL}
      onClick={open}
    >
      <Icon name="plus" size={14} />
      Connect a Cloud account
    </Button>
  );

  return (
    <Card className={arrival}>
      <Card.Header
        title="Cloud accounts"
        sub="AWS accounts and Google Cloud projects Cloudgate deploys into, each reached only with a credential of its own."
        headingLevel={2}
        actions={connectButton}
      />
      <Card.Body flush>
        <DataTable<CloudAccount>
          label="Connected Cloud accounts"
          rows={accounts.data ?? []}
          getRowId={(row) => row.cloudAccountId}
          empty={
            <EmptyState
              icon="cloud"
              title="No Cloud accounts yet"
              action={connectButton}
            >
              Connect an AWS account or a Google Cloud project to let an
              Environment deploy its Services there instead of on a Server.
            </EmptyState>
          }
          columns={[
            {
              id: "name",
              head: "Name",
              tone: "key",
              compare: (a, b) => a.name.localeCompare(b.name),
              cell: (row) => row.name,
            },
            {
              id: "account",
              head: "Account",
              cell: (row) => (
                <span className="flex items-center gap-1.5">
                  <span className="text-meta text-tx-2">
                    {cloudName(row.cloud)}
                  </span>
                  <Chip variant="mono">{row.cloudId}</Chip>
                </span>
              ),
            },
            {
              id: "externalId",
              head: "External id",
              cell: (row) => (
                <span className="font-mono text-meta wrap-anywhere">
                  {row.cloud === "aws" ? row.externalId : null}
                </span>
              ),
            },
            {
              id: "check",
              head: "Last check",
              cell: (row) => (
                <div className="grid gap-0.5">
                  <span
                    className={
                      row.lastCheckResult === "passed" ? "text-ok" : "text-bad"
                    }
                  >
                    {row.lastCheckResult === "passed" ? "Passed" : "Failed"}{" "}
                    <span className="text-tx-2">
                      <RowTime iso={row.lastCheckedAt} />
                    </span>
                  </span>
                  {row.lastCheckReason ? (
                    <span className="text-meta text-tx-2 wrap-anywhere">
                      {row.lastCheckReason}
                    </span>
                  ) : null}
                </div>
              ),
            },
            {
              id: "permissions",
              head: "Permissions",
              cell: (row) => (
                <PolicyStandingCell account={row} allowed={canUpdate.allowed} />
              ),
            },
            {
              id: "actions",
              head: <span className="sr-only">Actions</span>,
              className: "w-0",
              cell: (row) => (
                <div className="flex gap-1.5">
                  <Button
                    size="xs"
                    disabled={!canUpdate.allowed || check.isPending}
                    title={canUpdate.allowed ? undefined : UPDATE_REFUSAL}
                    aria-busy={
                      (check.isPending &&
                        check.variables === row.cloudAccountId) ||
                      undefined
                    }
                    onClick={() => checkNow(row)}
                  >
                    Check now
                  </Button>
                  <Button
                    size="xs"
                    disabled={!canUpdate.allowed}
                    title={canUpdate.allowed ? undefined : UPDATE_REFUSAL}
                    onClick={() => setEditing(row)}
                  >
                    Edit
                  </Button>
                  {row.cloud === "gcp" ? (
                    <Button
                      size="xs"
                      disabled={!canUpdate.allowed}
                      title={canUpdate.allowed ? undefined : UPDATE_REFUSAL}
                      onClick={() => setChangingKey(row)}
                    >
                      New key
                    </Button>
                  ) : null}
                  <Button
                    size="xs"
                    variant="dngr"
                    disabled={!canDelete.allowed}
                    title={canDelete.allowed ? undefined : DELETE_REFUSAL}
                    onClick={() => setDeleting(row)}
                  >
                    Delete
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </Card.Body>
      {connecting > 0 ? (
        <ConnectCloudAccountModal
          key={connecting}
          open
          onOpenChange={(next) => !next && setConnecting(0)}
        />
      ) : null}
      {editing?.cloud === "aws" ? (
        <EditCloudAccountModal
          key={editing.cloudAccountId}
          account={editing}
          onClose={() => setEditing(null)}
        />
      ) : editing?.cloud === "gcp" ? (
        <EditGoogleCloudAccountModal
          key={editing.cloudAccountId}
          account={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {changingKey ? (
        <NewKeyModal
          key={changingKey.cloudAccountId}
          account={changingKey}
          onClose={() => setChangingKey(null)}
        />
      ) : null}
      {deleting ? (
        <DeleteCloudAccountModal
          key={deleting.cloudAccountId}
          account={deleting}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </Card>
  );
}
