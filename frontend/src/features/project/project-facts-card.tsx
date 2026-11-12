import { Card } from "@/components/console/card";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Skeleton } from "@/components/console/skeleton";
import { countVariables } from "@/lib/format/env-blob";

import { spendFact } from "@/lib/format/token-spend";

import { useProject, useProjectTokenSpend } from "./use-projects";

/**
 * What this Project is, beside the list of what is in it
 * (the reference's aside, e-console.html:3900-3906).
 *
 * The reference's third row is a Services total. It is a Project variables count
 * here instead. A services total is no longer *unavailable* — an Environment's
 * read names everything deployed in it
 * — but totalling a
 * Project's means one detail read per Environment, for a figure in a rail. The
 * variables *are* on the row we already hold, so the rail says something true and
 * free rather than something bought.
 *
 * Every figure waits for its own request. A `0` under "Environments" while the
 * list is still in flight is the one thing this card must not say.
 *
 * **Token spend** is the last 30 days over the AI models the reader can
 * read, then one row per Environment holding any, so production and staging
 * read side by side. It is shown only when some Environment holds an AI model:
 * a Project with nothing to spend on has no AI cost to state.
 */
export function ProjectFactsCard({
  projectId,
  environmentCount,
}: {
  projectId: string;
  environmentCount: number | undefined;
}) {
  const project = useProject(projectId);
  const row = project.data;
  const spend = useProjectTokenSpend(projectId).data;
  const spending =
    spend?.environments.filter((env) => env.aiModelCount > 0) ?? [];
  const total = spend && spending.length > 0 ? spendFact(spend.total) : null;

  return (
    <Card>
      <Card.Header title="Project" headingLevel={2} />
      <Card.Body>
        <KVList>
          <KVRow
            label="Name"
            title={row?.name}
            value={row ? row.name : <Skeleton className="ml-auto w-24" />}
          />
          <KVRow
            label="Environments"
            value={environmentCount ?? <Skeleton className="ml-auto w-6" />}
          />
          <KVRow
            label="Project variables"
            value={
              row ? (
                countVariables(row.env)
              ) : (
                <Skeleton className="ml-auto w-6" />
              )
            }
          />
          {total ? (
            <>
              <KVRow
                label="Token spend, 30 days"
                title={total.title}
                value={total.value}
              />
              {spending.map((env) => {
                const fact = spendFact(env.total);
                return (
                  <KVRow
                    key={env.environmentId}
                    className="pl-3"
                    label={env.name}
                    title={fact.title}
                    value={fact.value}
                  />
                );
              })}
            </>
          ) : null}
        </KVList>
        {row?.description ? (
          <p className="mt-3 text-meta text-tx-2">{row.description}</p>
        ) : null}
      </Card.Body>
    </Card>
  );
}
