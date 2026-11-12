"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/api/api-error";
import { api } from "@/lib/api/client";
import { projectsApi } from "@/lib/api/endpoints/projects";
import { errorMessage } from "@/lib/api/error-message";

import { Failure, Panel, Row } from "./panel";

/**
 * Proves the client tells refusals apart. The one that matters is 403: the
 * caller is signed in and their role does not carry the action, so the screen
 * says so and the session stays exactly where it is. Only 401 signs anyone out,
 * and that is handled once in `query-client.ts`.
 *
 * Every probe is a read. `POST /projects` used to be the 403 probe, and for
 * anyone whose role *did* carry the action it created a Project called "Scope
 * probe" in their Organization; the empty-name validation probe went
 * with it, because it was the same create one bad validator away from a row.
 * `GET /servers` is the 403 now (a member's role reads no Servers), and
 * `dev-pages-write-nothing.test.ts` holds this directory to reads.
 */
export function RefusalPanel() {
  const [result, setResult] = useState<{
    status: number | null;
    kind: string;
    sentence: string;
    fields: string;
  } | null>(null);

  async function probe(run: () => Promise<unknown>) {
    setResult(null);
    try {
      await run();
      setResult({
        status: 200,
        kind: "accepted",
        sentence: "The backend accepted that.",
        fields: "—",
      });
    } catch (error) {
      setResult({
        status: isApiError(error) ? error.status : null,
        kind: describe(error),
        sentence: errorMessage(error),
        fields: isApiError(error) && error.issues.length
          ? error.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")
          : "—",
      });
    }
  }

  return (
    <Panel
      title="Refusals"
      blurb="Each button provokes one kind of refusal and shows what the client made of it, and none of them writes anything. A 403 must read as a permission problem and leave the session alone."
    >
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => void probe(() => projectsApi.findOne("does-not-exist"))}
        >
          Missing Project
        </Button>
        <Button
          variant="outline"
          onClick={() => void probe(() => api.get("/servers"))}
        >
          GET /servers
        </Button>
      </div>

      {result ? (
        <>
          <Row label="Status">{result.status ?? "no response"}</Row>
          <Row label="Read as">{result.kind}</Row>
          <Row label="Field issues">{result.fields}</Row>
          <Failure message={result.sentence} />
        </>
      ) : null}
    </Panel>
  );
}

function describe(error: unknown): string {
  if (!isApiError(error)) return "not an ApiError";
  if (error.isUnauthenticated) return "session gone — redirects to sign-in";
  if (error.isForbidden) return "permission denied — stays put";
  if (error.isValidation) return "validation — maps to fields";
  return `refused with ${error.status}`;
}
