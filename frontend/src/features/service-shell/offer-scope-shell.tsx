"use client";

import { useScope } from "@/components/shell/scope-provider";
import type { DatabaseKind } from "@/lib/api/endpoints/databases";
import type { TabSubject } from "@/lib/shell/tab-registry";
import { useApplication } from "@/features/application/use-application";
import { useCompose } from "@/features/compose/use-compose";
import { useDatabase } from "@/features/database/use-database";

import { OfferServiceShell } from "./offer-service-shell";
import {
  applicationShellService,
  composeShellService,
  databaseShellService,
} from "./shell-services";

/**
 * The Service scope's offer under the Dock's `+`, mounted by the
 * Application, database and Compose layouts so it is there on every tab, not
 * only the Shell tab.
 *
 * The scope and the facts the Shell tab is decided on (`subject`) are the
 * rail's own (`useScope`), and the row is the one every tab of the scope
 * already reads, by the same query key — so this asks the backend for nothing
 * but the container listing, which the Shell tab shares.
 */
export function OfferScopeShell() {
  const { scope, subject = {} } = useScope();
  if (scope.id === null) return null;
  switch (scope.kind) {
    case "application":
      return <OfferApplicationShell id={scope.id} subject={subject} />;
    case "database":
      return scope.variant ? (
        <OfferDatabaseShell
          kind={scope.variant}
          id={scope.id}
          subject={subject}
        />
      ) : null;
    case "compose":
      return <OfferComposeShell id={scope.id} subject={subject} />;
    default:
      return null;
  }
}

type ScopeProps = { id: string; subject: TabSubject };

function OfferApplicationShell({ id, subject }: ScopeProps) {
  const row = useApplication(id).data;
  return (
    <OfferServiceShell
      service={row ? applicationShellService(row) : null}
      subject={subject}
    />
  );
}

function OfferDatabaseShell({
  kind,
  id,
  subject,
}: ScopeProps & { kind: DatabaseKind }) {
  const row = useDatabase(kind, id).data;
  return (
    <OfferServiceShell
      service={row ? databaseShellService(row) : null}
      subject={subject}
    />
  );
}

function OfferComposeShell({ id, subject }: ScopeProps) {
  const row = useCompose(id).data;
  return (
    <OfferServiceShell
      service={row ? composeShellService(row) : null}
      subject={subject}
    />
  );
}
