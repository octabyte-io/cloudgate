import { useState } from "react";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Card } from "@/components/console/card";
import { Field, FormError } from "@/components/console/field";
import { Skeleton } from "@/components/console/skeleton";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DnsChallengeSetup } from "@/lib/api/endpoints/traefik";
import { errorMessage } from "@/lib/api/error-message";
import {
  useDnsChallenge,
  useDnsChallengeMutations,
} from "@/lib/api/use-dns-challenge";
import type { Gate } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";

import {
  DnsChallengeCredentials,
  type DnsChallengeValues,
} from "./dns-challenge-credentials";
import { DnsChallengeRemoveModal } from "./dns-challenge-remove-modal";
import { example } from "@/components/console/form-spec";

/**
 * The backend's own rules (`PutDnsChallengeDto`), said first: a lego provider
 * code, an upper-case env variable name of at most 128 characters, a value of
 * at most 4096 with no newline or NUL — Traefik's env takes it as one
 * `KEY=value` entry, which either would split or end — and at most 32 of them.
 */
const LEGO_PROVIDER_CODE = /^[a-z0-9-]{1,64}$/;
const ENV_VARIABLE_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const CREDENTIAL_VALUE_MAX = 4096;
const LINE_BREAK_OR_NUL = /[\n\r\0]/;
const CREDENTIALS_MAX = 32;

const schema = z
  .object({
    provider: z
      .string()
      .trim()
      .regex(
        LEGO_PROVIDER_CODE,
        "A provider code is lowercase letters, digits and dashes — for example cloudflare.",
      ),
    replace: z.boolean(),
    credentials: z
      .array(
        z.object({
          key: z
            .string()
            .trim()
            .regex(
              ENV_VARIABLE_NAME,
              "A key is capitals, digits and underscores, starting with a letter, and at most 128 characters.",
            ),
          value: z
            .string()
            .min(1, "Enter the value. Stored ones are not shown.")
            .max(
              CREDENTIAL_VALUE_MAX,
              `A value is at most ${CREDENTIAL_VALUE_MAX} characters.`,
            )
            .refine((value) => !LINE_BREAK_OR_NUL.test(value), {
              message: "A value is one line, with no line break or NUL.",
            }),
        }),
      )
      .max(CREDENTIALS_MAX, `At most ${CREDENTIALS_MAX} credentials.`),
  })
  .superRefine((values, context) => {
    const seen = new Set<string>();
    values.credentials.forEach((row, index) => {
      if (seen.has(row.key)) {
        context.addIssue({
          code: "custom",
          path: ["credentials", index, "key"],
          message: "This key is already above.",
        });
      }
      seen.add(row.key);
    });
  });

const TRAEFIK_PROVIDERS = "https://doc.traefik.io/traefik/https/acme/#providers";

/**
 * **A machine's DNS-01 setup**: the lego provider and credentials its
 * `letsencrypt-dns` resolver uses, the one way Let's Encrypt issues a wildcard.
 *
 * Shared by the platform host's Traefik screen (`serverId` null) and a
 * Server's Settings tab, because the setup is per machine as `traefik.yml` and
 * Traefik's env are. **`gate` is the caller's**, since the two machines take
 * different authority: the platform host is ADR-0013's instance authority, a
 * Server is owner-or-admin with access to it.
 *
 * Its own card rather than a block in "Traefik's container", which it sits
 * beside: that card's three reads inspect the running container, and a DNS
 * setup is a stored row that exists whether Traefik is running or not.
 */
export function DnsChallengeCard({
  serverId,
  gate,
}: {
  /** The machine. `null` is the platform host. */
  serverId: string | null;
  gate: Gate;
}) {
  const read = useDnsChallenge(serverId);

  return (
    <Card aria-busy={read.isPending || undefined}>
      <Card.Header
        title="DNS-01 certificates"
        sub="Let's Encrypt through your DNS provider — the one way to get a wildcard certificate."
        headingLevel={2}
      />
      {read.error ? (
        <Card.Body>
          <p role="alert" className="flex gap-2 text-body wrap-anywhere text-tx">
            <Icon name="alert" className="mt-0.5 flex-none text-bad" />
            {errorMessage(read.error)}
          </p>
        </Card.Body>
      ) : read.isPending ? (
        <Card.Body className="grid gap-3">
          <Skeleton className="h-9 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
        </Card.Body>
      ) : (
        <DnsChallengeForm
          // `useApiForm` reads its defaults once, so a new answer is a new form.
          key={`${read.data?.provider}:${read.data?.credentialKeys.join(",")}`}
          serverId={serverId}
          setup={read.data}
          gate={gate}
        />
      )}
      <Card.Footer>
        Saving or removing restarts Traefik on this machine, in the background,
        so the request finishes before the restart does. Every connection on 80
        and 443 drops when it happens.
      </Card.Footer>
    </Card>
  );
}

