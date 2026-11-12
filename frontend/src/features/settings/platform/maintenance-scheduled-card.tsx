import { useId, useState } from "react";

import { Card } from "@/components/console/card";
import { QAList, QARow } from "@/components/console/qa-row";
import { Skeleton } from "@/components/console/skeleton";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useWebServerSettings } from "@/lib/api/use-web-server-settings";

import {
  useInstanceGate,
  useLogCleanup,
  usePlatformMutations,
} from "./use-platform";

/** The two things that run on a schedule rather than when somebody presses them. */
export function ScheduledCard() {
  const settings = useWebServerSettings();
  const logCleanup = useLogCleanup();
  const mutations = usePlatformMutations();
  const [cron, setCron] = useState<string | null>(null);
  // Both switches and the schedule write the platform host's own jobs, which
  // is instance authority (ADR-0013) — off for anyone else, with the reason.
  const gate = useInstanceGate();
  const refusalId = useId();

  const storedCron = logCleanup.data?.cronExpression ?? "";
  const cronValue = cron ?? storedCron;

  return (
    <Card>
      <Card.Header
        title="On a schedule"
        sub="The two jobs Cloudgate runs on this host without being asked."
        headingLevel={2}
      />
      <Card.Body>
        {gate.allowed ? null : (
          <p id={refusalId} className="mb-3 text-meta text-tx-2">
            {gate.refusal}
          </p>
        )}
        <QAList>
          <QARow
            title="Prune Docker every night at 23:50"
            description={
              <>
                Runs <code className="font-mono">container</code>,{" "}
                <code className="font-mono">image</code>,{" "}
                <code className="font-mono">builder</code> and{" "}
                <code className="font-mono">system</code>{" "}
                prunes — everything in the list below except volumes, which are
                never pruned automatically because a volume whose container
                merely happens to be stopped is still somebody&rsquo;s data. A
                night when Docker stays busy for 10 minutes is skipped, noted in
                the backend&rsquo;s log, and tried again the next night.
              </>
            }
            action={
              settings.isPending ? (
                <Skeleton className="h-4.5 w-8 rounded-pill" />
              ) : (
                <Switch
                  checked={settings.data?.enableDockerCleanup === true}
                  disabled={
                    !gate.allowed || mutations.updateDockerCleanup.isPending
                  }
                  title={gate.allowed ? undefined : gate.refusal}
                  aria-describedby={gate.allowed ? undefined : refusalId}
                  aria-label="Prune Docker nightly on this host"
                  onCheckedChange={async (next) => {
                    try {
                      await mutations.updateDockerCleanup.mutateAsync(next);
                      toast.done(
                        next
                          ? "The nightly Docker prune is on."
                          : "The nightly Docker prune is off.",
                      );
                    } catch (error) {
                      toast.error(error);
                    }
                  }}
                />
              )
            }
          />

          <QARow
            title="Rotate Traefik's access log"
            description={
              <>
                On this schedule, if the access log has passed{" "}
                <strong className="font-medium">100 MiB</strong> it is renamed
                aside and Traefik is signalled to reopen it. Three previous files
                are kept. That log is what the Requests screen reads, so this
                decides how far back that screen can see — and because the size
                is only checked when the schedule fires, a busy instance wants a
                shorter one.
              </>
            }
            action={
              logCleanup.isPending ? (
                <Skeleton className="h-4.5 w-8 rounded-pill" />
              ) : (
                <Switch
                  checked={logCleanup.data?.enabled === true}
                  disabled={
                    !gate.allowed || mutations.updateLogCleanup.isPending
                  }
                  title={gate.allowed ? undefined : gate.refusal}
                  aria-describedby={gate.allowed ? undefined : refusalId}
                  aria-label="Rotate Traefik's access log on a schedule"
                  onCheckedChange={async (next) => {
                    try {
                      await mutations.updateLogCleanup.mutateAsync(
                        next ? cronValue || "0 0 * * *" : null,
                      );
                      setCron(null);
                      toast.done(
                        next
                          ? "The access log will be rotated on that schedule."
                          : "The access log is no longer rotated.",
                      );
                    } catch (error) {
                      toast.error(error);
                    }
                  }}
                />
              )
            }
          />
        </QAList>

        {logCleanup.data?.enabled ? (
          <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg bg-panel-2 p-3">
            <label className="min-w-0 flex-1 basis-48">
              <span className="mb-1 block text-meta font-medium text-tx-3">
                When it runs
              </span>
              <Input
                value={cronValue}
                className="font-mono"
                spellCheck={false}
                placeholder="0 0 * * *"
                onChange={(event) => setCron(event.target.value)}
              />
            </label>
            <Button
              type="button"
              size="sm"
              disabled={
                !gate.allowed ||
                cronValue.trim() === "" ||
                cronValue === storedCron ||
                mutations.updateLogCleanup.isPending
              }
              aria-busy={mutations.updateLogCleanup.isPending || undefined}
              onClick={async () => {
                try {
                  await mutations.updateLogCleanup.mutateAsync(cronValue.trim());
                  setCron(null);
                  toast.done("The schedule is saved.");
                } catch (error) {
                  toast.error(error);
                }
              }}
            >
              Save schedule
            </Button>
            <p className="basis-full text-meta text-tx-3">
              A five-field cron expression, in this machine&rsquo;s timezone.
              Nothing validates it here — an expression the scheduler cannot
              parse is refused when it is registered.
            </p>
          </div>
        ) : null}
      </Card.Body>
    </Card>
  );
}
