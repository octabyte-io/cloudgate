import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { Dash } from "@/components/console/dash";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Button } from "@/components/ui/button";
import { useInstanceMode } from "@/lib/api/use-instance-mode";

import {
  useInstanceReleaseTag,
  useInstanceVersion,
  useUpdateData,
} from "./use-platform";

/**
 * Version, release tag, whether a newer image has been published, and the
 * instance mode: Hosted or Self-hosted, off `GET /settings/about`.
 */
export function IdentityCard({
  checked,
  onCheck,
}: {
  checked: boolean;
  onCheck: () => void;
}) {
  const version = useInstanceVersion();
  const releaseTag = useInstanceReleaseTag();
  const update = useUpdateData(checked);
  const mode = useInstanceMode();

  return (
    <Card>
      <Card.Header
        title="This instance"
        sub="What is running, and what has been published."
        headingLevel={2}
        actions={
          <Button
            size="sm"
            disabled={update.isFetching}
            aria-busy={update.isFetching || undefined}
            onClick={() => {
              onCheck();
              if (checked) void update.refetch();
            }}
          >
            Check for updates
          </Button>
        }
      />
      <Card.Body>
        <KVList>
          <KVRow
            label="Version"
            mono
            value={version.data || <Dash word="Unknown" />}
          />
          <KVRow
            label="Mode"
            value={
              mode.data === "hosted" ? (
                "Hosted"
              ) : mode.data === "self-hosted" ? (
                "Self-hosted"
              ) : (
                <Dash word="Unknown" />
              )
            }
          />
          <KVRow
            label="Image tag"
            mono
            value={releaseTag.data || <Dash word="Unknown" />}
          />
          <KVRow
            label="Newest published"
            value={
              !checked ? (
                <span className="text-tx-2">Not checked yet</span>
              ) : update.isFetching ? (
                <span className="text-tx-2">Asking Docker Hub…</span>
              ) : update.error ? (
                <span className="text-tx-2">Docker Hub did not answer</span>
              ) : update.data?.error ? (
                <span className="flex flex-col gap-0.5">
                  <span className="text-warn">The check did not complete</span>
                  <span className="text-meta wrap-anywhere text-tx-2">
                    {update.data.error}
                  </span>
                </span>
              ) : update.data?.updateAvailable ? (
                <span className="flex flex-wrap items-center gap-1.75">
                  <span className="font-mono">{update.data.latestVersion}</span>
                  <Chip variant="brand">Newer than this one</Chip>
                </span>
              ) : (
                <span className="text-tx-2">
                  {update.data?.latestVersion
                    ? `${update.data.latestVersion} — this instance is up to date`
                    : "Nothing newer was found"}
                </span>
              )
            }
          />
        </KVList>
      </Card.Body>
      <Card.Footer>
        The check reaches hub.docker.com. An unreachable hub, or a repository
        that does not exist, is reported as a failure rather than as
        &ldquo;nothing newer&rdquo; &mdash; which is why this card says who it
        asked rather than asserting you are up to date.
      </Card.Footer>
    </Card>
  );
}
