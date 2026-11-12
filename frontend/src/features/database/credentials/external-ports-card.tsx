import { useId, useState } from "react";

import { Card } from "@/components/console/card";
import { Field, FormError } from "@/components/console/field";
import { example } from "@/components/console/form-spec";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/error-message";
import type {
  Database,
  DatabaseKind,
  ExternalPortsInput,
} from "@/lib/api/endpoints/databases";
import { usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";

import { DATABASE_KIND } from "../kinds";
import { DATABASE_PORTS_REFUSAL, stillConverging } from "../use-database";

/**
 * Publish the engine's listeners on the host, or take them back off.
 *
 * **One form for one port and for three.** Five engines have a single listener
 * and LibSQL has three, and the difference is `descriptor.ports.length` — this
 * component never learns which engine it is showing. The plural route
 * (`POST /libsql/:id/external-ports`) is `endpoints/databases.ts`'s problem, not
 * this form's.
 *
 * Two things this screen has to say out loud, because both are one-way in
 * practice:
 *
 * 1. **Publishing exposes the database beyond the overlay network**, and it says
 *    so at the toggle rather than in a footnote — that is the brief's own
 *    instruction and it is right. There is no allowlist column and Cloudgate
 *    writes no firewall rule.
 * 2. **Saving redeploys a running database.** `BaseDatabaseService.saveExternalPort`
 *    writes the column and then calls `deployInternal`, so a Swarm converge
 *    follows immediately. For a database that means a stop-first update — a few
 *    seconds of refused connections. Nobody expects a port field to restart a
 *    database. **A stopped one stays stopped**: the port is written onto
 *    its service with no tasks and published when it is next started, so the
 *    footer and the toast say that instead.
 *
 * **Save ports is off, with the reason, for a role the route would refuse**.
 * `POST /<engine>/:id/external-port` (LibSQL's `/external-ports`) is
 * `@RequirePermission('service', 'create')` and then runs `findOwnedForUpdate`,
 * which asks `service: ['update']` — two statements, the same on all six
 * engines, so both are read. The base member holds `update` and not `create`.
 * The fields stay live, as they do on a `SettingsCard`.
 */
export function ExternalPortsCard({
  database,
  kind,
  save,
}: {
  database: Database;
  kind: DatabaseKind;
  save: (input: ExternalPortsInput) => Promise<unknown>;
}) {
  const descriptor = DATABASE_KIND[kind];
  const ports = descriptor.ports;
  const stopped = database.applicationStatus === "stopped";

  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      ports.map((port) => {
        const current = database[port.column];
        return [port.column, current == null ? "" : String(current)];
      }),
    ),
  );
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The route's decorator, and the check its service runs after it.
  const canCreate = usePermission({ service: ["create"] });
  const canUpdate = usePermission({ service: ["update"] });
  const allowed = canCreate.allowed && canUpdate.allowed;
  const refusalId = useId();

  const set = (column: string, value: string) =>
    setDraft((was) => ({ ...was, [column]: value }));

  const badNumber = (value: string) =>
    value !== "" && !/^\d+$/.test(value.trim());
  const outOfRange = (value: string) => {
    if (value === "" || badNumber(value)) return false;
    const port = Number(value);
    return port < 1 || port > 65535;
  };

  const invalid = ports.some(
    (port) => badNumber(draft[port.column]) || outOfRange(draft[port.column]),
  );

  async function submit(event: React.SubmitEvent) {
    event.preventDefault();
    // Enter in a field submits whatever the button says.
    if (!allowed) {
      setRefusal(DATABASE_PORTS_REFUSAL);
      return;
    }
    if (invalid || saving) return;
    setRefusal(null);
    setSaving(true);

    const body = Object.fromEntries(
      ports.map((port) => {
        const value = draft[port.column].trim();
        return [port.column, value === "" ? null : Number(value)];
      }),
    ) as unknown as ExternalPortsInput;

    try {
      const answer = await save(body);
      toast.done("Published ports saved.", {
        description: keptStopped(answer)
          ? `${database.name} is stopped, so the new ports take effect when it is next started.`
          : stillConverging(answer)
            ? `${database.name} is converging onto the new ports.`
            : `${database.name} was redeployed onto the new ports.`,
      });
    } catch (error) {
      setRefusal(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <Card.Header
        title="Published ports"
        sub={
          ports.length > 1
            ? `${descriptor.label} has ${ports.length} listeners, each published separately.`
            : "Reach this database from outside the Server."
        }
        headingLevel={2}
      />
      <form method="post" noValidate onSubmit={submit}>
        <Card.Body className="grid gap-3.5">
          <p className="flex items-start gap-2 rounded-lg border border-warn-line bg-warn-tint px-3 py-2.5 text-body text-tx-2">
            <Icon
              name="alert"
              size={15}
              className="mt-0.5 flex-none text-warn"
            />
            <span>
              Publishing a port takes this database off the private overlay
              network and puts it on the Server&rsquo;s own address, reachable by
              anything that can route to it. Cloudgate adds no allowlist and no
              firewall rule — the password is the only protection. Leave a port
              empty unless something outside this Server genuinely has to
              connect.
            </span>
          </p>

          {ports.map((port) => {
            const reason = port.unavailable?.(database) ?? null;
            const value = draft[port.column];

            if (reason) {
              return (
                <div
                  key={port.column}
                  className="grid gap-1 rounded-lg border border-dashed border-line px-3 py-2.5"
                >
                  <span className="text-body font-medium text-tx-2">
                    {port.label} port
                  </span>
                  <span className="text-meta text-tx-3">{reason}</span>
                </div>
              );
            }

            return (
              <Field
                key={port.column}
                name={port.column}
                label={`${port.label} port`}
                optional
                hint={
                  <>
                    {port.hint} Container port{" "}
                    <span className="font-mono">{port.target}</span>. Leave it
                    empty to keep this listener private.
                  </>
                }
                error={
                  badNumber(value)
                    ? "A port is a whole number."
                    : outOfRange(value)
                      ? "A port is between 1 and 65535."
                      : undefined
                }
              >
                <Input
                  value={value}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder={example(String(port.target))}
                  className="num"
                  onChange={(event) => set(port.column, event.target.value)}
                />
              </Field>
            );
          })}

          <FormError message={refusal ?? undefined} />
          {allowed ? null : (
            <p id={refusalId} className="text-meta text-tx-2">
              {DATABASE_PORTS_REFUSAL}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <SubmitButton
              pending={saving}
              disabled={!allowed}
              title={allowed ? undefined : DATABASE_PORTS_REFUSAL}
              aria-describedby={allowed ? undefined : refusalId}
            >
              Save ports
            </SubmitButton>
          </div>
        </Card.Body>
        <Card.Footer>
          {stopped
            ? "This database is stopped, and saving does not start it — the ports take effect on its next start."
            : "Saving redeploys the service straight away — a stop-first Swarm update, so connections are refused for a few seconds."}
        </Card.Footer>
      </form>
    </Card>
  );
}

/** The save answered with the row still `stopped`: the backend wrote the ports
 * onto the service without starting it. Read off the answer rather than
 * the row the card was drawn from, so the toast says what the server did. */
function keptStopped(answer: unknown): boolean {
  return (
    (answer as { applicationStatus?: unknown } | null)?.applicationStatus ===
    "stopped"
  );
}
