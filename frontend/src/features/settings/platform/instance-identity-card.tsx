import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { CodeWell } from "@/components/console/code-well";
import { CopyButton } from "@/components/console/copy-button";
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
 * Version, its tag, whether a newer Cloudgate version is on GitHub Releases
 * with the command that installs it, and the instance mode: Hosted or
 * Self-hosted, off `GET /settings/about`.
 *
 * The Hosted instance is answered with no command (`upgradeCommand: null`):
 * its updater installs each Cloudgate version by itself (ADR-0081), and the
 * one-command install typed there by hand would leave hosted mode out. So the
 * card says that instead of showing nothing under a newer version.
 *
 * The check is GitHub's, by way of `POST /settings/update-data`. An unreachable
 * or failing API comes back as `error` and is shown as a check that did not
 * complete, never as "up to date": the Docker Hub check this replaced made
 * those one answer, and every native install was told it was current.
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
  const upgrade =
    checked && !update.isFetching && update.data?.updateAvailable
      ? update.data
      : null;
  const hosted = mode.data === "hosted";

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
            label="Version tag"
            mono
            value={releaseTag.data || <Dash word="Unknown" />}
          />
          <KVRow
            label="Newest published"
            value={
              !checked ? (
                <span className="text-tx-2">Not checked yet</span>
              ) : update.isFetching ? (
                <span className="text-tx-2">Asking GitHub…</span>
              ) : update.error ? (
                <span className="text-tx-2">GitHub did not answer</span>
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
        {upgrade?.upgradeCommand ? (
          <div className="mt-3.5 animate-rise">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-ui text-tx-2">
                Run this on the platform host, as root, to upgrade.
              </p>
              <CopyButton
                value={upgrade.upgradeCommand}
                label="upgrade command"
              />
            </div>
            <CodeWell
              content={upgrade.upgradeCommand}
              label={`Command that upgrades to ${upgrade.latestVersion}`}
            />
          </div>
        ) : upgrade && hosted ? (
          <p className="mt-3.5 text-ui text-tx-2">
            The Hosted instance upgrades itself to each Cloudgate version once
            it is published.
          </p>
        ) : null}
      </Card.Body>
      <Card.Footer>
        The check asks GitHub Releases for the latest Cloudgate version.
      </Card.Footer>
    </Card>
  );
}