function DnsChallengeForm({
  serverId,
  setup,
  gate,
}: {
  serverId: string | null;
  setup: DnsChallengeSetup | null;
  gate: Gate;
}) {
  const mutations = useDnsChallengeMutations(serverId);
  const [removing, setRemoving] = useState(false);

  const form = useApiForm<DnsChallengeValues>({
    schema,
    defaultValues: {
      provider: setup?.provider ?? "",
      // No setup yet: there is nothing to keep, so the rows are open.
      replace: setup === null,
      credentials: setup === null ? [{ key: "", value: "" }] : [],
    },
    onSubmit: async (values) => {
      // Enter in a field submits whatever the button says.
      if (!gate.allowed) {
        form.setError("root", { type: "manual", message: gate.refusal });
        return;
      }
      await mutations.save.mutateAsync({
        provider: values.provider,
        // Untouched, the stored credentials stay: the key is left out.
        ...(values.replace
          ? {
              credentials: Object.fromEntries(
                values.credentials.map((row) => [row.key, row.value]),
              ),
            }
          : {}),
      });
      form.reset({ provider: values.provider, replace: false, credentials: [] });
      toast.done("DNS-01 setup saved. Traefik on this machine is restarting.");
    },
  });

  return (
    <FormProvider {...form}>
      <form method="post" noValidate onSubmit={form.submit}>
        <Card.Body className="grid gap-4">
          <p className="text-meta text-tx-2">
            Saving adds a <code className="font-mono">letsencrypt-dns</code>{" "}
            resolver next to <code className="font-mono">letsencrypt</code>{" "}
            in this machine&rsquo;s <code className="font-mono">traefik.yml</code>,
            and restarts Traefik on this machine with the credentials in its
            environment. Domains using <code className="font-mono">letsencrypt</code>{" "}
            keep working as they are; a Domain uses this one by naming{" "}
            <code className="font-mono">letsencrypt-dns</code> as its custom
            resolver.
          </p>

          <Field
            name="provider"
            label="DNS provider"
            hint={
              <>
                The provider&rsquo;s lego code, for example{" "}
                <code className="font-mono">cloudflare</code>.{" "}
                <a
                  href={TRAEFIK_PROVIDERS}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
                >
                  Traefik&rsquo;s provider list
                </a>{" "}
                gives each code and the keys it reads.
              </>
            }
          >
            <Input
              autoComplete="off"
              spellCheck={false}
              placeholder={example("cloudflare")}
              className="font-mono text-meta"
            />
          </Field>

          <DnsChallengeCredentials
            stored={setup?.credentialKeys ?? null}
            gate={gate}
          />

          <FormError message={form.rootError} />
          {gate.allowed ? null : (
            <p className="text-meta text-tx-2">{gate.refusal}</p>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <SubmitButton
              pending={form.formState.isSubmitting}
              disabled={!gate.allowed}
              title={gate.allowed ? undefined : gate.refusal}
            >
              Save DNS-01 setup
            </SubmitButton>
            {setup !== null ? (
              <Button
                type="button"
                variant="dngr"
                disabled={!gate.allowed}
                title={gate.allowed ? undefined : gate.refusal}
                onClick={() => gate.allowed && setRemoving(true)}
              >
                Remove DNS-01 setup
              </Button>
            ) : null}
          </div>
        </Card.Body>
      </form>
      <DnsChallengeRemoveModal
        open={removing}
        onOpenChange={setRemoving}
        onConfirm={async () => {
          await mutations.remove.mutateAsync();
          setRemoving(false);
          toast.done("DNS-01 setup removed. Traefik on this machine is restarting.");
        }}
      />
    </FormProvider>
  );
}
