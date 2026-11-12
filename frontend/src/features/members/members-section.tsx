"use client";

import { LinkButton } from "@/components/console/link-button";

import { InvitationsCard } from "./invitations-card";
import { MembersCard } from "./members-card";
import { RolesCard } from "./roles-card";
import { StrandedMembersBanner } from "./stranded-banner";
import { TeamsCard } from "./teams-card";

/**
 * Membership, in the order the questions get asked: who is here, who has been
 * asked, what the roles mean, and how they are grouped.
 *
 * Each card owns its own query and its own waiting state rather than the section
 * gating on all four. They are four independent reads — members, invitations,
 * roles, teams — and there is nothing to hold back: the member table is useful
 * the moment it lands, and making it wait for the team roster would be waiting
 * on the least important thing on the screen.
 *
 * The banner goes first because it is about the table underneath it: when a
 * licence lapses, the people it locked out are rows on this screen, and the fix
 * — moving them to Admin or Member — is a button in those rows
 * It renders
 * nothing at all unless somebody is actually stranded.
 */
export function MembersSection() {
  return (
    <>
      <StrandedMembersBanner
        action={
          <LinkButton size="sm" href="/settings/roles">
            See the roles
          </LinkButton>
        }
      />
      <MembersCard />
      <InvitationsCard />
      <RolesCard />
      <TeamsCard />
    </>
  );
}
