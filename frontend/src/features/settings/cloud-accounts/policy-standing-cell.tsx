import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { CloudAccount } from "@/lib/api/endpoints/cloud-accounts";
import { useInstanceMode } from "@/lib/api/use-instance-mode";

import {
  downloadCloudFormation,
  downloadGoogleSetup,
  downloadPlainJson,
} from "./download-template";
import {
  useCloudAccountTemplate,
  useGoogleCloudAccountTemplate,
} from "./use-cloud-accounts";

/**
 * Whether a Cloud account's role is held to the policy this Cloudgate needs.
 * "Permissions out of date" is read from the policy versions alone —
 * nothing checks the cloud in the background — so it names exactly the
 * actions (on Google Cloud, permissions) the newer version adds and offers
 * that version's template: the same documents the role was first made from
 * with the new ones in — for AWS the CloudFormation or plain JSON, for a
 * Google Cloud project the setup script or the role definition alone. Once
 * the role is updated, Check now records the new version and this clears.
 *
 * On the Hosted instance it says what to do, and when: re-run setup before
 * the next cloud deploy. A hosted cloud build needs a newer version
 * than a Self-hosted instance does (ADR-0047), so a Cloud account connected
 * before it meets this once, before its first cloud deploy there.
 *
 * The template is `cloudAccount: update`, so the buttons follow the caller's
 * verdict on it, `allowed`.
 */
export function PolicyStandingCell({
  account,
  allowed,
}: {
  account: CloudAccount;
  allowed: boolean;
}) {
  const template = useCloudAccountTemplate();
  const googleTemplate = useGoogleCloudAccountTemplate();
  const hosted = useInstanceMode().data === "hosted";
  const what = account.cloud === "aws" ? "Policy" : "Role";

  if (!account.permissionsOutOfDate) {
    return (
      <span className="text-tx-2">
        {what} v{account.policyVersion}
      </span>
    );
  }

  async function get(kind: "cloudFormation" | "json") {
    try {
      const answer = await template.mutateAsync(account.cloudAccountId);
      if (kind === "cloudFormation") {
        downloadCloudFormation(account.cloudAccountId, answer);
      } else {
        downloadPlainJson(account.cloudAccountId, answer);
      }
    } catch (error) {
      toast.error(error);
    }
  }

  async function getGoogle(part: "script" | "role") {
    try {
      const answer = await googleTemplate.mutateAsync(account.cloudAccountId);
      downloadGoogleSetup(account.cloudAccountId, answer, part);
    } catch (error) {
      toast.error(error);
    }
  }

  const pending = template.isPending || googleTemplate.isPending;
  return (
    <div className="grid gap-1">
      <span className="text-warn">
        {hosted
          ? `Re-run setup before this Cloud account's next cloud deploy (v${account.policyVersion}, needs v${account.currentPolicyVersion})`
          : `Permissions out of date (v${account.policyVersion}, needs v${account.currentPolicyVersion})`}
      </span>
      <span className="text-meta text-tx-2 wrap-anywhere">
        Missing:{" "}
        <span className="font-mono">{account.missingActions.join(", ")}</span>
      </span>
      {!allowed ? null : account.cloud === "aws" ? (
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="xs"
            disabled={!allowed || pending}
            onClick={() => get("cloudFormation")}
          >
            New CloudFormation template
          </Button>
          <Button
            size="xs"
            disabled={!allowed || pending}
            onClick={() => get("json")}
          >
            As plain JSON
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="xs"
            disabled={!allowed || pending}
            onClick={() => getGoogle("script")}
          >
            New setup script
          </Button>
          <Button
            size="xs"
            disabled={!allowed || pending}
            onClick={() => getGoogle("role")}
          >
            The role alone
          </Button>
        </div>
      )}
    </div>
  );
}
