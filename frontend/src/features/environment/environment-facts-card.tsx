import Link from "next/link";

import { Card } from "@/components/console/card";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Skeleton } from "@/components/console/skeleton";
import { timeExact } from "@/lib/format/time";

import { spendFact } from "@/lib/format/token-spend";
import { useProject } from "@/features/project/use-projects";

import { useEnvironment, useEnvironmentTokenSpend } from "./use-environments";
import { countVariables } from "@/lib/format/env-blob";

/**
 * What this Environment is, in the rail beside whatever tab is open.
 *
 * The reference's version of this card leads with Runtime, Deploy target,
 * Orchestrator and Ingress (e-console.html:3934-3940). `environment.runtime`
 * was marked proposed by the prototype itself, and the last two are constants
 * dressed as facts. The Deploy target is a real column now, and is shown
 * and changed by its own card on the Settings tab rather than repeated here.
 * What is here is what the row actually carries.
 *
 * The description closes the card rather than sitting in the list, the way the
 * Project's card already ends with its own
 * it is a sentence,
 * not a value, and a right-aligned KV row would set it in the wrong column.
 *
 * The Project's *name* is a second request — an `environment` row has a
 * `projectId` and nothing else — which is the same chase `use-scope-queries.ts`
 * makes for the "Back to …" pill, so it is already in cache by the time this
 * renders.
 *
 * **Token spend** is the last 30 days over the AI models here the
 * reader can read, and is shown only when there is at least one: an
 * Environment with nothing to spend on has no AI cost to state, and a "0
 * tokens" there would read as a figure. Its own request, shared with the
 * Services tab's per-AI-model column.
 */
export function EnvironmentFactsCard({
  environmentId,
}: {
  environmentId: string;
}) {
  const environment = useEnvironment(environmentId);
  const row = environment.data;
  const project = useProject(row?.projectId ?? "");
  const spend = useEnvironmentTokenSpend(environmentId).data;
  const spent =
    spend && spend.aiModels.length > 0 ? spendFact(spend.total) : null;

  return (
    <Card>
      <Card.Header title="Environment" headingLevel={2} />
      <Card.Body>
        <KVList>
          <KVRow
            label="Name"
            title={row?.name}
            value={row ? row.name : <Skeleton className="ml-auto w-20" />}
          />
          <KVRow
            label="Project"
            title={project.data?.name}
            value={
              project.data && row ? (
                <Link
                  href={`/projects/${row.projectId}`}
                  className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
                >
                  {project.data.name}
                </Link>
              ) : (
                <Skeleton className="ml-auto w-20" />
              )
            }
          />
          <KVRow
            label="Variables"
            value={
              row ? countVariables(row.env) : <Skeleton className="ml-auto w-6" />
            }
          />
          {spent ? (
            <KVRow
              label="Token spend, 30 days"
              title={spent.title}
              value={spent.value}
            />
          ) : null}
          <KVRow
            label="Created"
            title={row ? timeExact(row.createdAt) : undefined}
            value={
              row ? (
                <time dateTime={row.createdAt}>{timeExact(row.createdAt)}</time>
              ) : (
                <Skeleton className="ml-auto w-28" />
              )
            }
          />
        </KVList>
        {row?.description ? (
          <p className="mt-3 text-meta text-tx-2">{row.description}</p>
        ) : null}
      </Card.Body>
    </Card>
  );
}
