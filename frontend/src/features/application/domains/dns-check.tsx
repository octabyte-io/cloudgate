import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/design/icons";

import { useValidateHost } from "./use-domains";

/**
 * Check DNS, for whichever form holds a host: the Add a domain dialog's
 * `DomainHostField`, and a Template setup's Domain field, where the host is
 * typed before any Domain row exists (`POST /domains/validate` takes a host
 * and the address it should reach, never a row).
 *
 * Out of `domain-host-field.tsx` so the two share the one rule that is easy
 * to get wrong: **a lookup's answer belongs to the host it was asked about.**
 * The verdict is handed back only while the field still holds the host the
 * lookup was sent for (`validate.variables.host`), so typing over a checked
 * host hides its answer rather than relabelling it with the new name, and
 * typing the old host back shows it again, because it is still true of that
 * one. The record and the verdict's wording stay `DnsHelper`'s alone.
 *
 * `pointsAt` is the address the host should resolve to, or null where
 * Cloudgate knows none; the check then says only that the name resolves.
 */
export function useDnsCheck(host: string, pointsAt: string | null) {
  const validate = useValidateHost();
  const asked = validate.variables?.host === host;
  return {
    /** Asks the resolver now; a refusal is a toast, as any failed action. */
    check: async () => {
      try {
        await validate.mutateAsync({ host, serverIp: pointsAt ?? undefined });
      } catch (error) {
        toast.error(error);
      }
    },
    /** A lookup is in flight, for any host. */
    checking: validate.isPending,
    /** The answer about this host, or null when it was not asked about. */
    result: asked ? (validate.data ?? null) : null,
    /** A lookup about this host is in flight. */
    pending: asked && validate.isPending,
    /** Forgets the last lookup, as replacing the host with a new one must. */
    reset: validate.reset,
  };
}

/** The Check DNS button, off while a lookup is in flight or `disabled`. */
export function CheckDnsButton({
  check,
  checking,
  disabled = false,
}: {
  check: () => void;
  checking: boolean;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      size="sm"
      disabled={disabled || checking}
      aria-busy={checking || undefined}
      onClick={check}
    >
      <Icon name="net" size={14} />
      Check DNS
    </Button>
  );
}
