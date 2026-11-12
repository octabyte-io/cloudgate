import { Card, CardBody, CardHeader } from "@/components/console/card";
import { CodeWell } from "@/components/console/code-well";
import { CopyButton } from "@/components/console/copy-button";
import { LinkButton } from "@/components/console/link-button";
import type {
  SetupPaste,
  TemplateSetupResult,
} from "@/lib/api/endpoints/templates";
import { environmentPlanHref } from "@/lib/format/plan-href";

/** A setup's answer on a repository-kept config: it has entries to paste. */
export type PastedSetup = TemplateSetupResult & { paste: SetupPaste };

/**
 * After Submit on a Project whose config is kept in a repository (#1378):
 * the renamed entries to paste into the config file. Cloudgate never writes
 * to the repository; the setup waits as a Pending setup, and the next push
 * of the file makes the Plan that creates the parts, matching each entry by
 * its Config name and kind. Presentational: shown with a setup's answer.
 */
export function SetupPasteView({
  result,
  templateName,
}: {
  result: PastedSetup;
  templateName: string;
}) {
  const { paste, configNames } = result;
  const names = listing(configNames);
  return (
    <Card>
      <CardHeader
        title={`Paste ${templateName} into ${paste.path}`}
        sub="Cloudgate does not write to your repository. Add these entries under services: yourself."
        headingLevel={2}
        actions={<CopyButton value={paste.yaml} label="entries" />}
      />
      <CardBody className="grid gap-4">
        <p className="text-body">
          Add them to <code>{paste.path}</code> in{" "}
          <code>{paste.repository}</code> on{" "}
          {paste.branch === null ? (
            "its default branch"
          ) : (
            <>
              the <code>{paste.branch}</code> branch
            </>
          )}
          .
        </p>
        <CodeWell
          content={paste.yaml}
          label={`Entries to paste into ${paste.path}`}
        />
        <p className="text-meta text-tx-3">
          The next push of the file makes the Plan that creates {names} from
          this setup, matching each entry by its Config name and kind. An entry
          renamed or given another kind gets none of the setup’s values, and the
          Plan notes the values left unused. The setup waits up to 30 days for
          that push.
        </p>
        <div>
          <LinkButton
            href={environmentPlanHref(
              result.setupRecord.projectId,
              result.pendingSetup.environmentId,
            )}
            size="sm"
          >
            Open the Config tab
          </LinkButton>
        </div>
      </CardBody>
    </Card>
  );
}

/** `a`, `a and b`, `a, b and c`. */
function listing(names: readonly string[]): string {
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
