import { useFormContext } from "react-hook-form";

import { Field } from "@/components/console/field";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/lib/design/icons";
import { hostnameValue, isHostname } from "@/lib/forms/hostname";

import { DnsHelper } from "./dns-helper";
import type { DomainValues } from "./domain-schema";
import {
  useGenerateHost,
  usePlatformHostIp,
  useValidateHost,
} from "./use-domains";

/**
 * The hostname, and the two network calls made *inside* a form — which no other
 * form in the console does:
 *
 * - **Generate** asks `POST /domains/generate` for an `sslip.io` host carrying the
 *   Server's address, so a service is reachable before anyone owns a domain. It
 *   mints a new random host each time, which is why it is a button and not a
 *   default value.
 * - **Check DNS** asks `POST /domains/validate` what the host resolves to. It is
 *   never automatic: it reaches a resolver, and someone typing a hostname
 *   character by character does not want a lookup per keystroke.
 *
 * Both mutations live here together because a lookup's answer belongs to **the
 * host it was asked about**, and both of them replace that host. The verdict is
 * shown only while the field still holds the host the lookup was sent for
 * (`validate.variables.host`), so typing over a checked host hides its answer
 * rather than relabelling it with the new name — "nope.invalid is behind
 * Cloudflare" about a host nobody looked up — and typing the old host back
 * shows it again, because it is still true of that one. Generate also resets the
 * lookup outright: the host it mints has never been asked about.
 */
export function DomainHostField({
  appName,
  serverIp,
  serverId,
  noun,
}: {
  /** Seeds the generated host — the backend truncates it to 40 characters. */
  appName: string;
  /**
   * The Server's address, and `null` for a service on Cloudgate's own host —
   * which has no `server` row, not no address: {@link usePlatformHostIp} is
   * where that one comes from.
   */
  serverIp: string | null;
  serverId: string | null;
  noun: string;
}) {
  const form = useFormContext<DomainValues>();
  const generate = useGenerateHost();
  const validate = useValidateHost();

  /**
   * Where the host should point, from whichever of the two places has it: the
   * Server's row, or — for a service on Cloudgate's own host, which has no such
   * row — the address this instance records for itself.
   *
   * Asked for only on the platform host, because that is the only branch with
   * nothing else to go on. At first nothing here read it at all, so the panel
   * printed "this machine's public address" as the Value to create a record
   * with and Check DNS ran with no address to compare against — which
   * `cdn.service.ts` answers `isValid` to for any host that resolves anywhere.
   *
   * The panel is **not** held back while this is in flight. For the length of
   * that one request it reads as though no address were recorded, which is the
   * state it corrects; holding the panel instead would delay every open of this
   * dialog, including the many where the answer is already cached, to spare a
   * frame of a sentence that is true of a fresh instance.
   */
  const platform = usePlatformHostIp(serverId === null);
  const pointsAt = serverIp ?? (platform.data?.trim() || null);

  // `?? ""` is a backstop, not decoration: this is read for the DNS helper and
  // for the Check DNS button's `disabled`, and `watch` returns whatever was last
  // `setValue`d — so one endpoint answering with something unexpected took the
  // whole dialog down on `undefined.trim()` rather than showing a wrong host.
  //
  // `hostnameValue` rather than a `.trim()` here and again at each reader: the
  // schema this field is validated by normalises the same way, and the point of
  // one function is that the three of them cannot come apart (X11-5).
  const host = hostnameValue(form.watch("host") ?? "");

  // Both of the below wait for a host the rule accepts, not merely a non-empty
  // box. The panel prints a record to go and create at a DNS provider, and
  // deriving one from a host the form has just refused is an instruction for a
  // name the product will never route (X11-6). The button follows the panel
  // because the lookup's answer renders *inside* it: a Check DNS that stays
  // pressable while the panel is hidden is a request whose result nobody sees.
  const usable = isHostname(host);

  // Keyed to the host that was asked about rather than cleared on each
  // keystroke: `variables` is what the last `mutateAsync` was called with, so
  // the pending line and the verdict both belong to *that* host, never to
  // whatever the field says now.
  const asked = validate.variables?.host === host;

  return (
    <>
      <Field
        name="host"
        label="Host"
        hint="The hostname visitors type. No scheme, no path."
      >
        <Input
          placeholder="api.example.com"
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-meta md:text-meta"
        />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={generate.isPending}
          aria-busy={generate.isPending || undefined}
          onClick={async () => {
            try {
              const generated = await generate.mutateAsync({
                appName,
                serverId,
              });
              form.setValue("host", generated, { shouldValidate: true });
              validate.reset();
            } catch (error) {
              toast.error(error);
            }
          }}
        >
          <Icon name="spark" size={14} />
          Generate one for me
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!usable || validate.isPending}
          aria-busy={validate.isPending || undefined}
          onClick={async () => {
            try {
              await validate.mutateAsync({
                host,
                serverIp: pointsAt ?? undefined,
              });
            } catch (error) {
              toast.error(error);
            }
          }}
        >
          <Icon name="net" size={14} />
          Check DNS
        </Button>
      </div>

      {usable ? (
        <DnsHelper
          host={host}
          serverIp={pointsAt}
          result={asked ? (validate.data ?? null) : null}
          pending={asked && validate.isPending}
          noun={noun}
        />
      ) : null}
    </>
  );
}
