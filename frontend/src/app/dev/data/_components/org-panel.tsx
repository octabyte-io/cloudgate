"use client";

import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { organizationsApi } from "@/lib/api/endpoints/organizations";
import { projectsApi } from "@/lib/api/endpoints/projects";
import { errorMessage } from "@/lib/api/error-message";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { unwrap } from "@/lib/auth/auth-error";
import { organization, useActiveOrganizationId } from "@/lib/auth/client";

import { Dump, Failure, Panel, Row } from "./panel";

/**
 * Proves the tenant boundary. The Projects list below is keyed by the active
 * Organization id, so switching Organization cannot show the previous one's
 * rows — the key moves, and `organizationChanged()` drops the old subtree
 * outright.
 */
export function OrganizationPanel() {
  const { organizationId, pending } = useActiveOrganizationId();
  const invalidate = useInvalidate();

  const organizations = useQuery({
    queryKey: keys.myOrganizations(),
    queryFn: () => organizationsApi.list(),
    enabled: !pending,
  });

  const projects = useQuery({
    queryKey: keys.projects.list(organizationId),
    queryFn: () => projectsApi.list(),
    enabled: organizationId !== null,
  });

  async function switchTo(id: string) {
    await unwrap(organization.setActive({ organizationId: id }));
    await invalidate.organizationChanged();
  }

  return (
    <Panel
      title="Organization scope"
      blurb="Every tenant query key hangs off the active Organization id. Switch below and watch the Projects query re-key rather than reuse what the last Organization had."
    >
      <Row label="Active organization id">{organizationId ?? "none"}</Row>
      <Row label="Projects query key">
        {JSON.stringify(keys.projects.list(organizationId))}
      </Row>

      {organizations.error ? (
        <Failure message={errorMessage(organizations.error)} />
      ) : null}

      <div className="flex flex-wrap gap-2">
        {organizations.data?.map((org) => (
          <Button
            key={org.id}
            variant={org.id === organizationId ? "default" : "outline"}
            onClick={() => void switchTo(org.id)}
          >
            {org.name}
          </Button>
        ))}
      </div>

      <Row label="Projects">
        {projects.isFetching
          ? "fetching…"
          : `${projects.data?.length ?? 0} returned`}
      </Row>
      {projects.error ? <Failure message={errorMessage(projects.error)} /> : null}
      {projects.data ? <Dump value={projects.data} /> : null}
    </Panel>
  );
}
