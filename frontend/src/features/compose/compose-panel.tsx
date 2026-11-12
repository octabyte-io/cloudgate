import { useState } from "react";

import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import { errorMessage } from "@/lib/api/error-message";
import type { ComposeDetail } from "@/lib/api/endpoints/compose";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { useCompose } from "./use-compose";

/**
 * The three states every Compose panel opens in, once.
 *
 * F11's wrapper, for F11's reason: eight tabs all need the same row, and eight
 * copies of "a refusal, a skeleton, and only then the screen" is where that stops
 * being acceptable. A panel is a function of the row.
 *
 * **A bad id never reaches here.** `useScopeQueries` marks the scope `missing` on
 * a 404 from the identity query and the route renders `Outcome` (F07). What lands
 * here is the other kind — a 403, or the backend not answering — where the stack
 * exists and this screen cannot read it. The shell around it stays, because the
 * rail and the masthead are still telling the truth.
 */
export function ComposePanel({
  panel,
  children,
  aside,
  header,
  /** Keep the row fresh — for the tabs that watch a deploy land. */
  live,
}: {
  panel: PanelProps;
  children: (row: ComposeDetail) => React.ReactNode;
  aside?: (row: ComposeDetail) => React.ReactNode;
  /** Replaces the default `<h1>`, for the tab that leads with the identity. */
  header?: (row: ComposeDetail) => React.ReactNode;
  live?: boolean;
}) {
  const { id, label, icon } = panel;
  const query = useCompose(id, { live });
  const row = query.data;
  // Rise only when the row arrives after the skeleton. A tab opened over a
  // cached row is already there, and moving it would be decoration.
  const [arrives] = useState(() => query.data === undefined);
  const enter = arrives ? "animate-rise" : undefined;

  if (query.error) {
    return (
      <Page>
        <PageHeader title={label} icon={icon} />
        <Cols>
          <Card>
            <Card.Body>
              <p className="text-body text-tx-2">{errorMessage(query.error)}</p>
            </Card.Body>
          </Card>
        </Cols>
      </Page>
    );
  }

  if (!row) {
    return (
      <Page>
        <PageHeader title={label} icon={icon} />
        <Cols>
          <Card>
            <Card.Body>
              <div className="grid gap-2.5" aria-busy="true">
                <Skeleton className="h-row" />
                <Skeleton className="h-row" />
                <Skeleton className="h-row" />
              </div>
            </Card.Body>
          </Card>
        </Cols>
      </Page>
    );
  }

  return (
    <Page>
      {header ? header(row) : <PageHeader title={label} icon={icon} />}
      {aside ? (
        <Cols
          aside={aside(row)}
          asideLabel={`About ${row.name}`}
          className={enter}
        >
          {children(row)}
        </Cols>
      ) : (
        <Cols className={enter}>{children(row)}</Cols>
      )}
    </Page>
  );
}
