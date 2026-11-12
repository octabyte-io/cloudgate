import { useFieldArray, useFormContext } from "react-hook-form";

import { Field } from "@/components/console/field";
import { PasswordInput } from "@/components/console/password-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Gate } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";

/** The form's shape, shared with `dns-challenge-card.tsx`. */
export type DnsChallengeValues = {
  provider: string;
  /**
   * Whether the credentials are being replaced. Off, a save omits
   * `credentials` and the stored ones stay (ADR-0019's first case).
   */
  replace: boolean;
  credentials: { key: string; value: string }[];
};

/**
 * The credentials half of the DNS-01 card.
 *
 * **A stored value is never on this screen, not even masked.** The read names
 * the keys that are set and nothing else, so an existing setup shows each key
 * as *set*, and editing means entering every value again: the write replaces
 * the whole map, and a value field prefilled with nothing would silently send
 * an empty string for a key somebody meant to keep. So there are two states —
 * the stored keys, untouched, which a save leaves alone, and a full new set,
 * which a save sends whole.
 *
 * The value inputs are `PasswordInput`s with `autoComplete="new-password"`, so
 * a browser neither shows a token on a shared screen nor offers to fill one in
 * from somebody's saved passwords.
 */
export function DnsChallengeCredentials({
  stored,
  gate,
}: {
  /** The keys the read says are set, or `null` when there is no setup yet. */
  stored: string[] | null;
  gate: Gate;
}) {
  const form = useFormContext<DnsChallengeValues>();
  const rows = useFieldArray({ control: form.control, name: "credentials" });
  const replacing = form.watch("replace");

  const startReplacing = () => {
    if (!gate.allowed) return;
    form.setValue("replace", true);
    rows.replace(
      (stored?.length ? stored : [""]).map((key) => ({ key, value: "" })),
    );
  };
  const keepStored = () => {
    form.setValue("replace", false);
    rows.replace([]);
  };

  return (
    <fieldset className="grid gap-2">
      <legend className="text-body font-medium text-tx">Credentials</legend>
      <p className="text-meta text-tx-2">
        The environment variables the provider reads, such as{" "}
        <code className="font-mono">CF_DNS_API_TOKEN</code>. They go into
        Traefik&rsquo;s environment on this machine and are stored encrypted.
        No value is ever shown again.
      </p>

      {stored !== null && !replacing ? (
        <>
          {stored.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line px-3 py-2.5 text-meta text-tx-3">
              No credentials are stored.
            </p>
          ) : (
            <ul className="grid gap-1.5" aria-label="Stored credentials">
              {stored.map((key) => (
                <li
                  key={key}
                  className="flex items-center justify-between gap-3 rounded-lg border border-line bg-panel-2 px-3 py-2"
                >
                  <code className="min-w-0 truncate font-mono text-meta text-tx">
                    {key}
                  </code>
                  <span className="text-meta text-tx-2">set</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-meta text-tx-2">
            Saving without replacing them keeps these as they are.
          </p>
          <div>
            <Button
              type="button"
              size="sm"
              disabled={!gate.allowed}
              title={gate.allowed ? undefined : gate.refusal}
              onClick={startReplacing}
            >
              Replace credentials
            </Button>
          </div>
        </>
      ) : (
        <>
          {stored !== null ? (
            <p className="text-meta text-tx-2">
              These replace every stored credential. The stored values are not
              shown, so enter each one again.
            </p>
          ) : null}
          {rows.fields.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line px-3 py-2.5 text-meta text-tx-3">
              No credentials. Most providers need at least one.
            </p>
          ) : null}
          {rows.fields.map((row, index) => (
            <div
              key={row.id}
              className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-panel-2 p-2.5"
            >
              <Field
                name={`credentials.${index}.key`}
                label={`Key ${index + 1}`}
                className="flex-1 basis-40"
              >
                <Input
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="CF_DNS_API_TOKEN"
                  className="font-mono text-meta"
                />
              </Field>
              <Field
                name={`credentials.${index}.value`}
                label={`Value ${index + 1}`}
                className="flex-1 basis-40"
              >
                <PasswordInput
                  autoComplete="new-password"
                  spellCheck={false}
                  className="font-mono text-meta md:text-meta"
                />
              </Field>
              <Button
                type="button"
                size="icon-sm"
                variant="qt"
                onClick={() => rows.remove(index)}
                aria-label={`Remove credential ${index + 1}`}
              >
                <Icon name="trash" size={15} />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!gate.allowed}
              title={gate.allowed ? undefined : gate.refusal}
              onClick={() => gate.allowed && rows.append({ key: "", value: "" })}
            >
              <Icon name="plus" size={14} />
              Add a credential
            </Button>
            {stored !== null ? (
              <Button type="button" size="sm" variant="qt" onClick={keepStored}>
                Keep the stored credentials
              </Button>
            ) : null}
          </div>
        </>
      )}
    </fieldset>
  );
}
