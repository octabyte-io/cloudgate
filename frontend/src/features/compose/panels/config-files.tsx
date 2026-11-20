"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Card } from "@/components/console/card";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import { errorMessage } from "@/lib/api/error-message";
import type { ComposeDetail } from "@/lib/api/endpoints/compose";
import { mountsApi } from "@/lib/api/endpoints/mounts";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { ComposePanel } from "../compose-panel";
import { ConfigFilesCard } from "../config-files/config-files-card";

/**
 * A Compose stack's **Config files** tab (#135): the files its Template
 * shipped, which Cloudgate keeps as the stack's `file` mounts. Absent for a
 * stack with none, or a role that cannot read volumes (`tabs/compose.ts`).
 */
export default function Panel(props: PanelProps) {
  return (
    <ComposePanel
      panel={props}
      header={(row) => (
        <PageHeader
          title={props.label}
          icon={props.icon}
          lede={`The files ${row.name}'s Template shipped with it. Only their content changes here: the compose file names them.`}
        />
      )}
    >
      {(row) => <Body compose={row} />}
    </ComposePanel>
  );
}

function Body({ compose }: { compose: ComposeDetail }) {
  const { organizationId } = useActiveOrganizationId();
  const queryClient = useQueryClient();
  const key = keys.mounts.byService(organizationId, compose.composeId);
  const mounts = useQuery({
    queryKey: key,
    queryFn: () => mountsApi.listByService(compose.composeId, "compose"),
    enabled: organizationId !== null,
    retry: false,
  });
  const update = useMutation({
    mutationFn: ({ mountId, content }: { mountId: string; content: string }) =>
      mountsApi.update(mountId, { content }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  if (mounts.error) {
    return (
      <Card>
        <Card.Body>
          <p className="text-body text-tx-2">{errorMessage(mounts.error)}</p>
        </Card.Body>
      </Card>
    );
  }
  if (!mounts.data) {
    return (
      <Card>
        <Card.Body>
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-row" />
            <Skeleton className="h-log" />
          </div>
        </Card.Body>
      </Card>
    );
  }

  const files = mounts.data.filter((mount) => mount.type === "file");
  if (files.length === 0) {
    return (
      <Card>
        <Card.Body>
          <p className="text-body text-tx-2">
            This stack has no config files. Only a stack set up from a Template
            that ships them has any.
          </p>
        </Card.Body>
      </Card>
    );
  }
  return (
    <ConfigFilesCard
      compose={compose}
      files={files}
      save={(mountId, content) => update.mutateAsync({ mountId, content })}
    />
  );
}
