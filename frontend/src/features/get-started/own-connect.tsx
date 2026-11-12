import { useState } from "react";

import { Card } from "@/components/console/card";
import { LogWell } from "@/components/console/log-well";
import { Skeleton } from "@/components/console/skeleton";
import { SubmitButton } from "@/components/console/submit-button";
import type { TemplateSummary } from "@/lib/api/endpoints/templates";
import { errorMessage } from "@/lib/api/error-message";
import { Icon } from "@/lib/design/icons";
import { useSshKeys } from "@/lib/api/use-ssh-keys";

import { toSetupLines } from "../server/infrastructure/setup-log-tones";
import { SetupConfirmModal } from "../server/infrastructure/setup-confirm-modal";
import {
  useServer,
  useServerSetupRun,
  useValidateServer,
  type SetupRunState,
} from "../server/use-server";
import { KeyLine } from "./own-server-form";
import { ServerReady, StageList } from "./wizard-parts";
import { isReadyServer, type StageState } from "./wizard-model";
import { wizardHref } from "./wizard-state";

/** The press that starts the setup, and the words on its confirmation. */
const CONNECT = "Connect my server";

/**
 * Connecting the person's own Server: Cloudgate first checks it can sign
 * in (`validate`), then the person confirms, and **that confirmation is the
 * press that starts the Setup run** (ADR-0058) — the same start-dial the
 * Server's Setup card makes, through the same hook, so nothing here starts
 * a run by being opened, reloaded or reconnected. The run's own output is
 * one press away, folded, for whoever wants to read it.
 */
export function OwnConnect({
  template,
  serverId,
}: {
  template: TemplateSummary;
  serverId: string;
}) {
  const server = useServer(serverId);
  const sshKeys = useSshKeys();
  const run = useServerSetupRun(serverId, server.data?.name);
  const validate = useValidateServer(serverId);
  const [confirming, setConfirming] = useState(false);

  if (server.error) {
    return (
      <Card>
        <Card.Body>
          <p className="text-body text-tx-2">{errorMessage(server.error)}</p>
        </Card.Body>
      </Card>
    );
  }
  if (!server.data) {
    return (
      <Card aria-busy="true">
        <Card.Body className="grid gap-3">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-32" />
        </Card.Body>
      </Card>
    );
  }

  const row = server.data;
  if (isReadyServer(row) || run.state === "finished") {
    return (
      <ServerReady
        name={row.name}
        href={wizardHref({
          templateId: template.id,
          serverId,
          deploying: true,
        })}
      />
    );
  }

  const key = sshKeys.data?.find((entry) => entry.sshKeyId === row.sshKeyId);
  const running = run.state === "running";

  return (
    <Card className="animate-fade">
      <Card.Header
        title={running ? `Setting up ${row.name}` : `Connect ${row.name}`}
        sub={
          running
            ? "Cloudgate is installing what apps need. This takes a few minutes, and carries on if you leave; come back to this page to go on."
            : `Cloudgate signs in to ${row.ipAddress} and installs what apps need to run.`
        }
        headingLevel={2}
      />
      <Card.Body className="grid gap-4">
        {running || run.state !== "idle" ? (
          <StageList
            label="Connecting your server"
            stages={stages(run.state)}
          />
        ) : key ? (
          <KeyLine publicKey={key.publicKey} user={row.username} />
        ) : null}

        {run.state === "failed" ||
        run.state === "interrupted" ||
        run.state === "refused" ||
        run.state === "blocked" ||
        run.state === "ended" ? (
          <p role="alert" className="text-body text-bad">
            {run.reason
              ? `Setup stopped: ${run.reason}`
              : "Setup stopped before it said how it went. Connect again to pick it back up; every step checks before it acts."}
          </p>
        ) : null}

        {validate.error ? (
          <div role="alert" className="grid gap-1">
            <p className="text-body text-bad">
              Cloudgate couldn&rsquo;t sign in to your server.
            </p>
            <p className="text-ui text-tx-2">{errorMessage(validate.error)}</p>
            <p className="text-ui text-tx-2">
              Check the address, and that the line above was run on the server
              signed in as {row.username}.
            </p>
          </div>
        ) : null}

        {run.lines.length > 0 ? (
          <details className="group grid gap-2">
            {/* Our own chevron in place of the browser's marker, turning as
                the output folds open. */}
            <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-ui text-tx-2 transition-colors duration-100 hover:text-tx [&::-webkit-details-marker]:hidden">
              <Icon
                name="chevR"
                size={14}
                className="flex-none transition-transform duration-150 ease-out-strong group-open:rotate-90"
              />
              Show what&rsquo;s happening
            </summary>
            <LogWell
              label="Setup output"
              lines={toSetupLines(run.lines)}
              live={running}
              dropped={run.dropped}
              className="mt-2"
            />
          </details>
        ) : null}

        {running ? null : (
          <div>
            <SubmitButton
              type="button"
              pending={validate.isPending}
              onClick={() =>
                validate.mutate(undefined, {
                  onSuccess: () => setConfirming(true),
                })
              }
            >
              {CONNECT}
            </SubmitButton>
          </div>
        )}
      </Card.Body>
      <SetupConfirmModal
        server={row}
        custom={row.command}
        state={run.state}
        actionLabel={CONNECT}
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => {
          setConfirming(false);
          run.start();
        }}
      />
    </Card>
  );
}

/** The three stages of connecting, from where the Setup run is. */
function stages(state: SetupRunState): { label: string; state: StageState }[] {
  const setup: StageState =
    state === "finished" ? "done" : state === "running" ? "now" : "todo";
  return [
    { label: "Signed in to your server", state: "done" },
    { label: "Installing what apps need", state: setup },
    { label: "Ready", state: state === "finished" ? "done" : "todo" },
  ];
}
