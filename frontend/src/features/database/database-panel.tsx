import { useState } from "react";

import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import { errorMessage } from "@/lib/api/error-message";
import type { Database, DatabaseKind } from "@/lib/api/endpoints/databases";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { useDatabase } from "./use-database";

/**
 * The three states every database panel opens in, once.
 *
 * All five tabs need the same row, and each of them would otherwise repeat the
 * same twenty lines: a refusal, a skeleton, and only then the screen. F09's
 * Application panels each carry their own copy of it and F10's inherit it; five
 * more copies here is where that stops being acceptable, so this is the wrapper
 * and a panel is a function of the row.
 *
 * **A bad id never reaches here.** `useScopeQueries` marks the scope `missing`
 * on a 404 from the identity query and the route renders `Outcome` (F07). What
 * lands here is the other kind — a 403, or the backend not answering — where the
 * database exists and this screen cannot read it. The shell around it stays and
 * only the reading is replaced, because the rail and the masthead are still
 * telling the truth.
 */
export function DatabasePanel({
  panel,
  children,
  aside,
  header,
}: {
  panel: PanelProps;
  /** Called only with a real row. */
  children: (row: Database, kind: DatabaseKind) => React.ReactNode;
  aside?: (row: Database, kind: DatabaseKind) => React.ReactNode;
  /** Replaces the default `<h1>`, for the tab that leads with the identity. */
  header?: (row: Database, kind: DatabaseKind) => React.ReactNode;
}) {
  const { id, kind, label, icon } = panel;
  const query = useDatabase(kind, id);
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

  if (!row || !kind) {
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
      {header ? header(row, kind) : <PageHeader title={label} icon={icon} />}
      {aside ? (
        <Cols
          aside={aside(row, kind)}
          asideLabel={`About ${row.name}`}
          className={enter}
        >
          {children(row, kind)}
        </Cols>
      ) : (
        <Cols className={enter}>{children(row, kind)}</Cols>
      )}
    </Page>
  );
}
