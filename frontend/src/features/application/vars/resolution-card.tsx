import Link from "next/link";

import { Card } from "@/components/console/card";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Skeleton } from "@/components/console/skeleton";
import type { ApplicationDetail } from "@/lib/api/endpoints/applications";

import { countVariables } from "@/lib/format/env-blob";

/**
 * Where this Application's container gets its environment, and what the Project
 * and the Environment are actually for.
 *
 * The reference has a "Where these come from" card with three rows and a Scope
 * column on the table beside it (`e-console.html:4234-4240`). **The Scope column
 * cannot exist**: each level is one encrypted blob on its own row, the merge is
 * computed nowhere, and a resolved list with a scope per line would be this screen
 * inventing a result the platform never produces.
 *
 * **F19 rewrote the sentence under the counts**, which said the Application's
 * values are layered over the Environment's over the Project's. They are not.
 * `prepareEnvironmentVariables` (`docker/docker.utils.ts`) returns the
 * service's **own** blob and nothing else; the other two are interpolation
 * sources for `${{project.KEY}}` / `${{environment.KEY}}`. Reproduced against the
 * real function.
 *
 * **The three counts were still one list, outermost first**, which is the shape
 * of a cascade — the sentence denied inheritance while the order above it drew
 * one. They are now two lists with the denial between them, F11's arrangement on
 * the database Variables tab: what the container gets, then what is merely
 * available to reference. Same order as F11, so moving between a database and
 * an Application does not mean learning a second model.
 *
 * **The denial is now the card's `sub` and nothing more**: "Only its
 * own reach the container." It was a three-clause paragraph explaining that
 * the other levels are not inherited. The reference example and the counts
 * show it, so the paragraph said it a third time.
 *
 * The links on the two counts matter more than they look: they are the only route
 * from "this key is not mine" to the screen that owns it.
 */
export function ResolutionCard({
  application,
  environmentCount,
  projectCount,
}: {
  application: ApplicationDetail | undefined;
  environmentCount: number;
  projectCount: number;
}) {
  const own = countVariables(application?.env);

  return (
    <Card>
      <Card.Header
        title="Where these come from"
        sub="Only its own reach the container."
        headingLevel={2}
      />
      <Card.Body>
        <KVList>
          <KVRow
            label="This Application"
            value={
              application ? (
                <span className="num">{own}</span>
              ) : (
                <Skeleton className="ml-auto w-6" />
              )
            }
          />
        </KVList>

        <div className="mt-3 rounded-lg border border-line bg-panel-2 px-3 py-2.5">
          <p className="text-meta text-tx-2">
            To use a Project or Environment variable, reference it by name:
          </p>
          <pre className="mt-1.5 overflow-x-auto font-mono text-meta text-tx">
            <code>{"CACHE_URL=${{project.REDIS_URL}}"}</code>
          </pre>
          <p className="mt-1.5 text-meta text-tx-3">An unset name fails the deploy.</p>
        </div>

        <p className="mt-3 text-meta text-tx-3">Available to reference:</p>
        <KVList>
          <KVRow
            label="Project"
            title={application?.environment.project.name}
            value={
              application ? (
                <Link
                  href={`/projects/${application.environment.project.projectId}`}
                  className="num font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
                >
                  {projectCount}
                </Link>
              ) : (
                <Skeleton className="ml-auto w-6" />
              )
            }
          />
          <KVRow
            label="Environment"
            title={application?.environment.name}
            value={
              application ? (
                <Link
                  href={`/environments/${application.environment.environmentId}/variables`}
                  className="num font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
                >
                  {environmentCount}
                </Link>
              ) : (
                <Skeleton className="ml-auto w-6" />
              )
            }
          />
        </KVList>
      </Card.Body>
    </Card>
  );
}
