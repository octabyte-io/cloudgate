import { DangerZone } from "@/components/console/danger-zone";

import { licensedFeaturesInline } from "../licensed-features";
import { useDeactivateLicense } from "../use-license";

/**
 * Releasing the key — **which releases it with the licence server too**, so it can
 * be activated on another instance.
 *
 * The consequence worth stating before anybody does it on a working instance is not
 * the licensed sections stopping: it is that a member holding a **custom role** is
 * denied *everything* without a licence, including what their role grants. Driven,
 * and the reason the Roles screen renders its list unlicensed with a banner.
 */
export function LicenseDangerZone() {
  const deactivate = useDeactivateLicense();

  return (
    <DangerZone
      sub="Releasing the key here also releases it with the license server, so it can be activated on another instance."
      actions={[
        {
          id: "deactivate",
          title: "Release this license key",
          // The features come from the registry the gates name.
          description: `${sentenceStart(licensedFeaturesInline())} stop working for this Organization immediately. Nothing they configured is deleted — the SSO providers, SCIM tokens, custom roles, branding and limits stay on record and start working again when a license does.`,
          consequences: (
            // "the release" here is the licence key being handed back to the
            // licence server, not a Deployment — a different concept, so the
            // glossary's Avoid row does not reach it.
            // eslint-disable-next-line no-restricted-syntax
            <>
              The key is released with the license server and cleared here. If the
              license server cannot be reached the local half still happens, so this
              always detaches the key even when the release does not land.
              <br />
              <br />
              One thing to know before you do it on a working instance: a member
              holding a <strong className="font-medium">custom role</strong> is
              denied <em>everything</em> without a license, not merely the licensed
              parts — including the actions their role grants. Move them to a
              built-in role first.
            </>
          ),
          button: "Release the key",
          run: () => deactivate.mutateAsync(),
          done: "The license key has been released.",
        },
      ]}
    />
  );
}

function sentenceStart(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
