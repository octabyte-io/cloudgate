import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResourceFormModal } from "@/components/console/resource-form-modal";
import type { Port, Redirect, Security } from "@/lib/api/endpoints/networking";

import { portsSpec, redirectsSpec, securitySpec } from "./networking-specs";

afterEach(cleanup);

const noop = async () => undefined;
const calls = { applicationId: "app-1", create: noop, update: noop, remove: noop };

const redirect = (permanent: boolean) =>
  ({
    redirectId: "r1",
    regex: "^http://example\\.com/old(.*)",
    replacement: "/new${1}",
    permanent,
  }) as Redirect;
const user = { securityId: "s1", username: "preview" } as Security;
const port = {
  portId: "p1",
  publishedPort: 18080,
  targetPort: 80,
  protocol: "tcp",
  publishMode: "ingress",
} as Port;

/** Every sentence a spec can put on screen, rendered, as one string. */
function copyOf<Row>(
  spec: {
    title: string;
    lede?: ReactNode;
    emptyTitle: string;
    emptyBody: ReactNode;
    fields: { label: string; hint?: ReactNode }[];
    deleteNote?: (row: Row) => ReactNode;
  },
  rows: Row[],
): string {
  const { container } = render(
    <>
      <p>{spec.title}</p>
      <p>{spec.lede}</p>
      <p>{spec.emptyTitle}</p>
      <p>{spec.emptyBody}</p>
      {spec.fields.map((field) => (
        <p key={field.label}>
          {field.label} {field.hint}
        </p>
      ))}
      {rows.map((row, index) => (
        <p key={index}>{spec.deleteNote?.(row)}</p>
      ))}
    </>,
  );
  const text = container.textContent ?? "";
  cleanup();
  return text;
}

describe("redirectsSpec and securitySpec", () => {
  // The same mistake once corrected on the Domains tab: both of these
  // regenerate the Application's Traefik file on save, and Traefik reloads it
  // within a second. A remove confirm saying "from the next Deployment" told an
  // operator a basic-auth gate would hold until a deploy it never waited for.
  it.each([
    ["redirects", copyOf(redirectsSpec(calls), [redirect(false), redirect(true)])],
    ["basic authentication", copyOf(securitySpec(calls), [user])],
  ])("never says %s wait for the next Deployment", (_, copy) => {
    expect(copy).not.toMatch(/next Deployment/i);
  });

  it.each([
    ["a redirect", copyOf({ ...redirectsSpec(calls), fields: [] }, [redirect(false)])],
    ["a basic-auth user", copyOf({ ...securitySpec(calls), fields: [] }, [user])],
  ])("says removing %s applies straight away", (_, copy) => {
    expect(copy).toContain("No Deployment is needed.");
  });

  it("still says a published port waits for the next Deployment, which it does", () => {
    // The other direction: Swarm binds a port from the service spec, so this
    // one is true, and a census that only ever looked for absence would pass
    // on a spec that had lost every word.
    expect(copyOf(portsSpec(calls), [port])).toMatch(/next Deployment/);
  });
});

describe("redirectsSpec's pattern check", () => {
  const schema = redirectsSpec(calls).schema;
  const check = (regex: string) =>
    schema.safeParse({ regex, replacement: "/x${1}", permanent: false });

  // Traefik compiles this with Go's RE2; the dialog used to compile it
  // with `new RegExp`, which refused the first three and passed the rest.
  it.each([
    "(?i)^https?://Example\\.com/(.*)",
    "^https?://(?i:example)\\.com/(.*)",
    "^/(?P<rest>.*)",
    // Escaped or inside a class, none of these is the construct.
    "^/\\(?=x",
    "^/[(?=]x",
    "^/a\\\\1",
    // Octal escapes, not backreferences: Go reads `\1`–`\7` followed by an
    // octal digit as a character code. Measured with Go 1.24's regexp.Compile.
    "^/a\\12",
    "^/a\\123",
    "^/a\\0",
  ])("accepts %s, which RE2 compiles", (regex) => {
    expect(check(regex).error?.issues).toBeUndefined();
  });

  it.each([
    ["^/(?=x)(.*)", "a lookahead (?=…)"],
    ["^/(?!x)(.*)", "a negative lookahead (?!…)"],
    ["^/(?<=x)(.*)", "a lookbehind (?<=…)"],
    ["^/(?<!x)(.*)", "a negative lookbehind (?<!…)"],
    ["^/(a)\\1", "a backreference (\\1)"],
    ["^/(a)(b)\\9", "a backreference (\\9)"],
    // `\7` then a non-octal digit is still a backreference to Go.
    ["^/a\\78", "a backreference (\\7)"],
  ])("refuses %s, naming %s", (regex, construct) => {
    const issues = check(regex).error?.issues ?? [];
    expect(issues.map((issue) => issue.message)).toEqual([
      `Traefik compiles this as a Go regular expression, which does not support ${construct} — saved, it would stop every domain of this Application being routed.`,
    ]);
  });
});

describe("portsSpec", () => {
  it("publishes 18080 → 80 from the dialog, as numbers", async () => {
    // The dialog refused every value with "Invalid input: expected
    // number, received string" and sent nothing.
    const create = vi.fn(async () => undefined);
    render(
      <ResourceFormModal
        spec={portsSpec({ ...calls, create })}
        row={null}
        open
        onOpenChange={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText(/^Port on the Server/), {
      target: { value: "18080" },
    });
    fireEvent.change(screen.getByLabelText(/^Port in the container/), {
      target: { value: "80" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish a port" }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({
      applicationId: "app-1",
      publishedPort: 18080,
      targetPort: 80,
      protocol: "tcp",
      publishMode: "ingress",
    });
    expect(document.body.textContent).not.toMatch(/expected number/);
  });
});
