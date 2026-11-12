"use client";

import { Card } from "@/components/console/card";
import { KVList, KVRow } from "@/components/console/kv-list";
import { PageHeader } from "@/components/console/page-header";
import {
  useConfigLock,
  variableNameLock,
} from "@/components/console/config-lock";
import { VariablesCard } from "@/components/console/variables-card";
import type { Database, DatabaseKind } from "@/lib/api/endpoints/databases";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import { countVariables, parseEnvBlob } from "@/lib/format/env-blob";
import { isLinkingType } from "@/lib/api/endpoints/wired-variables";
import { WiredChangedNotice } from "@/components/console/wired-changed-notice";
import { WiredVariablesCard } from "@/components/console/wired-variables-card";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { DatabaseFactsCard } from "../database-facts-card";
import { DatabasePanel } from "../database-panel";
import { DATABASE_KIND } from "../kinds";
import { useSaveDatabaseEnvironment } from "../use-database";

/**
 * The database's own variables — one encrypted dotenv blob, exactly like a
 * Project's or an Environment's.
 *
 * `PATCH /:kind/:id/environment` takes `{ env }` and nothing finer, which is why
 * this is F08's card and not a table of rows with their own endpoints. Reusing
 * it whole is the point: the masking rule, the "the mask is a guess from the
 * key's name" sentence and the edit-as-a-block behaviour are decisions that
 * should not be made twice.
 */
export default function Panel(props: PanelProps) {
  return (
    <DatabasePanel
      panel={props}
      aside={(row, kind) => (
        <>
          <DatabaseFactsCard database={row} kind={kind} />
          <ResolutionCard row={row} kind={kind} />
        </>
      )}
      header={(row) => (
        <PageHeader
          title={props.label}
          icon={props.icon}
          lede={`Variables handed to ${row.name}'s container on the next deploy.`}
        />
      )}
    >
      {(row, kind) => <Body row={row} kind={kind} />}
    </DatabasePanel>
  );
}

function Body({ row, kind }: { row: Database; kind: DatabaseKind }) {
  const save = useSaveDatabaseEnvironment(
    kind,
    row.databaseId,
    row.environmentId,
  );
  // `PATCH /<engine>/:id/environment` is `service: ['update']`.
  const canSave = usePermission({ service: ["update"] });
  // A postgres's or redis's file entry sets the names it lists.
  const lock = useConfigLock(row.environmentId, kind, row.databaseId);
  const gate = {
    allowed: canSave.allowed,
    refusal: roleRefusal("change this database's variables"),
  };
  const typedNames = parseEnvBlob(row.env).map((variable) => variable.key);

  return (
    <>
      {/* A linked Output changed outside a plan. */}
      <WiredChangedNotice wiredChangedAt={row.wiredChangedAt} />

      <VariablesCard
        names={variableNameLock(lock, "env", typedNames)}
        gate={gate}
        env={row.env ?? ""}
        save={(next) => save.mutateAsync(next === "" ? null : next)}
        noun="Database"
        title="Variables"
        sub={`Set on ${row.name} itself.`}
        emptyBody={
          <>
            Nothing is set on this database. {DATABASE_KIND[kind].label} still
            gets its own credentials at deploy — these are for anything else the
            image reads, as a block of <code>KEY=value</code> lines.
          </>
        }
        meta={
          <>
            {DATABASE_KIND[kind].label}&rsquo;s own credentials are added to the
            container automatically from the Credentials tab, so nothing here
            has to repeat them — and a line here that reuses one of their
            names <strong>replaces</strong> it. Values are masked when the
            <strong> key&rsquo;s name</strong> looks like a credential; nothing
            in the data marks a line as secret, so the rule is deliberately
            cautious.
          </>
        }
      />

      {/* A postgres, mysql or redis may link another Service's Output. */}
      {isLinkingType(kind) ? (
        <WiredVariablesCard
          serviceType={kind}
          serviceId={row.databaseId}
          environmentId={row.environmentId}
          typedNames={typedNames}
          lock={lock}
          gate={gate}
        />
      ) : null}
    </>
  );
}

/**
 * What actually reaches the container, and — the part worth the card — what does
 * not.
 *
 * **Project and Environment variables are not inherited.** This is the opposite
 * of what the shape of the hierarchy implies, and it is worth being exact
 * because getting it wrong costs an afternoon. `prepareEnvironmentVariables`
 * (`docker/docker.utils.ts`) maps over the **service's own** parsed
 * variables and returns only those; the Project's and the Environment's blobs
 * are passed in as *interpolation sources* for `${{project.KEY}}` and
 * `${{environment.KEY}}` references, and are never merged. A key set only on the
 * Project reaches nothing — verified against the real function, not read off
 * its signature.
 *
 * So the honest reading is two lines, not four: what this row sets, plus what it
 * can reach by reference. The counts on the two parent rows are there because
 * they are what is *available to reference*, and they link to the screens that
 * own them.
 */
function ResolutionCard({ row, kind }: { row: Database; kind: DatabaseKind }) {
  const descriptor = DATABASE_KIND[kind];

  return (
    <Card>
      <Card.Header
        title="What the container gets"
        sub="Two sources, and neither is inheritance."
        headingLevel={2}
      />
      <Card.Body>
        <KVList>
          <KVRow
            label={`${descriptor.label} credentials`}
            value="Added at deploy"
            title="Derived from the Credentials tab and prepended to this blob at deploy time. Not stored anywhere as text."
          />
          <KVRow
            label="This database"
            value={<span className="num">{countVariables(row.env)}</span>}
          />
        </KVList>

        <p className="mt-3 text-meta text-tx-2">
          That is the whole environment. Variables on{" "}
          <strong className="font-medium text-tx-2">
            {row.environment.project.name}
          </strong>{" "}
          and{" "}
          <strong className="font-medium text-tx-2">
            {row.environment.name}
          </strong>{" "}
          are <strong className="font-medium text-tx-2">not inherited</strong> —
          they are only reachable by naming them here, so a key set one level up
          and never referenced reaches nothing.
        </p>

        <div className="mt-3 rounded-lg border border-line bg-panel-2 px-3 py-2.5">
          <p className="text-meta text-tx-2">
            To use one, reference it by name:
          </p>
          <pre className="mt-1.5 overflow-x-auto font-mono text-meta text-tx">
            <code>{"CACHE_URL=${{project.REDIS_URL}}"}</code>
          </pre>
          <p className="mt-1.5 text-meta text-tx-3">
            A reference to a name that is not set makes the deploy fail rather
            than resolving to empty.
          </p>
        </div>

        <KVList className="mt-3">
          <KVRow
            label="Available to reference"
            value={
              <span className="num">
                {countVariables(row.environment.project.env) +
                  countVariables(row.environment.env)}
              </span>
            }
            title={`${countVariables(row.environment.project.env)} on the Project, ${countVariables(row.environment.env)} on the Environment`}
          />
        </KVList>
      </Card.Body>
    </Card>
  );
}
