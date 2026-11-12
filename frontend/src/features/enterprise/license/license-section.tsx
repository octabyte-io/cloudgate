"use client";

import { Card } from "@/components/console/card";
import { QAList, QARow } from "@/components/console/qa-row";
import { Skeleton } from "@/components/console/skeleton";
import { toast } from "@/components/console/toast";
import { Switch } from "@/components/ui/switch";
import { useInstanceMode } from "@/lib/api/use-instance-mode";
import { OCTABYTE_CONTACT } from "@/lib/contact";
import { useArrival } from "@/components/console/use-arrival";

import { SectionFailed, SectionPending } from "../../settings/section-states";
import { LicenseLocked } from "../license-gate";
import { LICENSED_FEATURES } from "../licensed-features";
import {
  useEnterpriseSettings,
  useLicenseStatus,
  useSetEnterpriseFeatures,
} from "../use-license";
import { LicenseDangerZone } from "./license-danger-zone";
import { LicenseKeyCard } from "./license-key-card";
import { LicenseStatusCard } from "./license-status-card";

/**
 * **The one screen in the Enterprise group that is not behind `LicenseGate`.**
 *
 * It cannot be: it is the screen you arrive at *because* the gate sent you, and
 * a gate in front of the thing that opens the gate is a locked door with the key
 * behind it. So every state below is written for an unlicensed instance first
 * and a licensed one second.
 *
 * ## Two switches, not one, and the order matters
 *
 * `enableEnterpriseFeatures` is a separate opt-in from the key, and `activate`
 * refuses until it is on — "Please activate enterprise features to activate
 * license key". So the screen puts the opt-in **above** the key rather than
 * beside it, and the key card says what it is waiting for rather than letting
 * somebody paste a key into a form that will refuse it. `deactivate`
 * deliberately leaves the opt-in on, which is why turning it off is its own
 * control and not a side effect of removing the key.
 *
 * ## Owner only, and an admin is told so rather than shown an empty form
 *
 * `GET /license/settings` runs `assertOwner`, which is stricter than the rest of
 * the enterprise surface (SSO, SCIM and forward-auth all take owner *or* admin).
 * An admin therefore sees the status — `GET /license/status` is open to every
 * member — and a stated refusal where the key would be. Two different
 * sentences, because they are two different facts.
 */
export function LicenseSection() {
  const mode = useInstanceMode();
  const status = useLicenseStatus();
  const settings = useEnterpriseSettings({
    enabled: mode.data === "self-hosted",
  });
  const setFeatures = useSetEnterpriseFeatures();

  if (mode.data === "hosted") return <EnterpriseCard status={status} />;

  const optedIn = settings.data?.enableEnterpriseFeatures === true;
  const storedKey = settings.data?.licenseKey ?? "";

  return (
    <>
      <LicenseStatusCard status={status} />

      {settings.error ? (
        <SectionFailed title="Enterprise features" error={settings.error}>
          The license key and the enterprise opt-in are readable by the
          Organization&rsquo;s owner only — stricter than the sections they
          unlock, which an admin can manage. The status above is not affected.
        </SectionFailed>
      ) : (
        <>
          <Card aria-busy={settings.isPending || undefined}>
            <Card.Header
              title="Enterprise features"
              sub="The opt-in a license key is activated against."
              headingLevel={2}
            />
            <Card.Body>
              <QAList>
                <QARow
                  title="Use enterprise features in this Organization"
                  description="Turning this on does not unlock anything by itself — it is the switch a license key is checked against, and activating a key is refused while it is off. Removing a key leaves it on."
                  action={
                    settings.isPending ? (
                      <Skeleton className="h-4.5 w-8 rounded-pill" />
                    ) : (
                      <Switch
                        checked={optedIn}
                        disabled={setFeatures.isPending}
                        aria-label="Use enterprise features in this Organization"
                        onCheckedChange={async (next) => {
                          try {
                            await setFeatures.mutateAsync(next);
                            toast.done(
                              next
                                ? "Enterprise features are on. Activate a license key to unlock them."
                                : "Enterprise features are off. Any active license stops applying.",
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
            </Card.Body>
          </Card>

          <LicenseKeyCard
            loading={settings.isPending}
            optedIn={optedIn}
            storedKey={storedKey}
          />

          {storedKey ? <LicenseDangerZone /> : null}
        </>
      )}
    </>
  );
}

/** The four features Enterprise brings on the Hosted instance, in words. */
const PAID = (["customRoles", "sso", "scim", "forwardAuth"] as const).map(
  (id) => LICENSED_FEATURES[id].inline,
);
const PAID_INLINE = `${PAID.slice(0, -1).join(", ")} and ${PAID[PAID.length - 1]}`;

/**
 * **The Hosted instance's version of this screen: no license key.**
 *
 * The paid features come with Enterprise, which Octabyte sets by agreement, so
 * there is nothing to paste, check or release here — only whether this
 * Organization is Enterprise, and "Contact us" when it is not. The status is
 * the same `GET /license/status`, which the backend answers from the
 * Enterprise marker in hosted mode.
 */
function EnterpriseCard({
  status,
}: {
  status: ReturnType<typeof useLicenseStatus>;
}) {
  const arrival = useArrival(status.isPending);
  if (status.isPending) return <SectionPending title="Enterprise" rows={2} />;
  if (status.error) {
    return (
      <SectionFailed title="Enterprise" error={status.error}>
        Cloudgate could not find out whether this Organization is Enterprise, so
        it is not guessing.
      </SectionFailed>
    );
  }
  return (
    <Card className={arrival}>
      <Card.Header
        title="Enterprise"
        sub="Billed by agreement with Octabyte, rather than through the Hosted plan."
        headingLevel={2}
      />
      <Card.Body>
        {status.data.licensed ? (
          <p className="text-body text-tx">
            This Organization is Enterprise: {PAID_INLINE} are on.
          </p>
        ) : (
          <>
            <LicenseLocked
              feature={["customRoles", "sso", "scim", "forwardAuth"]}
            >
              Custom roles, single sign-on, SCIM and forward auth are not part
              of the Hosted plan.
            </LicenseLocked>
            <p className="mt-3 text-meta text-tx-2">
              To ask about an Enterprise agreement, email{" "}
              <a
                href={`mailto:${OCTABYTE_CONTACT}`}
                className="text-brand-tx underline underline-offset-2"
              >
                {OCTABYTE_CONTACT}
              </a>
              .
            </p>
          </>
        )}
      </Card.Body>
    </Card>
  );
}
