"use client";

import { useArrival } from "@/components/console/use-arrival";
import { cn } from "@/lib/utils";

import { SectionFailed, SectionPending } from "../section-states";

import { ApiKeysCard } from "./api-keys-card";
import { PasswordCard } from "./password-card";
import { ProfileCard } from "./profile-card";
import { SessionsCard } from "./sessions-card";
import { TwoFactorCard } from "./two-factor-card";
import { useProfile } from "./use-account";

/**
 * The signed-in person, in five cards.
 *
 * **The profile query gates three of them and not the other two**, which is the
 * only structural decision on this screen. `ProfileCard` needs the row to fill
 * its fields and `TwoFactorCard` needs `twoFactorEnabled` to know which of its
 * two states it is in, so both wait. `PasswordCard`, `SessionsCard` and
 * `ApiKeysCard` do not read the profile at all — they would render perfectly
 * well while it was in flight — but they are inside the gate anyway, because a
 * screen that pours itself in three stages while somebody is deciding what to
 * change is worse than one that arrives.
 *
 * A failed profile read is an `Outcome` and not an empty screen: `GET /users/me`
 * failing means the session is not answering, and offering a password form under
 * that is offering something that cannot work.
 */
export function AccountSection() {
  const profile = useProfile();

  const arrival = useArrival(profile.isPending);
  if (profile.isPending) {
    return <SectionPending title="Profile" rows={4} />;
  }

  if (profile.error || !profile.data) {
    return (
      <SectionFailed title="Profile" error={profile.error}>
        Reloading is the thing to try. If it keeps happening, your session has
        probably ended — signing in again will fix it.
      </SectionFailed>
    );
  }

  return (
    <div className={cn("grid gap-5.5", arrival)}>
      {/* Keyed on the stored address so a saved email remounts the form with
          what the backend stored — lower-cased — rather than what was
          typed, and clears the password it was saved with. */}
      <ProfileCard key={profile.data.email} profile={profile.data} />
      <PasswordCard />
      <TwoFactorCard profile={profile.data} />
      <SessionsCard />
      <ApiKeysCard />
    </div>
  );
}
