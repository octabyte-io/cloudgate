import { useSyncExternalStore } from "react";

import { LinkButton } from "@/components/console/link-button";
import { Button } from "@/components/ui/button";
import {
  LAST_WARNING_DAYS,
  licenseExpiry,
  STOPPED_BY_LAPSE,
  type LicenseExpiry,
} from "@/features/enterprise/license/license-expiry";
import {
  useCheckLicenseNow,
  useLicenseStatus,
} from "@/features/enterprise/use-license";
import type { LicenseStatusReport } from "@/lib/api/endpoints/license";
import { errorMessage } from "@/lib/api/error-message";
import { useInstanceMode } from "@/lib/api/use-instance-mode";
import {
  useActiveMemberRole,
  useActiveOrganizationId,
  useSession,
} from "@/lib/auth/client";
import { Icon } from "@/lib/design/icons";
import { counted } from "@/lib/format/plural";
import { timeExact } from "@/lib/format/time";
import { cn } from "@/lib/utils";

import { createLocalStore, ownedKey, type LocalStore } from "./local-store";

/**
 * **The license renewal bar**, at the top of every console page of a
 * Self-hosted instance, for owners and admins.
 *
 * From `FIRST_WARNING_DAYS` before `validUntil` it says "Your Enterprise
 * license ends on <date> (in N days)". Until `LAST_WARNING_DAYS` are left it
 * can be hidden, for this `validUntil` and this person only (a renewal brings
 * a new date, which is a new bar); from then on it cannot, and once the date
 * has passed it lists what stopped (`STOPPED_BY_LAPSE`, the list the
 * `license-lapse` report gives) and stays until the key is valid again or
 * Enterprise features are turned off. The thresholds and stages are
 * `licenseExpiry`'s, which mirrors the backend's.
 *
 * Owners get the way to renew and "I've renewed, check now"
 * (`POST /license/check-now`); an admin cannot touch the key, so is told to ask
 * an owner. Members see nothing. Only `validUntil` is named: any grace the
 * license server allows after it is not the console's to promise.
 *
 * Nothing on the Hosted instance, where there is no license key and the
 * status is never asked for here, and nothing while anything it needs loads.
 */
export function LicenseBar({ className }: { className?: string }) {
  const mode = useInstanceMode();
  const role = useActiveMemberRole().data?.role;
  const userId = useSession().data?.user.id ?? null;
  const { organizationId } = useActiveOrganizationId();

  const selfHosted = mode.data === "self-hosted";
  const owner = role === "owner";
  const staff = owner || role === "admin";
  const status = useLicenseStatus({ enabled: selfHosted && staff });
  const hidden = useHiddenFor(userId, organizationId);
  const checkNow = useCheckLicenseNow();

  if (!selfHosted || !staff || !status.data) return null;
  const expiry = currentExpiry(status.data);
  if (expiry.stage === "none") return null;
  if (expiry.stage === "early" && hidden.validUntil === expiry.validUntil) {
    return null;
  }

  const ended = expiry.stage === "ended";
  const date = (
    <time dateTime={expiry.validUntil} className="font-semibold">
      {timeExact(expiry.validUntil)}
    </time>
  );

  return (
    <div
      role="status"
      data-slot="license-bar"
      className={cn(
        "flex flex-col gap-2 border-b px-4 py-2.75",
        ended ? "border-bad-line bg-bad-tint" : "border-warn-line bg-warn-tint",
        className,
      )}
    >
      <div className="flex items-start gap-2.5 text-ui text-tx">
        <Icon
          name="alert"
          size={15}
          className={cn("mt-0.5 flex-none", ended ? "text-bad" : "text-warn")}
        />
        <div className="grid min-w-0 flex-1 gap-1.5">
          <p className="wrap-anywhere">
            {ended ? (
              <strong className="font-semibold">
                Your Enterprise license ended on {date}.
              </strong>
            ) : (
              <strong className="font-semibold">
                Your Enterprise license ends on {date} (in{" "}
                {counted(expiry.daysLeft, "day", "days")}).
              </strong>
            )}{" "}
            {owner
              ? ended
                ? "Renew with Octabyte, then check again."
                : "Renew it with Octabyte. Cloudgate checks the key each day from now on, or check now once you have renewed."
              : "Ask an owner to renew it."}
          </p>
          {ended ? (
            <div className="grid gap-1">
              <p>What has stopped until it is renewed:</p>
              <ul className="grid list-disc gap-0.5 pl-4.5 text-tx-2">
                {STOPPED_BY_LAPSE.map((stopped) => (
                  <li key={stopped}>{stopped}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {owner ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="pri"
                disabled={checkNow.isPending}
                aria-busy={checkNow.isPending || undefined}
                onClick={() => checkNow.mutate()}
              >
                <Icon name="refresh" size={13} />
                I&apos;ve renewed, check now
              </Button>
              <LinkButton href="/settings/license" size="sm">
                Open License
              </LinkButton>
              {checkNow.error ? (
                <span className="text-meta wrap-anywhere text-bad">
                  {errorMessage(checkNow.error)}
                </span>
              ) : checkNow.isSuccess ? (
                <span className="text-meta text-tx-2">
                  Checked. The license server still gives this date.
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        {expiry.stage === "early" ? (
          <Button
            size="icon-xs"
            variant="qt"
            aria-label={HIDE_LABEL}
            title={HIDE_LABEL}
            onClick={() => hidden.hide(expiry.validUntil)}
          >
            <Icon name="x" size={13} />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

const HIDE_LABEL = `Hide until ${LAST_WARNING_DAYS} days are left`;

/**
 * The stage as of now. Module scope because `react-hooks/purity` rejects a
 * `Date.now()` in a component body; it is still read on every render, which
 * is what moves the bar from one stage to the next on the 30-second refetch.
 */
function currentExpiry(report: LicenseStatusReport): LicenseExpiry {
  return licenseExpiry(report, Date.now());
}

/**
 * The `validUntil` this person hid the bar for in this Organization, in this
 * browser. Keyed by user and Organization; the value is the date itself, so
 * hiding never outlives the date it was for.
 */
const stores = new Map<string, LocalStore<string | null>>();

function storeFor(key: string): LocalStore<string | null> {
  let store = stores.get(key);
  if (!store) {
    store = createLocalStore<string | null>(key, null, (value) =>
      typeof value === "string" ? value : null,
    );
    stores.set(key, store);
  }
  return store;
}

const NO_STORE: LocalStore<string | null> = {
  subscribe: () => () => {},
  get: () => null,
  set: () => {},
};

function useHiddenFor(userId: string | null, organizationId: string | null) {
  const store =
    userId === null || organizationId === null
      ? NO_STORE
      : storeFor(ownedKey(userId, `license-bar-hidden.${organizationId}`));
  const validUntil = useSyncExternalStore(
    store.subscribe,
    store.get,
    () => null,
  );
  return { validUntil, hide: (date: string) => store.set(date) };
}
