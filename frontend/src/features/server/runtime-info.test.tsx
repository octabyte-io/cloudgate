import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { KVList } from "@/components/console/kv-list";
import { ApiError } from "@/lib/api/api-error";
import type { Probe, RuntimeInfo } from "@/lib/api/endpoints/settings";

import {
  IngressRow,
  declaredMissingNote,
  ingressNote,
  type RuntimeInfoQuery,
} from "./runtime-info";

afterEach(cleanup);

/** Only `traefik` is read by these rows; the other nine readings have no row. */
function answered(traefik: Probe<string>): RuntimeInfoQuery {
  return {
    data: { traefik } as unknown as RuntimeInfo,
    error: null,
    isPending: false,
  } as unknown as RuntimeInfoQuery;
}

function refused(status: number, code?: string): RuntimeInfoQuery {
  return {
    data: undefined,
    error: new ApiError(
      status,
      "Only owners and admins can manage web server settings",
      code ? { code } : undefined,
    ),
    isPending: false,
  } as unknown as RuntimeInfoQuery;
}

const pending = {
  data: undefined,
  error: null,
  isPending: true,
} as unknown as RuntimeInfoQuery;

function said(query: RuntimeInfoQuery) {
  render(
    <KVList>
      <IngressRow query={query} />
    </KVList>,
  );
  return document.body.textContent ?? "";
}

/**
 * The row once emptied, and the four ways it can be wrong again.
 *
 * The two cases historically got wrong on this
 * shape of row are the last two: a stopped Docker daemon, whose null `observed`
 * is a 200 and not a failure, and a plain member, whose 403 must degrade the row
 * rather than replace a value with a refusal.
 */
describe("IngressRow", () => {
  it("names the version the container is actually running", () => {
    const text = said(
      answered({
        declared: "3.6.7",
        observed: "3.6.7",
        scope: "host",
        drift: false,
      }),
    );

    expect(text).toContain("Traefik 3.6.7");
    // Repeating the pin beside an identical observed version is noise on every
    // healthy install, and it is what stops the drift case being scannable.
    expect(text).not.toContain("declared");
  });

  it("shows the declared pin beside the observed version when they differ", () => {
    const text = said(
      answered({
        declared: "3.6.7",
        observed: "3.5.0",
        scope: "host",
        drift: true,
      }),
    );

    // The gap is the whole point of the endpoint: this exact pair is what the
    // deleted literal was a symptom of.
    expect(text).toContain("Traefik 3.5.0");
    expect(text).toContain("declared 3.6.7");
  });

  it("reads as not known, not as an error, when the host answered nothing", () => {
    const text = said(
      answered({
        declared: "3.6.7",
        observed: null,
        raw: null,
        reason: "cloudgate-traefik is not present on this host",
        scope: "host",
        drift: false,
      }),
    );

    expect(text).toContain("version not known — 3.6.7 declared");
    // Docker stopped is a normal answer. The backend's `reason` is written for
    // whoever reads the logs and never reaches the row.
    expect(text).not.toContain("not present on this host");
  });

  it("degrades for a plain member instead of showing a refusal", () => {
    const query = refused(403);
    const text = said(query);

    // The row keeps its name and loses only its number.
    expect(text).toContain("Ingress");
    expect(text).toContain("Traefik");
    expect(text).toContain("version needs owner or admin");
    expect(ingressNote(query)).toContain("the reading was not taken");
    expect(declaredMissingNote(query)).toBe("version needs owner or admin");
  });

  /**
   * The same status, and the reason `isRefusal` stopped reading one (H-48).
   *
   * A **banned** operator is refused this route with a 403 like any member, and
   * all three sentences hanging off `isRefusal` told them an owner or an admin
   * could take the reading for them. No role change lifts a ban, so the row was
   * naming a fix that does not exist and the note under the list was saying
   * nothing is known to be wrong about a machine nobody asked.
   *
   * A row is one KV cell wide, so what it says instead is the neutral "not
   * known" the 500 case already uses — the ban's own sentence needs a paragraph,
   * and `instance-runtime-card.tsx` is the surface that has one. What the fix
   * guarantees here is narrower and is the whole of the finding: **it never tells
   * a banned person their role is the problem.**
   */
  it("does not offer a role fix on the ban, which no role change lifts", () => {
    const query = refused(403, "BANNED_USER");
    const text = said(query);

    expect(text).toContain("Traefik");
    expect(text).toContain("version not known");
    expect(text).not.toContain("version needs owner or admin");
    expect(ingressNote(query)).toContain("read off the running container");
    expect(ingressNote(query)).not.toContain("Only an owner or an admin");
    expect(declaredMissingNote(query)).toBe("version not known");
  });

  it("does not read a failed request as a refusal", () => {
    const query = refused(500);

    expect(said(query)).toContain("version not known");
    expect(ingressNote(query)).toContain("read off the running container");
    expect(declaredMissingNote(query)).toBe("version not known");
  });

  it("marks the row busy while the reading is in flight", () => {
    render(
      <KVList>
        <IngressRow query={pending} />
      </KVList>,
    );

    expect(
      document.querySelector('[data-slot="kv-row"][aria-busy="true"]'),
    ).not.toBe(null);
  });
});
