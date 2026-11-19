"use client";

import { Card } from "@/components/console/card";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import { errorMessage } from "@/lib/api/error-message";
import type { ComposeDetail } from "@/lib/api/endpoints/compose";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { ComposePanel } from "../compose-panel";
import { ConfigFilesCard } from "../config-files/config-files-card";
import { useConfigFiles } from "../config-files/use-config-files";

/**
 * A Compose stack's **Config files** tab (spec #134): the files a Template
 * shipped with it, each edited and saved where the stack runs. Offered only
 * on a stack that has one, to a role that can read them (`tabs/compose.ts`).
 */
export default function Panel(props: PanelProps) {
  return (
    <ComposePanel
      panel={props}
      header={(row) => (
        <PageHeader
          title={props.label}
          icon={props.icon}
          lede={`The files ${row.name}'s Template shipped, edited where the stack runs.`}
        />
      )}
    >
      {(row) => <Body compose={row} />}
    </ComposePanel>
  );
}

function Body({ compose }: { compose: ComposeDetail }) {
  const files = useConfigFiles(compose.composeId);

  if (files.error) {
    return (
      <Card>
        <Card.Body>
          <p className="text-body text-tx-2">{errorMessage(files.error)}</p>
        </Card.Body>
      </Card>
    );
  }

  if (!files.data) {
    return (
      <Card>
        <Card.Body>
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-row" />
            <Skeleton className="h-row" />
          </div>
        </Card.Body>
      </Card>
    );
  }

  if (files.data.length === 0) {
    return (
      <Card>
        <Card.Body>
          <p className="text-body text-tx-2">
            This stack has no config files.
          </p>
        </Card.Body>
      </Card>
    );
  }

  return <ConfigFilesCard compose={compose} files={files.data} />;
}
